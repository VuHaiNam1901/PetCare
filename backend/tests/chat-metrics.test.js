const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { runMeasured, measure, measureSync, addDuration, setCode, STAGES } = require('../ai/metrics');
const { buildContext, inferSearch } = require('../ai/context');
const { createProductRepository } = require('../ai/products');
const { createChatStore, createSessionCodec } = require('../ai/sessions');

function assertEvent(event) {
    assert.deepEqual(Object.keys(event).sort(), ['code', 'counts', 'name', 'timings_ms']);
    assert.equal(event.name, 'chat_metrics');
    assert.deepEqual(Object.keys(event.counts), STAGES);
    assert.deepEqual(Object.keys(event.timings_ms), [...STAGES, 'mysql_ms', 'processing_ms', 'total_ms']);
    assert.ok(Object.values(event.timings_ms).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0));
    assert.ok(Object.values(event.counts).every(value => Number.isSafeInteger(value) && value >= 0));
}

test('stage timings preserve sync/async values and report numeric durations/counts', async () => {
    let event;
    const value = { result: 'private response' };
    assert.equal(measure('grounding_ms', () => value), value);
    const result = await runMeasured(async () => {
        assert.equal(measure('grounding_ms', () => 7), 7);
        assert.equal(measureSync('context_history_ms', () => value), value);
        await measure('gemini_ms', () => delay(4));
        addDuration('mysql_products_ms', 1.25);
        return value;
    }, { onComplete: metrics => { event = metrics; } });
    assert.equal(result, value);
    assertEvent(event);
    assert.equal(event.code, 'OK');
    assert.equal(event.counts.gemini_ms, 1);
    assert.equal(event.counts.grounding_ms, 1);
    assert.equal(event.timings_ms.mysql_products_ms, 1.25);
    assert.ok(event.timings_ms.gemini_ms > 0);
    assert.ok(event.timings_ms.total_ms >= event.timings_ms.gemini_ms);
});

test('failed stages remain timed and errors keep their original identity', async () => {
    let event;
    const failure = Object.assign(new Error('prompt token SQL password and stack are private'), { code: 'GEMINI_TIMEOUT' });
    await assert.rejects(runMeasured(async () => {
        await measure('gemini_ms', async () => { await delay(3); throw failure; });
    }, { onComplete: value => { event = value; } }), error => error === failure);
    assertEvent(event);
    assert.equal(event.code, 'GEMINI_TIMEOUT');
    assert.equal(event.counts.gemini_ms, 1);
    assert.ok(event.timings_ms.gemini_ms > 0);
    const syncFailure = new Error('private sync error');
    await assert.rejects(runMeasured(() => measureSync('grounding_ms', () => { throw syncFailure; }), {
        onComplete: value => { event = value; }
    }), error => error === syncFailure);
    assert.equal(event.code, 'ERROR');
    assert.equal(event.counts.grounding_ms, 1);
});

test('concurrent and nested measurements isolate their own stages and codes', async () => {
    const events = [];
    await Promise.all([1, 2, 3].map(index => runMeasured(async () => {
        addDuration('mysql_products_ms', index);
        await delay(5 - index);
        addDuration('mysql_products_ms', index);
        if (index === 2) {
            await runMeasured(() => { addDuration('mysql_products_ms', 50); setCode('NO_PRODUCTS'); }, {
                onComplete: value => { events.push({ index: 50, value }); }
            });
        }
    }, { onComplete: value => { events.push({ index, value }); } })));
    for (const { index, value } of events) {
        assert.equal(value.timings_ms.mysql_products_ms, index === 50 ? 50 : index * 2);
        assert.equal(value.counts.mysql_products_ms, index === 50 ? 1 : 2);
        assert.equal(value.code, index === 50 ? 'NO_PRODUCTS' : 'OK');
    }
    assert.equal(events.length, 4);
});

