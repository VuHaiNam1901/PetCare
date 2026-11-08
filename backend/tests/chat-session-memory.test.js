'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createChatStore, requestHash, sessionStorageId } = require('../ai/sessions');
const { createMemory, appendMessage, applyMemoryPatch, getActiveContext,
    resolveDisplayedProduct, serializeMemory } = require('../ai/memory');

// This protocol fixture exercises the real store without importing a real
// database pool, credentials, SQL driver, route, or Gemini adapter.
class MemorySqlFixture {
    constructor() {
        this.rows = [];
        this.events = [];
        this.locks = new Set();
        this.connections = new Set();
        this.nextId = 1;
        this.failInsert = false;
        this.failCommit = false;
        this.failRollback = false;
        this.failLoad = false;
    }
    row(token, message, userId = null, sender = 'assistant') {
        this.rows.push({ chat_history_id: this.nextId++, user_id: userId,
            message: typeof message === 'string' ? message : JSON.stringify(message),
            sender, session_id: sessionStorageId(token) });
    }
    async getConnection() {
        const fixture = this;
        let lock = null, pending = null;
        const connection = {
            async execute(sql, values = []) {
                if (sql.includes('GET_LOCK')) {
                    if (fixture.locks.has(values[0])) return [[{ acquired: 0 }]];
                    lock = values[0];
                    fixture.locks.add(lock);
                    fixture.events.push('lock');
                    return [[{ acquired: 1 }]];
                }
                assert.ok(lock, 'all session reads and writes require the same connection lock');
                if (sql.includes('RELEASE_LOCK')) {
                    assert.equal(values[0], lock);
                    fixture.locks.delete(lock);
                    lock = null;
                    fixture.events.push('unlock');
                    return [[{ released: 1 }]];
                }
                const scoped = fixture.rows.filter(row => row.session_id === values[0]);
                if (sql.startsWith('SELECT DISTINCT user_id')) return [scoped.map(row => ({ user_id: row.user_id }))];
                if (sql.startsWith('SELECT message')) {
                    if (!sql.includes('LIKE') && fixture.failLoad) throw new Error('private database load failure');
                    const rows = scoped.filter(row => row.sender === 'assistant' &&
                        (!sql.includes('LIKE') || row.message.includes(values[1].slice(1, -1))));
                    return [rows.slice(-1).map(row => ({ message: row.message }))];
                }
                if (sql.startsWith('SELECT sender')) return [scoped.slice(-8).reverse()
                    .map(row => ({ sender: row.sender, message: row.message }))];
                if (sql.startsWith('INSERT INTO chat_histories')) {
                    assert.ok(pending, 'history and memory require one transaction');
                    for (const offset of [0, 4]) pending.push({ chat_history_id: fixture.nextId++,
                        user_id: values[offset], message: values[offset + 1], sender: values[offset + 2], session_id: values[offset + 3] });
                    fixture.events.push('insert');
                    if (fixture.failInsert) throw new Error('private database insert failure');
                    return [{ affectedRows: 2 }];
                }
                throw new Error(`Unexpected offline memory query: ${sql}`);
            },
            async beginTransaction() {
                assert.equal(pending, null);
                assert.ok(lock);
                pending = [];
                fixture.events.push('begin');
            },
            async commit() {
                fixture.events.push('commit');
                if (fixture.failCommit) throw new Error('private database commit failure');
                fixture.rows.push(...pending);
                pending = null;
            },
            async rollback() {
                fixture.events.push('rollback');
                if (fixture.failRollback) throw new Error('private database rollback failure');
                pending = null;
            },
            release() {
                assert.equal(lock, null);
                assert.equal(pending, null);
                fixture.events.push('release');
                fixture.connections.delete(connection);
            },
            destroy() {
                fixture.locks.delete(lock);
                lock = null;
                pending = null;
                fixture.events.push('destroy');
                fixture.connections.delete(connection);
            }
        };
        fixture.connections.add(connection);
        return connection;
    }
}

const response = { message: 'Hai lựa chọn cho Miu 🐾', products: [{ product_id: 28 }, { product_id: 12 }], code: 'OK' };
const opening = 'Miu là mèo 6 tháng, ngân sách dưới 200000 đồng.';
const clone = value => JSON.parse(JSON.stringify(value));
const checkpointError = error => error.code === 'MEMORY_INVALID' && error.status === 503 && error.chatSafe === true;

