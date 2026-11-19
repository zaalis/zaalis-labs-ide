'use strict';
// Live updates: every open app or IDE of a user holds one Server-Sent Events
// stream. Events only ever go to the streams of the user they belong to.
const streams = new Map(); // userId -> Set<res>

function attach(userId, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let set = streams.get(userId);
  if (!set) streams.set(userId, set = new Set());
  set.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); set.delete(res); if (!set.size) streams.delete(userId); });
}
function emit(userId, type, data) {
  const set = streams.get(userId);
  if (!set) return 0;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
  return set.size;
}
const online = (userId) => (streams.get(userId) || new Set()).size > 0;

module.exports = { attach, emit, online };
