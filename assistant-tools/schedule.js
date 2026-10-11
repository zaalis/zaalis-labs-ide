'use strict';
const { fail } = require('./common');
function parseSchedule(value, now = Date.now(), timeZone = 'Europe/Paris') {
  if (typeof value !== 'string') throw fail('Schedule must be a date, interval or five-field cron expression.');
  const raw = value.trim(), duration = /^(every|in)\s+(\d+)\s*(s|m|h|d)$/i.exec(raw);
  if (duration) {
    const milliseconds = Number(duration[2]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[duration[3].toLowerCase()]);
    if (milliseconds < 60000 || milliseconds > 31536000000) throw fail('Schedule interval must be between one minute and one year.');
    return { type: duration[1].toLowerCase() === 'every' ? 'interval' : 'once', intervalMs: milliseconds, nextAt: now + milliseconds, text: raw, timeZone };
  }
  const fields = raw.split(/\s+/);
  if (fields.length === 5) {
    const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    const parts = fields.map((field, index) => fieldSet(field, ...limits[index]));
    const normalized = { type: 'cron', fields, parts, text: raw, timeZone };
    normalized.nextAt = nextCron(normalized, now); return normalized;
  }
  const date = Date.parse(raw);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(raw) || !Number.isFinite(date) || date <= now) throw fail('One-shot schedule must be a future ISO date with its timezone.');
  return { type: 'once', nextAt: date, text: raw, timeZone };
}
function fieldSet(raw, min, max) {
  const values = new Set();
  for (const piece of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece); if (!m) throw fail('Invalid cron field.');
    const step = Number(m[2] || 1); if (step < 1 || step > max + 1) throw fail('Invalid cron step.');
    const bounds = m[1] === '*' ? [min, max] : m[1].split('-').map(Number);
    const start = bounds[0], end = bounds.length > 1 ? bounds[1] : (m[2] ? max : start);
    if (start < min || end > max || end < start) throw fail('Cron value out of range.');
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return [...values];
}
function nextCron(schedule, after) {
  let formatter; try { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timeZone, minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short', hourCycle: 'h23' }); } catch { throw fail('Unknown timezone.'); }
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (let time = Math.floor(after / 60000) * 60000 + 60000, end = time + 370 * 86400000; time < end; time += 60000) {
    const p = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type, p.value])), week = weekdays[p.weekday];
    const dayMatch = schedule.parts[2].includes(Number(p.day)), weekMatch = schedule.parts[4].includes(week) || (week === 0 && schedule.parts[4].includes(7));
    const day = schedule.fields[2] === '*' ? weekMatch : schedule.fields[4] === '*' ? dayMatch : dayMatch || weekMatch;
    if (schedule.parts[0].includes(Number(p.minute)) && schedule.parts[1].includes(Number(p.hour)) && schedule.parts[3].includes(Number(p.month)) && day) return time;
  }
  throw fail('Cron expression has no occurrence within a year.');
}
function advance(schedule, now) { return schedule.type === 'interval' ? now + schedule.intervalMs : schedule.type === 'cron' ? nextCron(schedule, now) : null; }
module.exports = { parseSchedule, nextCron, advance };
