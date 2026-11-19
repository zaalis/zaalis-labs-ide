'use strict';
// Reminders and recurring missions. A job is claimed before it runs, so a
// restart in the middle never fires it twice; repeating jobs are moved to
// their next date in the same step.
const db = require('./db');
const agent = require('./agent');
const push = require('./push');
const events = require('./events');

function nextDue(due, repeat) {
  const d = new Date(due);
  if (repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (repeat === 'weekdays') { do d.setDate(d.getDate() + 1); while ([0, 6].includes(d.getDay())); }
  else return null;
  return d.getTime();
}
function tick() {
  const due = db.all("SELECT * FROM jobs WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at LIMIT 20", Date.now());
  for (const job of due) {
    let next = job.repeat ? nextDue(job.due_at, job.repeat) : null;
    while (next && next <= Date.now()) next = nextDue(next, job.repeat); // skip missed occurrences after downtime
    const claimed = next
      ? db.run("UPDATE jobs SET due_at = ? WHERE id = ? AND status = 'scheduled' AND due_at = ?", next, job.id, job.due_at).changes
      : db.run("UPDATE jobs SET status = 'done' WHERE id = ? AND status = 'scheduled'", job.id).changes;
    if (!claimed) continue;
    const glyph = db.get('SELECT * FROM glyphs WHERE id = ? AND user_id = ?', job.glyph_id, job.user_id);
    if (!glyph || glyph.status === 'paused') continue;
    const payload = db.json(job.payload, {});
    if (job.kind === 'message') {
      agent.addMessage(job.user_id, glyph.id, 'assistant', payload.text, { scheduled: true });
      const online = events.online(job.user_id);
      agent.setGlyph(job.user_id, glyph.id, online ? { status: 'done' } : { status: 'done', unread: glyph.unread + 1 });
      push.notify(job.user_id, { title: glyph.name, body: payload.text, glyphId: glyph.id, tag: 'job-' + job.id });
    } else if (job.kind === 'run') {
      agent.addMessage(job.user_id, glyph.id, 'user', `[Mission programmée] ${payload.instruction}`, { event: true, label: `Mission programmée : ${payload.instruction}`, ok: true, scheduled: true });
      agent.enqueue(job.user_id, glyph.id, 'scheduled');
    }
  }
}
let timer;
function start() { tick(); timer = setInterval(() => { try { tick(); } catch (error) { console.error('[glyphes] scheduler', error); } }, 15000); timer.unref(); }
function stop() { clearInterval(timer); }

module.exports = { start, stop, tick, nextDue };
