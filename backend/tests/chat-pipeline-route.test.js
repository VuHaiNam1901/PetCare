'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const secret = randomBytes(48).toString('hex');
const forbidden = [];
const pool = Object.fromEntries(['execute', 'query', 'getConnection'].map(name => [name, async () => {
    forbidden.push(name); throw new Error('Uninjected database access');
}]));
const modules = ['../config/db', '../config/auth', '../models/user', '../middleware/auth', '../routes/chat'].map(require.resolve);
const saved = new Map(modules.map(filename => [filename, require.cache[filename]]));
let users, createChatRouter;
try {
    for (const filename of modules) delete require.cache[filename];
    for (const [filename, exports] of [[modules[0], pool], [modules[1], { secret, expiresIn: '1h' }]]) {
        require.cache[filename] = { id: filename, filename, loaded: true, exports };
    }
    users = require('../models/user');
    ({ createChatRouter } = require('../routes/chat'));
} finally {
    for (const [filename, previous] of saved) {
        if (previous) require.cache[filename] = previous; else delete require.cache[filename];
    }
}
const { createSessionCodec, createChatStore, sessionStorageId } = require('../ai/sessions');
const { createChatLimiter } = require('../ai/rate-limit');
const { createOrchestrator } = require('../ai/orchestrator');
const { createProductRepository } = require('../ai/products');
const { getActiveContext } = require('../ai/memory');
const { readChatPipeline } = require('../config/chat-pipeline');
const originalById = users.byId;
users.byId = async id => ({ user_id: Number(id), role: 'user', status: 'active' });
after(() => { users.byId = originalById; assert.deepEqual(forbidden, []); });
const clone = value => JSON.parse(JSON.stringify(value));
const opening = 'Miu là mèo 6 tháng. Mình cần hạt, ngân sách tối đa 200000 đồng.';

// This fixture implements the real store's SQL/locking/transaction protocol.
// The route, session codec/store, memory, tools and product repository are real;
// only MySQL and Gemini I/O boundaries are replaced. Nothing reads credentials.
class Database {
    rows = []; locks = new Map(); nextId = 1; connections = new Set();
    failCommit = false; failRead = false; historyReads = 0; memoryReads = 0;
    async getConnection() {
        const db = this; let pending = null; const held = new Set();
        function unlock(key) {
            held.delete(key);
            const waiting = db.locks.get(key) || [];
            if (waiting.length) { const next = waiting.shift(); next(); }
            else db.locks.delete(key);
        }
        const connection = {
            async execute(sql, values = []) {
                if (sql.includes('GET_LOCK')) {
                    const key = values[0];
                    if (!db.locks.has(key)) db.locks.set(key, []);
                    else await new Promise(resolve => db.locks.get(key).push(resolve));
                    held.add(key); return [[{ acquired: 1 }]];
                }
                if (sql.includes('RELEASE_LOCK')) { unlock(values[0]); return [[{ released: 1 }]]; }
                if (db.failRead && sql.startsWith('SELECT')) throw new Error('PRIVATE_DATABASE_FAILURE');
                const rows = db.rows.filter(row => row.session_id === values[0]);
                if (sql.startsWith('SELECT DISTINCT user_id')) return [rows.map(row => ({ user_id: row.user_id }))];
                if (sql.startsWith('SELECT message')) {
                    const assistants = rows.filter(row => row.sender === 'assistant');
                    if (sql.includes('LIKE')) return [assistants.filter(row => row.message.includes(values[1].slice(1, -1))).slice(-1)];
                    db.memoryReads++; return [assistants.slice(-1)];
                }
                if (sql.startsWith('SELECT sender')) {
                    db.historyReads++; return [rows.slice(-8).reverse().map(({ sender, message }) => ({ sender, message }))];
                }
                if (sql.startsWith('INSERT INTO chat_histories')) {
                    assert.ok(pending, 'writes must be inside a transaction');
                    for (const offset of [0, 4]) pending.push({ chat_history_id: db.nextId++, user_id: values[offset],
                        message: values[offset + 1], sender: values[offset + 2], session_id: values[offset + 3] });
                    return [{ affectedRows: 2 }];
                }
                throw new Error(`Unexpected fixture query: ${sql}`);
            },
            async beginTransaction() { assert.equal(pending, null); pending = []; },
            async commit() {
                if (db.failCommit) throw new Error('PRIVATE_COMMIT_FAILURE');
                db.rows.push(...pending); pending = null;
            },
            async rollback() { pending = null; },
            release() { assert.equal(held.size, 0); db.connections.delete(connection); },
            destroy() { for (const key of [...held]) unlock(key); db.connections.delete(connection); }
        };
        db.connections.add(connection); return connection;
    }
    envelope(token) { return JSON.parse(this.rows.filter(row => row.session_id === sessionStorageId(token) && row.sender === 'assistant').at(-1).message); }
}

