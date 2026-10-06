'use strict';

// Real browser UI with disposable projects/account and a controlled microphone.
// Set ZAALIS_PLAYWRIGHT_PATH to use an already installed Playwright package.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.ZAALIS_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-navigation-voice-'));
const projects = ['Projet A', 'Projet B'].map(name => {
    const folder = path.join(temp, name);
    fs.mkdirSync(folder);
    return folder;
});
const port = 35700 + Math.floor(Math.random() * 700);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ZAALIS_PORT: String(port), ZAALIS_DATA_DIR: path.join(temp, 'data'), ZAALIS_RUST_CORE: 'off' } });
let browser;
let releaseTranscription;

async function main() {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (server.exitCode !== null) throw new Error('Isolated server exited');
        try { if ((await fetch(base)).ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const registration = await context.request.post(base + '/api/auth/register', {
        data: { email: 'navigation-voice@zaalis.local', password: 'password123' } });
    assert.equal(registration.status(), 200);
    assert.equal((await context.request.put(base + '/api/recent-projects', { data: { projects } })).status(), 200);
    assert.equal((await context.request.put(base + '/api/chats', { data: { kind: 'chat', conversations: projects.flatMap((projectPath, index) =>
        [1, 2].map(number => ({ id: `fixture-${index}-${number}`, title: `Chat ${index + 1}.${number}`, projectPath,
            project: `Projet ${index ? 'B' : 'A'}`, messages: [], date: new Date().toISOString() }))) } })).status(), 200);
    await context.addInitScript(({ projects }) => {
        localStorage.setItem('zaalis-recent', JSON.stringify(projects));
        if (!localStorage.getItem('zaalis-workspace')) localStorage.setItem('zaalis-workspace', JSON.stringify({ mode: 'chat', sidebarView: { chat: 'chats', editor: 'files' } }));
        window.__recorders = [];
        window.__tracks = [];
        Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => {
            const track = { stopped: false, stop() { this.stopped = true; } };
            window.__tracks.push(track);
            return { getTracks: () => [track] };
        } }, configurable: true });
        window.MediaRecorder = class extends EventTarget {
            constructor() { super(); this.state = 'inactive'; this.mimeType = 'audio/webm'; window.__recorders.push(this); }
            start() { this.state = 'recording'; }
            stop() { this.state = 'inactive'; }
            finish() {
                const event = new Event('dataavailable');
                event.data = new Blob(['controlled audio']);
                this.dispatchEvent(event);
                this.dispatchEvent(new Event('stop'));
            }
        };
    }, { projects });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/voice-status', route => route.fulfill({ json: { available: true } }));
    let slowTranscription = false;
    let transcriptionStarted;
    let announceTranscription;
    await page.route('**/api/stt', async route => {
        if (slowTranscription) await new Promise(resolve => { releaseTranscription = resolve; announceTranscription(); });
        await route.fulfill({ json: { text: 'Texte dicté' } }).catch(() => {});
    });
    await page.goto(base);
    await page.locator('#custom-select-ai-submodel').waitFor();
    const projectA = page.locator('.ws-project-toggle').filter({ hasText: 'Projet A' });
    await projectA.waitFor();
    await page.locator('.ws-conversation').filter({ hasText: 'Chat 1.1' }).waitFor();
    assert.equal(await projectA.locator('.ws-project-count').textContent(), '2');
    await projectA.click();
    assert.equal(await projectA.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.ws-conversation').filter({ hasText: 'Chat 1.1' }).isVisible(), false);
    await page.reload();
    await page.locator('#custom-select-ai-submodel').waitFor();
    await projectA.waitFor();
    assert.equal(await projectA.getAttribute('aria-expanded'), 'false', 'folded project persists after reload');
    await projectA.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await projectA.getAttribute('aria-expanded'), 'true');
    await page.waitForFunction(key => document.activeElement.dataset.focusKey === key,
        await projectA.getAttribute('data-focus-key'));
    await page.getByRole('button', { name: 'Replier tous les projets', exact: true }).click();
    assert.ok((await page.locator('.ws-project-toggle').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-expanded')))).every(value => value === 'false'));
    await page.getByRole('button', { name: 'Déplier tous les projets', exact: true }).click();
    await page.evaluate(() => { agentTaskRunning = true; state.currentConvId = 'fixture-0-1'; });
    await page.locator('.ws-conversation').filter({ hasText: 'Chat 2.1' }).click();
    assert.equal(await page.evaluate(() => state.currentConvId), 'fixture-0-1', 'agents task blocks switching conversation');
    await page.evaluate(() => { agentTaskRunning = false; });
    const missingProject = path.join(temp, 'Projet absent');
    await page.evaluate(missing => {
        localStorage.setItem('zaalis-recent', JSON.stringify([...getRecentProjects(), missing]));
        window.ZaalisWorkspace.refresh();
    }, missingProject);
    const missingGroup = page.locator('.ws-project-group').filter({ has: page.locator('.ws-project-toggle').filter({ hasText: 'Projet absent' }) });
    await missingGroup.getByRole('button', { name: 'Nouveau chat dans ce projet', exact: true }).click();
    await page.locator('#project-path-moved-modal.active').waitFor();
    assert.equal(await page.evaluate(() => state.currentConvId), 'fixture-0-1', 'missing project does not create a chat in the previous folder');
    await page.evaluate(missing => {
        closeMovedProjectPathModal();
        localStorage.setItem('zaalis-recent', JSON.stringify(getRecentProjects().filter(project => project !== missing)));
        window.ZaalisWorkspace.refresh();
    }, missingProject);
    await page.evaluate(() => {
        window.dictationWav = async blob => blob;
        window.dictationBase64 = async () => 'controlled-audio';
        window.__voiceSent = 0;
        window.handleChatSubmit = () => { window.__voiceSent++; };
    });
    const capture = page.locator('#chat-input').locator('..').locator('.voice-capture');
    await page.locator('#chat-input').fill('Brouillon');
    await page.locator('#chat-voice-btn').click();
    await capture.locator('.voice-capture-stop').waitFor({ state: 'visible' });
    await capture.locator('.voice-capture-cancel').click();
    await page.locator('#chat-voice-btn').click();
    await page.waitForFunction(() => window.__recorders.length === 2);
    await page.evaluate(() => window.__recorders[0].finish());
    assert.equal(await page.evaluate(() => window.__tracks[1].stopped), false, 'old stop event cannot stop the new microphone');
    assert.equal(await capture.locator('.voice-capture-stop').isEnabled(), true);
    await capture.locator('.voice-capture-stop').click();
    await page.evaluate(() => window.__recorders[1].finish());
    await page.waitForFunction(() => document.getElementById('chat-input').value === 'Brouillon Texte dicté');
    assert.equal(await page.evaluate(() => window.__voiceSent), 0, 'square inserts without sending');
    await page.locator('#chat-voice-btn').click();
    await capture.locator('.voice-capture-send').click();
    await page.evaluate(() => window.__recorders[2].finish());
    await page.waitForFunction(() => window.__voiceSent === 1);
    await page.locator('#chat-input').fill('Conserver');
    slowTranscription = true;
    transcriptionStarted = new Promise(resolve => { announceTranscription = resolve; });
    await page.locator('#chat-voice-btn').click();
    await capture.locator('.voice-capture-stop').click();
    await page.evaluate(() => window.__recorders[3].finish());
    await transcriptionStarted;
    await page.evaluate(() => window.dispatchEvent(new Event('zaalis-conversation-change')));
    releaseTranscription();
    await page.waitForFunction(() => document.querySelector('#chat-input').closest('.chat-input-area').classList.contains('voice-capture-active') === false);
    assert.equal(await page.locator('#chat-input').inputValue(), 'Conserver', 'switching context cancels pending transcription');
    await page.setViewportSize({ width: 800, height: 900 });
    await page.locator('.ws-mobile-menu').click();
    await projectA.click();
    assert.equal(await projectA.getAttribute('aria-expanded'), 'false');
    assert.equal(await projectA.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'project heading fits the narrow sidebar');
    await page.locator('.ws-mobile-menu').click();
    await page.setViewportSize({ width: 1440, height: 960 });
    // The same memory view is reachable in both workspace layouts.
    await page.evaluate(project => { state.projectRoot = project; }, projects[0]);
    await page.getByRole('button', { name: 'Mémoire des corrections', exact: true }).click();
    const memory = page.locator('.correction-memory-dialog');
    await memory.getByText('0 fiche(s)', { exact: false }).waitFor();
    await memory.getByRole('button', { name: 'Ajouter une note' }).click();
    await memory.getByRole('textbox', { name: 'Problème', exact: true }).fill('Browser memory regression');
    await memory.getByRole('textbox', { name: 'Cause ou solution' }).fill('Persisted correction');
    await memory.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await memory.locator('summary').filter({hasText:'Browser memory regression'}).waitFor();
    await memory.locator('summary').filter({hasText:'Browser memory regression'}).click();
    await memory.getByRole('textbox', {name:'Modifier la fiche'}).fill('Updated correction');
    await memory.getByRole('button', {name:'Enregistrer',exact:true}).click();
    await memory.getByRole('button', {name:'Fermer',exact:true}).click();
    await page.getByRole('button', {name:'Éditeur',exact:true}).click();
    await page.getByRole('button', { name: 'Mémoire des corrections', exact: true }).click();
    await memory.locator('summary').filter({hasText:'Browser memory regression'}).click();
    await memory.getByText('Updated correction',{exact:true}).waitFor();
    await memory.getByRole('button',{name:'Supprimer',exact:true}).click();
    await memory.getByText('0 fiche(s)',{exact:false}).waitFor();
    await memory.getByRole('button',{name:'Fermer',exact:true}).click();
    assert.deepEqual(errors, []);
    if (process.env.ZAALIS_UI_SCREENSHOT) await page.screenshot({ path: process.env.ZAALIS_UI_SCREENSHOT });
    console.log('Browser UI OK: project fold/unfold, counts, persistence, keyboard, fold all, narrow sidebar, agents navigation guard, missing project; voice cancel/restart, square, arrow, pending transcription cancellation.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    releaseTranscription?.();
    await browser?.close();
    if (server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(temp).startsWith('zaalis-navigation-voice-'));
    fs.rmSync(temp, { recursive: true, force: true });
});
