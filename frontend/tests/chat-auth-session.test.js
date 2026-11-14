import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activateChatIdentity, chatRevision, clearChatOnLogout, completeChatLogin, readChatConversation,
  restoreChatConversation, saveChatConversation, CHAT_AUTH_EVENT, CHAT_OPEN_KEY } from '../src/utils/chat-session.js';

const cap = `${'a'.repeat(43)}.${'b'.repeat(43)}`;
const otherCap = `${'c'.repeat(43)}.${'d'.repeat(43)}`;
const requestId = '4e55c407-9b05-4d61-83b2-dc5902fabdc9';
const account = { user_id: 1, role: 'user' };
const saved = (identity = 'guest', session = cap, message = 'Guest conversation') => ({ identity, input: 'draft', session_id: session,
  turns: [{ request: { request_id: requestId, session_id: session, message: 'Question' }, state: 'done',
    response: { message, products: [], warnings: [], follow_up: null } }] });

function setup(t) {
  const values = new Map();
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const events = new EventTarget();
  for (const [key, value] of [['sessionStorage', storage], ['window', events]]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  let claimed = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/claim')) claimed = true;
    const allowed = body.session_id === otherCap || !claimed || options.headers.Authorization === 'Bearer account-one';
    return new Response(JSON.stringify(allowed ? { success: true, request_id: body.request_id, session_id: body.session_id, ...(body.restore_history ? { turns: [] } : {}) }
      : { success: false, code: 'SESSION_FORBIDDEN' }), { status: allowed ? 200 : 403 });
  });
  return { values, storage, events };
}

test('guest navigation and auth form suspension retain UUID, capability, draft and transcript', async t => {
  setup(t);
  activateChatIdentity('guest');
  const revision = chatRevision('guest');
  assert.equal(saveChatConversation(saved(), revision), true);
  const restored = await restoreChatConversation('guest');
  assert.equal(restored.conversation.session_id, cap);
  assert.equal(restored.conversation.turns[0].request.request_id, requestId);
  assert.equal(restored.conversation.input, 'draft');
  assert.equal(readChatConversation('guest').turns.length, 1);
});

test('explicit login transfers only the guest snapshot after backend approval and revokes stale guest saves', async t => {
  const { values } = setup(t);
  activateChatIdentity('guest');
  const before = chatRevision('guest');
  saveChatConversation(saved(), before);
  await completeChatLogin(account, 'account-one');
  const result = await restoreChatConversation('user:1', { token: 'account-one' });
  assert.equal(result.conversation.session_id, cap);
  assert.equal(result.conversation.turns[0].response.message, 'Guest conversation');
  assert.equal(readChatConversation('guest'), null);
  assert.equal(saveChatConversation(saved(), before), false);
  assert.equal([...values.values()].some(value => value.includes('account-one')), false);
});

test('logout closes chat and late unmounts cannot restore private data for a guest or a different account', async t => {
  const { storage, events } = setup(t);
  activateChatIdentity('user:1');
  const revision = chatRevision('user:1');
  saveChatConversation(saved('user:1', cap, 'Private account one'), revision);
  storage.setItem(CHAT_OPEN_KEY, '1');
  let closed = false;
  events.addEventListener(CHAT_AUTH_EVENT, () => { closed = true; });
  clearChatOnLogout();
  assert.equal(closed, true);
  assert.equal(storage.getItem(CHAT_OPEN_KEY), '0');
  assert.equal(saveChatConversation(saved('user:1'), revision), false);
  assert.equal(readChatConversation('guest'), null);
  await completeChatLogin({ user_id: 2, role: 'user' }, 'account-two');
  assert.equal((await restoreChatConversation('user:2', { token: 'account-two' })).conversation, null);
  assert.equal(readChatConversation('user:1'), null);
});

