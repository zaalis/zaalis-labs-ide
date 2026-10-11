'use strict';

// Speech-to-text for the dictation button of the chat and for the integrated
// browser's voice search. The client records the microphone and posts a WAV;
// it is transcribed on this PC — nothing is sent to a cloud service:
//
//   1. whisper.cpp (native/whisper, shipped with the application) with a
//      Whisper model downloaded once into the data folder;
//   2. Windows' own speech recognizer while that model is not there yet, or if
//      the engine cannot run. Much less accurate, but always available.
//
// The embedded WebView exposes the browser SpeechRecognition API but has no
// speech service behind it, which is why dictation cannot stay client-side.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
// Below this peak level (about -46 dBFS) a recording is room noise. Speech
// models invent a sentence when handed silence, so it is never given to one.
const SILENCE_PEAK = 0.005;
const WHISPER_TIMEOUT_MS = 180_000;
const WINDOWS_TIMEOUT_MS = 120_000;
const PULL_RETRY_MS = 60_000;

// The "small" multilingual Whisper model, quantized: on a desktop CPU it
// transcribes a sentence in one to two seconds with very few mistakes. The
// smaller ones misheard ordinary French; the larger ones need a GPU build.
const WHISPER_MODEL = {
  file: 'ggml-small-q5_1.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  bytes: 190085487,
};
const LOCALES = { fr: 'fr-FR', en: 'en-US' };

function sttError(code, message, status) { return Object.assign(new Error(message || code), { code, status: status || 500 }); }
const language = (value) => (/^[a-z]{2}$/.test(String(value || '')) ? String(value) : 'fr');

// Header of a PCM WAV file: enough to refuse anything else and to measure it.
function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw sttError('audio-invalid', 'Enregistrement audio invalide (WAV attendu).', 400);
  let format = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && start + 16 <= buffer.length) {
      format = { encoding: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bits: buffer.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      if (!format || format.encoding !== 1 || format.bits !== 16 || !format.channels || !format.sampleRate) break;
      const end = Math.min(buffer.length, start + size);
      const frames = Math.floor((end - start) / (2 * format.channels));
      return { ...format, dataStart: start, frames, seconds: frames / format.sampleRate };
    }
    offset = start + size + (size % 2);
  }
  throw sttError('audio-invalid', 'Enregistrement audio invalide (WAV PCM 16 bits attendu).', 400);
}
// Loudest sample of the recording, 0..1.
function peakLevel(buffer, wav) {
  let peak = 0;
  const end = wav.dataStart + wav.frames * 2 * wav.channels;
  for (let offset = wav.dataStart; offset + 2 <= end; offset += 2) {
    const value = Math.abs(buffer.readInt16LE(offset));
    if (value > peak) peak = value;
  }
  return peak / 32768;
}

// What a speech model writes when nobody spoke: sound annotations, dots, or
// the subtitle credits its training data was full of. None of it was said.
const PHANTOM = /^(?:sous-titres? (?:réalisés?|faits?) (?:par|para) .*|sous-titrage .*|merci d['’]avoir regardé.*|thanks? for watching.*|subtitles by .*)$/i;
function cleanTranscript(text) {
  const spoken = String(text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(spoken) || /^(?:\([^)]*\)\s*)+$/.test(spoken) || PHANTOM.test(spoken)) return '';
  return spoken;
}

function withTempWav(audio, tempDir, work) {
  const wav = path.join(tempDir || os.tmpdir(), `zaalis-stt-${process.pid}-${crypto.randomBytes(6).toString('hex')}.wav`);
  try { fs.mkdirSync(path.dirname(wav), { recursive: true }); fs.writeFileSync(wav, audio); } catch { return Promise.reject(sttError('stt-unavailable', 'Impossible d’écrire l’enregistrement temporaire.')); }
  return work(wav).finally(() => { try { fs.unlinkSync(wav); } catch {} });
}

function runWhisper({ cli, model, audio, lang, tempDir }) {
  const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
  return withTempWav(audio, tempDir, (wav) => new Promise((resolve, reject) => {
    // -nt/-np: text only on stdout. -sns: no sound annotations ("(musique)").
    execFile(cli, ['-m', model, '-f', wav, '-l', lang, '-nt', '-np', '-sns', '-t', String(threads)],
      { timeout: WHISPER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, cwd: path.dirname(cli) },
      (error, stdout) => (error ? reject(sttError('stt-unavailable', 'Le moteur de transcription local a échoué.')) : resolve(String(stdout || ''))));
  }));
}

// Windows' desktop recognizer (System.Speech). The recording and the locale
// travel in the environment, never in the command line. `Recognize` returns
// one phrase per call and throws once the file is exhausted.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Speech',
  '$locale = $env:ZAALIS_STT_LOCALE',
  '$installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()',
  '$recognizer = $installed | Where-Object { $_.Culture.Name -eq $locale } | Select-Object -First 1',
  'if (-not $recognizer) { $recognizer = $installed | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $locale.Substring(0, 2) } | Select-Object -First 1 }',
  'if (-not $recognizer) { throw "windows-speech-language-unavailable:$locale" }',
  '$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)',
  'try {',
  '  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
  '  $engine.SetInputToWaveFile($env:ZAALIS_STT_WAV)',
  '  $parts = New-Object System.Collections.Generic.List[string]',
  '  for ($i = 0; $i -lt 400; $i++) {',
  '    $phrase = $null',
  '    try { $phrase = $engine.Recognize() } catch { if ($i -eq 0) { throw } else { break } }',
  '    if (-not $phrase) { break }',
  '    $parts.Add($phrase.Text)',
  '  }',
  '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "  [Console]::Out.Write(($parts -join ' '))",
  '} finally { $engine.Dispose() }',
].join('\n');

