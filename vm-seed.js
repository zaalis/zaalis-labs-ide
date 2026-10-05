'use strict';
// Small ISO9660 NoCloud seed. Linux mounts ISO names as lower case.
function seedIso(files) {
  const block = 2048, entries = Object.entries(files), out = Buffer.alloc((21 + entries.reduce((n, [, v]) => n + Math.ceil(Buffer.byteLength(v) / block), 0)) * block);
  const both16 = (b, p, n) => { b.writeUInt16LE(n, p); b.writeUInt16BE(n, p + 2); };
  const both32 = (b, p, n) => { b.writeUInt32LE(n, p); b.writeUInt32BE(n, p + 4); };
  function record(extent, size, name, dir = false) {
    const id = Buffer.isBuffer(name) ? name : Buffer.from(name);
    const b = Buffer.alloc(33 + id.length + (id.length % 2 === 0 ? 1 : 0));
    b[0] = b.length; both32(b, 2, extent); both32(b, 10, size);
    b.set([126, 1, 1, 0, 0, 0, 0], 18); b[25] = dir ? 2 : 0; both16(b, 28, 1); b[32] = id.length; id.copy(b, 33); return b;
  }
  const pvd = out.subarray(16 * block, 17 * block);
  pvd[0] = 1; pvd.write('CD001', 1); pvd[6] = 1; pvd.fill(32, 8, 72); pvd.write('CIDATA', 40);
  both32(pvd, 80, out.length / block); both16(pvd, 120, 1); both16(pvd, 124, 1); both16(pvd, 128, block);
  both32(pvd, 132, 10); pvd.writeUInt32LE(18, 140); pvd.writeUInt32BE(19, 148); record(20, block, Buffer.from([0]), true).copy(pvd, 156); pvd[881] = 1;
  out[17 * block] = 255; out.write('CD001', 17 * block + 1); out[17 * block + 6] = 1;
  for (const [sector, be] of [[18, false], [19, true]]) { const p = sector * block; out[p] = 1; if (be) { out.writeUInt32BE(20, p + 2); out.writeUInt16BE(1, p + 6); } else { out.writeUInt32LE(20, p + 2); out.writeUInt16LE(1, p + 6); } }
  let pos = 20 * block, extent = 21;
  for (const id of [0, 1]) { const r = record(20, block, Buffer.from([id]), true); r.copy(out, pos); pos += r.length; }
  for (const [name, value] of entries) { const data = Buffer.from(value); const r = record(extent, data.length, name.toUpperCase() + '.;1'); r.copy(out, pos); pos += r.length; data.copy(out, extent * block); extent += Math.ceil(data.length / block); }
  return out;
}
module.exports = { seedIso };
