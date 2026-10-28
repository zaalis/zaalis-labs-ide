'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SkillsStore, REVERSE_SKILL } = require('../src/agent/skills-store');

test('skills import, precedence, activation and account isolation', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-skills-'));
  t.after(() => fs.rmSync(temp,{recursive:true,force:true}));
  const store = new SkillsStore(temp);
  const project = path.join(temp,'project'); fs.mkdirSync(project);
  assert.equal(store.get('a',project,'revers').instructions,REVERSE_SKILL);
  store.import('a', "---\r\nname: 'review'\r\ndescription: Personal\r\n---\r\n# Steps");
  assert.equal(store.get('a',project,'review').description,'Personal');
  assert.throws(() => store.get('b',project,'review'),/introuvable/);
  const override = path.join(project,'.zaalis','skills','review'); fs.mkdirSync(override,{recursive:true});
  fs.writeFileSync(path.join(override,'SKILL.md'),'---\nname: review\ndescription: Project\n---\n# Steps');
  assert.equal(store.get('a',project,'review').description,'Project');
  const before = store.revision('a',project);
  store.toggle('a','review',false,project);
  assert.notEqual(store.revision('a',project),before);
  assert.throws(() => store.get('a',project,'review'),/désactivée/);
  assert.equal(store.get('b',project,'review').enabled,true);
  store.toggle('a','review',true,project);
  assert.equal(store.get('a',project,'review').enabled,true);
  for (const name of ['../escape','..','revers','x/y','']) assert.throws(() => store.import('a',`---\nname: ${name}\n---\n# Steps`));
  assert.throws(() => store.import('a','x'.repeat(262145)),/256/);
  assert.throws(() => store.import('a','---\nname: review\n---\n# Duplicate'),/existe/);
  assert.throws(() => store.toggle('a','review','yes',project),/invalide/);
});

test('skill roots reject filesystem links instead of writing outside the library', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'zaalis-skills-links-'));
  t.after(() => fs.rmSync(temp,{recursive:true,force:true}));
  const store = new SkillsStore(temp); store.ensure('a');
  const outside = path.join(temp,'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(store.directory('a'),'skills','linked'),'junction');
  assert.throws(() => store.import('a','---\nname: linked\n---\n# Forbidden'),/symbolique/);
  assert.equal(fs.existsSync(path.join(outside,'SKILL.md')),false);
});
