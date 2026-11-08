import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_ORIGIN } from '../src/services/api.js';
import { CHAT_TIMEOUT_MS, createChatRequestId, sendChatMessage } from '../src/services/chat.js';

// This suite never imports backend code. Every fetch is replaced with a stub.
const requestId = '4e55c407-9b05-4d61-83b2-dc5902fabdc9';
const session = `${'a'.repeat(43)}.${'b'.repeat(43)}`;
const request = () => ({ message: '  Tư vấn thức ăn cho mèo 🐾  ', request_id: requestId });
const product = () => ({ product_id: 12, category_id: 1, category_name: 'Thức ăn', name: 'Thức ăn cho mèo',
  price: '125000.00', stock_quantity: 3, image_url: '/images/products/test.webp', status: 'Đang bán', available: true, source: 'MySQL' });
const answer = (changes = {}) => ({ success: true, session_id: session, request_id: requestId,
  message: 'Bạn có thể xem lựa chọn bên dưới.', products: [product()], follow_up: 'Bé bao nhiêu tuổi?', warnings: [], code: 'OK', replayed: false, ...changes });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('sends only the real chat contract and preserves exact message text', async t => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, options) => { sent = { url, options }; return json(answer()); });
  const result = await sendChatMessage({ ...request(), history: [{ text: 'do not send' }], user_id: 99, mode: 'product' });
  assert.equal(sent.url, `${API_ORIGIN}/api/chat`);
  assert.equal(sent.options.method, 'POST');
  assert.equal(sent.options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(sent.options.body), request());
  assert.equal(result.session_id, session);
  assert.deepEqual(result.products, [product()]);
  assert.equal(result.follow_up, 'Bé bao nhiêu tuổi?');
});

test('authenticated follow-up sends bearer and the original session and request IDs', async t => {
  const payload = { ...request(), session_id: session };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer offline-test-token');
    assert.deepEqual(JSON.parse(options.body), payload);
    return json(answer({ replayed: true }));
  });
  assert.equal((await sendChatMessage(payload, { token: 'offline-test-token' })).replayed, true);
});

test('success may contain plain text markup and safe defaults for optional fields', async t => {
  t.mock.method(globalThis, 'fetch', async () => json(answer({ message: '<img src=x onerror=alert(1)>', follow_up: undefined, warnings: undefined, products: [] })));
  const result = await sendChatMessage(request());
  assert.equal(result.message, '<img src=x onerror=alert(1)>');
  assert.equal(result.follow_up, null);
  assert.deepEqual(result.warnings, []);
});

test('generates UUIDs accepted by the backend', () => {
  const ids = Array.from({ length: 12 }, createChatRequestId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('invalid request input stops before fetch without trimming retry content', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected network'); });
  for (const input of [null, {}, { ...request(), message: '  ' }, { ...request(), message: 'x'.repeat(2001) },
    { ...request(), message: 'hello\u0000' }, { ...request(), request_id: 'bad' }, { ...request(), session_id: 'bad' }]) {
    await assert.rejects(sendChatMessage(input), error => error.code === 'INVALID_REQUEST' && error.retryable === false);
  }
  assert.equal(calls, 0);
});

test('malformed or mismatched success envelopes are retryable and never expose raw errors', async t => {
  let data;
  t.mock.method(globalThis, 'fetch', async () => json(data));
  for (data of [answer({ request_id: '8e55c407-9b05-4d61-83b2-dc5902fabdc9' }), answer({ session_id: 'bad' }),
    answer({ message: '' }), answer({ products: [product(), product()] }), answer({ products: [{ ...product(), product_id: '12' }] }),
    answer({ products: [{ ...product(), price: '-1' }] }), answer({ products: [{ ...product(), available: 'yes' }] }),
    answer({ warnings: [55] }), answer({ replayed: 'false' }), answer({ follow_up: { html: 'private' } })]) {
    await assert.rejects(sendChatMessage(request()), error => error.code === 'INVALID_RESPONSE' && error.retryable === true && !error.message.includes('private'));
  }
  data = answer({ session_id: `${'c'.repeat(43)}.${'d'.repeat(43)}` });
  await assert.rejects(sendChatMessage({ ...request(), session_id: session }), error => error.code === 'INVALID_RESPONSE' && error.session_id === undefined);
});

test('a valid session envelope is retained when a success payload cannot be rendered', async t => {
  t.mock.method(globalThis, 'fetch', async () => json(answer({ products: [{ ...product(), stock_quantity: -1 }] })));
  await assert.rejects(sendChatMessage(request()), error => error.code === 'INVALID_RESPONSE' && error.session_id === session && error.request_id === requestId);
});

test('network failure is retryable, does not invent a session and never retries automatically', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('private transport details'); });
  await assert.rejects(sendChatMessage(request()), error => error.code === 'NETWORK_ERROR' && error.retryable && error.session_id === undefined && !error.message.includes('private'));
  assert.equal(calls, 1);
});

