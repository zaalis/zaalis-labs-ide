'use strict';

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scripts = path.join(__dirname, '..', 'interface', 'script');

test('all browser UI scripts parse before packaging', () => {
  for (const name of fs.readdirSync(scripts).filter((entry) => entry.endsWith('.js'))) {
    const file = path.join(scripts, name);
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  }
});
