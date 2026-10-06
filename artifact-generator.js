'use strict';

// Dependency-free local document export. Files are created only inside the
// active workspace by the authenticated Rust workspace capability.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function xml(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const parts = [], directory = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const file = Buffer.from(content, 'utf8'), compressed = zlib.deflateRawSync(file);
    const filename = Buffer.from(name, 'utf8'), crc = crc32(file);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.length, 22); local.writeUInt16LE(filename.length, 26);
    parts.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(file.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralSize = directory.reduce((n, part) => n + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}

function xlsx(sheets) {
  const columnName = index => { let name = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; };
  const used = new Set();
  const normalized = sheets.map((sheet, index) => {
    let name = String(sheet.name || `Feuille ${index + 1}`).replace(/[\\/?*\[\]:]/g, '').slice(0, 31) || `Feuille ${index + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 27)} ${index + 1}`;
    used.add(name.toLowerCase());
    if (!Array.isArray(sheet.rows) || sheet.rows.length > 10000) throw new Error('Feuille invalide ou trop grande.');
    return {name, rows: sheet.rows};
  });
  if (!normalized.length || normalized.length > 20) throw new Error('Nombre de feuilles invalide.');
  const entries = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${normalized.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${normalized.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${normalized.map((_, i) => `<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}</Relationships>`],
  ];
  normalized.forEach((sheet, index) => {
    const rows = sheet.rows.map((row, ri) => {
      if (!Array.isArray(row) || row.length > 100) throw new Error('Ligne invalide ou trop large.');
      return `<row r="${ri+1}">${row.map((value, ci) => {
        const ref = `${columnName(ci)}${ri+1}`;
        if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
        if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value).slice(0, 32767)}</t></is></c>`;
      }).join('')}</row>`;
    }).join('');
    entries.push([`xl/worksheets/sheet${index+1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`]);
  });
  return zip(entries);
}

function docx(title, content) {
  const paragraphs = [title, ...String(content || '').split(/\r?\n/)];
  if (paragraphs.length > 10000) throw new Error('Document trop long.');
  const body = paragraphs.map((line, index) => `<w:p><w:pPr>${index === 0 ? '<w:pStyle w:val="Title"/>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`).join('');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`],
  ]);
}

function pdf(title, content) {
  const clean = text => String(text ?? '').normalize('NFKC').replace(/[\u0000-\u001f]/g, ' ').replace(/[^\u0020-\u00ff]/g, '?');
  const escape = text => clean(text).replace(/[\\()]/g, '\\$&');
  const lines = [];
  for (const paragraph of String(content).split(/\r?\n/)) {
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).length > 92 && line) { lines.push(line); line = ''; }
      line += (line ? ' ' : '') + word;
    }
    lines.push(line);
  }
  const pages = [], perPage = 52;
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length > 200) throw new Error('PDF trop long.');
  const objects = [null];
  const add = content => { objects.push(content); return objects.length - 1; };
  const catalog = add(''), pagesId = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  pages.forEach((pageLines, pageIndex) => {
    const commands = ['BT /F1 17 Tf 50 790 Td (' + escape(pageIndex === 0 ? title : `${title} (suite)`) + ') Tj ET'];
    pageLines.forEach((line, i) => commands.push(`BT /F1 11 Tf 50 ${760 - i*13} Td (${escape(line)}) Tj ET`));
    const stream = Buffer.from(commands.join('\n'), 'latin1');
    const streamId = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]));
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${streamId} 0 R >>`));
  });
  objects[catalog] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n%\xff\xff\xff\xff\n', 'latin1')], offsets = [0];
  objects.slice(1).forEach((object, index) => {
    offsets.push(parts.reduce((n, part) => n + part.length, 0));
    parts.push(Buffer.from(`${index+1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object, 'latin1'), Buffer.from('\nendobj\n'));
  });
  const xref = parts.reduce((n, part) => n + part.length, 0);
  parts.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(parts);
}

function csv(rows) {
  if (!Array.isArray(rows) || rows.length > 10000 || rows.some(row => !Array.isArray(row) || row.length > 100)) throw new Error('Données CSV invalides ou trop grandes.');
  return Buffer.from('\ufeff' + rows.map(row => row.map(value => {
    let cell = String(value ?? '');
    if (/^[\s]*[=+@\-\t\r]/.test(cell)) cell = "'" + cell;
    return `"${cell.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n'), 'utf8');
}

function createArtifact(root, input) {
  const format = String(input.format || '').toLowerCase();
  if (!['pdf', 'docx', 'xlsx', 'csv'].includes(format)) throw new Error('Format non pris en charge.');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 8 * 1024 * 1024) throw new Error('Données trop volumineuses.');
  const base = String(input.name || input.title || 'document').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'document';
  const dir = path.join(root, 'artifacts');
  fs.mkdirSync(dir, {recursive: true});
  if (fs.lstatSync(dir).isSymbolicLink() || !fs.realpathSync(dir).startsWith(fs.realpathSync(root) + path.sep)) throw new Error('Dossier artefacts non sûr.');
  const sheets = Array.isArray(input.sheets) ? input.sheets : [{name: 'Données', rows: input.rows}];
  const buffer = format === 'pdf' ? pdf(input.title || base, input.content || '') :
    format === 'docx' ? docx(input.title || base, input.content || '') :
    format === 'xlsx' ? xlsx(sheets) : csv(input.rows || sheets[0]?.rows || []);
  if (buffer.length > 20 * 1024 * 1024) throw new Error('Fichier trop volumineux.');
  for (let i = 0; i < 1000; i++) {
    const target = path.join(dir, `${base}${i ? '-' + i : ''}.${format}`);
    try { fs.writeFileSync(target, buffer, {flag: 'wx'}); return {path: target, bytes: buffer.length, format}; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Trop de fichiers du même nom.');
}

module.exports = {createArtifact, pdf, docx, xlsx, csv};
