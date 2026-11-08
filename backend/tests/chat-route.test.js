const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const express = require('express');
const testSecret = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const blockedPoolCalls = [];
const forbidPool = method => async () => {
    blockedPoolCalls.push(method);
    throw new Error(`Offline chat fixture forbids pool.${method}`);
};
const pool = Object.freeze({ execute: forbidPool('execute'), query: forbidPool('query'),
    getConnection: forbidPool('getConnection'), async end() {} });
// Load the real router/auth/user modules against fail-closed test dependencies.
// config/db and config/auth are never evaluated, so neither .env nor mysql2 is
// loaded. Restore all cache entries immediately; the router keeps its isolated
// dependency objects without affecting another test file's module imports.
const fixtureModules = ['../config/db', '../config/auth', '../models/user', '../middleware/auth', '../routes/chat']
    .map(request => require.resolve(request));
const savedModules = new Map(fixtureModules.map(filename => [filename, require.cache[filename]]));
const cacheFixture = (filename, exports) => { require.cache[filename] = { id: filename, filename, loaded: true, exports }; };
let users, createChatRouter, createChatCapacity;
try {
    for (const filename of fixtureModules) delete require.cache[filename];
    cacheFixture(fixtureModules[0], pool);
    cacheFixture(fixtureModules[1], { secret: testSecret, expiresIn: '1h' });
    users = require('../models/user');
    ({ createChatRouter, createChatCapacity } = require('../routes/chat'));
} finally {
    for (const [filename, previous] of savedModules) {
        if (previous) require.cache[filename] = previous;
        else delete require.cache[filename];
    }
}
const { createChatStore, createSessionCodec, sessionStorageId, requestHash } = require('../ai/sessions');
const { createChatLimiter } = require('../ai/rate-limit');

// Exercise the real store's SQL, connection locking, transaction boundaries and
// rollback with a deterministic MySQL protocol fixture; no catalog/API writes.
class MysqlFixture {
    constructor() {
        this.rows = [];
        this.locks = new Map();
        this.waiters = new Map();
        this.events = [];
        this.nextId = 1;
        this.failNextInsert = false;
        this.connections = new Set();
        this.connectionCount = 0;
    }
    async getConnection() {
        this.connectionCount++;
        const fixture = this;
        let pending = null;
        let released = false;
        const held = new Set();
        function unlock(key) {
            held.delete(key);
            const waiters = fixture.waiters.get(key) || [];
            const next = waiters.shift();
            if (next) { clearTimeout(next.timer); next.accept(); }
            else fixture.locks.delete(key);
        }
        const connection = {
            async execute(sql, values = []) {
                if (sql.includes('GET_LOCK')) {
                    const key = values[0];
                    if (!fixture.locks.has(key)) {
                        fixture.locks.set(key, true);
                        held.add(key);
                        return [[{ acquired: 1 }]];
                    }
                    const acquired = await new Promise(resolve => {
                        const entry = { accept: () => { held.add(key); resolve(1); } };
                        const waiters = fixture.waiters.get(key) || [];
                        fixture.waiters.set(key, waiters);
                        waiters.push(entry);
                        entry.timer = setTimeout(() => {
                            waiters.splice(waiters.indexOf(entry), 1);
                            resolve(0);
                        }, values[1] * 1000);
                    });
                    return [[{ acquired }]];
                }
                if (sql.includes('RELEASE_LOCK')) { unlock(values[0]); return [[{ released: 1 }]]; }
                if (sql.startsWith('SELECT DISTINCT user_id')) {
                    return [fixture.rows.filter(row => row.session_id === values[0]).map(row => ({ user_id: row.user_id }))];
                }
                if (sql.startsWith('SELECT message')) {
                    const fragment = values[1].slice(1, -1);
                    return [fixture.rows.filter(row => row.session_id === values[0] && row.sender === 'assistant' && row.message.includes(fragment)).slice(-1)];
                }
                if (sql.startsWith('SELECT sender')) {
                    return [fixture.rows.filter(row => row.session_id === values[0]).slice(-8).reverse().map(row => ({ sender: row.sender, message: row.message }))];
                }
                if (sql.startsWith('INSERT INTO chat_histories')) {
                    assert.ok(pending, 'pair insert requires an active transaction');
                    for (const offset of [0, 4]) pending.push({ chat_history_id: fixture.nextId++, user_id: values[offset], message: values[offset + 1], sender: values[offset + 2], session_id: values[offset + 3] });
                    if (fixture.failNextInsert) { fixture.failNextInsert = false; throw new Error('database password and SQL must remain private'); }
                    return [{ affectedRows: 2 }];
                }
                throw new Error(`Unexpected fixture query: ${sql}`);
            },
            async beginTransaction() { assert.equal(pending, null); fixture.events.push('begin'); pending = []; },
            async commit() { fixture.events.push('commit'); fixture.rows.push(...pending); pending = null; },
            async rollback() { fixture.events.push('rollback'); pending = null; },
            release() { assert.equal(held.size, 0); released = true; fixture.connections.delete(connection); },
            destroy() { for (const key of [...held]) unlock(key); released = true; fixture.connections.delete(connection); },
            get released() { return released; }
        };
        fixture.connections.add(connection);
        return connection;
    }
}

