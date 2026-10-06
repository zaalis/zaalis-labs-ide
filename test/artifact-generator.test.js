'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArtifact } = require('../artifact-generator');

test('PDF, Word, Excel et CSV sont de vrais fichiers locaux distincts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-export-'));
  try {
    const pdf = createArtifact(root, {format:'pdf', name:'rapport', title:'Résumé', content:'Bonjour à tous'});
    const pdf2 = createArtifact(root, {format:'pdf', name:'rapport', title:'Résumé', content:'Suite'});
    const docx = createArtifact(root, {format:'docx', name:'lettre', title:'Bonjour', content:'Été 2026'});
    const xlsx = createArtifact(root, {format:'xlsx', name:'données', sheets:[{name:'Été', rows:[['Nom','Prix'],['test',12.5]]}]});
    const csv = createArtifact(root, {format:'csv', name:'tableau', rows:[['Valeur'],['=1+1']]});
    assert.notEqual(pdf.path, pdf2.path);
    for (const item of [pdf, pdf2, docx, xlsx, csv]) assert.ok(item.path.startsWith(path.join(root, 'artifacts') + path.sep));
    assert.equal(fs.readFileSync(pdf.path).subarray(0, 8).toString(), '%PDF-1.4');
    assert.equal(fs.readFileSync(xlsx.path).subarray(0, 2).toString(), 'PK');
    assert.equal(fs.readFileSync(docx.path).subarray(0, 2).toString(), 'PK');
    assert.match(fs.readFileSync(csv.path, 'utf8'), /'\=1\+1/);
    assert.throws(() => createArtifact(root, {format:'exe', name:'x'}), /Format/);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});