function remembered() {
    let memory = appendMessage(createMemory(), { turn_id: 'u:first', role: 'user', text: opening });
    const source = { kind: 'user', turn_id: 'u:first', quote: opening };
    const fact = value => ({ value, source });
    memory = applyMemoryPatch(memory, { base_revision: memory.revision, operations: [
        { op: 'add_pet', pet_id: 'miu', fields: { name: fact('Miu'), species: fact('cat'), age: fact({ amount: 6, unit: 'months' }) } },
        { op: 'switch_pet', pet_id: 'miu' },
        { op: 'switch_topic', topic: 'food', source },
        { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact({ currency: 'VND', min: null, max: '200000.00' }) }
    ] });
    return appendMessage(memory, { turn_id: 'a:first', role: 'assistant', text: response.message, product_ids: [28, 12] });
}

const pair = (memory = remembered(), overrides = {}) => ({ message: opening, requestId: randomUUID(),
    hash: requestHash(opening), response: clone(response), memory, pipeline: 'orchestrator', ...overrides });
function setup() {
    const fixture = new MemorySqlFixture();
    return { fixture, store: createChatStore({ pool: fixture }), token: `guest-${randomUUID()}` };
}
const session = (store, token, callback, userId = null) => store.withSession({ sessionId: token, userId }, callback);

test('session memory: empty sessions return null under the session lock', async () => {
    const { fixture, store, token } = setup();
    await session(store, token, async current => assert.equal(await current.loadMemory(), null));
    assert.deepEqual(fixture.events, ['lock', 'unlock', 'release']);
    assert.equal(fixture.connections.size, 0);
});

test('session memory: a committed checkpoint survives a fresh store and preserves order and provenance', async () => {
    const { fixture, store, token } = setup();
    const saved = pair();
    await session(store, token, current => current.savePair(saved));
    assert.equal(fixture.rows.length, 2);
    assert.ok(fixture.rows.every(row => /^[\x00-\x7f]*$/.test(row.message)), 'utf8mb3-safe JSON includes memory and emoji');
    const encoded = JSON.parse(fixture.rows[1].message);
    assert.equal(encoded.v, 1);
    assert.equal(encoded.pipeline, 'orchestrator');
    assert.deepEqual(encoded.memory, saved.memory);
    assert.deepEqual(encoded.response, saved.response);
    assert.deepEqual(fixture.events, ['lock', 'begin', 'insert', 'commit', 'unlock', 'release']);

    const restoredStore = createChatStore({ pool: fixture });
    await session(restoredStore, token, async current => {
        const restored = await current.loadMemory();
        assert.deepEqual(restored, saved.memory);
        const context = getActiveContext(restored);
        assert.equal(context.pet.name.value, 'Miu');
        assert.equal(context.pet.name.source.kind, 'user');
        assert.equal(context.constraints.budget.value.max, '200000.00');
        assert.equal(resolveDisplayedProduct(restored, { position: 2 }), 12);
        restored.state.pets[0].name.value = 'Only this copy';
        assert.equal(getActiveContext(await current.loadMemory()).pet.name.value, 'Miu');
    });
    assert.equal(fixture.connections.size, 0);
});

test('session memory: history and replay response exclude internal checkpoints', async () => {
    const { store, token } = setup();
    const saved = pair();
    await session(store, token, async current => {
        await current.savePair(saved);
        const history = await current.history();
        assert.deepEqual(history, [{ role: 'user', text: opening },
            { role: 'assistant', text: response.message, product_ids: [28, 12] }]);
        assert.equal(JSON.stringify(history).includes('schema_version'), false);
        const replay = await current.findRequest(saved.requestId);
        assert.equal(replay.request_hash, saved.hash);
        assert.deepEqual(replay.response, response);
        assert.equal(Object.hasOwn(replay.response, 'memory'), false);
        assert.equal(Object.hasOwn(replay.response, 'pipeline'), false);
        assert.deepEqual(replay.memory, saved.memory);
    });
});

test('session memory: replay lookup is read-only and cannot revert a later checkpoint', async () => {
    const { fixture, store, token } = setup();
    const first = pair();
    await session(store, token, current => current.savePair(first));
    let next = appendMessage(first.memory, { turn_id: 'u:next', role: 'user', text: 'Tăng ngân sách thành 300000.' });
    next = applyMemoryPatch(next, { base_revision: next.revision, operations: [{ op: 'set_fact', section: 'constraints', key: 'budget',
        fact: { value: { currency: 'VND', min: null, max: '300000.00' }, source: { kind: 'user', turn_id: 'u:next', quote: 'Tăng ngân sách thành 300000.' } } }] });
    next = appendMessage(next, { turn_id: 'a:next', role: 'assistant', text: 'Đã ghi nhớ nhu cầu.' });
    await session(store, token, current => current.savePair(pair(next)));
    const before = fixture.rows.map(row => row.message);
    await session(store, token, async current => {
        assert.equal((await current.findRequest(first.requestId)).memory.revision, first.memory.revision);
        assert.equal(getActiveContext(await current.loadMemory()).constraints.budget.value.max, '300000.00');
        assert.equal(await current.findRequest(randomUUID()), null);
    });
    assert.deepEqual(fixture.rows.map(row => row.message), before);
});

