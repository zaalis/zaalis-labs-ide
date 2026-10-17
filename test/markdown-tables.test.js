'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../interface/script/markdown-tables.js'), 'utf8'), context);
const render = (text, inline = value => value) => context.window.ZaalisMarkdownTables.tableAt(text.split('\n'), 0, inline);
test('tables retain alignment, escaped pipes and inline markup without eating following blocks', () => {
  const result = render('| Name | Value |\n|:---|---:|\n|A \\| B|**Ready**|\n\n## Next', value => value.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'));
  assert.equal(result.nextIndex, 3); assert.match(result.html, /<thead>/); assert.match(result.html, /text-align:right/);
  assert.match(result.html, /A \| B/); assert.match(result.html, /<strong>Ready<\/strong>/); assert.doesNotMatch(result.html, /Next/);
});
test('ordinary pipe text and incomplete streams stay plain until a valid table separator arrives', () => {
  assert.equal(render('a | b\nnot a separator'), null);
  assert.equal(render('|a|b|\n|-|---|'), null);
  assert.equal(render('a | b'), null);
  const result = render('| &lt;script&gt; | A |\n|---|---|\n|x|y|');
  assert.match(result.html, /&lt;script&gt;/); assert.doesNotMatch(result.html, /<script>/);
});

test('the actual chat renderer supports tables while keeping fenced tables as escaped code', () => {
  const source = fs.readFileSync(path.join(__dirname, '../interface/script/ai.js'), 'utf8');
  const renderer = source.slice(source.indexOf('function renderMarkdown(src)'), source.indexOf("document.addEventListener('click', async event"));
  const scope = vm.createContext({ window: context.window,
    escapeHTML: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'),
    fenceFilePath: () => null, uiTemplate: value => value,
  });
  vm.runInContext(renderer + '\nthis.render = renderMarkdown;', scope);
  const table = '| Name | Value |\n|---|---|\n|Safe|[docs](https://example.org)|';
  const html = scope.render(table + '\n\n```text\n' + table + '\n<script>bad()</script>\n```');
  assert.equal((html.match(/<table>/g) || []).length, 1);
  assert.match(html, /<a href="https:\/\/example.org"/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