test('logging is disabled by default and diagnostics cannot alter outcomes', async () => {
    const previous = process.env.CHAT_METRICS;
    delete process.env.CHAT_METRICS;
    let logged = false;
    try {
        assert.equal(await runMeasured(() => 19, {
            onComplete() { throw new Error('diagnostic failure'); }, logger() { logged = true; }
        }), 19);
        assert.equal(logged, false);
        process.env.CHAT_METRICS = '1';
        assert.equal(await runMeasured(() => 23, {
            onComplete: async () => { throw new Error('async diagnostic failure'); },
            logger() { throw new Error('logging failure'); }
        }), 23);
        await delay(0);
    } finally {
        if (previous === undefined) delete process.env.CHAT_METRICS;
        else process.env.CHAT_METRICS = previous;
    }
});

test('enabled logs allow only fixed names, sanitized codes, durations and counts', async () => {
    const previous = process.env.CHAT_METRICS;
    process.env.CHAT_METRICS = '1';
    const sensitive = 'private-user-session-token-sql-prompt-key-stack';
    let logged;
    try {
        const result = await runMeasured(() => {
            addDuration(sensitive, 99);
            addDuration('mysql_products_ms', NaN);
            addDuration('mysql_products_ms', -1);
            setCode(sensitive);
            return { input: sensitive, request_id: sensitive, user_id: sensitive, config: sensitive };
        }, {
            onComplete(event) { event.input = sensitive; event.timings_ms.token = sensitive; event.counts.user_id = 1; },
            logger: event => { logged = event; }
        });
        assert.equal(result.input, sensitive);
        assertEvent(logged);
        assert.equal(logged.code, 'ERROR');
        assert.equal(JSON.stringify(logged).includes(sensitive), false);
        assert.ok(Object.isFrozen(logged) && Object.isFrozen(logged.timings_ms) && Object.isFrozen(logged.counts));
    } finally {
        if (previous === undefined) delete process.env.CHAT_METRICS;
        else process.env.CHAT_METRICS = previous;
    }
});

const product = id => ({ product_id: id, category_id: 1, category_name: 'Food', name: `Food ${id}`,
    price: `${id}.00`, stock_quantity: 5, description: 'Food', image_url: `/private-image-${id}.jpg`, status: '\u0110ang b\u00e1n' });

test('catalog keyset page SQL is aggregated separately from context processing', async () => {
    let page = 0;
    let event;
    const repository = createProductRepository({ db: { async execute() {
        await delay(2);
        return [page++ === 0 ? Array.from({ length: 64 }, (_, index) => product(index + 1)) : [product(65)]];
    } } });
    const result = await runMeasured(() => repository.search(), { onComplete: value => { event = value; } });
    assert.equal(result.totalMatches, 65);
    assert.equal(event.counts.mysql_products_ms, 2);
    assert.equal(event.timings_ms.mysql_ms, event.timings_ms.mysql_products_ms);
    assert.equal(event.counts.context_history_ms, 0);
});

test('context CPU timing excludes repository waits and model catalog omits image URLs', async () => {
    let event;
    const context = await runMeasured(() => buildContext({ message: 'Tìm thức ăn', repository: {
        search: () => measure('mysql_products_ms', async () => { await delay(35); return { products: [product(1)], totalMatches: 1 }; })
    } }), { onComplete: value => { event = value; } });
    assert.equal(context.products[0].image_url, product(1).image_url);
    assert.equal(Object.hasOwn(context.payload.catalog.products[0], 'image_url'), false);
    assert.equal(event.counts.mysql_products_ms, 1);
    assert.ok(event.timings_ms.mysql_products_ms >= 20);
    assert.ok(event.timings_ms.context_history_ms < event.timings_ms.mysql_products_ms);
    assert.ok(event.timings_ms.processing_ms < event.timings_ms.total_ms);
});

