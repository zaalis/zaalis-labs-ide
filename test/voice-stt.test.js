'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const voiceStt = require('../voice-stt');

// A 16 kHz mono PCM WAV holding a tone of the given amplitude (0..1).
function wav(seconds, amplitude) {
  const rate = 16000;
  const frames = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0, 'ascii'); buffer.writeUInt32LE(36 + frames * 2, 4); buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii'); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii'); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(Math.round(Math.sin(i / 8) * amplitude * 32767), 44 + i * 2);
  return buffer;
}
const speech = wav(1, 0.5);

// A folder laid out like an installation: the engine in one place, the model
// (a small stand-in with its real checksum) downloadable into another.
function fixture(t, { engine = true, model = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-stt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engineDir = path.join(root, 'whisper');
  const modelDir = path.join(root, 'voice');
  fs.mkdirSync(engineDir);
  // Both names: the engine is `whisper-cli.exe` on Windows, `whisper-cli` elsewhere.
  if (engine) for (const name of ['whisper-cli.exe', 'whisper-cli']) fs.writeFileSync(path.join(engineDir, name), '');
  const content = Buffer.from('not a real model, only its stand-in');
  const spec = { file: 'ggml-test.bin', url: 'https://models.invalid/ggml-test.bin', sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: content.length };
  if (model) { fs.mkdirSync(modelDir); fs.writeFileSync(path.join(modelDir, spec.file), content); }
  return { engineDir, modelDir, spec, content };
}
// fetch stand-in serving `body` in two chunks, the second one when released.
function download(body) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const half = Math.ceil(body.length / 2);
    const chunks = [body.subarray(0, half), body.subarray(half)];
    let index = 0;
    return {
      ok: true, status: 200, headers: { get: () => String(body.length) },
      body: { getReader: () => ({ read: async () => { if (index === 1) await gate; return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; } }) },
    };
  };
  return { fetchImpl, calls, release };
}

test('a recording is measured, and anything that is not PCM WAV is refused', () => {
  const info = voiceStt.parseWav(speech);
  assert.deepEqual({ rate: info.sampleRate, channels: info.channels, bits: info.bits, seconds: info.seconds }, { rate: 16000, channels: 1, bits: 16, seconds: 1 });
  assert.ok(Math.abs(voiceStt.peakLevel(speech, info) - 0.5) < 0.01);
  assert.throws(() => voiceStt.parseWav(Buffer.from('not a wav file at all, just some text to fill the header')), /invalide/);
  assert.throws(() => voiceStt.parseWav(Buffer.alloc(10)), /invalide/);
});

test('what a model writes when nobody spoke is not a transcript', () => {
  assert.equal(voiceStt.cleanTranscript('  Bonjour,   peux-tu ouvrir le fichier ?\n'), 'Bonjour, peux-tu ouvrir le fichier ?');
  assert.equal(voiceStt.cleanTranscript(' ...'), '');
  assert.equal(voiceStt.cleanTranscript('(bruits d\'eau) (bruits d\'eau)'), '');
  assert.equal(voiceStt.cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(voiceStt.cleanTranscript('*musique*'), '');
  assert.equal(voiceStt.cleanTranscript('Sous-titres réalisés para la communauté d\'Amara.org'), '');
  assert.equal(voiceStt.cleanTranscript('Merci d\'avoir regardé cette vidéo !'), '');
  // Ordinary sentences that merely contain those words or a parenthesis stay.
  assert.equal(voiceStt.cleanTranscript('Ajoute [musique] un bouton (rouge) en bas.'), 'Ajoute un bouton (rouge) en bas.');
  assert.equal(voiceStt.cleanTranscript('Ajoute le sous-titrage de la vidéo.'), 'Ajoute le sous-titrage de la vidéo.');
});

test('whisper transcribes when the engine and its model are present', async (t) => {
  const { engineDir, modelDir, spec } = fixture(t, { model: true });
  const seen = [];
  const voice = voiceStt.create({
    engineDirs: [path.join(engineDir, 'missing'), engineDir], modelDir, model: spec, platform: 'win32',
    runWhisper: async (call) => { seen.push({ ...call, audio: call.audio.length }); return '  Ouvre le projet   dans Blender.\n'; },
    runWindows: async () => { throw new Error('must not run'); },
    fetchImpl: async () => { throw new Error('nothing to download'); },
  });
  assert.deepEqual(voice.status().stt, { ready: true, engine: 'whisper', engines: ['whisper', 'windows-speech'], model: { file: spec.file, bytes: spec.bytes, installed: true }, pull: null, hint: '' });
  assert.deepEqual(await voice.transcribe({ audio: speech, language: 'fr' }), { text: 'Ouvre le projet dans Blender.', engine: 'whisper' });
  assert.deepEqual(seen, [{ cli: path.join(engineDir, 'whisper-cli.exe'), model: path.join(modelDir, spec.file), audio: speech.length, lang: 'fr', tempDir: modelDir }]);
  // An unusable language code falls back to French rather than reaching the engine.
  await voice.transcribe({ audio: speech, language: '../x' });
  assert.equal(seen[1].lang, 'fr');
});

test('silence is never given to a speech engine', async (t) => {
  const { engineDir, modelDir, spec } = fixture(t, { model: true });
  const forbidden = async () => { throw new Error('must not run'); };
  const voice = voiceStt.create({ engineDirs: [engineDir], modelDir, model: spec, platform: 'win32', runWhisper: forbidden, runWindows: forbidden });
  assert.deepEqual(await voice.transcribe({ audio: wav(1, 0.001) }), { text: '', engine: 'none', silent: true });
  assert.deepEqual(await voice.transcribe({ audio: wav(0.05, 0.5) }), { text: '', engine: 'none', silent: true });
  await assert.rejects(voice.transcribe({ audio: Buffer.alloc(0) }), (error) => error.code === 'audio-required');
});

test('the model is downloaded once, checked, and Windows speech stands in meanwhile', async (t) => {
  const { engineDir, modelDir, spec, content } = fixture(t);
  const { fetchImpl, calls, release } = download(content);
  const engines = [];
  const voice = voiceStt.create({
    engineDirs: [engineDir], modelDir, model: spec, platform: 'win32', fetchImpl,
    runWhisper: async () => { engines.push('whisper'); return 'depuis whisper'; },
    runWindows: async ({ lang }) => { engines.push('windows'); return `depuis windows ${lang}`; },
  });
  assert.deepEqual(voice.status().stt.engines, ['windows-speech']);
  assert.equal(voice.status().stt.pull, null);

  const first = await voice.transcribe({ audio: speech, language: 'en' });
  assert.equal(first.text, 'depuis windows en');
  assert.equal(first.engine, 'windows-speech');
  assert.equal(first.pull.downloading, true);
  assert.equal(first.pull.total, content.length);
  voice.prepare(); voice.prepare();               // a running download is left alone
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(path.join(modelDir, spec.file)), false);

  release();
  await voice.whenPrepared();
  assert.deepEqual(fs.readFileSync(path.join(modelDir, spec.file)), content);
  assert.equal(fs.existsSync(path.join(modelDir, spec.file + '.part')), false);
  assert.deepEqual(voice.status().stt.engines, ['whisper', 'windows-speech']);
  assert.deepEqual(await voice.transcribe({ audio: speech }), { text: 'depuis whisper', engine: 'whisper' });
  assert.deepEqual(engines, ['windows', 'whisper']);
  assert.equal(calls.length, 1);
});