const respond = (intent, advice, product_ids = []) => ({ name: 'respond', args: {
    mode: product_ids.length ? 'product' : 'care', intent, advice, product_ids, follow_up: null, warnings: []
} });
function script(initial, replies) {
    const step = replies.filter(reply => reply.name !== 'compact_memory').length;
    const source = { kind: 'user', turn_id: initial.current_turn_id, quote: initial.user_request };
    if (initial.user_request === opening) {
        if (!step) return { name: 'update_memory', args: { operations: [
            { op: 'add_pet', pet_id: 'miu', fields: { name: { value: 'Miu', source }, species: { value: 'cat', source }, age: { value: { amount: 6, unit: 'months' }, source } } },
            { op: 'switch_pet', pet_id: 'miu' }, { op: 'switch_topic', topic: 'food', source },
            { op: 'set_fact', section: 'needs', key: 'product_type', fact: { value: 'kibble', source } },
            { op: 'set_fact', section: 'constraints', key: 'budget', fact: { value: { currency: 'VND', min: null, max: '200000.00' }, source } }
        ] } };
        if (step === 1) return { name: 'search_products', args: { filters: { query: 'hạt cho mèo' } } };
        return respond('product_advice', 'Bạn xem các lựa chọn bên dưới nhé.', [101, 102]);
    }
    if (initial.user_request === 'Cái thứ hai còn bán không?') {
        assert.deepEqual(initial.active_context.displayed_product_set.product_ids, [101, 102]);
        if (!step) return { name: 'get_product_details', args: { product_ids: [102] } };
        const available = replies.find(reply => reply.name === 'get_product_details').response.products.length;
        return available ? respond('price_stock', 'Thông tin hiện tại nằm trong thẻ bên dưới.', [102])
            : respond('price_stock', 'Lần kiểm tra mới chưa tìm thấy sản phẩm đó còn khả dụng.');
    }
    if (initial.user_request === 'Tăng ngân sách lên 300000 đồng.') {
        if (!step) return { name: 'update_memory', args: { operations: [{ op: 'set_fact', section: 'constraints', key: 'budget',
            fact: { value: { currency: 'VND', min: null, max: '300000.00' }, source } }] } };
        return respond('conversation', 'Mình đã ghi nhận ngân sách bạn vừa điều chỉnh.');
    }
    if (initial.user_request === 'Tìm hạt cho mèo.') {
        if (!step) return { name: 'search_products', args: { filters: { query: 'hạt cho mèo' } } };
        return respond('product_search', 'Bạn xem các lựa chọn bên dưới nhé.', [101, 102]);
    }
    if (initial.user_request === 'Cho gặp quản lý') return respond('handoff_request', 'Mình chưa có chức năng kết nối trực tiếp với quản lý. Bạn muốn trao đổi vấn đề gì để mình hỗ trợ?');
    return respond('conversation', 'Mình đang lắng nghe. Bạn muốn chia sẻ thêm điều gì?');
}

