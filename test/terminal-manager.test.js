'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const { TerminalManager, TERMINAL_PROFILE_IDS, DEFAULT_TERMINAL_PROFILE } = require('../src/runtime/terminal-manager');

// Le terminal intégré s'appuie sur node-pty, un module natif que le paquet
// installe à côté du binaire plutôt que dans l'instantané pkg. Une machine sans
// ce module doit voir le test ignoré, pas échouer : c'est exactement la
// dégradation que TerminalManager applique au produit.
function ptyAvailable() {
  // Charger le module suffit : tuer un ConPTY aussitôt créé fait échouer
  // l'agent de node-pty sous Windows (« AttachConsole failed » sur stderr).
  try { require('node-pty'); return true; }
  catch { return false; }
}

test('les profils annoncés correspondent à la plateforme', () => {
  const expected = process.platform === 'win32'
    ? ['cmd', 'powershell', 'pwsh', 'git-bash']
    : process.platform === 'darwin'
      ? ['zsh', 'bash', 'fish', 'sh', 'login-shell']
      : ['bash', 'zsh', 'fish', 'sh', 'login-shell'];
  assert.deepEqual(TERMINAL_PROFILE_IDS, expected);
  assert.equal(DEFAULT_TERMINAL_PROFILE, expected[0]);
  assert.deepEqual(new TerminalManager().profiles().map((p) => p.id), expected);
});

test('un profil inconnu retombe sur un shell réellement disponible', () => {
  const profile = new TerminalManager().profile('profil-inexistant');
  assert.ok(profile, 'un profil de repli doit toujours être renvoyé');
  assert.ok(TERMINAL_PROFILE_IDS.includes(profile.id));
  assert.equal(typeof profile.shell, 'string');
});

test('fermer un terminal déjà sorti libère le PTY une seule fois', () => {
  const manager = new TerminalManager();
  let kills = 0;
  const session = { id: 'ended', closed: true, proc: { kill() { kills++; } } };
  manager.sessions.set(session.id, session);
  manager.close(session); manager.close(session);
  assert.equal(kills, 1);
  assert.equal(manager.sessions.has(session.id), false);
});

test('le marqueur renvoyé en écho ne termine pas une commande avant son résultat', async () => {
  const manager = new TerminalManager();
  const session = { buffer: '', closed: false, ready: Promise.resolve(), events: new EventEmitter() };
  session.proc = { write(input) {
    const marker = input.match(/__ZAALIS_DONE_[a-f0-9]+/)[0];
    queueMicrotask(() => {
      session.buffer += input; session.events.emit('data', input);
      setImmediate(() => {
        const result = `\r\nRésultat complet\r\n${marker}:7\r\n`;
        session.buffer += result; session.events.emit('data', result);
      });
    });
  } };
  manager.latest = () => session;
  const result = await manager.runCommand({ userId: 'marker', cwd: process.cwd(), command: 'echo test', waitMs: 1000 });
  assert.equal(result.exitCode, 7); assert.equal(result.timedOut, false);
  assert.match(result.output, /Résultat complet/);
});

test('le PTY persistant exécute une commande et rend son code de sortie', { skip: !ptyAvailable() && 'node-pty indisponible' }, async () => {
  const manager = new TerminalManager();
  const command = process.platform === 'win32' ? 'echo terminal-ok' : 'printf terminal-ok';
  const result = await manager.runCommand({ userId: 'test-user', cwd: process.cwd(), command, waitMs: 15000 });
  try {
    assert.match(result.output, /terminal-ok/);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.session.profile.id, DEFAULT_TERMINAL_PROFILE);
    assert.equal(result.session.origin, 'agent');
  } finally {
    if (!result.session.closed) {
      const exited = new Promise(resolve => result.session.events.once('exit', resolve));
      manager.write(result.session, 'exit\r');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
    }
    manager.close(result.session);
  }
});

test('la fermeture ConPTY arrête aussi un processus enfant attaché', {
  skip: (process.platform !== 'win32' || !ptyAvailable()) && 'ConPTY Windows indisponible',
  timeout: 15000,
}, async () => {
  const manager = new TerminalManager();
  const script = 'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); console.log("PTY_CHILD:"+child.pid); setInterval(()=>{},1000)';
  const session = manager.createExternal({ userId: 'child-cleanup', cwd: process.cwd(),
    shell: process.execPath, args: ['-e', script], label: 'node', origin: 'agent' });
  let childPid;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.events.removeListener('data', inspect); reject(new Error('PID enfant absent')); }, 5000);
      function inspect() {
        const match = session.buffer.match(/PTY_CHILD:(\d+)/);
        if (match) { childPid = Number(match[1]); clearTimeout(timer); session.events.removeListener('data', inspect); resolve(); }
      }
      session.events.on('data', inspect); inspect();
    });
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    assert.equal(alive(childPid), true);
    const exited = once(session.events, 'exit');
    manager.close(session);
    let exitTimer;
    try { await Promise.race([exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('Le PTY ne s’est pas fermé')), 5000); })]); }
    finally { clearTimeout(exitTimer); }
    const deadline = Date.now() + 3000;
    while (alive(childPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(alive(childPid), false, 'le descendant attaché doit quitter avec le pseudo-console');
  } finally {
    manager.close(session);
    // Failure cleanup is limited to the exact child created by this fixture.
    if (childPid) { try { process.kill(childPid); } catch {} }
  }
});