test('a download that does not match its checksum is thrown away', async (t) => {
  const { engineDir, modelDir, spec, content } = fixture(t);
  const tampered = Buffer.from(content); tampered[0] ^= 1;
  const { fetchImpl, calls, release } = download(tampered);
  const voice = voiceStt.create({ engineDirs: [engineDir], modelDir, model: spec, platform: 'linux', fetchImpl });
  voice.prepare();
  assert.equal(voice.status().stt.pull.downloading, true);
  await assert.rejects(voice.transcribe({ audio: speech }), (error) => error.code === 'model-downloading' && error.status === 409);
  release();
  await voice.whenPrepared();
  assert.deepEqual(fs.readdirSync(modelDir), []);
  const after = voice.status().stt;
  assert.deepEqual([after.ready, after.engine, after.pull, after.model.installed], [false, 'none', null, false]);
  assert.match(after.hint, /n’a pas pu être téléchargé/);
  // Not retried on every request: the failure is remembered for a while.
  voice.prepare();
  assert.equal(calls.length, 1);
  await assert.rejects(voice.transcribe({ audio: speech }), (error) => error.code === 'stt-unavailable');
});

test('Windows speech takes over when whisper fails, and the last failure is reported when nothing works', async (t) => {
  const { engineDir, modelDir, spec } = fixture(t, { model: true });
  const broken = async () => { throw Object.assign(new Error('moteur en panne'), { code: 'stt-unavailable' }); };
  const fallback = voiceStt.create({ engineDirs: [engineDir], modelDir, model: spec, platform: 'win32', runWhisper: broken, runWindows: async () => 'repli windows' });
  assert.deepEqual(await fallback.transcribe({ audio: speech }), { text: 'repli windows', engine: 'windows-speech' });

  const nothing = voiceStt.create({ engineDirs: [engineDir], modelDir, model: spec, platform: 'linux', runWhisper: broken });
  await assert.rejects(nothing.transcribe({ audio: speech }), /moteur en panne/);

  // No engine shipped and not on Windows: said plainly, nothing is downloaded.
  const absent = fixture(t, { engine: false });
  const none = voiceStt.create({ engineDirs: [absent.engineDir], modelDir: absent.modelDir, model: absent.spec, platform: 'linux', fetchImpl: async () => { throw new Error('must not download'); } });
  none.prepare();
  assert.deepEqual([none.status().stt.ready, none.status().stt.pull], [false, null]);
  await assert.rejects(none.transcribe({ audio: speech }), (error) => error.code === 'stt-unavailable' && error.status === 409);
});

test('the shipped engine and model description are consistent', { skip: process.platform !== 'win32' }, () => {
  const dir = path.resolve(__dirname, '..', 'native', 'whisper');
  for (const file of ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-x64.dll', 'vcomp140.dll', 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE']) {
    assert.ok(fs.statSync(path.join(dir, file)).size > 0, file);
  }
  assert.match(voiceStt.WHISPER_MODEL.url, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-[a-z0-9_.-]+\.bin$/);
  assert.match(voiceStt.WHISPER_MODEL.sha256, /^[0-9a-f]{64}$/);
  assert.ok(voiceStt.WHISPER_MODEL.url.endsWith('/' + voiceStt.WHISPER_MODEL.file));
});
