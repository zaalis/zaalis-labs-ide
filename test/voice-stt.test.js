'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

// A stand-in for fetch that answers each call from a script and records it.
function scripted(replies) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const reply = replies[calls.length];
    calls.push({ url, authorization: options.headers.Authorization, model: options.body.get('model'), language: options.body.get('language'), file: options.body.get('file') });
    if (reply instanceof Error) throw reply;
    return { ok: reply.status === 200, status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  return { calls, fetchImpl };
}

test('a recording is measured, and anything that is not PCM WAV is refused', () => {
  const info = voiceStt.parseWav(speech);
  assert.deepEqual({ rate: info.sampleRate, channels: info.channels, bits: info.bits, seconds: info.seconds }, { rate: 16000, channels: 1, bits: 16, seconds: 1 });
  assert.ok(Math.abs(voiceStt.peakLevel(speech, info) - 0.5) < 0.01);
  assert.throws(() => voiceStt.parseWav(Buffer.from('not a wav file at all, just some text to fill the header')), /invalide/);
  assert.throws(() => voiceStt.parseWav(Buffer.alloc(10)), /invalide/);
});

test('the engines follow the keys the user stored, Windows speech last', () => {
  assert.deepEqual(voiceStt.engines({ keys: { mistral: 'm', openai: 'o', google: 'g' }, platform: 'win32' }), ['openai', 'mistral', 'windows-speech']);
  assert.deepEqual(voiceStt.engines({ keys: {}, platform: 'win32' }), ['windows-speech']);
  assert.deepEqual(voiceStt.engines({ keys: { mistral: 'm' }, platform: 'linux' }), ['mistral']);
  const none = voiceStt.status({ keys: {}, platform: 'linux' });
  assert.equal(none.stt.ready, false);
  assert.match(none.stt.hint, /clé API/);
  assert.deepEqual(voiceStt.status({ keys: { openai: 'o' }, platform: 'linux' }).stt, { ready: true, engine: 'openai', engines: ['openai'], pull: null, hint: '' });
});

test('silence is never sent to a speech model', async () => {
  const { calls, fetchImpl } = scripted([]);
  const windows = async () => { throw new Error('must not run'); };
  assert.deepEqual(await voiceStt.transcribe({ audio: wav(1, 0.001), keys: { openai: 'o' }, platform: 'win32', fetchImpl, windows }), { text: '', engine: 'none', silent: true });
  assert.deepEqual(await voiceStt.transcribe({ audio: wav(0.05, 0.5), keys: { openai: 'o' }, platform: 'win32', fetchImpl, windows }), { text: '', engine: 'none', silent: true });
  assert.equal(calls.length, 0);
});

test('the cloud engine posts the recording and returns its text', async () => {
  const { calls, fetchImpl } = scripted([{ status: 200, body: { text: '  Bonjour   le monde. ' } }]);
  const result = await voiceStt.transcribe({ audio: speech, language: 'fr', keys: { openai: 'sk-test' }, platform: 'linux', fetchImpl });
  assert.deepEqual(result, { text: 'Bonjour le monde.', engine: 'openai' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(calls[0].authorization, 'Bearer sk-test');
  assert.equal(calls[0].model, 'gpt-4o-mini-transcribe');
  assert.equal(calls[0].language, 'fr');
  assert.equal(calls[0].file.size, speech.length);
  assert.equal(calls[0].file.type, 'audio/wav');
});

test('an unknown model is retried with the next one, a refused key moves to the next engine', async () => {
  const retried = scripted([{ status: 404, body: { error: { message: 'model not found' } } }, { status: 200, body: { text: 'ok' } }]);
  assert.deepEqual(await voiceStt.transcribe({ audio: speech, keys: { openai: 'o' }, platform: 'linux', fetchImpl: retried.fetchImpl }), { text: 'ok', engine: 'openai' });
  assert.deepEqual(retried.calls.map((call) => call.model), ['gpt-4o-mini-transcribe', 'whisper-1']);

  const refused = scripted([{ status: 401, body: { error: { message: 'bad key' } } }, { status: 200, body: { text: 'depuis mistral' } }]);
  assert.deepEqual(await voiceStt.transcribe({ audio: speech, language: 'en', keys: { openai: 'o', mistral: 'm' }, platform: 'linux', fetchImpl: refused.fetchImpl }), { text: 'depuis mistral', engine: 'mistral' });
  assert.deepEqual(refused.calls.map((call) => [call.url, call.model, call.language]), [
    ['https://api.openai.com/v1/audio/transcriptions', 'gpt-4o-mini-transcribe', 'en'],
    ['https://api.mistral.ai/v1/audio/transcriptions', 'voxtral-mini-latest', 'en'],
  ]);
});

test('Windows speech takes over when the cloud fails, and the last failure is reported when nothing works', async () => {
  const offline = scripted([new Error('network down')]);
  const result = await voiceStt.transcribe({ audio: speech, keys: { openai: 'o' }, platform: 'win32', fetchImpl: offline.fetchImpl, windows: async (audio, lang) => `dictée ${lang} ${audio.length}` });
  assert.deepEqual(result, { text: `dictée fr ${speech.length}`, engine: 'windows-speech' });

  const broken = scripted([{ status: 429, body: { error: { message: 'quota exceeded' } } }]);
  await assert.rejects(voiceStt.transcribe({ audio: speech, keys: { openai: 'o' }, platform: 'linux', fetchImpl: broken.fetchImpl }), (error) => error.code === 'stt-provider' && /quota exceeded/.test(error.message));
  assert.equal(broken.calls.length, 1);
  await assert.rejects(voiceStt.transcribe({ audio: speech, keys: {}, platform: 'linux' }), (error) => error.code === 'stt-unavailable' && error.status === 409);
  await assert.rejects(voiceStt.transcribe({ audio: Buffer.alloc(0), keys: {} }), (error) => error.code === 'audio-required');
});
