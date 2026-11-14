'use strict';

// Run with scripts/chat-test-guard.cjs: no real DB, Gemini or credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { createChatRouter } = require('../routes/chat');
const { createSessionCodec, chatError } = require('../ai/sessions');
const { deserializeMemory } = require('../ai/memory');

async function fixture(t) {
    const saved = new Map();
    const counts = { calls: 0, saves: 0, store: 0 };
    let failure = null;
    let reply = null;
    const codec = createSessionCodec('offline-recovery-fixture-secret');
    const assistant = { async reply(input) {
        counts.calls++;
        if (reply) return reply(input);
        if (failure) throw failure;
        return { message: 'Phản hồi kiểm tra kỹ thuật.', products: [], warnings: [], follow_up: null, code: 'OK', memory: deserializeMemory(null) };
    } };
    const store = { async withSession({ sessionId }, action) {
        counts.store++;
        return action({ async findRequest(id) { return saved.get(`${sessionId}:${id}`) || null; },
            async history() { return []; }, async loadMemory() { return null; },
            async savePair({ requestId, hash, response }) {
                counts.saves++;
                saved.set(`${sessionId}:${requestId}`, { request_hash: hash, response });
            } });
    } };
    const app = express();
    app.use(express.json());
    app.use('/api/chat', createChatRouter({ pipeline: 'orchestrator', assistant, store, sessionCodec: codec }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const post = (path, body, options = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/chat${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options,
    });
    return { counts, codec, post, setFailure(value) { failure = value; }, setReply(value) { reply = value; } };
}

test('recovery session issuance does not invoke the store or Gemini; replay does not save or generate twice', async t => {
    const f = await fixture(t);
    const request_id = randomUUID();
    const sessionResponse = await f.post('/session', { request_id });
    const { session_id } = await sessionResponse.json();
    assert.equal(f.codec.verify(session_id), true);
    assert.equal(sessionResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(f.counts, { calls: 0, saves: 0, store: 0 });
    const request = { request_id, session_id, message: 'Kiểm tra kỹ thuật' };
    // Receiving the same POST again is also how a lost response is recovered.
    assert.equal((await (await f.post('', request)).json()).replayed, false);
    assert.equal((await (await f.post('', request)).json()).replayed, true);
    assert.equal(f.counts.calls, 1);
    assert.equal(f.counts.saves, 1);
});

test('recovery quota failure retains the session and releases request capacity for retry', async t => {
    const f = await fixture(t);
    const request = { request_id: randomUUID(), session_id: f.codec.issue(), message: 'Kiểm tra kỹ thuật' };
    f.setFailure(chatError(503, 'GEMINI_QUOTA', 'Quota fixture'));
    const response = await f.post('', request);
    const failure = await response.json();
    assert.equal(failure.code, 'GEMINI_QUOTA');
    assert.equal(failure.session_id, request.session_id);
    assert.equal(failure.retry_after_ms, 60000);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal(f.counts.saves, 0);
    f.setFailure(null);
    assert.equal((await (await f.post('', request)).json()).success, true);
    assert.equal(f.counts.saves, 1);
});

test('recovery client disconnect aborts the orchestrator without saving a partial turn', async t => {
    const f = await fixture(t);
    let started, cancelled;
    const ready = new Promise(resolve => { started = resolve; });
    const stopped = new Promise(resolve => { cancelled = resolve; });
    f.setReply(input => new Promise((_, reject) => {
        input.signal.addEventListener('abort', () => {
            cancelled();
            reject(chatError(504, 'GEMINI_TIMEOUT', 'Cancelled fixture'));
        }, { once: true });
        started();
    }));
    const controller = new AbortController();
    const pending = f.post('', { request_id: randomUUID(), session_id: f.codec.issue(), message: 'Kiểm tra kỹ thuật' }, { signal: controller.signal });
    await ready;
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    await stopped;
    assert.equal(f.counts.saves, 0);
});