test('429 honors Retry-After seconds even when the backend omits session metadata', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ success: false, code: 'RATE_LIMITED', message: 'private server message' }, 429, { 'Retry-After': '7' }));
  await assert.rejects(sendChatMessage(request()), error => error.status === 429 && error.code === 'RATE_LIMITED' && error.retryAfterMs === 7000 && error.retryable && error.session_id === undefined && !error.message.includes('private'));
});

test('Retry-After HTTP dates are respected and invalid values do not delay retry', async t => {
  let header = new Date(Date.now() + 60000).toUTCString();
  t.mock.method(globalThis, 'fetch', async () => json({ success: false, code: 'CHAT_BUSY' }, 503, { 'Retry-After': header }));
  await assert.rejects(sendChatMessage(request()), error => error.retryAfterMs > 58000 && error.retryAfterMs <= 60000);
  header = 'not-a-date';
  await assert.rejects(sendChatMessage(request()), error => error.retryAfterMs === 0);
});

test('503 and 504 preserve issued session and request IDs for the same retry', async t => {
  let status = 503;
  let code = 'GEMINI_QUOTA';
  t.mock.method(globalThis, 'fetch', async () => json({ success: false, code, session_id: session, request_id: requestId, message: 'raw private failure' }, status));
  for ([status, code] of [[503, 'GEMINI_QUOTA'], [503, 'GEMINI_UNAVAILABLE'], [504, 'GEMINI_TIMEOUT']]) {
    await assert.rejects(sendChatMessage(request()), error => error.status === status && error.code === code && error.session_id === session && error.request_id === requestId && error.retryable && !error.message.includes('raw'));
  }
});

test('401, 403 and conflicting request are terminal; busy session is retryable', async t => {
  let status, code;
  t.mock.method(globalThis, 'fetch', async () => json({ success: false, code }, status));
  for ([status, code] of [[401, undefined], [403, 'SESSION_FORBIDDEN'], [409, 'REQUEST_CONFLICT']]) {
    await assert.rejects(sendChatMessage(request()), error => error.status === status && error.retryable === false);
  }
  [status, code] = [409, 'SESSION_BUSY'];
  await assert.rejects(sendChatMessage(request()), error => error.status === 409 && error.retryable === true);
});

test('malformed JSON retains HTTP failure behavior and rejects invalid success', async t => {
  let status = 503;
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>private gateway failure</html>', { status }));
  await assert.rejects(sendChatMessage(request()), error => error.status === 503 && error.retryable && !error.message.includes('private'));
  status = 200;
  await assert.rejects(sendChatMessage(request()), error => error.code === 'INVALID_RESPONSE' && error.retryable);
});

test('caller cancellation aborts fetch and is not offered as a retryable failure', async t => {
  const caller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const result = sendChatMessage(request(), { signal: caller.signal });
  caller.abort();
  await assert.rejects(result, error => error.name === 'AbortError' && error.code === 'REQUEST_ABORTED' && !error.retryable);
  await assert.rejects(sendChatMessage(request(), { signal: caller.signal }), error => error.name === 'AbortError');
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test('65-second client timeout aborts transport and remains retryable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let transport;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    transport = signal;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const result = sendChatMessage(request());
  t.mock.timers.tick(CHAT_TIMEOUT_MS - 1);
  assert.equal(transport.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(result, error => error.code === 'CLIENT_TIMEOUT' && error.retryable === true);
  assert.equal(transport.aborted, true);
});

test('client deadline includes parsing the response body and cleans up after success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let transport;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    transport = signal;
    return { ok: true, status: 200, headers: new Headers(), json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }) };
  });
  const result = sendChatMessage(request());
  await Promise.resolve();
  t.mock.timers.tick(CHAT_TIMEOUT_MS);
  await assert.rejects(result, error => error.code === 'CLIENT_TIMEOUT' && error.retryable === true);
  assert.equal(transport.aborted, true);
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => { transport = signal; return json(answer()); });
  await sendChatMessage(request());
  t.mock.timers.tick(CHAT_TIMEOUT_MS);
  assert.equal(transport.aborted, false);
});
