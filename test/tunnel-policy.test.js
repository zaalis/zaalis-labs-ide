'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mobileAllowed, tunnelRouteAllowed } = require('../tunnel-policy');

test('mobile policy authorizes exact method and route pairs', () => {
  assert.equal(mobileAllowed('POST', '/chat'), true);
  assert.equal(mobileAllowed('GET', '/keys'), false);
  assert.equal(mobileAllowed('PUT', '/keys'), false);
  assert.equal(mobileAllowed('POST', '/exec'), false);
  assert.equal(mobileAllowed('POST', '/recent-projects'), false);
});

test('tunnel policy never exposes desktop authentication or execution', () => {
  assert.equal(tunnelRouteAllowed('GET', '/m'), true);
  assert.equal(tunnelRouteAllowed('GET', '/mobile/mobile.js'), true);
  assert.equal(tunnelRouteAllowed('POST', '/api/chat'), true);
  assert.equal(tunnelRouteAllowed('POST', '/api/auth/register'), false);
  assert.equal(tunnelRouteAllowed('POST', '/api/auth/login'), false);
  assert.equal(tunnelRouteAllowed('POST', '/api/exec'), false);
  assert.equal(tunnelRouteAllowed('PUT', '/api/keys'), false);
});