function runWindows({ audio, lang, tempDir }) {
  return withTempWav(audio, tempDir, (wav) => new Promise((resolve, reject) => {
    const system = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    execFile(path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
      { timeout: WINDOWS_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, ZAALIS_STT_WAV: wav, ZAALIS_STT_LOCALE: LOCALES[lang] || `${lang}-${lang.toUpperCase()}` } },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout || ''));
        if (/windows-speech-language-unavailable/.test(String(stderr))) {
          return reject(sttError('windows-speech-language-unavailable', 'La reconnaissance vocale de cette langue n’est pas installée dans Windows (Paramètres › Heure et langue › Voix).', 409));
        }
        reject(sttError('stt-unavailable', 'La reconnaissance vocale de Windows a échoué.', 500));
      });
  }));
}

// Streams the model to `<file>.part`, checks it, then puts it in place: a
// partial or altered download can never be mistaken for the model.
async function downloadModel(model, dest, onProgress, fetchImpl) {
  const response = await fetchImpl(model.url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Téléchargement échoué (HTTP ${response.status})`);
  const total = Number(response.headers.get('content-length')) || model.bytes;
  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(part);
  const hash = crypto.createHash('sha256');
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress(received, total);
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  if (hash.digest('hex') !== model.sha256) {
    try { fs.unlinkSync(part); } catch {}
    throw new Error('Le modèle téléchargé ne correspond pas à son empreinte.');
  }
  fs.renameSync(part, dest);
}

// One dictation service for the application.
//   engineDirs : folders where whisper-cli may be (first match wins)
//   modelDir   : where the Whisper model lives, and where recordings are
//                written while they are transcribed
// The remaining options replace the real engines in tests.
function create(options = {}) {
  const platform = options.platform || process.platform;
  const model = options.model || WHISPER_MODEL;
  const modelDir = options.modelDir || os.tmpdir();
  const modelFile = path.join(modelDir, model.file);
  const whisper = options.runWhisper || runWhisper;
  const windows = options.runWindows || runWindows;
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const cliName = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  let pull = null;              // { status, completed, total, error, at }
  let queue = Promise.resolve(); // one transcription at a time: the engine uses every core it is given

  function whisperCli() {
    for (const dir of options.engineDirs || []) {
      const candidate = path.join(dir, cliName);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
    return '';
  }
  function modelReady() { try { return fs.statSync(modelFile).size === model.bytes; } catch { return false; } }
  const pulling = () => (pull && pull.status === 'downloading' ? { downloading: true, completed: pull.completed, total: pull.total } : null);

  // Starts the one-time model download when the engine is there and the model
  // is not. Safe to call on every request: a running download is left alone
  // and a failed one is only retried after a pause.
  function prepare() {
    if (!whisperCli() || modelReady()) return;
    if (pull && (pull.status === 'downloading' || (pull.status === 'error' && Date.now() - pull.at < PULL_RETRY_MS))) return;
    const task = { status: 'downloading', completed: 0, total: model.bytes, error: '', at: Date.now() };
    pull = task;
    task.done = downloadModel(model, modelFile, (completed, total) => { task.completed = completed; task.total = total; }, fetchImpl)
      .then(() => { task.status = 'success'; }, (error) => { task.status = 'error'; task.error = String((error && error.message) || error); })
      .finally(() => { task.at = Date.now(); });
  }

  // Engines usable right now, best first.
  function engines() {
    const list = [];
    if (whisperCli() && modelReady()) list.push('whisper');
    if (platform === 'win32') list.push('windows-speech');
    return list;
  }
  function status() {
    const list = engines();
    const downloading = pulling();
    return {
      stt: {
        ready: list.length > 0, engine: list[0] || 'none', engines: list,
        model: { file: model.file, bytes: model.bytes, installed: modelReady() }, pull: downloading,
        hint: list.length ? '' : downloading ? 'Le modèle vocal se télécharge, un instant…'
          : whisperCli() ? 'Le modèle vocal n’a pas pu être téléchargé. Vérifiez la connexion Internet.'
            : 'La reconnaissance vocale n’est pas disponible sur ce PC.',
      },
      tts: { ready: false, engine: 'none', voices: [] },
    };
  }

  // { text, engine } for one recording. `audio` is a PCM 16-bit WAV buffer.
  // Each engine is tried in turn; the last failure is reported when none works.
  async function transcribe({ audio, language: requested } = {}) {
    if (!Buffer.isBuffer(audio) || !audio.length) throw sttError('audio-required', 'audio requis', 400);
    if (audio.length > MAX_AUDIO_BYTES) throw sttError('audio-too-long', 'Enregistrement trop long.', 413);
    const wav = parseWav(audio);
    if (wav.seconds < 0.2 || peakLevel(audio, wav) < SILENCE_PEAK) return { text: '', engine: 'none', silent: true };
    prepare();
    const lang = language(requested);
    const list = engines();
    if (!list.length) {
      if (pulling()) throw sttError('model-downloading', status().stt.hint, 409);
      throw sttError('stt-unavailable', status().stt.hint, 409);
    }
    const run = async () => {
      let failure = null;
      for (const engine of list) {
        try {
          const text = engine === 'whisper' ? await whisper({ cli: whisperCli(), model: modelFile, audio, lang, tempDir: modelDir })
            : await windows({ audio, lang, tempDir: modelDir });
          const downloading = pulling();
          return { text: cleanTranscript(text), engine, ...(downloading ? { pull: downloading } : {}) };
        } catch (error) {
          failure = error;
        }
      }
      throw failure;
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  return { transcribe, status, prepare, engines, whenPrepared: () => (pull && pull.done) || Promise.resolve() };
}

module.exports = { create, parseWav, peakLevel, cleanTranscript, WHISPER_MODEL };
