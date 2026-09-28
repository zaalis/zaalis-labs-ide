'use strict';

// Le masquage Node doit rester d'accord avec `rust/crates/zaalis-secrets` :
// deux implementations pour un seul contrat, donc les memes cas des deux cotes.

const test = require('node:test');
const assert = require('node:assert');
const { sanitize, detectsSecret, registerSecret, clearRegisteredSecrets } = require('../secrets-mask');

test('une sortie ordinaire traverse sans modification', () => {
  const text = 'Compiling zaalis-core v1.0.15\n    Finished in 4.21s\n';
  assert.strictEqual(sanitize(text), text);
  assert.strictEqual(detectsSecret(text), false);
});

test('les jetons a prefixe fournisseur sont masques', () => {
  const tokens = [
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    'AIzaEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
    'AKIAIOSFODNN7EXAMPLE',
    'hf_FFFFFFFFFFFFFFFFFFFFFFFFF',
  ];
  for (const token of tokens) {
    const masked = sanitize(`echo ${token}`);
    assert.ok(!masked.includes(token), `« ${token} » doit etre masque, obtenu : ${masked}`);
  }
});

test('un prefixe seul cite dans une doc n\'est pas un secret', () => {
  for (const text of ['les cles commencent par sk-', 'use a ghp_ token', 'task-runner started']) {
    assert.strictEqual(sanitize(text), text, `« ${text} » ne doit pas etre masque`);
  }
});

test('un dump d\'environnement masque les valeurs sensibles et garde le reste', () => {
  const text = 'PATH=/usr/bin\nOPENAI_API_KEY=zzzzzzzzzzzzzzzzzzzz\nDB_PASSWORD=hunter2hunter2\nHOME=/home/dev\n';
  const masked = sanitize(text);
  assert.ok(!masked.includes('zzzzzzzzzzzzzzzzzzzz'));
  assert.ok(!masked.includes('hunter2hunter2'));
  assert.ok(masked.includes('PATH=/usr/bin'));
  assert.ok(masked.includes('HOME=/home/dev'));
});

test('un nom qui mentionne un secret sans le porter n\'est pas masque', () => {
  const text = 'SECRET_PATH=/etc/zaalis/keys\nMAX_TOKENS=4096\nAUTH_URL=https://example.test/oauth\n';
  assert.strictEqual(sanitize(text), text);
});

test('un bloc de cle privee est masque en entier', () => {
  const text = 'avant\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----\napres\n';
  const masked = sanitize(text);
  assert.ok(masked.includes('[cle privee masquee]') || masked.includes('[clé privée masquée]'));
  assert.ok(!masked.includes('MIIEpAIBAAKCAQEA1234'));
  assert.ok(masked.includes('avant') && masked.includes('apres'));
});

test('une cle enregistree est masquee partout ou elle apparait', () => {
  clearRegisteredSecrets();
  registerSecret('cle de test', 'ZZZZZZZZZZZZZZZZZZZZZZZZ');
  const masked = sanitize('curl -H "x: ZZZZZZZZZZZZZZZZZZZZZZZZ" https://api.example');
  assert.ok(!masked.includes('ZZZZZZZZZZZZZZZZZZZZZZZZ'));
  clearRegisteredSecrets();
  assert.ok(sanitize('valeur ZZZZZZZZZZZZZZZZZZZZZZZZ').includes('ZZZZZZZZZZZZZZZZZZZZZZZZ'));
});

test('une valeur trop courte n\'est jamais enregistree', () => {
  clearRegisteredSecrets();
  registerSecret('trop court', 'dev');
  assert.strictEqual(sanitize('dev server started'), 'dev server started');
});

test('un en-tete Authorization garde son schema et perd son jeton', () => {
  const masked = sanitize('Authorization: Bearer abcdefghijklmnop\n');
  assert.ok(masked.includes('Bearer'));
  assert.ok(!masked.includes('abcdefghijklmnop'));
});

test('un texte non ASCII n\'est pas corrompu', () => {
  const masked = sanitize('compilation terminée — 4 crates à jour, clé ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
  assert.ok(masked.includes('compilation terminée — 4 crates à jour'));
  assert.ok(!masked.includes('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
});
