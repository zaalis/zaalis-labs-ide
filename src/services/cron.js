'use strict';

// Five-field cron expressions (minute hour day-of-month month day-of-week), in
// the server's local time. Supports *, lists, ranges, steps and the usual
// aliases. Like Vixie cron, when both day fields are restricted a day matches
// either of them.

const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day', 1, 31], ['month', 1, 12], ['weekday', 0, 7]];

function value(text, label) {
  const lower = String(text).toLowerCase();
  if (lower in NAMES) return NAMES[lower];
  if (!/^\d+$/.test(lower)) throw new Error(`Cron : valeur invalide « ${text} » (${label}).`);
  return Number(lower);
}

function field(text, [label, min, max]) {
  const set = new Set();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Cron : pas invalide (${label}).`);
    let from, to;
    if (range === '*') { from = min; to = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); from = value(a, label); to = value(b, label); }
    else { from = value(range, label); to = stepText === undefined ? from : max; }
    if (from < min || to > max || from > to) throw new Error(`Cron : ${label} hors limites (${min}-${max}).`);
    for (let n = from; n <= to; n += step) set.add(label === 'weekday' && n === 7 ? 0 : n);
  }
  return set;
}

function parse(expression) {
  const text = String(expression || '').trim().replace(/\s+/g, ' ');
  const source = ALIASES[text.toLowerCase()] || text;
  const parts = source.split(' ');
  if (parts.length !== 5) throw new Error('Cron : cinq champs attendus « minute heure jour mois jourSemaine ».');
  const [minute, hour, day, month, weekday] = parts.map((part, index) => field(part, FIELDS[index]));
  return { expression: text, minute, hour, day, month, weekday, dayRestricted: parts[2] !== '*', weekdayRestricted: parts[4] !== '*' };
}

function dayMatches(spec, date) {
  const dom = spec.day.has(date.getDate()), dow = spec.weekday.has(date.getDay());
  if (spec.dayRestricted && spec.weekdayRestricted) return dom || dow;
  if (spec.dayRestricted) return dom;
  if (spec.weekdayRestricted) return dow;
  return true;
}

// Next run strictly after `from` (milliseconds), or null within five years.
function next(expression, from = Date.now()) {
  const spec = typeof expression === 'string' ? parse(expression) : expression;
  const date = new Date(from);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = from + 5 * 366 * 86400000;
  while (date.getTime() <= limit) {
    if (!spec.month.has(date.getMonth() + 1)) { date.setMonth(date.getMonth() + 1, 1); date.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(spec, date)) { date.setDate(date.getDate() + 1); date.setHours(0, 0, 0, 0); continue; }
    if (!spec.hour.has(date.getHours())) { date.setHours(date.getHours() + 1, 0, 0, 0); continue; }
    if (!spec.minute.has(date.getMinutes())) { date.setMinutes(date.getMinutes() + 1, 0, 0); continue; }
    return date.getTime();
  }
  return null;
}

module.exports = { parse, next };
