const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const express = require('express');
const { classifyIntent } = require('../ai/context');
const { createAssistant } = require('../ai/assistant');
const { createSessionCodec } = require('../ai/sessions');
const { createChatLimiter } = require('../ai/rate-limit');

// These tests preserve a diagnosis of the existing pipeline, not evidence of
// the cause of an unobserved production incident. The same public sentence can
// represent different backend error codes; no real Gemini or MySQL is used.
const testSecret = randomBytes(48).toString('hex');
const blockedPoolCalls = [];
const blockedPool = Object.freeze(Object.fromEntries(['execute', 'query', 'getConnection'].map(method =>
    [method, async () => { blockedPoolCalls.push(method); throw new Error('Offline diagnostic forbids database access'); }])));
const fixtureModules = ['../config/db', '../config/auth', '../models/user', '../middleware/auth', '../routes/chat']
    .map(request => require.resolve(request));
const savedModules = new Map(fixtureModules.map(filename => [filename, require.cache[filename]]));
const cacheFixture = (filename, exports) => {
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let createChatRouter, createChatCapacity;
try {
    for (const filename of fixtureModules) delete require.cache[filename];
    cacheFixture(fixtureModules[0], blockedPool);
    cacheFixture(fixtureModules[1], { secret: testSecret, expiresIn: '1h' });
    ({ createChatRouter, createChatCapacity } = require('../routes/chat'));
} finally {
    for (const [filename, previous] of savedModules) {
        if (previous) require.cache[filename] = previous;
        else delete require.cache[filename];
    }
}
after(() => assert.deepEqual(blockedPoolCalls, [], 'the fixture must never access a real pool'));

const managerMessage = 'Cho gặp quản lý';
const interruption = 'Trợ lý đang tạm thời gián đoạn. Bạn vui lòng thử lại.';
const syntheticProduct = {
    product_id: 7101, category_id: 71, name: 'Thức ăn tổng hợp để kiểm thử',
    category_name: 'Danh mục tổng hợp', price: '100000.00', stock_quantity: 2,
    status: 'Đang bán', description: 'Fixture chẩn đoán, không phải sản phẩm thật.', image_url: null
};

async function diagnose(scenario) {
    const calls = { search: 0, gemini: 0, saved: 0 };
    const repository = { async search() {
        calls.search++;
        if (scenario === 'catalog_error') throw new Error('Private fixture catalog error');
        const products = scenario === 'gemini_quota' ? [syntheticProduct] : [];
        return { products, totalMatches: products.length, catalogLimited: false };
    } };
    const assistant = createAssistant({ repository, generate: async () => {
        calls.gemini++;
        throw Object.assign(new Error('Private fixture provider error'), { status: 429 });
    } });
    const store = { async withSession(options, callback) {
        return callback({
            async findRequest() { return null; },
            async history() { return []; },
            async savePair() { calls.saved++; }
        });
    } };
    const app = express();
    app.use(express.json());
    app.use('/api/chat', createChatRouter({ assistant, store,
        sessionCodec: createSessionCodec(testSecret), capacity: createChatCapacity(1),
        limiter: createChatLimiter({ sessionLimit: 100, ipLimit: 100 }) }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: managerMessage, request_id: randomUUID() })
        });
        return { status: response.status, body: await response.json(), calls };
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

test('manager diagnostic: an empty catalog intercepts an ordinary conversation before Gemini', async () => {
    assert.equal(classifyIntent(managerMessage), 'product_search');
    const result = await diagnose('catalog_empty');
    assert.equal(result.status, 200);
    assert.equal(result.body.code, 'NO_PRODUCTS');
    assert.equal(result.body.success, true);
    assert.notEqual(result.body.message, interruption);
    assert.deepEqual(result.calls, { search: 1, gemini: 0, saved: 1 });
});

test('manager diagnostic: a catalog error reproduces the interruption with no Gemini request', async () => {
    const result = await diagnose('catalog_error');
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'CATALOG_UNAVAILABLE');
    assert.equal(result.body.success, false);
    assert.equal(result.body.message, interruption);
    assert.deepEqual(result.calls, { search: 1, gemini: 0, saved: 0 });
    assert.equal(JSON.stringify(result.body).includes('Private fixture'), false);
});

test('manager diagnostic: a different provider failure has the same sentence but its own error code', async () => {
    const result = await diagnose('gemini_quota');
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'GEMINI_QUOTA');
    assert.equal(result.body.success, false);
    assert.equal(result.body.message, interruption);
    assert.deepEqual(result.calls, { search: 1, gemini: 1, saved: 0 });
    assert.equal(JSON.stringify(result.body).includes('Private fixture'), false);
});