test('history loads, advisory wait and transaction driver calls use separate buckets', async () => {
    let event;
    let released = false;
    const connection = {
        async execute(sql) {
            await delay(1);
            if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
            if (sql.includes('SELECT sender')) return [[{ sender: 'user', message: 'private history' }]];
            return [[]];
        },
        beginTransaction: () => delay(1), commit: () => delay(1), rollback: () => delay(1),
        release() { released = true; }, destroy() { released = true; }
    };
    const store = createChatStore({ pool: { getConnection: async () => { await delay(1); return connection; } } });
    await runMeasured(() => store.withSession({ sessionId: 'private session' }, async session => {
        await session.findRequest(randomUUID());
        const history = await session.history();
        assert.equal(history[0].text, 'private history');
        await session.savePair({ message: 'private input', requestId: randomUUID(), hash: 'private hash', response: { message: 'private output' } });
    }), { onComplete: value => { event = value; } });
    assert.equal(released, true);
    assert.equal(event.counts.session_wait_ms, 2);
    assert.equal(event.counts.mysql_history_load_ms, 3);
    assert.equal(event.counts.mysql_history_save_ms, 3);
    assert.equal(event.counts.mysql_session_ms, 1);
    assert.equal(event.counts.context_history_ms, 1);
    assert.ok(event.timings_ms.mysql_ms > 0);
    assert.equal(JSON.stringify(event).includes('private'), false);
});

test('nominal budgets parse as an upper bound and listed-only cheapest keeps the selected IDs', async () => {
    for (const message of ['ngân sách 200k', 'ngân sách 200.000đ', 'ngân sách là 200k', 'ngan sach khoang 200k', 'ngân sách tầm 200k']) {
        assert.equal(inferSearch(message).maxPrice, '200000.00');
    }
    const history = [
        { role: 'user', text: 'Thức ăn cho mèo' },
        { role: 'assistant', text: 'Lựa chọn', product_ids: [2, 3, 4], search: { query: 'thức ăn cho mèo', maxPrice: '200000.00' } }
    ];
    const searches = [];
    const repository = { async search(filters) { searches.push(filters); return { products: [product(3)], totalMatches: 1 }; } };
    await buildContext({ message: 'Trong những loại đó, loại nào rẻ nhất?', history, repository });
    assert.deepEqual(searches[0].productIds, [2, 3, 4]);
    assert.equal(searches[0].sort, 'price_asc');
    assert.equal(searches[0].limit, 1);
    await buildContext({ message: 'Loại nào rẻ nhất?', history, repository });
    assert.equal(Object.hasOwn(searches[1], 'productIds'), false);
    history.push({ role: 'assistant', text: 'Rẻ nhất', product_ids: [3], search: searches[0] });
    await buildContext({ message: 'Loại đó có phù hợp với mèo 6 tháng không?', history, repository });
    assert.deepEqual(searches[2].productIds, [3]);
});

test('route metrics include saving and stay out of the public response when the hook fails', async () => {
    process.env.JWT_SECRET ||= 'chat-metrics-tests-only-secret';
    const express = require('express');
    const { createChatRouter } = require('../routes/chat');
    const pool = require('../config/db');
    after(() => pool.end());
    const events = [];
    const app = express();
    app.use(express.json());
    app.use('/chat', createChatRouter({
        assistant: { reply: async () => ({ message: 'Answer', products: [], code: 'OK' }) },
        store: { withSession: async (input, callback) => callback({ findRequest: async () => null, history: async () => [],
            savePair: () => measure('mysql_history_save_ms', () => delay(8)) }) },
        sessionCodec: createSessionCodec('chat-metrics-tests-only-secret'),
        onMetrics(event) { events.push(event); throw new Error('private hook failure'); }
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'private request', request_id: randomUUID() }) });
        const data = await response.json();
        assert.equal(response.status, 200);
        assert.equal(data.message, 'Answer');
        assert.equal(data.timings_ms, undefined);
        assert.equal(data.counts, undefined);
        assert.equal(events.length, 1);
        assertEvent(events[0]);
        assert.equal(events[0].counts.mysql_history_save_ms, 1);
        assert.ok(events[0].timings_ms.total_ms >= events[0].timings_ms.mysql_history_save_ms);
        assert.equal(JSON.stringify(events[0]).includes(data.session_id), false);
        assert.equal(JSON.stringify(events[0]).includes(data.request_id), false);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