async function harness(t, options = {}) {
    const db = options.db || new Database();
    const state = options.state || { generations: 0, contexts: [], productReads: 0, failure: null, factories: { legacy: 0, orchestrator: 0 } };
    state.inventory ||= [101, 102].map((product_id, index) => ({ product_id, category_id: 1, category_name: 'Thức ăn',
        name: `Hạt khô cho mèo mẫu ${index + 1}`, price: index ? '150000.00' : '180000.00', stock_quantity: 3,
        status: 'Đang bán', image_url: '/images/products/test.webp', description: 'Dữ liệu tổng hợp kiểm thử.' }));
    const repository = createProductRepository({ db: { async execute(sql, params) {
        state.productReads++;
        if (state.failure === 'catalog') throw new Error('PRIVATE_CATALOG_FAILURE');
        assert.match(sql, /^SELECT\b/);
        const result = sql.includes('p.product_id IN') ? state.inventory.filter(row => params.slice(1).includes(row.product_id))
            : state.inventory.filter(row => row.product_id > params.at(-1)).slice(0, 64);
        return [clone(result)];
    } }, categoryReader: async () => [{ category_id: 1, name: 'Thức ăn' }] });
    const generate = async request => {
        state.generations++;
        if (state.failure === 'quota') throw Object.assign(new Error('PRIVATE_API_KEY'), { status: 429 });
        if (state.failure === 'gemini') throw Object.assign(new Error('PRIVATE_API_KEY'), { status: 503 });
        if (state.failure === 'timeout') return new Promise(() => {});
        if (state.failure === 'late') {
            // Deliberately ignore AbortSignal, as a provider may finish after
            // the backend deadline. Releasing this gate must not persist a turn.
            await new Promise(resolve => { state.releaseLate = resolve; });
            state.lateCompleted = true;
        }
        const initial = JSON.parse(request.contents[0].parts[0].text);
        state.contexts.push(clone(initial));
        const replies = request.contents.flatMap(content => content.parts).filter(part => part.functionResponse).map(part => part.functionResponse);
        const action = initial.preparing && !replies.some(reply => reply.name === 'compact_memory')
            ? { name: 'compact_memory', args: { through_sequence: initial.recent_history[3].sequence,
                text: 'Khách đã trao đổi về thú cưng và sản phẩm. Trạng thái có nguồn giữ các điều kiện hiện hành.' } }
            : (options.script || script)(initial, replies);
        return { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, totalTokenCount: 200 },
            candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: {
                id: `call:${state.generations}`, name: action.name, args: action.args }, thoughtSignature: 'opaque-test-signature' }] } }] };
    };
    const assistantFactories = {
        legacy() { state.factories.legacy++; return { async reply() { return { message: 'Legacy answer', code: 'OK', products: [], warnings: [] }; } }; },
        orchestrator() { state.factories.orchestrator++; return createOrchestrator({ generate, repository, limits: { timeoutMs: 100 } }); }
    };
    const app = express(); app.use(express.json());
    app.use('/api/chat', createChatRouter({ ...(options.pipeline ? { pipeline: options.pipeline } : {}),
        assistantFactories, store: createChatStore({ pool: db }), sessionCodec: createSessionCodec(secret),
        limiter: createChatLimiter({ sessionLimit: 200, ipLimit: 1000 }) }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let closed = false;
    const close = async () => { if (!closed) { closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(db.connections.size, 0); } };
    t.after(close);
    const url = `http://127.0.0.1:${server.address().port}/api/chat`;
    return { db, state, close, url, token: id => jwt.sign({}, secret, { subject: String(id), expiresIn: '1h' }),
        async post(message, session_id, request_id = randomUUID(), token) {
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ message, request_id, ...(session_id ? { session_id } : {}) }) });
            return { status: response.status, body: await response.json() };
        } };
}
function success(result) {
    assert.equal(result.status, 200, result.body.code); assert.equal(result.body.success, true); assert.equal(result.body.code, 'OK');
    assert.equal(typeof result.body.message, 'string'); assert.ok(Array.isArray(result.body.products));
    for (const key of ['memory', 'usage', 'context_search', 'request_hash']) assert.equal(Object.hasOwn(result.body, key), false);
    return result.body.session_id;
}

