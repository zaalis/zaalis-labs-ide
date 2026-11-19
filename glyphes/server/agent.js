'use strict';
// The Glyph's thinking loop: model -> tools -> model, until it has answered.
//
// Every tool call gets an immediate result so the conversation stays valid
// for any provider. An action that needs the user's go-ahead is answered with
// "awaiting confirmation" and shown as a card above the chat. When the user
// taps Confirmer/Refuser, the action runs (or not) on the server, a short note
// is added to the conversation, and the Glyph picks the thread back up.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const models = require('./models');
const tools = require('./tools');
const events = require('./events');
const push = require('./push');

let FILES_DIR = '';
function init(dataDir) { FILES_DIR = path.join(dataDir, 'files'); fs.mkdirSync(FILES_DIR, { recursive: true }); }
const MAX_STEPS = 10;
const HISTORY = 48;

// ---------------------------------------------------------------- helpers
function glyphRow(userId, glyphId) {
  const g = db.get('SELECT * FROM glyphs WHERE id = ? AND user_id = ?', glyphId, userId);
  if (!g) throw Object.assign(new Error('Glyphe introuvable.'), { status: 404 });
  return g;
}
function publicMessage(m) {
  const data = db.json(m.data, {});
  return { id: m.id, glyphId: m.glyph_id, role: m.role, content: m.content, data, createdAt: m.created_at };
}
function addMessage(userId, glyphId, role, content, data) {
  const row = { id: db.newId('m'), glyph_id: glyphId, user_id: userId, role, content: String(content || ''), data: data ? JSON.stringify(data) : null, created_at: db.now() };
  db.run('INSERT INTO messages (id, glyph_id, user_id, role, content, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', row.id, glyphId, userId, role, row.content, row.data, row.created_at);
  const visible = role === 'assistant' ? !!row.content.trim() : role !== 'tool';
  if (visible) events.emit(userId, 'message', publicMessage(row));
  return row;
}
function setGlyph(userId, glyphId, patch) {
  const keys = Object.keys(patch);
  db.run(`UPDATE glyphs SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`, ...keys.map(k => patch[k]), db.now(), glyphId, userId);
  events.emit(userId, 'glyph', publicGlyph(db.get('SELECT * FROM glyphs WHERE id = ?', glyphId)));
}
function publicGlyph(g) {
  if (!g) return null;
  const pending = db.get("SELECT COUNT(*) AS n FROM actions WHERE glyph_id = ? AND status = 'pending'", g.id).n;
  const last = db.get("SELECT content, role, created_at FROM messages WHERE glyph_id = ? AND role IN ('user', 'assistant') AND content != '' AND content NOT LIKE '[Note système]%' ORDER BY created_at DESC LIMIT 1", g.id);
  return { id: g.id, name: g.name, variant: g.variant, mode: g.mode, model: g.model, instructions: g.instructions, status: g.status,
    taskLabel: g.task_label, unread: g.unread, pending, updatedAt: g.updated_at, createdAt: g.created_at,
    last: last ? { role: last.role, text: last.content.slice(0, 140), at: last.created_at } : null };
}
function userSettings(userId) { return db.json((db.get('SELECT settings FROM users WHERE id = ?', userId) || {}).settings, {}); }
function nowIn(timeZone) {
  const d = new Date();
  const label = d.toLocaleString('fr-FR', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(d).map(p => [p.type, p.value]));
  const offset = (parts.timeZoneName || 'GMT+00:00').replace('GMT', '') || '+00:00';
  return { label, offset };
}
function systemPrompt(user, glyph) {
  const settings = userSettings(user.id);
  const tz = settings.timezone || 'Europe/Paris';
  const { label, offset } = nowIn(tz);
  const plugins = require('./google').pluginStatus(user.id).filter(p => p.connected).map(p => p.label);
  const autonomous = glyph.mode === 'autonomous';
  return [
    `Tu es ${glyph.name}, un Glyphe : un assistant personnel autonome de zaalis Labs qui travaille pour ${user.name || 'l’utilisateur'} (${user.email}), 24 h/24, depuis un serveur.`,
    glyph.instructions ? `Ta mission, définie par l’utilisateur :\n${glyph.instructions}` : 'Aucune mission particulière : aide pour les e-mails, l’agenda, les tâches, les notes et les recherches.',
    `Date et heure actuelles : ${label} (fuseau ${tz}, UTC${offset}). Écris toujours les dates des outils en ISO 8601 avec ce décalage.`,
    `Plugins connectés : ${plugins.length ? plugins.join(', ') : 'aucun'}. Recherche web et Google Maps sont toujours disponibles. Si une action demande un plugin absent, dis-le simplement : l’utilisateur le connecte avec la multiprise en haut à droite.`,
    autonomous
      ? 'Mode AUTONOME : tu agis sans demander, dans le cadre de ta mission et de la demande. Exception stricte : toute suppression définitive (outils marqués « définitivement ») attend toujours la confirmation explicite de l’utilisateur ; une intention sous-entendue ne suffit jamais.'
      : 'Mode SUPERVISÉ : chaque action qui agit à l’extérieur (envoi, création, modification, corbeille) affiche une carte Confirmer/Refuser à l’utilisateur. Prépare l’action complète, appelle l’outil, puis dis en une phrase ce qui attend sa confirmation.',
    'Quand un outil répond "awaiting_confirmation", l’action N’EST PAS faite : n’affirme jamais le contraire et ne la relance pas. Une note système te dira ensuite si l’utilisateur a confirmé ou refusé.',
    'Tu ne supprimes jamais rien définitivement sans que l’utilisateur l’ait explicitement demandé pour cet élément précis.',
    'Style : français, chaleureux et bref, comme dans une messagerie. Pas de titres ni de longs pavés. Tu peux enchaîner plusieurs messages courts avec send_message. Pour un lieu ou un trajet, utilise maps_route ou maps_search ; pour une page web utile, show_link. Pour un rappel à une heure précise, schedule_message ; pour une mission récurrente, schedule_task.',
    'N’invente jamais un résultat : si un outil échoue, explique-le et propose une solution.',
  ].join('\n\n');
}
function fileParts(userId, files) {
  const parts = [];
  for (const f of files || []) {
    const row = db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', f.id, userId);
    if (!row) continue;
    const file = path.join(FILES_DIR, userId, row.id);
    if (!fs.existsSync(file)) continue;
    if (/^image\/(png|jpeg|webp|gif)$/.test(row.mime) && row.size <= 8 * 1024 * 1024) {
      parts.push({ type: 'image_url', image_url: { url: `data:${row.mime};base64,${fs.readFileSync(file).toString('base64')}` } });
    } else if (/^text\/|json|xml|csv|markdown/.test(row.mime) && row.size <= 200 * 1024) {
      parts.push({ type: 'text', text: `Fichier joint « ${row.name} » :\n${fs.readFileSync(file, 'utf8').slice(0, 60000)}` });
    } else {
      parts.push({ type: 'text', text: `Fichier joint « ${row.name} » (${row.mime}, ${Math.round(row.size / 1024)} Ko) : contenu non lisible directement.` });
    }
  }
  return parts;
}
function history(userId, glyphId) {
  const rows = db.all("SELECT * FROM messages WHERE glyph_id = ? AND role IN ('user', 'assistant', 'tool') ORDER BY created_at DESC LIMIT ?", glyphId, HISTORY).reverse();
  const start = rows.findIndex(r => r.role === 'user');
  const out = [];
  for (const r of start < 0 ? [] : rows.slice(start)) {
    const data = db.json(r.data, {});
    if (r.role === 'user') {
      const files = fileParts(userId, data.files);
      const text = data.reply
        ? (data.reply.later ? `(Réponse à ta question « ${data.reply.question} » : l’utilisateur choisit « Plus tard », il n’est pas encore prêt.)` : `(Réponse à ta question « ${data.reply.question} ») ${r.content}`)
        : r.content;
      out.push({ role: 'user', content: files.length ? [{ type: 'text', text: text || '(pièce jointe)' }, ...files] : text });
    } else if (r.role === 'assistant') {
      out.push({ role: 'assistant', content: r.content || '', ...(data.tool_calls ? { tool_calls: data.tool_calls } : {}) });
    } else {
      out.push({ role: 'tool', tool_call_id: data.tool_call_id, content: r.content });
    }
  }
  // A cut history must never leave a tool call without its answer.
  const answered = new Set(out.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  return out.filter(m => m.role !== 'assistant' || !m.tool_calls || m.tool_calls.every(c => answered.has(c.id)));
}

// ---------------------------------------------------------------- run queue (one run at a time per Glyph)
const queues = new Map();
function enqueue(userId, glyphId, reason) {
  const prev = queues.get(glyphId) || Promise.resolve();
  const next = prev.then(() => run(userId, glyphId, reason)).catch(error => console.error('[glyphes] run', glyphId, error));
  queues.set(glyphId, next);
  next.finally(() => { if (queues.get(glyphId) === next) queues.delete(glyphId); });
  return next;
}
const busy = (glyphId) => queues.has(glyphId);

async function run(userId, glyphId, reason) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  let glyph = db.get('SELECT * FROM glyphs WHERE id = ? AND user_id = ?', glyphId, userId);
  if (!user || !glyph || glyph.status === 'paused') return;
  setGlyph(userId, glyphId, { status: 'working' });
  const labels = [];
  const offered = tools.available(userId);
  const ctx = {
    glyph, user,
    say: (text) => { if (String(text || '').trim()) addMessage(userId, glyphId, 'assistant', text, { extra: true }); },
    card: (card) => addMessage(userId, glyphId, 'card', card.title, card),
    schedule: (kind, at, payload, repeat) => {
      const due = new Date(at).getTime();
      if (!Number.isFinite(due)) throw new Error('Date invalide.');
      if (due < Date.now() - 60000) throw new Error('Cette date est déjà passée.');
      const id = db.newId('j');
      db.run('INSERT INTO jobs (id, user_id, glyph_id, kind, payload, due_at, repeat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, userId, glyphId, kind, JSON.stringify(payload), due, repeat && repeat !== 'none' ? repeat : null, db.now());
      return { scheduled: true, id, at: new Date(due).toISOString(), repeat: repeat || 'none' };
    },
  };
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const messages = [{ role: 'system', content: systemPrompt(user, glyph) }, ...history(userId, glyphId)];
      const reply = await models.complete(userId, glyph.model, messages, offered.map(tools.schema));
      const calls = (reply.tool_calls || []).filter(c => c && c.function && c.function.name).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
      addMessage(userId, glyphId, 'assistant', reply.content || '', calls.length ? { tool_calls: calls } : null);
      if (!calls.length) break;
      for (const call of calls) {
        const result = await execute(userId, glyph, call, ctx, labels);
        addMessage(userId, glyphId, 'tool', JSON.stringify(result).slice(0, 24000), { tool_call_id: call.id, tool: call.function.name });
      }
      glyph = db.get('SELECT * FROM glyphs WHERE id = ?', glyphId);
      if (!glyph || glyph.status === 'paused') return;
    }
    finish(userId, glyphId, labels, null, reason);
  } catch (error) {
    const text = error.setup ? error.message : `Je n’ai pas pu terminer : ${error.message}`;
    addMessage(userId, glyphId, 'assistant', text, { error: true });
    finish(userId, glyphId, labels, error, reason);
  }
}
async function execute(userId, glyph, call, ctx, labels) {
  const tool = tools.BY_NAME[call.function.name];
  if (!tool || !tools.available(userId).includes(tool)) return { error: `Outil indisponible : ${call.function.name}` };
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { error: 'Arguments JSON invalides.' }; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'Arguments invalides.' };
  for (const key of tool.required || []) if (args[key] === undefined || args[key] === '') return { error: `Paramètre manquant : ${key}` };
  if (tool.label) labels.push(tool.label);
  if (tools.needsConfirmation(tool, glyph.mode)) {
    const card = tools.cardFor(tool, args);
    const id = db.newId('a');
    db.run('INSERT INTO actions (id, glyph_id, user_id, tool, args, summary, irreversible, status, call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, glyph.id, userId, tool.name, JSON.stringify(args), JSON.stringify(card), tool.kind === 'irreversible' ? 1 : 0, 'pending', call.id, db.now());
    const action = publicAction(db.get('SELECT * FROM actions WHERE id = ?', id));
    events.emit(userId, 'action', action);
    push.notify(userId, { title: `${glyph.name} attend ta confirmation`, body: card.title, glyphId: glyph.id, tag: 'action-' + id });
    return { status: 'awaiting_confirmation', actionId: id, note: 'Carte Confirmer/Refuser affichée à l’utilisateur. Action non effectuée pour l’instant.' };
  }
  try { return await tool.run(userId, args, ctx); }
  catch (error) { return { error: error.message, ...(error.plugin ? { plugin: error.plugin } : {}) }; }
}
function finish(userId, glyphId, labels, error, reason) {
  const glyph = db.get('SELECT * FROM glyphs WHERE id = ?', glyphId);
  if (!glyph) return;
  const pending = db.get("SELECT COUNT(*) AS n FROM actions WHERE glyph_id = ? AND status = 'pending'", glyphId).n;
  const patch = { status: error ? 'error' : pending ? 'waiting' : 'done' };
  const label = [...new Set(labels)].slice(0, 4).join(', ');
  if (label) patch.task_label = label;
  const online = events.online(userId);
  if (!online) patch.unread = glyph.unread + 1;
  setGlyph(userId, glyphId, patch);
  if (!online && !pending && reason !== 'silent') {
    const last = db.get("SELECT content FROM messages WHERE glyph_id = ? AND role = 'assistant' AND content != '' ORDER BY created_at DESC LIMIT 1", glyphId);
    push.notify(userId, { title: glyph.name, body: last ? last.content : 'Tâche terminée.', glyphId, tag: 'glyph-' + glyphId });
  }
}