test('denied guest transfer cannot overwrite an existing private account conversation', async t => {
  setup(t);
  activateChatIdentity('user:1');
  saveChatConversation(saved('user:1', otherCap, 'Existing account conversation'), chatRevision('user:1'));
  activateChatIdentity('guest');
  // Retain an existing account snapshot as may happen after an interrupted login.
  sessionStorage.setItem('petcare.chatbot-conversation.v2.user:1', JSON.stringify({ ...saved('user:1', otherCap, 'Existing account conversation'), version: 2 }));
  saveChatConversation(saved(), chatRevision('guest'));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify(url.endsWith('/claim') ? { success: false, code: 'SESSION_FORBIDDEN' }
      : { success: true, request_id: body.request_id, session_id: body.session_id, turns: [] }), { status: url.endsWith('/claim') ? 403 : 200 });
  });
  await completeChatLogin(account, 'account-one');
  const result = await restoreChatConversation('user:1', { token: 'account-one' });
  assert.equal(result.conversation.session_id, otherCap);
  assert.equal(result.conversation.turns[0].response.message, 'Existing account conversation');
});

test('a late transfer response after logout cannot populate another account cache', async t => {
  setup(t);
  activateChatIdentity('guest'); saveChatConversation(saved(), chatRevision('guest'));
  let finish;
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise(resolve => {
    const body = JSON.parse(options.body);
    finish = () => resolve(new Response(JSON.stringify({ success: true, request_id: body.request_id, session_id: cap })));
  }));
  const pending = completeChatLogin(account, 'account-one');
  clearChatOnLogout();
  await completeChatLogin({ user_id: 2, role: 'user' }, 'account-two');
  finish(); await pending;
  assert.equal(readChatConversation('user:1'), null);
  assert.equal(readChatConversation('user:2'), null);
});

test('a restored cache is not returned when the server denies its owner', async t => {
  setup(t);
  activateChatIdentity('user:2'); saveChatConversation(saved('user:2'), chatRevision('user:2'));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: false, code: 'SESSION_FORBIDDEN' }), { status: 403 }));
  assert.equal((await restoreChatConversation('user:2', { token: 'account-two' })).conversation, null);
});

test('reload recovers a committed answer by UUID without duplicating an interrupted turn', async t => {
  setup(t);
  activateChatIdentity('guest');
  const pending = { ...saved(), turns: [{ request: saved().turns[0].request, state: 'sending' }] };
  saveChatConversation(pending, chatRevision('guest'));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.restore_history, true);
    return new Response(JSON.stringify({ success: true, request_id: body.request_id, session_id: cap,
      turns: [{ request_id: requestId, message: 'Question', response: { message: 'Committed on server', products: [], warnings: [], follow_up: null, code: 'OK' } }] }));
  });
  for (let i = 0; i < 2; i++) {
    const { conversation } = await restoreChatConversation('guest');
    assert.equal(conversation.turns.length, 1);
    assert.equal(conversation.turns[0].state, 'done');
    assert.equal(conversation.turns[0].request.request_id, requestId);
    assert.equal(conversation.turns[0].response.message, 'Committed on server');
    assert.equal(conversation.input, 'draft');
  }
});

test('a history read failure preserves cached turns and draft without claiming restoration succeeded', async t => {
  setup(t);
  activateChatIdentity('guest'); saveChatConversation(saved(), chatRevision('guest'));
  const before = readChatConversation('guest');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: false, code: 'MEMORY_UNAVAILABLE' }), { status: 503 }));
  await assert.rejects(restoreChatConversation('guest'), { code: 'MEMORY_UNAVAILABLE' });
  assert.deepEqual(readChatConversation('guest'), before);
});

test('a history response arriving after logout cannot repopulate a private cache', async t => {
  setup(t);
  activateChatIdentity('user:1'); saveChatConversation(saved('user:1'), chatRevision('user:1'));
  let finish, started;
  const loading = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise(resolve => {
    const body = JSON.parse(options.body);
    finish = () => resolve(new Response(JSON.stringify({ success: true, request_id: body.request_id, session_id: cap, turns: [] })));
    started();
  }));
  const pending = restoreChatConversation('user:1', { token: 'account-one' });
  await loading;
  clearChatOnLogout();
  finish();
  await assert.rejects(pending, { code: 'REQUEST_ABORTED' });
  assert.equal(readChatConversation('guest'), null);
  assert.equal(readChatConversation('user:1'), null);
});
