'use strict';

// Speech-to-text for the dictation button of the chat and for the integrated
// browser's voice search. The client records the microphone and posts a WAV;
// this module turns it into text with the first engine that works:
//
//   1. a cloud transcription model, when the user has stored a key for a
//      provider that offers one (the same providers the chat already talks to);
//   2. Windows' own speech recognizer, offline, as the fallback.
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
// models invent a sentence when handed silence, so it is never sent to one.
const SILENCE_PEAK = 0.005;
const CLOUD_TIMEOUT_MS = 60_000;
const WINDOWS_TIMEOUT_MS = 120_000;

const CLOUD_ENGINES = [
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1/audio/transcriptions', models: ['gpt-4o-mini-transcribe', 'whisper-1'] },
  { id: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1/audio/transcriptions', models: ['voxtral-mini-latest'] },
];
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

// Engines usable for these keys on this system, best first.
function engines({ keys, platform } = {}) {
  const list = CLOUD_ENGINES.filter((engine) => keys && keys[engine.id]).map((engine) => engine.id);
  if ((platform || process.platform) === 'win32') list.push('windows-speech');
  return list;
}
function status(options) {
  const list = engines(options);
  return {
    stt: {
      ready: list.length > 0, engine: list[0] || 'none', engines: list, pull: null,
      hint: list.length ? '' : 'La transcription vocale demande une clé API OpenAI ou Mistral (Réglages › Clés API).',
    },
    tts: { ready: false, engine: 'none', voices: [] },
  };
}

async function transcribeCloud(engine, key, audio, lang, fetchImpl) {
  let failure = null;
  for (const model of engine.models) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'dictation.wav');
    form.append('model', model);
    form.append('language', lang);
    let response;
    try {
      response = await fetchImpl(engine.url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) });
    } catch (error) {
      throw sttError('stt-network', `${engine.label} est injoignable.`, 502);
    }
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    if (response.ok && data && typeof data.text === 'string') return data.text;
    const detail = String((data && ((data.error && data.error.message) || data.message || data.detail)) || `HTTP ${response.status}`).slice(0, 200);
    failure = sttError('stt-provider', `${engine.label} : ${detail}`, 502);
    // An unknown model is worth a second try with the next one; a refused key,
    // an empty credit or a rate limit is the same for every model.
    if (![400, 404].includes(response.status)) break;
  }
  throw failure || sttError('stt-provider', `${engine.label} : aucune réponse.`, 502);
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

function transcribeWindows(audio, lang, tempDir) {
  const wav = path.join(tempDir || os.tmpdir(), `zaalis-stt-${process.pid}-${crypto.randomBytes(6).toString('hex')}.wav`);
  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(path.dirname(wav), { recursive: true }); fs.writeFileSync(wav, audio); } catch (error) { return reject(sttError('stt-unavailable', 'Impossible d’écrire l’enregistrement temporaire.')); }
    const system = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    execFile(path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
      { timeout: WINDOWS_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, ZAALIS_STT_WAV: wav, ZAALIS_STT_LOCALE: LOCALES[lang] || `${lang}-${lang.toUpperCase()}` } },
      (error, stdout, stderr) => {
        try { fs.unlinkSync(wav); } catch {}
        if (!error) return resolve(String(stdout || ''));
        if (/windows-speech-language-unavailable/.test(String(stderr))) {
          return reject(sttError('windows-speech-language-unavailable', 'La reconnaissance vocale de cette langue n’est pas installée dans Windows (Paramètres › Heure et langue › Voix).', 409));
        }
        reject(sttError('stt-unavailable', 'La reconnaissance vocale de Windows a échoué.', 500));
      });
  });
}

// { text, engine } for one recording. `audio` is a PCM 16-bit WAV buffer.
// Each engine is tried in turn; the last failure is reported when none works.
async function transcribe({ audio, language: requested, keys, tempDir, platform, fetchImpl, windows } = {}) {
  if (!Buffer.isBuffer(audio) || !audio.length) throw sttError('audio-required', 'audio requis', 400);
  if (audio.length > MAX_AUDIO_BYTES) throw sttError('audio-too-long', 'Enregistrement trop long.', 413);
  const wav = parseWav(audio);
  if (wav.seconds < 0.2 || peakLevel(audio, wav) < SILENCE_PEAK) return { text: '', engine: 'none', silent: true };
  const lang = language(requested);
  const list = engines({ keys, platform });
  if (!list.length) throw sttError('stt-unavailable', status({ keys, platform }).stt.hint, 409);
  let failure = null;
  for (const id of list) {
    try {
      const cloud = CLOUD_ENGINES.find((engine) => engine.id === id);
      const text = cloud ? await transcribeCloud(cloud, keys[id], audio, lang, fetchImpl || fetch)
        : await (windows || transcribeWindows)(audio, lang, tempDir);
      return { text: String(text || '').replace(/\s+/g, ' ').trim(), engine: id };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

module.exports = { transcribe, status, engines, parseWav, peakLevel, CLOUD_ENGINES };