for (const failure of ['failInsert', 'failCommit']) {
    test(`session memory: ${failure} rolls back both history and candidate memory`, async () => {
        const { fixture, store, token } = setup();
        const first = pair();
        await session(store, token, current => current.savePair(first));
        const candidate = appendMessage(first.memory, { turn_id: 'u:failed', role: 'user', text: 'Không được lưu lượt này.' });
        const failed = pair(candidate);
        fixture[failure] = true;
        await assert.rejects(session(store, token, current => current.savePair(failed)), /private database/);
        fixture[failure] = false;
        assert.equal(fixture.rows.length, 2);
        assert.ok(fixture.events.includes('rollback'));
        await session(store, token, async current => {
            assert.deepEqual(await current.loadMemory(), first.memory);
            assert.equal(await current.findRequest(failed.requestId), null);
            await current.savePair(failed);
            assert.deepEqual(await current.loadMemory(), candidate);
        });
        assert.equal(fixture.rows.length, 4);
        assert.equal(fixture.connections.size, 0);
    });
}

test('session memory: a rollback failure destroys the connection without publishing its candidate', async () => {
    const { fixture, store, token } = setup();
    fixture.failInsert = true;
    fixture.failRollback = true;
    await assert.rejects(session(store, token, current => current.savePair(pair())), /private database insert/);
    assert.deepEqual(fixture.events, ['lock', 'begin', 'insert', 'rollback', 'destroy']);
    assert.equal(fixture.rows.length, 0);
    assert.equal(fixture.locks.size, 0);
    assert.equal(fixture.connections.size, 0);
});

test('session memory: legacy turns write a null marker and never revive a pre-rollback checkpoint', async () => {
    const { fixture, store, token } = setup();
    await session(store, token, current => current.savePair(pair()));
    const legacy = { message: 'Chủ đề khác', requestId: randomUUID(), hash: requestHash('Chủ đề khác'),
        response: { message: 'Legacy reply', products: [], code: 'OK' } };
    await session(store, token, current => current.savePair(legacy));
    const latest = JSON.parse(fixture.rows.at(-1).message);
    assert.equal(latest.memory, null);
    assert.equal(latest.pipeline, 'legacy');
    await session(createChatStore({ pool: fixture }), token, async current => {
        assert.equal(await current.loadMemory(), null);
        assert.equal((await current.history()).length, 4);
    });
    assert.equal(fixture.rows.length, 4, 'rollback does not delete older rows');
});

test('session memory: old v1 envelopes and plain-text latest answers invalidate older checkpoints', async t => {
    for (const oldFormat of ['envelope', 'plain']) {
        await t.test(oldFormat, async () => {
            const { fixture, store, token } = setup();
            await session(store, token, current => current.savePair(pair()));
            fixture.row(token, oldFormat === 'plain' ? 'Legacy answer' : { v: 1, request_id: randomUUID(),
                request_hash: requestHash('Legacy'), response: { message: 'Legacy answer' } });
            await session(store, token, async current => assert.equal(await current.loadMemory(), null));
        });
    }
});

test('session memory: invalid checkpoints fail before beginning any transaction', async t => {
    for (const [name, memory] of [
        ['empty object', {}], ['legacy array', []], ['future version', { ...createMemory(), schema_version: 2 }],
        ['broken schema', { ...createMemory(), recent_history: 'wrong' }],
        ['oversized snapshot', { ...createMemory(), summary: { text: 'x'.repeat(40000), through_sequence: 0, kind: null } }]
    ]) {
        await t.test(name, async () => {
            const { fixture, store, token } = setup();
            await assert.rejects(session(store, token, current => current.savePair(pair(memory))), checkpointError);
            assert.equal(fixture.rows.length, 0);
            assert.deepEqual(fixture.events, ['lock', 'unlock', 'release']);
        });
    }
});

