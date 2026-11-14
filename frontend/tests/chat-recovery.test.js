import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_TIMEOUT_MS, sendChatMessage, sendChatMessageWithRecovery } from '../src/services/chat.js';

const request = { message: 'Tư vấn cho mèo', request_id: '4e55c407-9b05-4d61-83b2-dc5902fabdc9' };
const session = `${'a'.repeat(43)}.${'b'.repeat(43)}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const answer = () => ({ success: true, ...request, session_id: session, products: [], warnings: [], follow_up: null, code: 'OK', replayed: true });

test('recovery reserves the first session before generation and retries identical IDs once', async t => {
  const bodies = [];
  let remembered;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (url.endsWith('/session')) return json({ success: true, request_id: request.request_id, session_id: session });
    assert.equal(remembered, session);
    if (bodies.length === 2) throw new TypeError('private network details');
    return json(answer());
  });
  const result = await sendChatMessageWithRecovery(request, { onSession: value => { remembered = value; } });
  assert.equal(result.replayed, true);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[1], { ...request, session_id: session });
  assert.deepEqual(bodies[1], bodies[2]);
});

test('recovery stops after one automatic retry; manual retry keeps the retained session and UUID', async t => {
  let online = false;
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (!online) throw new TypeError('private transport failure');
    return json(answer());
  });
  const pending = { ...request, session_id: session };
  await assert.rejects(sendChatMessageWithRecovery(pending), error => error.code === 'NETWORK_ERROR' && error.retryable);
  assert.equal(bodies.length, 2);
  online = true;
  await sendChatMessageWithRecovery(pending);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies, [pending, pending, pending]);
});

test('Gemini quota has a cooldown and never starts automatic retries', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    count++;
    return json({ success: false, code: 'GEMINI_QUOTA', retry_after_ms: 7000, session_id: session, request_id: request.request_id }, 503);
  });
  await assert.rejects(sendChatMessageWithRecovery({ ...request, session_id: session }), error =>
    error.kind === 'quota' && error.retryAfterMs === 7000 && error.retryable && !error.autoRetryable && /hạn mức/.test(error.message));
  assert.equal(count, 1);
});

test('history save failure is explicit and waits for a manual retry with the same UUID', async t => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return json({ success: false, code: 'HISTORY_SAVE_FAILED', request_id: request.request_id, session_id: session }, 503);
  });
  await assert.rejects(sendChatMessageWithRecovery({ ...request, session_id: session }), error =>
    error.code === 'HISTORY_SAVE_FAILED' && error.retryable && !error.autoRetryable && /Chưa xác nhận lưu/.test(error.message));
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].request_id, request.request_id);
});

test('hard deadline releases a transport that ignores AbortSignal, including a stalled body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  let pending = sendChatMessage(request);
  t.mock.timers.tick(CHAT_TIMEOUT_MS);
  await assert.rejects(pending, error => error.code === 'CLIENT_TIMEOUT' && error.kind === 'timeout');
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  pending = sendChatMessage(request);
  await Promise.resolve();
  t.mock.timers.tick(CHAT_TIMEOUT_MS);
  await assert.rejects(pending, error => error.code === 'CLIENT_TIMEOUT');
  t.mock.method(globalThis, 'fetch', async () => json(answer()));
  assert.equal((await sendChatMessage(request)).message, request.message);
});
