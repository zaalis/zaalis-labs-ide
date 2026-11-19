'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../interface/script/ui.js'), 'utf8');
const initializer = source.slice(source.indexOf('let authenticatedInit = null;'), source.indexOf('function setupAuth()'));

test('all authenticated entries refresh providers before restoring selection and share in-flight initialization', async () => {
  const calls = []; let release;
  const providers = new Promise(resolve => { release = resolve; });
  const scope = vm.createContext({ window: { ZaalisWorkspace: { refreshCapabilities: () => calls.push('capabilities') } },
    showApp: email => calls.push(`show:${email}`), applyServerProfile() {},
    loadPermissionPreference: async () => calls.push('permissions'), loadSharedHardwareConfig: async () => calls.push('config'),
    loadUserChats: async () => calls.push('chats'), loadCompatProviders: async () => { calls.push('providers:start'); await providers; calls.push('providers:ready'); },
    migrateRetiredModelState() {}, restoreConfiguredModelSelection: () => calls.push('selection'),
    openSavedProject() {}, syncOllamaModels() {}, loadGgufModels() {}, setTimeout() {},
  });
  vm.runInContext(initializer, scope);
  const first = scope.initializeAuthenticatedApp({ email: 'qa@local', profile: {} });
  const same = scope.initializeAuthenticatedApp({ email: 'qa@local', profile: {} });
  assert.equal(first, same); assert.equal(calls.includes('selection'), false);
  release(); await first;
  assert.ok(calls.indexOf('providers:ready') < calls.indexOf('selection'));
  assert.equal(calls.filter(call => call === 'chats').length, 1);
  await scope.initializeAuthenticatedApp({ email: 'qa@local', profile: {} });
  assert.equal(calls.filter(call => call === 'providers:start').length, 2, 'a later login refreshes instead of using an old guest result');
});