test('session memory: the whole encoded envelope still has a 60000-byte cap', async () => {
    const { fixture, store, token } = setup();
    let memory = createMemory();
    for (let i = 0; i < 12; i++) memory = appendMessage(memory,
        { turn_id: `size:${i}`, role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(1900) });
    assert.ok(Buffer.byteLength(serializeMemory(memory)) < 32768);
    // Both values fit their independent budget; their utf8mb3-safe combined
    // envelope does not. Check before starting a transaction or inserting rows.
    const oversized = pair(memory, { response: { message: '🐾'.repeat(3200), products: [], code: 'OK' } });
    await assert.rejects(session(store, token, current => current.savePair(oversized)),
        error => error.code === 'RESPONSE_TOO_LARGE' && error.status === 503 && error.chatSafe === true);
    assert.deepEqual(fixture.events, ['lock', 'unlock', 'release']);
    assert.equal(fixture.rows.length, 0);
});

test('session memory: a corrupt latest checkpoint never falls back to an older valid one', async t => {
    const cases = [
        ['future memory', { memory: { ...createMemory(), schema_version: 42 } }],
        ['empty memory', { memory: {} }],
        ['legacy memory', { memory: [] }],
        ['missing orchestrator memory', { memory: undefined }],
        ['null orchestrator memory', { memory: null }],
        ['unknown pipeline', { memory: createMemory(), pipeline: 'unknown' }],
        ['legacy with checkpoint', { memory: createMemory(), pipeline: 'legacy' }]
    ];
    for (const [name, changes] of cases) await t.test(name, async () => {
        const { fixture, store, token } = setup();
        await session(store, token, current => current.savePair(pair()));
        fixture.row(token, { v: 1, request_id: randomUUID(), request_hash: requestHash('new'),
            response: { message: 'Latest answer' }, memory: createMemory(), pipeline: 'orchestrator', ...changes });
        await assert.rejects(session(store, token, current => current.loadMemory()), checkpointError);
        assert.equal(fixture.rows.length, 3);
        assert.equal(fixture.connections.size, 0);
    });
});

test('session memory: malformed internal envelopes fail closed', async t => {
    for (const value of ['{"v":1,"memory":', { v: 1, memory: createMemory(), pipeline: 'orchestrator' }]) {
        await t.test(typeof value === 'string' ? 'invalid JSON' : 'invalid outer shape', async () => {
            const { fixture, store, token } = setup();
            fixture.row(token, value);
            await assert.rejects(session(store, token, current => current.loadMemory()), checkpointError);
            assert.equal(fixture.connections.size, 0);
        });
    }
});

test('session memory: a valid checkpoint without optional pipeline metadata remains readable', async () => {
    const { fixture, store, token } = setup();
    const memory = remembered();
    fixture.row(token, { v: 1, request_id: randomUUID(), request_hash: requestHash(opening), response, memory });
    await session(store, token, async current => assert.deepEqual(await current.loadMemory(), memory));
});

test('session memory: contradictory save metadata cannot publish a checkpoint', async t => {
    for (const [name, changes] of [
        ['missing orchestrator memory', { memory: null }],
        ['legacy memory', { pipeline: 'legacy' }],
        ['unknown pipeline', { pipeline: 'invalid' }]
    ]) await t.test(name, async () => {
        const { fixture, store, token } = setup();
        await assert.rejects(session(store, token, current => current.savePair(pair(remembered(), changes))), checkpointError);
        assert.equal(fixture.rows.length, 0);
        assert.equal(fixture.events.includes('begin'), false);
    });
});

test('session memory: session and owner boundaries apply before any checkpoint is returned', async () => {
    const { fixture, store, token } = setup();
    await session(store, token, current => current.savePair(pair()), 5);
    await session(store, `${token}-other`, async current => assert.equal(await current.loadMemory(), null));
    for (const wrongUser of [null, 6]) await assert.rejects(
        session(store, token, current => current.loadMemory(), wrongUser),
        error => error.code === 'SESSION_FORBIDDEN' && error.status === 403);
    await session(store, token, async current => assert.equal(getActiveContext(await current.loadMemory()).pet.name.value, 'Miu'), 5);
    assert.equal(fixture.rows.length, 2);
    assert.equal(fixture.connections.size, 0);
});

test('session memory: a load failure releases the lock and makes no persistent change', async () => {
    const { fixture, store, token } = setup();
    await session(store, token, current => current.savePair(pair()));
    const before = fixture.rows.map(row => row.message);
    fixture.failLoad = true;
    await assert.rejects(session(store, token, current => current.loadMemory()), /private database load/);
    assert.deepEqual(fixture.rows.map(row => row.message), before);
    assert.equal(fixture.locks.size, 0);
    assert.equal(fixture.connections.size, 0);
});
