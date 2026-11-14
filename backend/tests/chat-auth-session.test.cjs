'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createChatStore, createSessionCodec, sessionStorageId } = require('../ai/sessions');
const { createChatRouter } = require('../routes/chat');

function fixture() {
  const codec = createSessionCodec('offline-chat-auth-secret');
  const cap = codec.issue();
  const id = sessionStorageId(cap);
  const original = [{ session_id: id, user_id: null, message: 'guest question', sender: 'user' },
    { session_id: id, user_id: null, message: 'unchanged memory checkpoint', sender: 'assistant' },
    { session_id: 'unrelated-session', user_id: 2, message: 'private other account', sender: 'assistant' }];
  let rows = structuredClone(original), before;
  let updates = 0, failUpdate = false;
  const connection = {
    async execute(sql, values) {
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SELECT user_id') || sql.startsWith('SELECT DISTINCT user_id')) return [rows.filter(row => row.session_id === values[0]).map(({ user_id }) => ({ user_id }))];
      if (sql.startsWith('SELECT sender')) return [rows.filter(row => row.session_id === values[0]).map(({ sender, message }) => ({ sender, message }))];
      if (sql.startsWith('UPDATE chat_histories SET user_id')) {
        updates++;
        const affected = rows.filter(row => row.session_id === values[1] && row.user_id == null);
        affected.forEach(row => { row.user_id = values[0]; });
        return [{ affectedRows: failUpdate ? 0 : affected.length }];
      }
      throw new Error('Unexpected offline query');
    },
    async beginTransaction() { before = structuredClone(rows); },
    async commit() { before = null; },
    async rollback() { rows = before; before = null; }, release() {}, destroy() {},
  };
  const store = createChatStore({ pool: { async getConnection() { return connection; } } });
  return { store, codec, cap, original, rows: () => rows, updates: () => updates, failUpdate() { failUpdate = true; } };
}

test('guest claim preserves session/history/memory, is idempotent and excludes guests or another user afterwards', async () => {
  const f = fixture();
  assert.deepEqual(await f.store.claimGuestSession({ sessionId: f.cap, userId: 1 }), { empty: false, replayed: false });
  assert.deepEqual(f.rows(), f.original.map(row => row.session_id === sessionStorageId(f.cap) ? { ...row, user_id: 1 } : row));
  assert.equal((await f.store.claimGuestSession({ sessionId: f.cap, userId: 1 })).replayed, true);
  assert.equal(f.updates(), 1);
  await assert.rejects(f.store.claimGuestSession({ sessionId: f.cap, userId: 2 }), error => error.code === 'SESSION_FORBIDDEN');
  for (const userId of [null, 2]) await assert.rejects(f.store.withSession({ sessionId: f.cap, userId, requireOwned: true }, async () => {}), error => error.code === 'SESSION_FORBIDDEN');
  assert.equal(await f.store.withSession({ sessionId: f.cap, userId: 1, requireOwned: true }, async () => 'owned'), 'owned');
});

test('failed or mixed-owner claims roll back without changing any private history', async () => {
  const f = fixture(); f.failUpdate();
  await assert.rejects(f.store.claimGuestSession({ sessionId: f.cap, userId: 1 }), error => error.code === 'SESSION_BUSY');
  assert.deepEqual(f.rows(), f.original);
  f.rows()[0].user_id = 2;
  const before = structuredClone(f.rows());
  await assert.rejects(f.store.claimGuestSession({ sessionId: f.cap, userId: 1 }), error => error.code === 'SESSION_FORBIDDEN');
  assert.deepEqual(f.rows(), before);
  const empty = f.codec.issue();
  await assert.rejects(f.store.withSession({ sessionId: empty, userId: 1, requireOwned: true }, async () => {}), error => error.code === 'SESSION_FORBIDDEN');
  assert.equal((await f.store.claimGuestSession({ sessionId: empty, userId: 1 })).empty, true);
});

test('API requires guest capability plus authenticated owner; ordinary requests never auto-claim a guest', async t => {
  const f = fixture();
  const users = require('../models/user');
  t.mock.method(users, 'byId', async id => ({ user_id: Number(id), role: 'user', status: 'active' }));
  const secret = require('../config/auth').secret;
  const tokens = [1, 2].map(id => jwt.sign({ sub: String(id) }, secret, { algorithm: 'HS256' }));
  const app = express(); app.use(express.json());
  app.use('/api/chat', createChatRouter({ pipeline: 'orchestrator', store: f.store, sessionCodec: f.codec }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = async (path, token, cap = f.cap) => fetch(`http://127.0.0.1:${server.address().port}/api/chat${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ request_id: randomUUID(), session_id: cap, ...(path === '/session' ? { restore_history: true } : {}) }),
  });
  assert.equal((await post('/session')).status, 200);
  assert.equal((await post('/session', tokens[0])).status, 403);
  assert.equal((await post('/session/claim')).status, 401);
  assert.equal((await (await post('/session/claim', tokens[0])).json()).session_id, f.cap);
  assert.equal((await post('/session', tokens[0])).status, 200);
  assert.equal((await post('/session')).status, 403);
  assert.equal((await post('/session', tokens[1])).status, 403);
  assert.equal((await post('/session/claim', tokens[1])).status, 403);
  const empty = f.codec.issue();
  const claimed = await (await post('/session/claim', tokens[0], empty)).json();
  assert.equal(f.codec.verify(claimed.session_id, 1), true);
  assert.equal(f.codec.verify(claimed.session_id, null), false);
  assert.equal((await post('/session', tokens[1], claimed.session_id)).status, 403);
});
