'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { frontend } = require('./helpers/frontend-dom');

test('native children move from active to completed with names, terminal reports and stable timestamps', () => {
  const { context } = frontend(['agent-activity.js']);
  const api = context.window.ZaalisAgentActivity, agents = [];
  const spawn = (id, parent, label) => api.update(agents, { type: 'agent_spawned', agent: { id, parent_id: parent, role: { label }, state: { state: 'running' } } }, 'session', 1000);
  spawn('lead', null, 'Assistant'); spawn('audit', 'lead', 'Audit du code'); spawn('ui', 'lead', 'Vérification interface');
  assert.equal(api.groups(agents).active.length, 2);
  api.update(agents, {type:'agent_state_changed',agent_id:'audit',state:{state:'waiting_permission'}}, 'session', 2000);
  assert.equal(api.groups(agents).active.length, 2);
  api.update(agents, {type:'agent_completed',agent_id:'audit',report:{summary:'Aucun défaut détecté.'}}, 'session', 3000);
  api.update(agents, {type:'agent_cancelled',agent_id:'ui'}, 'session', 4000);
  const saved = JSON.parse(JSON.stringify(agents));
  assert.equal(api.groups(saved).active.length, 0); assert.equal(api.groups(saved).completed.length, 2);
  assert.equal(saved.find(a => a.id === 'audit').report, 'Aucun défaut détecté.');
  api.update(agents, {type:'agent_state_changed',agent_id:'audit',state:{state:'done'}}, 'session', 100000);
  assert.equal(agents.find(a => a.id === 'audit').finishedAt, new Date(3000).toISOString());
  spawn('audit', 'lead', 'Audit du code'); assert.equal(agents.length, 3);
});

test('failed children preserve the error and terminal state when rehydrated', () => {
  const { context } = frontend(['agent-activity.js']); const api = context.window.ZaalisAgentActivity, agents = [];
  api.update(agents, {type:'agent_spawned',agent:{id:'child',parent_id:'lead',role:{label:'Analyse'},state:{state:'failed',error:'Budget dépassé'}}}, 's');
  api.update(agents, {type:'agent_failed',agent_id:'child',error:'Budget dépassé'}, 's');
  assert.equal(api.groups(agents).completed.length, 1);
  assert.equal(agents[0].error, 'Budget dépassé');
});

test('activity renders separate counted groups and a working stop action', async () => {
  const { context, document } = frontend(['agent-activity.js']); const api = context.window.ZaalisAgentActivity;
  const agents = [{id:'child',parentId:'lead',label:'Audit',state:'running',startedAt:new Date().toISOString()}];
  const pane = document.createElement('div'); document.body.append(pane); let stopped;
  const el = (tag, css, value) => {const node = document.createElement(tag); node.className = css; if(value !== undefined) node.textContent=value; return node;};
  api.render(pane, agents, {el,text:(fr)=>fr,stop:agent=>{stopped=agent.id;}});
  assert.match(pane.textContent, /Actifs · 1/); assert.match(pane.textContent,/Terminés · 0/);
  await pane.querySelector('button').emit('click'); assert.equal(stopped,'child');
  assert.equal(pane.querySelector('summary').querySelector('strong').textContent, 'Audit');
  pane.querySelector('details').open = true;
  api.render(pane, agents, {el,text:(fr)=>fr,stop() {}});
  assert.equal(pane.querySelector('details').open, true);
});