test('pipeline config: strict allowlist, legacy default and sanitized startup failure', () => {
    for (const environment of [{}, { CHAT_PIPELINE: '' }, { CHAT_PIPELINE: 'legacy' }]) assert.equal(readChatPipeline(environment), 'legacy');
    assert.equal(readChatPipeline({ CHAT_PIPELINE: 'orchestrator' }), 'orchestrator');
    for (const value of ['orchestrat0r', 'private-value', ' Orchestrator ', null, 1]) {
        assert.throws(() => readChatPipeline({ CHAT_PIPELINE: value }), error => {
            assert.equal(error.code, 'CHAT_PIPELINE_CONFIG'); assert.equal(error.message.includes(String(value)), false); return true;
        });
    }
    assert.throws(() => createChatRouter({ pipeline: 'private-value' }), { code: 'CHAT_PIPELINE_CONFIG' });
});

test('pipeline route: default legacy is lazy and does not initialize Gemini', async t => {
    const h = await harness(t);
    assert.deepEqual(h.state.factories, { legacy: 0, orchestrator: 0 });
    const result = await h.post('Cho gặp quản lý'); success(result);
    assert.equal(result.body.message, 'Legacy answer');
    assert.deepEqual(h.state.factories, { legacy: 1, orchestrator: 0 });
    assert.equal(h.state.generations, 0); assert.equal(h.state.productReads, 0);
    const response = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Bật AI.', request_id: randomUUID(), pipeline: 'orchestrator' }) });
    assert.equal(response.status, 400); assert.equal(h.state.factories.orchestrator, 0);
});

test('pipeline route: server environment is read once when the router is constructed', async t => {
    const previous = process.env.CHAT_PIPELINE;
    let h;
    try { process.env.CHAT_PIPELINE = 'orchestrator'; h = await harness(t); }
    finally { if (previous === undefined) delete process.env.CHAT_PIPELINE; else process.env.CHAT_PIPELINE = previous; }
    const response = await h.post('Cho gặp quản lý'); success(response);
    assert.equal(response.body.intent, 'handoff_request');
    assert.deepEqual(h.state.factories, { legacy: 0, orchestrator: 1 });
});

test('pipeline route: enabled orchestrator handles manager requests and preserves the frontend contract', async t => {
    const h = await harness(t, { pipeline: 'orchestrator' });
    assert.equal(h.state.factories.orchestrator, 0);
    const result = await h.post('Cho gặp quản lý'); const session = success(result);
    assert.equal(result.body.intent, 'handoff_request'); assert.match(result.body.message, /chưa có chức năng/);
    assert.deepEqual(h.state.factories, { legacy: 0, orchestrator: 1 }); assert.equal(h.state.productReads, 0);
    assert.equal(h.db.envelope(session).memory.schema_version, 1);
    const { sendChatMessage } = await import(pathToFileURL(path.resolve(__dirname, '../../frontend/src/services/chat.js')).href);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => originalFetch(h.url, init);
    try {
        const response = await sendChatMessage({ message: 'Mình muốn trò chuyện.', session_id: session, request_id: randomUUID() });
        assert.equal(response.success, true); assert.equal(response.session_id, session); assert.deepEqual(response.products, []);
        assert.equal(Object.hasOwn(response, 'memory'), false);
    } finally { globalThis.fetch = originalFetch; }
});