const originalById = users.byId;
users.byId = async id => ({ user_id: Number(id), role: id === '3' ? 'admin' : 'user', status: id === '4' ? 'inactive' : 'active' });
after(async () => { users.byId = originalById; await pool.end(); assert.deepEqual(blockedPoolCalls, []); });

async function harness(options = {}) {
    const fixture = options.fixture || new MysqlFixture();
    const calls = [];
    const assistant = options.assistant || { async reply(input) {
        calls.push(input);
        fixture.events.push('generated');
        return { message: `Answer ${calls.length} 🐾`, products: [{ product_id: 12, name: 'Food' }], code: 'OK', context_search: { species: 'dog' } };
    } };
    const app = express();
    // Let the route's schema validation handle JSON primitives as well.
    app.use(express.json({ strict: false }));
    app.use('/api/chat', createChatRouter({ assistant,
        store: createChatStore({ pool: fixture, lockTimeoutSeconds: options.lockTimeoutSeconds ?? 0.2 }),
        limiter: options.limiter || createChatLimiter({ sessionLimit: 100, ipLimit: 1000 }),
        sessionCodec: createSessionCodec(testSecret), ...(options.capacity ? { capacity: options.capacity } : {}) }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/chat`;
    return { fixture, calls,
        token: userId => jwt.sign({}, testSecret, { subject: String(userId), expiresIn: '1h' }),
        async post(body, token, rawAuthorization) {
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(rawAuthorization !== undefined ? { Authorization: rawAuthorization } : {}) }, body: JSON.stringify(body) });
            return { status: response.status, body: await response.json(), retryAfter: response.headers.get('Retry-After') };
        },
        async close() { await new Promise(resolve => server.close(resolve)); assert.equal(fixture.connections.size, 0); }
    };
}

const input = (message = 'Help with food 🐶', sessionId, requestId = randomUUID()) => ({ message, request_id: requestId, ...(sessionId ? { session_id: sessionId } : {}) });

test('guest sessions persist an atomic pair, round-trip emoji, replay retries and isolate history', async () => {
    const h = await harness();
    try {
        const firstBody = input();
        const first = await h.post(firstBody);
        assert.equal(first.status, 200);
        const session = first.body.session_id;
        assert.equal(session.length, 87);
        assert.equal(first.body.replayed, false);
        assert.equal(first.body.context_search, undefined);
        assert.deepEqual(h.fixture.events, ['generated', 'begin', 'commit']);
        assert.equal(h.fixture.rows.length, 2);
        assert.ok(h.fixture.rows.every(row => row.user_id === null && /^[\x00-\x7f]*$/.test(row.message)));
        const replay = await h.post({ ...firstBody, session_id: session });
        assert.equal(replay.status, 200);
        assert.equal(replay.body.replayed, true);
        assert.equal(replay.body.message, first.body.message);
        assert.equal(h.calls.length, 1);
        const conflict = await h.post({ ...firstBody, message: 'Different', session_id: session });
        assert.equal(conflict.status, 409);
        assert.equal(h.fixture.rows.length, 2);
        const second = await h.post(input('More please', session));
        assert.equal(second.status, 200);
        assert.deepEqual(h.calls[1].history, [
            { role: 'user', text: firstBody.message },
            { role: 'assistant', text: first.body.message, product_ids: [12], search: { species: 'dog' } }
        ]);
        await h.post(input('Unrelated new conversation'));
        assert.deepEqual(h.calls[2].history, []);
        for (let i = 0; i < 4; i++) await h.post(input(`Turn ${i}`, session));
        assert.equal(h.calls.at(-1).history.length, 8);
        assert.equal(JSON.stringify(h.calls).includes('request_hash'), false);
        assert.equal(JSON.stringify(h.calls).includes(session), false);
    } finally { await h.close(); }
});

test('source-backed category answers retain the public contract and replay without generation', async () => {
    const { createAssistant } = require('../ai/assistant');
    const { createProductRepository } = require('../ai/products');
    let categoryReads = 0, generations = 0;
    const repository = createProductRepository({
        db: { async execute() { throw new Error('An overview must not search products'); } },
        categoryReader: async () => {
            categoryReads++;
            return [{ category_id: 91, name: 'Phụ kiện kiểm thử' }, { category_id: 92, name: 'Đồ chơi kiểm thử' }];
        }
    });
    const assistant = createAssistant({ repository, generate: async () => {
        generations++;
        throw new Error('A category answer must not call a model');
    } });
    const h = await harness({ assistant });
    try {
        const body = input('Shop mình bán những gì nhỉ?');
        const first = await h.post(body);
        assert.equal(first.status, 200);
        assert.equal(first.body.success, true);
        assert.equal(first.body.code, 'OK');
        assert.equal(first.body.intent, 'catalog_overview');
        assert.equal(first.body.request_id, body.request_id);
        assert.equal(first.body.session_id.length, 87);
        assert.deepEqual(first.body.products, []);
        assert.deepEqual(first.body.warnings, []);
        assert.equal(typeof first.body.follow_up, 'string');
        assert.match(first.body.message, /Phụ kiện kiểm thử/);
        assert.match(first.body.message, /Đồ chơi kiểm thử/);
        assert.equal(Object.hasOwn(first.body, 'model'), false);
        assert.equal(Object.hasOwn(first.body, 'context_search'), false);
        assert.equal(h.fixture.rows.length, 2);
        const replay = await h.post({ ...body, session_id: first.body.session_id });
        assert.equal(replay.status, 200);
        assert.equal(replay.body.replayed, true);
        assert.equal(replay.body.message, first.body.message);
        assert.equal(categoryReads, 1);
        assert.equal(generations, 0);
        assert.equal(h.fixture.rows.length, 2);
    } finally { await h.close(); }
});

test('authenticated sessions bind to the current user and reject forged, stolen, invalid and inactive credentials', async () => {
    const h = await harness();
    try {
        const body = input();
        const created = await h.post(body, h.token(1));
        assert.equal(created.status, 200);
        const session = created.body.session_id;
        assert.ok(h.fixture.rows.every(row => row.user_id === 1));
        assert.equal((await h.post(input('Next', session), h.token(1))).status, 200);
        assert.equal((await h.post(input('Stolen', session), h.token(2))).status, 403);
        assert.equal((await h.post(input('Stolen', session))).status, 403);
        const forged = `${session.slice(0, -1)}${session.endsWith('A') ? 'B' : 'A'}`;
        assert.equal((await h.post(input('Forged', forged), h.token(1))).status, 403);
        assert.equal((await h.post(input('x'), 'invalid')).status, 401);
        assert.equal((await h.post(input('x'), undefined, 'Basic bad')).status, 401);
        assert.equal((await h.post(input('x'), h.token(3))).status, 403);
        assert.equal((await h.post(input('x'), h.token(4))).status, 403);
        const guest = await h.post(input('guest'));
        assert.equal((await h.post(input('x', guest.body.session_id), h.token(1))).status, 403);
        // Valid server-issued tokens are usable before their first stored row.
        const emptySession = createSessionCodec(testSecret).issue(1);
        assert.equal((await h.post(input('first', emptySession), h.token(1))).status, 200);
    } finally { await h.close(); }
});

test('chat strictly validates its public body without client-controlled history or options', async () => {
    const h = await harness();
    try {
        const valid = input();
        for (const body of [null, [], {}, { ...valid, message: '' }, { ...valid, message: '  ' }, { ...valid, message: 'x'.repeat(2001) },
            { ...valid, message: 4 }, { message: 'x' }, { ...valid, request_id: 'not-a-uuid' }, { ...valid, session_id: null },
            ...['history', 'user_id', 'mode', 'filters', 'options'].map(key => ({ ...valid, [key]: [] })),
            ...Array.from({ length: 33 }, (_, index) => index).filter(code => ![9, 10, 13, 32].includes(code))
                .concat(127).map(code => ({ ...valid, message: `text${String.fromCharCode(code)}` }))]) {
            assert.equal((await h.post(body)).status, 400, JSON.stringify(body));
        }
        assert.equal((await h.post({ ...valid, session_id: '' })).status, 403);
        assert.equal(h.calls.length, 0);
        assert.equal(h.fixture.rows.length, 0);
        assert.equal(h.fixture.connectionCount, 0);
        assert.equal((await h.post(input('🐶'.repeat(2000)))).status, 200);
    } finally { await h.close(); }
});

test('same-session concurrent retries call the model once; a busy lock returns 409', async () => {
    let release;
    let began;
    const ready = new Promise(resolve => { began = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let count = 0;
    const h = await harness({ assistant: { async reply() { count++; began(); await gate; return { message: 'Complete', products: [] }; } } });
    try {
        const session = createSessionCodec(testSecret).issue();
        const body = input('One message', session);
        const first = h.post(body);
        await ready;
        const second = h.post(body);
        release();
        const results = await Promise.all([first, second]);
        assert.ok(results.every(result => result.status === 200));
        assert.equal(results.filter(result => result.body.replayed).length, 1);
        assert.equal(count, 1);
        assert.equal(h.fixture.rows.length, 2);

        const connection = await h.fixture.getConnection();
        const { createHash } = require('node:crypto');
        const lock = `pc_chat:${createHash('sha256').update(session).digest('hex').slice(0, 56)}`;
        await connection.execute('SELECT GET_LOCK(?, ?) AS acquired', [lock, 0.2]);
        const busy = await h.post(input('Wait', session));
        assert.equal(busy.status, 409);
        await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lock]);
        connection.release();
        assert.equal(count, 1);
    } finally { release(); await h.close(); }
});

test('IP quotas run before authentication/session work; session quota and bounded maps expire with injected clock', async () => {
    let now = 1000;
    const limiter = createChatLimiter({ clock: () => now, ipLimit: 2, sessionLimit: 1, maxKeys: 2, windowMs: 1000 });
    const h = await harness({ limiter });
    try {
        const first = await h.post(input());
        assert.equal(first.status, 200);
        const limitedSession = await h.post(input('next', first.body.session_id));
        assert.equal(limitedSession.status, 429);
        assert.equal(limitedSession.retryAfter, '1');
        // Even an invalid JWT is rejected by the exhausted IP quota first.
        assert.equal((await h.post(input(), 'invalid')).status, 429);
        assert.equal(h.calls.length, 1);
        now += 1000;
        assert.equal((await h.post(input('retry', first.body.session_id))).status, 200);
        const bounded = createChatLimiter({ clock: () => now, ipLimit: 2, sessionLimit: 2, maxKeys: 2, windowMs: 1000 });
        assert.equal(bounded.consumeIp('a').allowed, true);
        assert.equal(bounded.consumeIp('b').allowed, true);
        assert.equal(bounded.consumeIp('c').allowed, false);
        now += 1000;
        assert.equal(bounded.consumeIp('c').allowed, true);
    } finally { await h.close(); }
});

test('failed atomic persistence rolls back both rows and allows the same request retry without exposing database errors', async () => {
    const h = await harness();
    try {
        h.fixture.failNextInsert = true;
        const body = input();
        const failed = await h.post(body);
        assert.equal(failed.status, 503);
        assert.equal(h.fixture.rows.length, 0);
        assert.deepEqual(h.fixture.events, ['generated', 'begin', 'rollback']);
        assert.equal(JSON.stringify(failed.body).includes('password'), false);
        const retry = await h.post({ ...body, session_id: failed.body.session_id });
        assert.equal(retry.status, 200);
        assert.equal(retry.body.replayed, false);
        assert.equal(h.fixture.rows.length, 2);
        assert.equal(h.calls.length, 2);
    } finally { await h.close(); }
});

test('transient model failures and thrown errors produce sanitized retryable errors without storing history', async () => {
    for (const code of ['CATALOG_UNAVAILABLE', 'GEMINI_BAD_REQUEST', 'GEMINI_AUTH', 'GEMINI_MODEL_UNAVAILABLE', 'GEMINI_QUOTA', 'GEMINI_TIMEOUT', 'GEMINI_UNAVAILABLE']) {
        const h = await harness({ assistant: { async reply() { return { message: 'Unavailable', code }; } } });
        try {
            const result = await h.post(input());
            assert.equal(result.status, code === 'GEMINI_TIMEOUT' ? 504 : 503);
            assert.equal(result.body.code, code);
            assert.equal(h.fixture.rows.length, 0);
            assert.equal(h.fixture.events.includes('begin'), false);
        } finally { await h.close(); }
    }
    const h = await harness({ assistant: { async reply() { throw Object.assign(new Error('private prompt and secret'), { status: 503 }); } } });
    try {
        const result = await h.post(input());
        assert.equal(result.status, 503);
        assert.equal(JSON.stringify(result.body).includes('secret'), false);
        assert.equal(h.fixture.rows.length, 0);
    } finally { await h.close(); }
});

test('assistant input validation maps to a safe 400 without exposing its error details', async () => {
    const h = await harness({ assistant: { async reply() {
        throw Object.assign(new Error('private model context and secret'), { code: 'INVALID_SEARCH', status: 503 });
    } } });
    try {
        const result = await h.post(input());
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'INVALID_SEARCH');
        assert.equal(JSON.stringify(result.body).includes('private'), false);
        assert.equal(JSON.stringify(result.body).includes('secret'), false);
        assert.equal(h.fixture.rows.length, 0);
        assert.equal(h.fixture.events.includes('begin'), false);
    } finally { await h.close(); }
});

test('oversized responses never open a transaction and session ownership is checked against stored rows', async () => {
    const h = await harness({ assistant: { async reply() { return { message: 'a'.repeat(60001) }; } } });
    try {
        assert.equal((await h.post(input())).status, 503);
        assert.equal(h.fixture.rows.length, 0);
        assert.equal(h.fixture.events.includes('begin'), false);
        const token = createSessionCodec(testSecret).issue();
        h.fixture.rows.push({ session_id: sessionStorageId(token), user_id: 1, sender: 'user', message: 'wrong owner' });
        assert.equal((await h.post(input('try', token))).status, 403);
    } finally { await h.close(); }
});

test('session capability is opaque and owner-bound', () => {
    const codec = createSessionCodec('unit-test-only-secret');
    const guest = codec.issue();
    const user = codec.issue(120);
    assert.equal(codec.verify(guest), true);
    assert.equal(codec.verify(guest, 120), false);
    assert.equal(codec.verify(user, 120), true);
    assert.equal(codec.verify(user), false);
    assert.equal(codec.verify(user, 121), false);
    assert.equal(codec.verify(null), false);
    assert.notEqual(requestHash('a'), requestHash('b'));
});

test('global in-flight capacity rejects excess work before database acquisition and recovers after success or failure', async () => {
    let unblock;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    let calls = 0;
    const fixture = new MysqlFixture();
    const capacity = createChatCapacity(2);
    const h = await harness({ fixture, capacity, assistant: { async reply({ message }) {
        calls++;
        if (calls === 2) signalStarted();
        if (message === 'fail') throw new Error('private failure');
        await gate;
        return { message: 'Complete', products: [] };
    } } });
    try {
        const pending = [h.post(input('first')), h.post(input('second'))];
        await started;
        assert.equal(fixture.connections.size, 2);
        const busy = await h.post(input('excess'));
        assert.equal(busy.status, 503);
        assert.equal(busy.body.code, 'CHAT_BUSY');
        assert.equal(busy.retryAfter, '2');
        assert.equal(fixture.connections.size, 2);
        assert.equal(calls, 2);
        unblock();
        assert.ok((await Promise.all(pending)).every(result => result.status === 200));
        for (let attempt = 0; attempt < 3; attempt++) assert.equal((await h.post(input('fail'))).status, 503);
        assert.equal((await h.post(input('recovered'))).status, 200);
        assert.equal(fixture.connections.size, 0);
    } finally { unblock(); await h.close(); }
});
