const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createQueue() {
    const context = { window: {}, document: { getElementById: () => null } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../interface/script/pending-queue.js'), 'utf8'), context);
    return new context.window.ZaalisPendingQueue('chat-input');
}
test('pending queue preserves attachment identity while reordering and draining', () => {
    const queue = createQueue();
    const attachment = { name: 'private.txt', content: 'local data' };
    const first = { message: 'first', attachments: [attachment] };
    const second = { message: 'second' };
    queue.push(first, 'chat-a'); queue.push(second, 'chat-a');
    queue.move(1, -1);
    assert.equal(queue.take(), second);
    assert.equal(queue.take().attachments[0], attachment);
    assert.equal(queue.length, 0);
    assert.equal(queue.take(), undefined);
});
test('pending queue refuses cross conversation delivery until drained', () => {
    const queue = createQueue();
    queue.push({ message: 'A' }, 'chat-a');
    assert.throws(() => queue.push({ message: 'B' }, 'chat-b'), /switching conversation/);
    assert.equal(queue.length, 1);
    queue.clear(); queue.push({ message: 'B' }, 'chat-b');
    assert.equal(queue.take().message, 'B');
});
test('moving beyond queue edges does not drop drafts', () => {
    const queue = createQueue(); const draft = { message: 'keep me' };
    queue.push(draft, 'chat-a'); queue.move(0, -1); queue.move(0, 1);
    assert.equal(queue.take(), draft);
});