test('pipeline route: checkpoint survives reconstruction, compaction and the SQL history window', async t => {
    let h = await harness(t, { pipeline: 'orchestrator' });
    const first = await h.post(opening), session = success(first);
    assert.deepEqual(h.db.envelope(session).memory.state.displayed_product_sets.at(-1).product_ids, [101, 102]);
    const db = h.db, state = h.state; await h.close();
    h = await harness(t, { pipeline: 'orchestrator', db, state });
    const calls = state.generations, factories = state.factories.orchestrator, reads = db.memoryReads;
    const replay = await h.post(opening, session, first.body.request_id); success(replay);
    assert.equal(replay.body.replayed, true); assert.equal(state.generations, calls);
    assert.equal(state.factories.orchestrator, factories, 'replay does not initialize the new router model');
    assert.equal(db.memoryReads, reads, 'replay bypasses checkpoint loading');
    for (let turn = 0; turn < 7; turn++) success(await h.post(`Mình muốn nói tiếp ${turn}.`, session));
    const memory = db.envelope(session).memory, active = getActiveContext(memory);
    assert.equal(active.pet.name.value, 'Miu'); assert.equal(active.pet.age.value.amount, 6);
    assert.equal(active.constraints.budget.value.max, '200000.00');
    assert.ok(memory.summary.through_sequence > 0, 'older turns have been compacted');
    assert.equal(db.historyReads, 1, 'once a checkpoint exists the truncated history is not used');
    const referenced = await h.post('Cái thứ hai còn bán không?', session); success(referenced);
    assert.deepEqual(referenced.body.products.map(row => row.product_id), [102]);
});

test('pipeline route: unavailable product facts replace remembered product cards', async t => {
    const h = await harness(t, { pipeline: 'orchestrator' });
    const session = success(await h.post(opening));
    h.state.inventory = h.state.inventory.filter(row => row.product_id !== 102);
    const response = await h.post('Cái thứ hai còn bán không?', session); success(response);
    assert.deepEqual(response.body.products, []); assert.match(response.body.message, /chưa tìm thấy/);
});

test('pipeline route: concurrent UUID replay neither generates nor advances memory twice', async t => {
    const h = await harness(t, { pipeline: 'orchestrator' });
    const session = success(await h.post(opening));
    const request = randomUUID(), beforeRows = h.db.rows.length;
    const results = await Promise.all([h.post('Tăng ngân sách lên 300000 đồng.', session, request), h.post('Tăng ngân sách lên 300000 đồng.', session, request)]);
    results.forEach(success); assert.deepEqual(results.map(result => result.body.replayed).sort(), [false, true]);
    assert.equal(h.db.rows.length, beforeRows + 2);
    assert.equal(getActiveContext(h.db.envelope(session).memory).constraints.budget.value.max, '300000.00');
    const before = clone(h.db.envelope(session)), count = h.state.generations, reads = h.db.memoryReads;
    success(await h.post('Tăng ngân sách lên 300000 đồng.', session, request));
    assert.equal(h.state.generations, count); assert.equal(h.db.memoryReads, reads); assert.deepEqual(h.db.envelope(session), before);
    assert.equal((await h.post('Nội dung khác.', session, request)).status, 409);
});

test('pipeline route: provider, timeout and catalog failures preserve the checkpoint and permit safe retry', async t => {
    for (const [failure, code, status, message] of [
        ['quota', 'GEMINI_QUOTA', 503, 'Tăng ngân sách lên 300000 đồng.'],
        ['gemini', 'GEMINI_UNAVAILABLE', 503, 'Tăng ngân sách lên 300000 đồng.'],
        ['timeout', 'GEMINI_TIMEOUT', 504, 'Tăng ngân sách lên 300000 đồng.'],
        ['catalog', 'CATALOG_UNAVAILABLE', 503, 'Tìm hạt cho mèo.']
    ]) await t.test(failure, async t => {
        const h = await harness(t, { pipeline: 'orchestrator' }); const session = success(await h.post(opening));
        const before = clone(h.db.envelope(session)), rowCount = h.db.rows.length, request = randomUUID();
        h.state.failure = failure;
        const failed = await h.post(message, session, request); assert.equal(failed.status, status); assert.equal(failed.body.code, code);
        assert.equal(JSON.stringify(failed).includes('PRIVATE'), false); assert.equal(h.db.rows.length, rowCount); assert.deepEqual(h.db.envelope(session), before);
        h.state.failure = null; success(await h.post(message, session, request)); assert.equal(h.db.rows.length, rowCount + 2);
        const count = h.state.generations; const replay = await h.post(message, session, request); success(replay);
        assert.equal(replay.body.replayed, true); assert.equal(h.state.generations, count);
    });
});

