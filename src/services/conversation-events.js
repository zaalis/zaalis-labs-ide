'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { safeKey } = require('./json-store');

class ConversationEvents {
  constructor(directory) { this.directory = directory; this.sequences = new Map(); }
  file(user, kind, id) { return path.join(this.directory, `${safeKey(`${user}:${kind}:${id}`)}.jsonl`); }
  append(user, kind, id, turnId, event) {
    const file = this.file(user, kind, id);
    let sequence = this.sequences.get(file);
    if (sequence === undefined) sequence = this.list(user, kind, id, 0).lastSeq;
    const frame = { seq: sequence + 1, turnId, at: Date.now(), event };
    fs.mkdirSync(this.directory, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(frame) + '\n', { mode: 0o600 });
    this.sequences.set(file, frame.seq); return frame.seq;
  }
  list(user, kind, id, fromSeq = 0, limit = 1000) {
    const file = this.file(user, kind, id), events = []; let lastSeq = 0;
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { events, lastSeq }; throw error; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let frame; try { frame = JSON.parse(line); } catch { continue; } // interrupted final append
      lastSeq = Math.max(lastSeq, Number(frame.seq) || 0);
      if (frame.seq > Number(fromSeq || 0) && events.length < Math.min(1000, Math.max(1, Number(limit) || 1000))) events.push(frame);
    }
    return { events, lastSeq, nextSeq: events.at(-1)?.seq || Number(fromSeq) || 0 };
  }
}
module.exports = { ConversationEvents };
