'use strict';
// Google sign-in and the Google services a Glyph uses (Gmail, Agenda, Tasks,
// Docs for notes). Each user's refresh token is sealed in google_tokens; an
// access token is minted on demand. Nothing here ever asks for the full
// https://mail.google.com/ scope, so a Glyph cannot permanently delete a mail:
// the most it can do is move it to the bin.
const db = require('./db');
const secrets = require('./secrets');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BASE_SCOPES = ['openid', 'email', 'profile'];
// Plugins shown behind the "multiprise" button. Maps needs no scope: routes
// open in Google Maps through public links.
const PLUGINS = {
  gmail:    { label: 'Gmail', scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  calendar: { label: 'Google Agenda', scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'] },
  tasks:    { label: 'Google Tasks', scopes: ['https://www.googleapis.com/auth/tasks'] },
  notes:    { label: 'Notes (Google Docs)', scopes: ['https://www.googleapis.com/auth/drive.file'] },
  maps:     { label: 'Google Maps', scopes: [] },
  web:      { label: 'Recherche web', scopes: [] },
};

function config() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw Object.assign(new Error('Connexion Google non configurée sur le serveur.'), { status: 503 });
  return { id, secret, redirect: `${process.env.PUBLIC_URL}/auth/google/callback` };
}
function authUrl({ state, scopes, loginHint }) {
  const c = config();
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: c.id, redirect_uri: c.redirect, response_type: 'code', state,
    scope: [...new Set([...BASE_SCOPES, ...scopes])].join(' '),
    access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent',
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return url.toString();
}
async function tokenCall(params) {
  const c = config();
  const response = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...params }), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error_description || data.error || `Google a refusé (HTTP ${response.status}).`), { status: response.status === 400 ? 401 : 502, code: data.error });
  return data;
}
async function exchangeCode(code) {
  const c = config();
  const tokens = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: c.redirect });
  const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15000) }).then(r => r.json());
  if (!info.sub || !info.email || info.email_verified === false) throw Object.assign(new Error('Compte Google non vérifié.'), { status: 401 });
  return { tokens, profile: { id: 'g' + info.sub, email: info.email, name: info.name || info.email, picture: info.picture || '' } };
}
function saveTokens(userId, tokens) {
  const prev = db.get('SELECT * FROM google_tokens WHERE user_id = ?', userId);
  const scopes = new Set([...(prev ? prev.scopes.split(' ') : []), ...String(tokens.scope || '').split(' ')].filter(Boolean));
  const refresh = tokens.refresh_token ? secrets.seal(tokens.refresh_token, 'grt:' + userId) : prev && prev.refresh_enc;
  db.run(`INSERT INTO google_tokens (user_id, refresh_enc, access_enc, expires_at, scopes) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET refresh_enc = excluded.refresh_enc, access_enc = excluded.access_enc, expires_at = excluded.expires_at, scopes = excluded.scopes`,
    userId, refresh || null, secrets.seal(tokens.access_token, 'gat:' + userId), Date.now() + (Number(tokens.expires_in) || 3000) * 1000, [...scopes].join(' '));
}
function grantedScopes(userId) {
  const row = db.get('SELECT scopes FROM google_tokens WHERE user_id = ?', userId);
  return new Set(row ? row.scopes.split(' ') : []);
}
function pluginStatus(userId) {
  const granted = grantedScopes(userId);
  return Object.entries(PLUGINS).map(([id, p]) => ({ id, label: p.label, connected: p.scopes.every(s => granted.has(s)), needsGoogle: p.scopes.length > 0 }));
}
const refreshing = new Map();
async function accessToken(userId) {
  const row = db.get('SELECT * FROM google_tokens WHERE user_id = ?', userId);
  if (!row) throw Object.assign(new Error('Compte Google non connecté.'), { status: 401, plugin: true });
  if (row.access_enc && row.expires_at > Date.now() + 60000) {
    const value = secrets.open(row.access_enc, 'gat:' + userId);
    if (value) return value;
  }
  if (refreshing.has(userId)) return refreshing.get(userId);
  const job = (async () => {
    const refresh = secrets.open(row.refresh_enc, 'grt:' + userId);
    if (!refresh) throw Object.assign(new Error('Reconnecte ton compte Google (multiprise › Connecter).'), { status: 401, plugin: true });
    try {
      const tokens = await tokenCall({ refresh_token: refresh, grant_type: 'refresh_token' });
      saveTokens(userId, { ...tokens, scope: tokens.scope || row.scopes });
      return tokens.access_token;
    } catch (error) {
      if (error.code === 'invalid_grant') {
        db.run('UPDATE google_tokens SET refresh_enc = NULL, access_enc = NULL WHERE user_id = ?', userId);
        throw Object.assign(new Error('Google a expiré l’accès. Reconnecte tes plugins depuis la multiprise.'), { status: 401, plugin: true });
      }
      throw error;
    }
  })().finally(() => refreshing.delete(userId));
  refreshing.set(userId, job);
  return job;
}
async function revoke(userId) {
  const row = db.get('SELECT * FROM google_tokens WHERE user_id = ?', userId);
  const refresh = row && secrets.open(row.refresh_enc, 'grt:' + userId);
  if (refresh) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refresh), { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(() => {});
  db.run('DELETE FROM google_tokens WHERE user_id = ?', userId);
}
function needScope(userId, plugin) {
  const granted = grantedScopes(userId);
  if (!PLUGINS[plugin].scopes.every(s => granted.has(s))) {
    throw Object.assign(new Error(`Le plugin ${PLUGINS[plugin].label} n’est pas connecté. Ouvre la multiprise en haut à droite et touche « Connecter ».`), { status: 403, plugin });
  }
}
async function api(userId, plugin, method, url, body, extra = {}) {
  needScope(userId, plugin);
  const token = await accessToken(userId);
  const response = await fetch(url, {
    method, signal: AbortSignal.timeout(25000),
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': extra.type || 'application/json' } : {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  if (response.status === 204) return {};
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error && (data.error.message || data.error.status) || `HTTP ${response.status}`;
    throw Object.assign(new Error(`${PLUGINS[plugin].label} : ${message}`), { status: response.status });
  }
  return data;
}

// ---------------------------------------------------------------- Gmail
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const header = (msg, name) => ((msg.payload && msg.payload.headers) || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function bodyText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body && part.body.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const child of part.parts || []) { const text = bodyText(child); if (text) return text; }
  if (part.mimeType === 'text/html' && part.body && part.body.data) return Buffer.from(part.body.data, 'base64url').toString('utf8').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  return '';
}
async function gmailSearch(userId, { query = 'in:inbox', max = 10 }) {
  const list = await api(userId, 'gmail', 'GET', `${GMAIL}/messages?maxResults=${Math.min(25, max)}&q=${encodeURIComponent(query)}`);
  const out = [];
  for (const m of list.messages || []) {
    const msg = await api(userId, 'gmail', 'GET', `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
    out.push({ id: msg.id, threadId: msg.threadId, from: header(msg, 'From'), to: header(msg, 'To'), subject: header(msg, 'Subject'), date: header(msg, 'Date'), snippet: msg.snippet, unread: (msg.labelIds || []).includes('UNREAD'), labels: msg.labelIds || [] });
  }
  return out;
}
async function gmailRead(userId, { id }) {
  const msg = await api(userId, 'gmail', 'GET', `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
  return { id: msg.id, threadId: msg.threadId, from: header(msg, 'From'), to: header(msg, 'To'), cc: header(msg, 'Cc'), subject: header(msg, 'Subject'), date: header(msg, 'Date'), messageId: header(msg, 'Message-ID'), body: bodyText(msg.payload).slice(0, 12000) };
}
const encodeHeader = (value) => /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
const cleanAddress = (value) => String(value || '').replace(/[\r\n]/g, ' ').trim();
function mime({ to, cc, subject, body, inReplyTo }) {
  const lines = [`To: ${cleanAddress(to)}`];
  if (cc) lines.push(`Cc: ${cleanAddress(cc)}`);
  lines.push(`Subject: ${encodeHeader(cleanAddress(subject))}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
  if (inReplyTo) lines.push(`In-Reply-To: ${cleanAddress(inReplyTo)}`, `References: ${cleanAddress(inReplyTo)}`);
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + Buffer.from(String(body || ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')).toString('base64url');
}
async function gmailSend(userId, args) {
  const reply = args.replyTo ? await gmailRead(userId, { id: args.replyTo }) : null;
  const raw = mime({ ...args, inReplyTo: reply && reply.messageId });
  const sent = await api(userId, 'gmail', 'POST', `${GMAIL}/messages/send`, { raw, ...(reply ? { threadId: reply.threadId } : {}) });
  return { sent: true, id: sent.id };
}
async function gmailDraft(userId, args) {
  const draft = await api(userId, 'gmail', 'POST', `${GMAIL}/drafts`, { message: { raw: mime(args) } });
  return { draft: true, id: draft.id };
}
async function gmailModify(userId, { id, addLabels = [], removeLabels = [] }) {
  await api(userId, 'gmail', 'POST', `${GMAIL}/messages/${encodeURIComponent(id)}/modify`, { addLabelIds: addLabels, removeLabelIds: removeLabels });
  return { ok: true };
}
async function gmailTrash(userId, { id }) { await api(userId, 'gmail', 'POST', `${GMAIL}/messages/${encodeURIComponent(id)}/trash`, {}); return { trashed: true, recoverable: '30 jours dans la corbeille Gmail' }; }
async function gmailLabels(userId) { const d = await api(userId, 'gmail', 'GET', `${GMAIL}/labels`); return (d.labels || []).map(l => ({ id: l.id, name: l.name })); }
async function gmailCreateLabel(userId, { name }) { const l = await api(userId, 'gmail', 'POST', `${GMAIL}/labels`, { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }); return { id: l.id, name: l.name }; }

// ---------------------------------------------------------------- Calendar
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const shapeEvent = e => ({ id: e.id, title: e.summary || '(sans titre)', start: e.start && (e.start.dateTime || e.start.date), end: e.end && (e.end.dateTime || e.end.date), location: e.location || '', description: (e.description || '').slice(0, 800), link: e.htmlLink });
async function calendarList(userId, { from, to, query, max = 20 }) {
  const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(50, max)), timeMin: new Date(from || Date.now()).toISOString() });
  if (to) params.set('timeMax', new Date(to).toISOString());
  if (query) params.set('q', query);
  const d = await api(userId, 'calendar', 'GET', `${CAL}?${params}`);
  return (d.items || []).map(shapeEvent);
}
function timeField(value, zone, allDay) {
  if (allDay) return { date: String(value).slice(0, 10) };
  return { dateTime: new Date(value).toISOString(), timeZone: zone || 'Europe/Paris' };
}
async function calendarCreate(userId, { title, start, end, allDay, location, description, timezone, reminderMinutes }) {
  const body = { summary: title, location, description, start: timeField(start, timezone, allDay), end: timeField(end || new Date(new Date(start).getTime() + 3600000).toISOString(), timezone, allDay) };
  if (reminderMinutes != null) body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: Number(reminderMinutes) }] };
  return shapeEvent(await api(userId, 'calendar', 'POST', CAL, body));
}
async function calendarUpdate(userId, { id, title, start, end, location, description, timezone }) {
  const patch = {};
  if (title) patch.summary = title; if (location != null) patch.location = location; if (description != null) patch.description = description;
  if (start) patch.start = timeField(start, timezone); if (end) patch.end = timeField(end, timezone);
  return shapeEvent(await api(userId, 'calendar', 'PATCH', `${CAL}/${encodeURIComponent(id)}`, patch));
}
async function calendarDelete(userId, { id }) { await api(userId, 'calendar', 'DELETE', `${CAL}/${encodeURIComponent(id)}`); return { deleted: true }; }

// ---------------------------------------------------------------- Tasks
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
async function taskLists(userId) { const d = await api(userId, 'tasks', 'GET', `${TASKS}/users/@me/lists`); return (d.items || []).map(l => ({ id: l.id, title: l.title })); }
async function listId(userId, wanted) {
  if (wanted && !/\s/.test(wanted) && wanted.length > 15) return wanted;
  const lists = await taskLists(userId);
  if (!wanted) return lists[0] ? lists[0].id : '@default';
  const found = lists.find(l => l.title.toLowerCase() === String(wanted).toLowerCase());
  if (found) return found.id;
  const created = await api(userId, 'tasks', 'POST', `${TASKS}/users/@me/lists`, { title: wanted });
  return created.id;
}
const shapeTask = t => ({ id: t.id, title: t.title, notes: t.notes || '', due: t.due || null, status: t.status });
async function tasksList(userId, { list, showCompleted = false }) {
  const id = await listId(userId, list);
  const d = await api(userId, 'tasks', 'GET', `${TASKS}/lists/${encodeURIComponent(id)}/tasks?showCompleted=${showCompleted}&maxResults=100`);
  return { list: id, tasks: (d.items || []).map(shapeTask) };
}
async function tasksCreate(userId, { list, title, notes, due }) {
  const id = await listId(userId, list);
  return shapeTask(await api(userId, 'tasks', 'POST', `${TASKS}/lists/${encodeURIComponent(id)}/tasks`, { title, notes, ...(due ? { due: new Date(due).toISOString() } : {}) }));
}
async function tasksComplete(userId, { list, id }) {
  const lid = await listId(userId, list);
  return shapeTask(await api(userId, 'tasks', 'PATCH', `${TASKS}/lists/${encodeURIComponent(lid)}/tasks/${encodeURIComponent(id)}`, { status: 'completed' }));
}
async function tasksDelete(userId, { list, id }) {
  const lid = await listId(userId, list);
  await api(userId, 'tasks', 'DELETE', `${TASKS}/lists/${encodeURIComponent(lid)}/tasks/${encodeURIComponent(id)}`); return { deleted: true };
}

// ---------------------------------------------------------------- Notes (Google Docs in a "Notes Glyphes" folder)
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
async function notesFolder(userId) {
  const found = await api(userId, 'notes', 'GET', `${DRIVE}?q=${encodeURIComponent("name = 'Notes Glyphes' and mimeType = 'application/vnd.google-apps.folder' and trashed = false")}&fields=files(id)`);
  if (found.files && found.files[0]) return found.files[0].id;
  const folder = await api(userId, 'notes', 'POST', DRIVE, { name: 'Notes Glyphes', mimeType: 'application/vnd.google-apps.folder' });
  return folder.id;
}
async function notesList(userId, { query }) {
  const folder = await notesFolder(userId);
  let q = `'${folder}' in parents and trashed = false`;
  if (query) q += ` and fullText contains '${String(query).replace(/['\\]/g, ' ')}'`;
  const d = await api(userId, 'notes', 'GET', `${DRIVE}?q=${encodeURIComponent(q)}&orderBy=modifiedTime desc&pageSize=30&fields=files(id,name,modifiedTime,webViewLink)`);
  return (d.files || []).map(f => ({ id: f.id, title: f.name, modified: f.modifiedTime, link: f.webViewLink }));
}
async function notesRead(userId, { id }) {
  needScope(userId, 'notes');
  const token = await accessToken(userId);
  const response = await fetch(`${DRIVE}/${encodeURIComponent(id)}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Note illisible (HTTP ${response.status}).`);
  return { id, text: (await response.text()).slice(0, 20000) };
}
async function multipart(userId, method, url, meta, text) {
  const boundary = 'glyphes' + Date.now();
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
  return api(userId, 'notes', method, url, body, { type: `multipart/related; boundary=${boundary}` });
}
async function notesCreate(userId, { title, text }) {
  const folder = await notesFolder(userId);
  const file = await multipart(userId, 'POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    { name: title, mimeType: 'application/vnd.google-apps.document', parents: [folder] }, String(text || ''));
  return { id: file.id, title: file.name, link: file.webViewLink };
}
async function notesUpdate(userId, { id, text, append = true }) {
  const current = append ? (await notesRead(userId, { id })).text.replace(/^\uFEFF/, '') : '';
  const file = await multipart(userId, 'PATCH', `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=multipart&fields=id,name,webViewLink`,
    {}, append ? `${current.trimEnd()}\n\n${text}` : String(text || ''));
  return { id: file.id, title: file.name, link: file.webViewLink };
}
async function notesTrash(userId, { id }) { await api(userId, 'notes', 'PATCH', `${DRIVE}/${encodeURIComponent(id)}`, { trashed: true }); return { trashed: true, recoverable: '30 jours dans la corbeille Drive' }; }

module.exports = {
  PLUGINS, authUrl, exchangeCode, saveTokens, grantedScopes, pluginStatus, accessToken, revoke,
  gmailSearch, gmailRead, gmailSend, gmailDraft, gmailModify, gmailTrash, gmailLabels, gmailCreateLabel,
  calendarList, calendarCreate, calendarUpdate, calendarDelete,
  taskLists, tasksList, tasksCreate, tasksComplete, tasksDelete,
  notesList, notesRead, notesCreate, notesUpdate, notesTrash,
};