test('pipeline route: MySQL read/commit failures do not publish partial memory updates', async t => {
    const h = await harness(t, { pipeline: 'orchestrator' }); const session = success(await h.post(opening));
    const before = clone(h.db.envelope(session)), rows = h.db.rows.length;
    h.db.failRead = true; const calls = h.state.generations;
    const read = await h.post('Tiếp tục.', session); assert.equal(read.status, 503); assert.equal(h.state.generations, calls);
    h.db.failRead = false; h.db.failCommit = true; const request = randomUUID();
    const commit = await h.post('Tăng ngân sách lên 300000 đồng.', session, request); assert.equal(commit.status, 503);
    assert.equal(JSON.stringify(commit).includes('PRIVATE'), false); assert.deepEqual(h.db.envelope(session), before); assert.equal(h.db.rows.length, rows);
    h.db.failCommit = false; success(await h.post('Tăng ngân sách lên 300000 đồng.', session, request));
    assert.equal(h.db.rows.length, rows + 2); assert.equal(getActiveContext(h.db.envelope(session).memory).constraints.budget.value.max, '300000.00');
});

test('pipeline route: a provider finishing after timeout cannot persist a late turn or checkpoint', async t => {
    const h = await harness(t, { pipeline: 'orchestrator' }); const session = success(await h.post(opening));
    const before = clone(h.db.envelope(session)), rows = h.db.rows.length;
    h.state.failure = 'late';
    const response = await h.post('Tăng ngân sách lên 300000 đồng.', session);
    assert.equal(response.status, 504); assert.equal(response.body.code, 'GEMINI_TIMEOUT');
    assert.equal(h.db.rows.length, rows); assert.deepEqual(h.db.envelope(session), before);
    assert.equal(typeof h.state.releaseLate, 'function'); h.state.releaseLate();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.lateCompleted, true);
    assert.equal(h.db.rows.length, rows); assert.deepEqual(h.db.envelope(session), before);
    assert.equal(h.db.connections.size, 0);
});

test('pipeline route: account capabilities isolate memory before any model call', async t => {
    const h = await harness(t, { pipeline: 'orchestrator' });
    const session = success(await h.post(opening, undefined, randomUUID(), h.token(1)));
    const calls = h.state.generations, reads = h.db.memoryReads;
    for (const token of [undefined, h.token(2)]) assert.equal((await h.post('Tiếp tục.', session, randomUUID(), token)).status, 403);
    const forged = `${session.slice(0, -1)}${session.endsWith('A') ? 'B' : 'A'}`;
    assert.equal((await h.post('Tiếp tục.', forged, randomUUID(), h.token(1))).status, 403);
    assert.equal(h.state.generations, calls); assert.equal(h.db.memoryReads, reads);
    const guest = await h.post('Chào bạn.'); success(guest);
    assert.equal(h.state.contexts.at(-1).active_context.pet, null);
    assert.deepEqual(h.state.contexts.at(-1).active_context.constraints, {});
});

test('pipeline route: legacy rollback invalidates the checkpoint before enabling again', async t => {
    let h = await harness(t, { pipeline: 'orchestrator' }); const session = success(await h.post(opening));
    const db = h.db, state = h.state; await h.close();
    h = await harness(t, { pipeline: 'legacy', db, state }); success(await h.post('Bỏ điều kiện ngân sách.', session));
    assert.equal(db.envelope(session).memory, null); await h.close();
    const prior = state.contexts.length;
    h = await harness(t, { pipeline: 'orchestrator', db, state }); success(await h.post('Mình muốn trò chuyện.', session));
    assert.deepEqual(state.contexts[prior].active_context.constraints, {});
    assert.ok(state.contexts[prior].recent_history.some(item => item.text === 'Bỏ điều kiện ngân sách.'));
    assert.equal(getActiveContext(db.envelope(session).memory).constraints.budget, undefined);
});
