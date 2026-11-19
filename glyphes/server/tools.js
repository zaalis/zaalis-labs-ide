'use strict';
// What a Glyph can do, and the rule that decides whether it may do it now.
//
//   kind 'read'          looks only (mails, agenda, web, location): always runs.
//   kind 'internal'      changes only the Glyph itself (reminders, its own
//                        messages): always runs.
//   kind 'write'         acts outside (sends a mail, creates an event, a note):
//                        supervised mode -> confirmation card; autonomous -> runs.
//   kind 'irreversible'  permanent deletion: in EVERY mode it waits for the
//                        user's explicit "Confirmer". Nothing the model says or
//                        infers can stand in for that click.
const google = require('./google');
const web = require('./web');
const db = require('./db');

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TOOLS = [
  // ------------------------------------------------ Gmail
  { name: 'gmail_search', plugin: 'gmail', kind: 'read', label: 'Lecture mails',
    description: 'Cherche des e-mails (syntaxe de recherche Gmail : from:, is:unread, newer_than:2d, label:…).',
    parameters: { query: str('Requête Gmail, par défaut in:inbox'), max: { type: 'integer', description: 'Nombre maximum (≤ 25)' } },
    run: (u, a) => google.gmailSearch(u, a) },
  { name: 'gmail_read', plugin: 'gmail', kind: 'read', label: 'Lecture mails', description: 'Lit un e-mail complet.',
    parameters: { id: str('Identifiant du message') }, required: ['id'], run: (u, a) => google.gmailRead(u, a) },
  { name: 'gmail_labels', plugin: 'gmail', kind: 'read', label: 'Tri mails', description: 'Liste les libellés Gmail.', parameters: {}, run: (u) => google.gmailLabels(u) },
  { name: 'gmail_send', plugin: 'gmail', kind: 'write', label: 'Envoi mail',
    description: 'Envoie un e-mail. Pour répondre, passe replyTo (id du message reçu).',
    parameters: { to: str('Destinataire(s)'), cc: str('Copie'), subject: str('Objet'), body: str('Texte du message'), replyTo: str('Id du message auquel répondre') },
    required: ['to', 'subject', 'body'], run: (u, a) => google.gmailSend(u, a),
    card: a => ({ title: 'Envoyer cet e-mail ?', fields: [['À', a.to], a.cc && ['Cc', a.cc], ['Objet', a.subject]].filter(Boolean), preview: a.body }) },
  { name: 'gmail_draft', plugin: 'gmail', kind: 'write', label: 'Brouillon mail',
    description: 'Prépare un brouillon dans Gmail sans l’envoyer.',
    parameters: { to: str('Destinataire(s)'), cc: str('Copie'), subject: str('Objet'), body: str('Texte') }, required: ['to', 'subject', 'body'],
    run: (u, a) => google.gmailDraft(u, a),
    card: a => ({ title: 'Créer ce brouillon ?', fields: [['À', a.to], ['Objet', a.subject]], preview: a.body }) },
  { name: 'gmail_label', plugin: 'gmail', kind: 'write', label: 'Tri mails',
    description: 'Classe un e-mail : ajoute/retire des libellés (ex. retirer UNREAD = marquer lu, retirer INBOX = archiver).',
    parameters: { id: str('Id du message'), addLabels: { type: 'array', items: { type: 'string' } }, removeLabels: { type: 'array', items: { type: 'string' } } }, required: ['id'],
    run: (u, a) => google.gmailModify(u, a),
    card: a => ({ title: 'Classer cet e-mail ?', fields: [a.addLabels && a.addLabels.length && ['Ajouter', a.addLabels.join(', ')], a.removeLabels && a.removeLabels.length && ['Retirer', a.removeLabels.join(', ')]].filter(Boolean) }) },
  { name: 'gmail_create_label', plugin: 'gmail', kind: 'write', label: 'Tri mails', description: 'Crée un libellé Gmail.',
    parameters: { name: str('Nom du libellé') }, required: ['name'], run: (u, a) => google.gmailCreateLabel(u, a),
    card: a => ({ title: 'Créer ce libellé ?', fields: [['Libellé', a.name]] }) },
  { name: 'gmail_trash', plugin: 'gmail', kind: 'write', label: 'Tri mails', description: 'Met un e-mail à la corbeille (récupérable 30 jours ; jamais de suppression définitive).',
    parameters: { id: str('Id du message'), subject: str('Objet, pour l’affichage') }, required: ['id'], run: (u, a) => google.gmailTrash(u, a),
    card: a => ({ title: 'Mettre cet e-mail à la corbeille ?', fields: [['E-mail', a.subject || a.id]], note: 'Récupérable 30 jours dans la corbeille Gmail.' }) },
  // ------------------------------------------------ Agenda
  { name: 'calendar_list', plugin: 'calendar', kind: 'read', label: 'Consultation agenda', description: 'Liste les événements de l’agenda principal.',
    parameters: { from: str('Début (ISO 8601), par défaut maintenant'), to: str('Fin (ISO 8601)'), query: str('Texte à chercher'), max: { type: 'integer' } },
    run: (u, a) => google.calendarList(u, a) },
  { name: 'calendar_create', plugin: 'calendar', kind: 'write', label: 'Préparation agenda',
    description: 'Crée un événement. Dates en ISO 8601 avec fuseau (ex. 2026-11-20T18:00:00+01:00).',
    parameters: { title: str('Titre'), start: str('Début'), end: str('Fin'), allDay: { type: 'boolean' }, location: str('Lieu'), description: str('Détails'), reminderMinutes: { type: 'integer', description: 'Rappel en minutes avant' } },
    required: ['title', 'start'], run: (u, a) => google.calendarCreate(u, a),
    card: a => ({ title: 'Ajouter cet événement ?', fields: [['Titre', a.title], ['Début', when(a.start)], a.end && ['Fin', when(a.end)], a.location && ['Lieu', a.location]].filter(Boolean) }) },
  { name: 'calendar_update', plugin: 'calendar', kind: 'write', label: 'Préparation agenda', description: 'Modifie un événement existant.',
    parameters: { id: str('Id de l’événement'), title: str('Titre'), start: str('Début'), end: str('Fin'), location: str('Lieu'), description: str('Détails') }, required: ['id'],
    run: (u, a) => google.calendarUpdate(u, a),
    card: a => ({ title: 'Modifier cet événement ?', fields: [a.title && ['Titre', a.title], a.start && ['Début', when(a.start)], a.end && ['Fin', when(a.end)], a.location && ['Lieu', a.location]].filter(Boolean) }) },
  { name: 'calendar_delete', plugin: 'calendar', kind: 'irreversible', label: 'Suppression événement', description: 'Supprime définitivement un événement. Exige la confirmation explicite de l’utilisateur.',
    parameters: { id: str('Id de l’événement'), title: str('Titre, pour l’affichage') }, required: ['id'], run: (u, a) => google.calendarDelete(u, a),
    card: a => ({ title: 'Supprimer définitivement cet événement ?', fields: [['Événement', a.title || a.id]] }) },
  // ------------------------------------------------ Tasks
  { name: 'tasks_list', plugin: 'tasks', kind: 'read', label: 'Consultation tâches', description: 'Liste les tâches Google Tasks.',
    parameters: { list: str('Nom de la liste'), showCompleted: { type: 'boolean' } }, run: (u, a) => google.tasksList(u, a) },
  { name: 'tasks_create', plugin: 'tasks', kind: 'write', label: 'Création tâche', description: 'Crée une tâche ou un rappel dans Google Tasks.',
    parameters: { title: str('Titre'), notes: str('Détails'), due: str('Échéance (ISO 8601)'), list: str('Nom de la liste (créée si absente)') }, required: ['title'],
    run: (u, a) => google.tasksCreate(u, a),
    card: a => ({ title: 'Créer cette tâche ?', fields: [['Tâche', a.title], a.due && ['Échéance', when(a.due)], a.list && ['Liste', a.list]].filter(Boolean), preview: a.notes }) },
  { name: 'tasks_complete', plugin: 'tasks', kind: 'write', label: 'Suivi tâches', description: 'Marque une tâche comme terminée.',
    parameters: { id: str('Id de la tâche'), list: str('Liste'), title: str('Titre, pour l’affichage') }, required: ['id'], run: (u, a) => google.tasksComplete(u, a),
    card: a => ({ title: 'Marquer cette tâche comme faite ?', fields: [['Tâche', a.title || a.id]] }) },
  { name: 'tasks_delete', plugin: 'tasks', kind: 'irreversible', label: 'Suppression tâche', description: 'Supprime définitivement une tâche. Exige la confirmation explicite de l’utilisateur.',
    parameters: { id: str('Id de la tâche'), list: str('Liste'), title: str('Titre, pour l’affichage') }, required: ['id'], run: (u, a) => google.tasksDelete(u, a),
    card: a => ({ title: 'Supprimer définitivement cette tâche ?', fields: [['Tâche', a.title || a.id]] }) },
  // ------------------------------------------------ Notes (Google Docs)
  { name: 'notes_list', plugin: 'notes', kind: 'read', label: 'Lecture notes', description: 'Liste ou cherche les notes (Google Docs du dossier « Notes Glyphes »).',
    parameters: { query: str('Texte à chercher') }, run: (u, a) => google.notesList(u, a) },
  { name: 'notes_read', plugin: 'notes', kind: 'read', label: 'Lecture notes', description: 'Lit une note.', parameters: { id: str('Id de la note') }, required: ['id'], run: (u, a) => google.notesRead(u, a) },
  { name: 'notes_create', plugin: 'notes', kind: 'write', label: 'Prise de notes', description: 'Crée une note (Google Docs) dans « Notes Glyphes ».',
    parameters: { title: str('Titre'), text: str('Contenu') }, required: ['title', 'text'], run: (u, a) => google.notesCreate(u, a),
    card: a => ({ title: 'Créer cette note ?', fields: [['Titre', a.title]], preview: a.text }) },
  { name: 'notes_update', plugin: 'notes', kind: 'write', label: 'Prise de notes', description: 'Ajoute du texte à une note (append=true) ou la remplace.',
    parameters: { id: str('Id de la note'), text: str('Texte'), append: { type: 'boolean' }, title: str('Titre, pour l’affichage') }, required: ['id', 'text'], run: (u, a) => google.notesUpdate(u, a),
    card: a => ({ title: a.append === false ? 'Remplacer le contenu de cette note ?' : 'Compléter cette note ?', fields: [['Note', a.title || a.id]], preview: a.text }) },
  { name: 'notes_trash', plugin: 'notes', kind: 'write', label: 'Rangement notes', description: 'Met une note à la corbeille Drive (récupérable 30 jours).',
    parameters: { id: str('Id de la note'), title: str('Titre, pour l’affichage') }, required: ['id'], run: (u, a) => google.notesTrash(u, a),
    card: a => ({ title: 'Mettre cette note à la corbeille ?', fields: [['Note', a.title || a.id]], note: 'Récupérable 30 jours dans la corbeille Drive.' }) },
  // ------------------------------------------------ Web, Maps, location
  { name: 'web_search', plugin: 'web', kind: 'read', label: 'Recherche web', description: 'Recherche sur Internet.',
    parameters: { query: str('Requête') }, required: ['query'], run: (u, a) => web.search(a.query) },
  { name: 'web_read', plugin: 'web', kind: 'read', label: 'Recherche web', description: 'Lit le texte d’une page web publique.',
    parameters: { url: str('Adresse https://…') }, required: ['url'], run: (u, a) => web.read(a.url) },
  { name: 'show_link', plugin: 'web', kind: 'internal', label: 'Recherche web',
    description: 'Affiche à l’utilisateur une fenêtre centrée cliquable vers une page trouvée (résultat web important, réservation, article…).',
    parameters: { title: str('Titre'), url: str('Adresse https://…'), subtitle: str('Une ligne d’explication') }, required: ['title', 'url'],
    run: (u, a, ctx) => { if (!/^https:\/\//.test(a.url || '')) throw new Error('Lien https requis.'); ctx.card({ kind: 'web', title: a.title, subtitle: a.subtitle || hostOf(a.url), url: a.url }); return { shown: true }; } },
  { name: 'maps_route', plugin: 'maps', kind: 'read', label: 'Itinéraire',
    description: 'Prépare l’itinéraire le plus rapide dans Google Maps depuis la position actuelle de l’utilisateur (si partagée) et l’affiche en fenêtre centrée.',
    parameters: { destination: str('Adresse ou lieu'), mode: str('driving, walking, bicycling ou transit', { enum: ['driving', 'walking', 'bicycling', 'transit'] }) }, required: ['destination'],
    run: (u, a, ctx) => {
      const loc = db.get('SELECT * FROM locations WHERE user_id = ?', u);
      const fresh = loc && Date.now() - loc.at < 30 * 60000;
      const url = new URL('https://www.google.com/maps/dir/');
      url.searchParams.set('api', '1');
      if (fresh) url.searchParams.set('origin', `${loc.lat},${loc.lng}`);
      url.searchParams.set('destination', a.destination);
      url.searchParams.set('travelmode', a.mode || 'driving');
      ctx.card({ kind: 'maps', title: a.destination, subtitle: `Itinéraire ${({ driving: 'en voiture', walking: 'à pied', bicycling: 'à vélo', transit: 'en transports' })[a.mode || 'driving']} · depuis ta position`, url: url.toString() });
      return { shown: true, origin: fresh ? 'position partagée' : 'position du téléphone dans Google Maps', url: url.toString() };
    } },
  { name: 'maps_search', plugin: 'maps', kind: 'read', label: 'Recherche Maps', description: 'Ouvre une recherche de lieux dans Google Maps (autour de l’utilisateur si sa position est partagée).',
    parameters: { query: str('Ce qu’il faut chercher') }, required: ['query'],
    run: (u, a, ctx) => {
      const loc = db.get('SELECT * FROM locations WHERE user_id = ?', u);
      const url = new URL('https://www.google.com/maps/search/');
      url.searchParams.set('api', '1');
      url.searchParams.set('query', loc && Date.now() - loc.at < 30 * 60000 ? `${a.query} near ${loc.lat},${loc.lng}` : a.query);
      ctx.card({ kind: 'maps', title: a.query, subtitle: 'Recherche dans Google Maps', url: url.toString() });
      return { shown: true };
    } },
  { name: 'get_location', plugin: null, kind: 'read', label: 'Localisation', description: 'Dernière position partagée par le téléphone de l’utilisateur.',
    parameters: {}, run: (u) => {
      const loc = db.get('SELECT * FROM locations WHERE user_id = ?', u);
      if (!loc) return { available: false, hint: 'L’utilisateur peut activer Paramètres › Localisation dans l’app.' };
      return { available: true, lat: loc.lat, lng: loc.lng, accuracyMeters: Math.round(loc.accuracy || 0), ageMinutes: Math.round((Date.now() - loc.at) / 60000) };
    } },
  // ------------------------------------------------ The Glyph itself
  { name: 'send_message', plugin: null, kind: 'internal', label: '',
    description: 'Envoie tout de suite un message séparé dans la conversation (pour enchaîner plusieurs messages).',
    parameters: { text: str('Message') }, required: ['text'], run: (u, a, ctx) => { ctx.say(a.text); return { sent: true }; } },
  { name: 'ask_user', plugin: null, kind: 'internal', label: '',
    description: 'Pose une question à l’utilisateur avec 3 propositions courtes, affichées dans une mini-fenêtre (il peut aussi écrire sa propre réponse ou choisir « Plus tard »). Après cet appel, termine ton tour et attends sa réponse.',
    parameters: { question: str('La question, courte'), options: { type: 'array', items: { type: 'string' }, description: '3 propositions concrètes et courtes (quelques mots chacune)' } },
    required: ['question', 'options'],
    run: (u, a, ctx) => {
      const options = (Array.isArray(a.options) ? a.options : []).map(o => String(o || '').trim().slice(0, 80)).filter(Boolean).slice(0, 4);
      const question = String(a.question || '').trim().slice(0, 200);
      if (!question || !options.length) return { error: 'Question ou propositions manquantes.' };
      ctx.card({ kind: 'ask', title: question, question, options });
      return { asked: true, note: 'Mini-fenêtre affichée. N’ajoute rien : sa réponse arrivera comme prochain message.' };
    } },
  { name: 'schedule_message', plugin: null, kind: 'internal', label: 'Rappel programmé',
    description: 'Programme un message (avec notification) à une date donnée, éventuellement répété. Ex. « C’est l’heure de ta séance de sport ».',
    parameters: { at: str('Date ISO 8601 avec fuseau'), text: str('Message à envoyer'), repeat: str('Répétition', { enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'] }) }, required: ['at', 'text'],
    run: (u, a, ctx) => ctx.schedule('message', a.at, { text: a.text }, a.repeat) },
  { name: 'schedule_task', plugin: null, kind: 'internal', label: 'Tâche programmée',
    description: 'Programme une mission que le Glyphe exécutera seul à une date donnée, éventuellement répétée (ex. trier les mails chaque matin à 8 h).',
    parameters: { at: str('Date ISO 8601 avec fuseau'), instruction: str('Ce qu’il faudra faire'), repeat: str('Répétition', { enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'] }) }, required: ['at', 'instruction'],
    run: (u, a, ctx) => ctx.schedule('run', a.at, { instruction: a.instruction }, a.repeat) },
  { name: 'list_scheduled', plugin: null, kind: 'read', label: '', description: 'Liste les messages et missions programmés de ce Glyphe.', parameters: {},
    run: (u, a, ctx) => db.all("SELECT id, kind, payload, due_at, repeat FROM jobs WHERE user_id = ? AND glyph_id = ? AND status = 'scheduled' ORDER BY due_at", u, ctx.glyph.id)
      .map(j => ({ id: j.id, kind: j.kind, ...db.json(j.payload, {}), at: new Date(j.due_at).toISOString(), repeat: j.repeat || 'none' })) },
  { name: 'cancel_scheduled', plugin: null, kind: 'internal', label: '', description: 'Annule un message ou une mission programmé.',
    parameters: { id: str('Id renvoyé par list_scheduled') }, required: ['id'],
    run: (u, a, ctx) => ({ cancelled: db.run("UPDATE jobs SET status = 'cancelled' WHERE id = ? AND user_id = ? AND glyph_id = ?", a.id, u, ctx.glyph.id).changes > 0 }) },
];
const BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));

function when(value) {
  const d = new Date(value);
  return isNaN(d) ? String(value) : d.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: process.env.GLYPHES_TZ || 'Europe/Paris' });
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

// Tools offered to the model: those of connected plugins plus the Glyph's own.
function available(userId) {
  const plugins = Object.fromEntries(google.pluginStatus(userId).map(p => [p.id, p.connected]));
  return TOOLS.filter(t => !t.plugin || plugins[t.plugin]);
}
function schema(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description,
    parameters: { type: 'object', properties: tool.parameters, required: tool.required || [], additionalProperties: false } } };
}
// The single decision point. `mode` is the Glyph's mode.
function needsConfirmation(tool, mode) {
  if (tool.kind === 'irreversible') return true;
  if (tool.kind === 'write') return mode !== 'autonomous';
  return false;
}
function cardFor(tool, args) {
  const base = tool.card ? tool.card(args) : { title: tool.label || tool.name, fields: [] };
  return { ...base, irreversible: tool.kind === 'irreversible',
    note: tool.kind === 'irreversible' ? 'Action définitive : elle ne pourra pas être annulée.' : base.note || '' };
}

module.exports = { TOOLS, BY_NAME, available, schema, needsConfirmation, cardFor, when };
