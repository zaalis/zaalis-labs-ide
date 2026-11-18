'use strict';
// Correcteur orthographique façon Chrome : activation, choix des langues
// (toutes les sessions de profil, navigation privée comprise) et dictionnaire
// personnel. Réglages dans la page « Langues » (interface/languages.html).

const DEFAULT_LANGS = ['fr-FR', 'en-US'];

function init(ctx) {
  const { path, electron } = ctx;
  const { session } = electron;
  const prefsFile = () => path.join(ctx.dataFolder, 'spellcheck.json');
  let prefs = { enabled: true, languages: DEFAULT_LANGS.slice() };

  function sessions() {
    const out = [];
    for (const p of ctx.readyPartitions) { try { out.push(session.fromPartition(p)); } catch {} }
    return out;
  }
  function currentSession() {
    const t = ctx.activeTab();
    if (t && !t.incognito) return t.view.webContents.session;
    return session.fromPartition(ctx.browserPartition());
  }
  function available() {
    try { return session.fromPartition(ctx.browserPartition()).availableSpellCheckerLanguages || []; } catch { return []; }
  }
  // « fr » ou « fr-FR » -> code proposé par le moteur (fr-FR, fr…).
  function resolve(codes, avail) {
    const out = [];
    for (const c of codes) {
      const exact = avail.find(a => a.toLowerCase() === String(c).toLowerCase());
      const loose = exact || avail.find(a => a.toLowerCase().split('-')[0] === String(c).toLowerCase().split('-')[0]);
      if (loose && !out.includes(loose)) out.push(loose);
    }
    return out;
  }
  function apply(ses) {
    try {
      ses.setSpellCheckerEnabled(!!prefs.enabled);
      const avail = ses.availableSpellCheckerLanguages || [];
      // macOS : correcteur du système, la liste de langues est ignorée.
      if (process.platform !== 'darwin' && avail.length) {
        const langs = resolve(prefs.languages, avail);
        ses.setSpellCheckerLanguages(langs.length ? langs : resolve(DEFAULT_LANGS, avail));
      }
    } catch (e) { console.error('[spellcheck]', e.message); }
  }
  function applyAll() { for (const s of sessions()) apply(s); }
  function save() { ctx.writeJson(prefsFile(), prefs); }

  function publicState() {
    let active = [];
    try { active = currentSession().getSpellCheckerLanguages(); } catch {}
    return { enabled: !!prefs.enabled, languages: prefs.languages.slice(), active, available: available(), platform: process.platform };
  }

  prefs = Object.assign(prefs, ctx.readJson(prefsFile(), {}));
  ctx.on('session', (ses) => apply(ses));
  ctx.alias('languages', 'languages.html');
  ctx.alias('spellcheck', 'languages.html');

  const opts = { pages: ['languages.html'] };
  ctx.rpc('spellState', () => publicState(), opts);
  ctx.rpc('spellSet', (p) => {
    if ('enabled' in p) prefs.enabled = !!p.enabled;
    if (Array.isArray(p.languages)) prefs.languages = p.languages.map(String).filter(Boolean).slice(0, 12);
    save(); applyAll();
    return publicState();
  }, opts);
  ctx.rpc('spellWords', async () => {
    try { return (await currentSession().listWordsInSpellCheckerDictionary()).sort((a, b) => a.localeCompare(b)); } catch { return []; }
  }, opts);
  ctx.rpc('spellAddWord', (p) => {
    const w = String(p.word || '').trim();
    if (!w || /\s/.test(w) || w.length > 60) throw new Error('Un seul mot, sans espace.');
    for (const s of sessions()) { try { s.addWordToSpellCheckerDictionary(w); } catch {} }
    return true;
  }, opts);
  ctx.rpc('spellRemoveWord', (p) => {
    for (const s of sessions()) { try { s.removeWordFromSpellCheckerDictionary(String(p.word || '')); } catch {} }
    return true;
  }, opts);

  return { publicState, applyAll, prefs: () => prefs };
}

module.exports = { init };
