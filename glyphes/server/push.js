'use strict';
// Web Push (VAPID). Works on iPhone for a web app added to the home screen
// (iOS 16.4+). Keys are generated once and kept in the database.
const db = require('./db');
let webpush = null;
try { webpush = require('web-push'); } catch {}

function init() {
  if (!webpush) return;
  let keys = db.json(db.kvGet('vapid'), null);
  if (!keys) { keys = webpush.generateVAPIDKeys(); db.kvSet('vapid', JSON.stringify(keys)); }
  webpush.setVapidDetails(process.env.PUBLIC_URL || 'https://localhost', keys.publicKey, keys.privateKey);
}
function publicKey() { const keys = db.json(db.kvGet('vapid'), null); return keys ? keys.publicKey : null; }
function subscribe(userId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw Object.assign(new Error('Abonnement aux notifications invalide.'), { status: 400 });
  }
  db.run(`INSERT INTO push_subs (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`, sub.endpoint, userId, JSON.stringify(sub.keys), Date.now());
}
function unsubscribe(userId, endpoint) { db.run('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?', userId, endpoint); }
async function notify(userId, { title, body, glyphId, tag }) {
  if (!webpush) return 0;
  const user = db.get('SELECT settings FROM users WHERE id = ?', userId);
  if (db.json(user && user.settings, {}).notifications === false) return 0;
  const subs = db.all('SELECT * FROM push_subs WHERE user_id = ?', userId);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) },
        JSON.stringify({ title, body: String(body || '').slice(0, 180), glyphId, tag }), { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) db.run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint);
    }
  }));
  return sent;
}

module.exports = { init, publicKey, subscribe, unsubscribe, notify, get available() { return !!webpush; } };
