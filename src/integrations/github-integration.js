'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function repository(url) {
  const match = String(url || '').trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}
function rootKey(root) {
  const resolved = fs.realpathSync(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
class GitHubIntegration {
  constructor({ loadUsers, saveUsers, encrypt, decrypt, fetchImpl = fetch, clientId = process.env.ZAALIS_GITHUB_CLIENT_ID || '', browserAuth = null }) {
    Object.assign(this, { loadUsers, saveUsers, encrypt, decrypt, fetch: fetchImpl, clientId, browserAuth });
    this.devices = new Map();
  }
  user(id) { const u = this.loadUsers().find(u => u.id === id); if (!u) throw Error('Compte introuvable.'); return u; }
  save(id, change) { const users = this.loadUsers(); const u = users.find(u => u.id === id); if (!u) throw Error('Compte introuvable.'); change(u); this.saveUsers(users); }
  async request(id, endpoint, method = 'GET', body, token) {
    const stored = !token;
    token ||= this.decrypt(this.user(id).github?.token || '');
    if (!token) throw Error('Connectez GitHub dans les intégrations.');
    const response = await this.fetch(`https://api.github.com${endpoint}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'zaalis-ide', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    // A revoked or expired authorization cannot recover: flag it so the
    // integration page asks for a reconnection instead of a vague failure.
    if (response.status === 401 && stored) {
      this.save(id, u => { if (u.github) u.github.reauth = true; });
      throw Object.assign(Error('Votre autorisation GitHub a expiré ou a été révoquée. Reconnectez le compte dans Intégrations → GitHub.'), { status: 401 });
    }
    if (response.status === 403 && response.headers?.get?.('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const at = Number.isFinite(reset) && reset > 0 ? new Date(reset).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
      throw Object.assign(Error(`Limite d’appels GitHub atteinte.${at ? ` Réessayez après ${at}.` : ' Réessayez plus tard.'}`), { status: 429 });
    }
    if (!response.ok) throw Error(`GitHub : accès refusé ou opération impossible (HTTP ${response.status}). Vérifiez les permissions, la protection de branche et les limites API.`);
    return response.status === 204 ? {} : response.json();
  }
  status(id) { const user = this.user(id), g = user.github; return { connected: !!g?.token, reauth: !!g?.reauth, login: g?.login || '', deviceAvailable: !!(this.browserAuth?.available || user.githubClientId || this.clientId), method: user.githubClientId || this.clientId ? 'oauth' : 'github-cli', permissions: g?.permissions || {} }; }
  configure(id, clientId) {
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9._-]{10,100}$/.test(clientId)) throw Error('Client ID GitHub invalide.');
    this.devices.delete(id);
    this.save(id, u => { u.githubClientId = clientId; });
    return this.status(id);
  }
  async connect(id, token, expectedDevice) {
    if (typeof token !== 'string' || token.length < 10 || token.length > 1000 || /\s/.test(token)) throw Error('Jeton GitHub invalide.');
    const account = await this.request(id, '/user', 'GET', undefined, token);
    if (expectedDevice && this.devices.get(id) !== expectedDevice) throw Error('Connexion annulée.');
    this.save(id, u => { u.github = { token: this.encrypt(token), login: account.login, permissions: u.github?.login === account.login ? u.github.permissions || {} : {} }; });
    return this.status(id);
  }
  disconnect(id) { this.cancel(id); this.save(id, u => { delete u.github; }); return this.status(id); }
  cancel(id) { this.devices.delete(id); this.browserAuth?.cancel(id); return { cancelled: true }; }
  async start(id) {
    const clientId = this.user(id).githubClientId || this.clientId;
    this.cancel(id);
    if (!clientId && this.browserAuth?.available) {
      const device = { kind: 'cli', expires: Date.now() + 900000 };
      this.devices.set(id, device);
      const result = await this.browserAuth.start(id);
      if (this.devices.get(id) !== device) throw Error('Connexion annulée.');
      return result;
    }
    if (!clientId) throw Error('La connexion navigateur nécessite ZAALIS_GITHUB_CLIENT_ID ou un Client ID public configuré et le device flow activé dans l’application GitHub.');
    const response = await this.fetch('https://github.com/login/device/code', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: clientId, scope: 'repo' }) });
    const d = await response.json();
    if (!response.ok || !d.device_code || typeof d.user_code !== 'string' || !Number.isFinite(d.expires_in) || d.expires_in <= 0 || d.verification_uri !== 'https://github.com/login/device') throw Error('Connexion GitHub indisponible.');
    this.devices.set(id, { clientId, code: d.device_code, expires: Date.now() + d.expires_in * 1000, interval: Math.max(5, d.interval || 5) * 1000, next: Date.now() });
    return { code: d.user_code, url: d.verification_uri, interval: Math.max(5, d.interval || 5), expiresIn: d.expires_in };
  }
  async poll(id) {
    const d = this.devices.get(id);
    if (!d || d.expires < Date.now()) { this.devices.delete(id); throw Error('Connexion expirée. Recommencez.'); }
    if (d.kind === 'cli') {
      const result = await this.browserAuth.poll(id);
      if (this.devices.get(id) !== d) throw Error('Connexion annulée.');
      if (result.pending) return result;
      const status = await this.connect(id, result.token, d); this.devices.delete(id); return status;
    }
    if (Date.now() < d.next) return { pending: true };
    d.next = Date.now() + d.interval;
    const response = await this.fetch('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: d.clientId || this.clientId, device_code: d.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
    const data = await response.json();
    if (this.devices.get(id) !== d) throw Error('Connexion annulée.');
    if (data.error === 'slow_down') { d.interval += 5000; d.next = Date.now() + d.interval; return { pending: true, interval: d.interval / 1000 }; }
    if (data.error === 'authorization_pending') return { pending: true, interval: d.interval / 1000 };
    if (!response.ok || !data.access_token) { this.devices.delete(id); throw Error('Autorisation GitHub refusée ou expirée.'); }
    const result = await this.connect(id, data.access_token, d); this.devices.delete(id); return result;
  }
  async repos(id) {
    const repositories = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request(id, `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      repositories.push(...batch.map(r => ({ id: r.id, name: r.full_name, private: r.private, branch: r.default_branch, canPush: !!r.permissions?.push })));
      if (batch.length < 100) return { repositories };
    }
    return { repositories, truncated: true };
  }
  async git(root, args, env = {}) {
    return (await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env } })).stdout.trim();
  }
  async verify(root, repo) {
    const key = rootKey(root);
    const top = rootKey(await this.git(root, ['rev-parse', '--show-toplevel']));
    if (key !== top) throw Error('Sélectionnez la racine exacte du dépôt Git.');
    const fetchUrl = await this.git(root, ['remote', 'get-url', 'origin']);
    const pushUrls = (await this.git(root, ['remote', 'get-url', '--push', '--all', 'origin'])).split(/\r?\n/);
    if (repository(fetchUrl) !== repo.toLowerCase() || pushUrls.some(url => repository(url) !== repo.toLowerCase())) throw Error('Le dépôt GitHub ne correspond pas au remote origin du projet. Aucune écriture effectuée.');
    const effective = await this.git(root, ['ls-remote', '--get-url', `https://github.com/${repo}.git`]);
    if (repository(effective) !== repo.toLowerCase() || !effective.startsWith('https://github.com/')) throw Error('Une règle Git réécrit la destination HTTPS. Vérification refusée.');
    return key;
  }
  async permission(id, { repo, mode, root }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !['none', 'read', 'write'].includes(mode)) throw Error('Permission invalide.');
    repo = repo.toLowerCase();
    const remote = await this.request(id, `/repos/${repo}`);
    let canonical = '';
    if (mode === 'write' && !remote.permissions?.push) throw Error('GitHub ne vous accorde pas l’écriture sur ce dépôt.');
    if (root) canonical = await this.verify(root, repo);
    if (mode === 'write' && !canonical) throw Error('Associez et vérifiez le dossier local avant d’autoriser l’écriture.');
    this.save(id, u => { u.github.permissions ||= {}; u.github.permissions[repo] = { mode, root: canonical, id: remote.id }; });
    return this.status(id);
  }
  async readOnly(id, root) {
    const permissions = this.user(id).github?.permissions || {};
    const key = rootKey(root);
    if (Object.values(permissions).some(p => p.mode === 'read' && p.root && (key === p.root || key.startsWith(p.root + path.sep)))) return true;
    let repo;
    try { repo = repository(await this.git(root, ['remote', 'get-url', 'origin'])); } catch { return false; }
    return permissions[repo]?.mode === 'read';
  }
  async action(id, root, input) {
    if (input.action === 'repos') {
      const result = await this.repos(id), permissions = this.user(id).github?.permissions || {};
      result.repositories = result.repositories.filter(r => ['read', 'write'].includes(permissions[r.name.toLowerCase()]?.mode)); return result;
    }
    const repo = String(input.repo || '').toLowerCase();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('Dépôt invalide.');
    const grant = this.user(id).github?.permissions?.[repo];
    if (!grant || !['read', 'write'].includes(grant.mode)) throw Error('Ce dépôt n’est pas autorisé dans les intégrations.');
    const remote = await this.request(id, `/repos/${repo}`);
    if (remote.id !== grant.id) throw Error('L’identité du dépôt a changé. Renouvelez son autorisation.');
    const base = `/repos/${repo}`;
    const branch = String(input.branch || remote.default_branch);
    if (!/^[\w./-]{1,200}$/.test(branch) || branch.includes('..') || branch.startsWith('-')) throw Error('Branche invalide.');
    if (input.action === 'files') return this.request(id, `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (input.action === 'read') {
      const file = String(input.path || '');
      if (!file || file.includes('..') || file.startsWith('/') || file.length > 1000) throw Error('Chemin invalide.');
      return this.request(id, `${base}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    }
    if (input.action === 'pulls') return this.request(id, `${base}/pulls?state=open&per_page=100`);
    if (grant.mode !== 'write') throw Error('Lecture seule : toute écriture GitHub est refusée, y compris en mode autonome.');
    if (await this.readOnly(id, root)) throw Error('Le projet actif est en lecture seule.');
    const key = await this.verify(root, repo);
    if (key !== grant.root) throw Error('Ce dossier n’est pas celui associé au dépôt. Aucune écriture effectuée.');
    // Compare committed file names against the remote tree, as well as Git identity.
    const tree = await this.request(id, `${base}/git/trees/${encodeURIComponent(remote.default_branch)}?recursive=1`);
    if (tree.truncated) throw Error('Arborescence distante incomplète : vérification refusée.');
    const local = (await this.git(root, ['ls-tree', '-r', '--name-only', 'HEAD'])).split(/\r?\n/);
    const paths = new Set(tree.tree.filter(x => x.type === 'blob').map(x => x.path));
    if (!local.some(f => paths.has(f))) throw Error('Aucun fichier commun avec le dépôt distant : vérification manuelle nécessaire.');
    const baseRef = await this.request(id, `${base}/git/ref/heads/${remote.default_branch.split('/').map(encodeURIComponent).join('/')}`);
    try { await this.git(root, ['merge-base', 'HEAD', baseRef.object.sha]); } catch { throw Error('Le projet local ne partage pas un historique vérifiable avec ce dépôt. Faites un fetch puis vérifiez le projet.'); }
    if (input.action === 'create_pull') {
      if (!input.title || !input.head) throw Error('Titre et branche source requis.');
      return this.request(id, `${base}/pulls`, 'POST', { title: String(input.title).slice(0, 250), body: String(input.body || '').slice(0, 60000), head: input.head, base: branch, draft: !!input.draft });
    }
    if (input.action === 'merge') {
      if (!Number.isSafeInteger(input.number) || input.number < 1 || !/^[a-f0-9]{40}$/.test(input.sha || '')) throw Error('Numéro de PR et SHA exact de sa branche requis.');
      return this.request(id, `${base}/pulls/${input.number}/merge`, 'PUT', { sha: input.sha, merge_method: 'merge' });
    }
    if (input.action !== 'push') throw Error('Action GitHub inconnue.');
    if (await this.git(root, ['status', '--porcelain'])) throw Error('Des changements locaux ne sont pas commités. Préparez un commit avant le push.');
    const ref = await this.request(id, `${base}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    try { await this.git(root, ['merge-base', '--is-ancestor', ref.object.sha, 'HEAD']); } catch { throw Error('La branche distante n’est pas un ancêtre du commit local. Faites un fetch et vérifiez l’historique ; aucun push forcé.'); }
    const token = this.decrypt(this.user(id).github.token);
    const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
    try {
      await this.git(root, ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'http.proxy=', 'push', `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`], {
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`
      });
    } catch { throw Error('Push refusé par GitHub ou Git : vérifiez l’historique, les permissions et la protection de branche.'); }
    return { summary: `Commit poussé vers ${repo} · ${branch}`, sha: await this.git(root, ['rev-parse', 'HEAD']) };
  }
}
module.exports = { GitHubIntegration, repository, rootKey };