// ---------------------------------------------------------------- user entry points
function publicAction(a) {
  return { id: a.id, glyphId: a.glyph_id, tool: a.tool, card: db.json(a.summary, {}), irreversible: !!a.irreversible, status: a.status, createdAt: a.created_at, result: db.json(a.result, null) };
}
function userMessage(userId, glyphId, text, files, reply) {
  const glyph = glyphRow(userId, glyphId);
  const clean = String(text || '').slice(0, 20000);
  if (!clean.trim() && !(files && files.length)) throw Object.assign(new Error('Message vide.'), { status: 400 });
  const owned = (files || []).slice(0, 8).filter(f => f && db.get('SELECT id FROM files WHERE id = ? AND user_id = ?', f.id, userId))
    .map(f => { const row = db.get('SELECT id, name, mime, size FROM files WHERE id = ?', f.id); return { id: row.id, name: row.name, mime: row.mime, size: row.size }; });
  const data = {};
  if (owned.length) data.files = owned;
  // An answer to an ask_user mini-window: shown under the question, and the model knows what it answers.
  if (reply && typeof reply === 'object' && String(reply.question || '').trim()) data.reply = { question: String(reply.question).slice(0, 200), later: !!reply.later };
  const message = addMessage(userId, glyphId, 'user', clean, Object.keys(data).length ? data : null);
  if (glyph.status === 'paused') return publicMessage(message);
  enqueue(userId, glyphId, 'user');
  return publicMessage(message);
}
// A new Glyph says hello: greets the user by first name, gives its name, asks how it can help and
// offers 3 suggestions in a mini-window (ask_user). The words are the model's own; the note is hidden.
function intro(userId, glyphId) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  const glyph = db.get('SELECT * FROM glyphs WHERE id = ? AND user_id = ?', glyphId, userId);
  if (!user || !glyph) return false;
  if (!glyph.model && !models.defaultModel(userId)) return false;            // no AI connected yet: stay quiet
  const first = String(user.name || '').trim().split(/\s+/)[0] || '';
  addMessage(userId, glyphId, 'user', `[Note système] Tu viens d’être créé et ${first || 'l’utilisateur'} ouvre la conversation pour la première fois. `
    + `Écris un court message d’accueil avec tes propres mots : salue-${first ? 'le par son prénom (' + first + ')' : 'le'}, dis que tu t’appelles ${glyph.name}, puis demande en quoi tu peux l’aider aujourd’hui. `
    + 'Ensuite appelle ask_user avec la question « En quoi puis-je t’aider aujourd’hui ? » et 3 propositions concrètes et courtes, adaptées à ta mission et aux plugins connectés (par exemple trier les mails, ajouter des alertes, planifier des rendez-vous). '
    + 'N’écris rien après l’appel.', { hidden: true });
  enqueue(userId, glyphId, 'intro');
  return true;
}
async function decide(userId, actionId, approve) {
  const action = db.get('SELECT * FROM actions WHERE id = ? AND user_id = ?', actionId, userId);
  if (!action) throw Object.assign(new Error('Action introuvable.'), { status: 404 });
  // Claim the action atomically: a double tap or two devices cannot run it twice.
  const claimed = db.run("UPDATE actions SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'", approve ? 'running' : 'refused', db.now(), actionId).changes;
  if (!claimed) throw Object.assign(new Error('Cette action a déjà été traitée.'), { status: 409 });
  const glyph = db.get('SELECT * FROM glyphs WHERE id = ?', action.glyph_id);
  const tool = tools.BY_NAME[action.tool];
  const card = db.json(action.summary, {});
  let note;
  if (!approve) note = { ok: false, text: `Refusé : ${String(card.title || '').replace(/\s*\?$/, '')}` };
  else {
    try {
      const result = await tool.run(userId, db.json(action.args, {}), { glyph, user: db.get('SELECT * FROM users WHERE id = ?', userId), say() {}, card() {}, schedule() { throw new Error('indisponible'); } });
      db.run("UPDATE actions SET status = 'done', result = ? WHERE id = ?", JSON.stringify(result).slice(0, 8000), actionId);
      note = { ok: true, text: `Confirmé : ${card.title.replace(/\s*\?$/, '')}`, result };
    } catch (error) {
      db.run("UPDATE actions SET status = 'failed', result = ? WHERE id = ?", JSON.stringify({ error: error.message }), actionId);
      note = { ok: false, text: `Échec : ${error.message}` };
    }
  }
  const updated = publicAction(db.get('SELECT * FROM actions WHERE id = ?', actionId));
  events.emit(userId, 'action', updated);
  addMessage(userId, action.glyph_id, 'user', `[Note système] L’utilisateur a ${approve ? 'confirmé' : 'refusé'} l’action « ${action.tool} » (id ${actionId}). ${note.ok ? 'Résultat : ' + JSON.stringify(note.result).slice(0, 2000) : note.text}`,
    { event: true, label: note.text, ok: note.ok, actionId });
  enqueue(userId, action.glyph_id, 'decision');
  return updated;
}
function cancelPending(userId, glyphId) {
  const rows = db.all("SELECT id FROM actions WHERE user_id = ? AND glyph_id = ? AND status = 'pending'", userId, glyphId);
  for (const r of rows) {
    db.run("UPDATE actions SET status = 'expired', decided_at = ? WHERE id = ?", db.now(), r.id);
    events.emit(userId, 'action', publicAction(db.get('SELECT * FROM actions WHERE id = ?', r.id)));
  }
}

module.exports = { init, enqueue, busy, userMessage, intro, decide, publicGlyph, publicMessage, publicAction, addMessage, setGlyph, cancelPending, glyphRow, FILES_DIR: () => FILES_DIR, systemPrompt, history };
