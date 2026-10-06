'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Exercise the server's token lifecycle without starting listeners or using
// real accounts. Storage and the upstream refresh are controlled boundaries.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('const accountRefreshes = new Map();');
const end = source.indexOf('async function withAccountToken', start);
assert.ok(start >= 0 && end > start);
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture(refresh) {
    const user = { id: 'test-user', session: { accessToken: 'old', refreshToken: 'old-refresh' } };
    const writes = [];
    const context = { crypto, loadUsers: () => [user], accountSession: current => current.session,
        storeAccountSession: (_id, _provider, session) => { user.session = session; writes.push(session); },
        accountSubscriptions: { needsRefresh: () => true, refresh } };
    vm.runInNewContext(source.slice(start, end) + '\nglobalThis.accessToken = accountAccessToken;', context);
    return { user, writes, token: () => context.accessToken(user.id, 'xai') };
}

test('disconnect while refreshing cannot restore the removed account', async () => {
    const upstream = deferred();
    const f = fixture(() => upstream.promise);
    const token = f.token();
    f.user.session = null;
    upstream.resolve({ accessToken: 'renewed', refreshToken: 'renewed-refresh' });
    await assert.rejects(token, error => error.status === 401);
    assert.equal(f.user.session, null);
    assert.equal(f.writes.length, 0);
});

test('an old refresh failure cannot disconnect a newly connected account', async () => {
    const upstream = deferred();
    const f = fixture(() => upstream.promise);
    const token = f.token();
    f.user.session = { accessToken: 'new-account', refreshToken: 'new-account-refresh' };
    upstream.reject(Object.assign(new Error('revoked old token'), { status: 401, relogin: true }));
    await assert.rejects(token, /revoked/);
    assert.equal(f.user.session.accessToken, 'new-account');
    assert.equal(f.writes.length, 0);
});

test('a new account gets its own refresh while the old one is still pending', async () => {
    const pending = [deferred(), deferred()];
    let calls = 0;
    const f = fixture(() => pending[calls++].promise);
    const old = f.token();
    const duplicate = f.token();
    f.user.session = { accessToken: 'new-account', refreshToken: 'new-account-refresh' };
    const current = f.token();
    assert.equal(calls, 2, 'same session shares a refresh; another session does not');
    pending[0].resolve({ accessToken: 'old-renewed', refreshToken: 'old-renewed-refresh' });
    await assert.rejects(old, error => error.status === 401);
    await assert.rejects(duplicate, error => error.status === 401);
    pending[1].resolve({ accessToken: 'new-renewed', refreshToken: 'new-renewed-refresh' });
    assert.equal(await current, 'new-renewed');
    assert.equal(f.writes.length, 1);
});
