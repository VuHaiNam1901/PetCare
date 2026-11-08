'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const express = require('express');
const { createOrchestrator } = require('../ai/orchestrator');
const { createProductRepository } = require('../ai/products');
const { serializeMemory, deserializeMemory, getActiveContext } = require('../ai/memory');
const { createSessionCodec } = require('../ai/sessions');

// Express and the orchestrator/memory/tools/repository are real. Only the
// database driver and Gemini boundary are in-memory fixtures. These tests do
// not claim to measure the real model's Vietnamese conversation quality.
const clone = value => JSON.parse(JSON.stringify(value));
const opening = 'Miu là mèo 6 tháng. Mình cần hạt, ngân sách tối đa 200000 đồng.';
const products = () => [
    item(101, 'Hạt khô cho mèo mẫu A', '180000.00'),
    item(102, 'Hạt khô cho mèo mẫu B', '150000.00'),
    item(103, 'Hạt khô cho mèo mẫu C', '80000.00'),
    item(201, 'Đồ chơi cho mèo mẫu D', '50000.00', 2),
    item(202, 'Đồ chơi cho mèo mẫu E', '70000.00', 2)
];
function item(product_id, name, price, category_id = 1) {
    return { product_id, category_id, category_name: category_id === 1 ? 'Thức ăn' : 'Đồ chơi',
        name, price, stock_quantity: 3, status: 'Đang bán', image_url: '/images/products/conversation-fixture.webp',
        description: 'Dữ liệu tổng hợp riêng cho kiểm thử.' };
}
function finalReply(intent, advice, product_ids = [], mode = product_ids.length ? 'product' : 'care') {
    return { name: 'respond', args: { mode, intent, advice, product_ids, follow_up: null, warnings: [] } };
}
function userSource(initial) {
    return { kind: 'user', turn_id: initial.current_turn_id, quote: initial.user_request };
}
function update(operations) { return { name: 'update_memory', args: { operations } }; }

function conversationScript(initial, replies) {
    const source = userSource(initial);
    const step = replies.filter(reply => reply.name !== 'compact_memory').length;
    if (initial.user_request === opening) {
        if (step === 0) return update([
            { op: 'add_pet', pet_id: 'miu', fields: { name: { value: 'Miu', source }, species: { value: 'cat', source }, age: { value: { amount: 6, unit: 'months' }, source } } },
            { op: 'switch_pet', pet_id: 'miu' }, { op: 'switch_topic', topic: 'food', source },
            { op: 'set_fact', section: 'needs', key: 'product_type', fact: { value: 'kibble', source } },
            { op: 'set_fact', section: 'constraints', key: 'budget', fact: { value: { currency: 'VND', min: null, max: '200000.00' }, source } }
        ]);
        if (step === 1) return { name: 'search_products', args: { filters: { query: 'hạt cho mèo' } } };
        return finalReply('product_advice', 'Bạn có thể cân nhắc các lựa chọn bên dưới và kiểm tra thông tin trên nhãn.', [101, 102]);
    }
    if (initial.user_request === 'Cái thứ hai, có món nào rẻ hơn không?') {
        assert.deepEqual(initial.active_context.displayed_product_set.product_ids, [101, 102]);
        assert.equal(initial.active_context.pet.age.value.amount, 6);
        assert.equal(initial.active_context.constraints.budget.value.max, '200000.00');
        if (step === 0) return { name: 'get_product_details', args: { product_ids: [102] } };
        const details = replies.find(reply => reply.name === 'get_product_details').response;
        assert.equal(details.products[0].price, '90000.00', 'reference prices must be read again, not taken from history');
        if (step === 1) return { name: 'search_products', args: { filters: { query: 'hạt cho mèo', maxPrice: '89999.99', sort: 'price_asc' } } };
        return finalReply('product_advice', 'Lựa chọn bên dưới có mức giá thấp hơn sản phẩm bạn vừa nhắc đến tại thời điểm tra cứu.', [103]);
    }
    if (initial.user_request === 'Tăng ngân sách lên 300000 đồng.') {
        if (step === 0) return update([{ op: 'set_fact', section: 'constraints', key: 'budget', fact: { value: { currency: 'VND', min: null, max: '300000.00' }, source } }]);
        if (step === 1) return { name: 'search_products', args: { filters: { query: 'hạt cho mèo' } } };
        return finalReply('product_advice', 'Mình đã đối chiếu các lựa chọn bên dưới với ngân sách bạn vừa điều chỉnh.', [101, 102]);
    }
    if (initial.user_request === 'Bỏ ngân sách và chuyển sang đồ chơi cho Miu.') {
        if (step === 0) return update([
            { op: 'remove_fact', section: 'constraints', key: 'budget', source },
            { op: 'switch_topic', topic: 'toys', source },
            { op: 'set_fact', section: 'needs', key: 'product_type', fact: { value: 'toys', source } }
        ]);
        if (step === 1) return { name: 'search_products', args: { filters: { query: 'đồ chơi cho mèo' } } };
        return finalReply('product_search', 'Bạn xem các lựa chọn đồ chơi bên dưới nhé.', [201, 202]);
    }
    if (initial.user_request === 'Hai món đó, loại nào bền hơn?') {
        assert.deepEqual(initial.active_context.displayed_product_set.product_ids, [201, 202]);
        if (step === 0) return { name: 'compare_products', args: { product_ids: [201, 202], criteria: ['price', 'durability'] } };
        assert.deepEqual(replies.find(reply => reply.name === 'compare_products').response.comparison.not_verified, ['durability']);
        return finalReply('compare', 'Mình chưa có dữ liệu xác minh độ bền để kết luận lựa chọn nào bền hơn. Bạn có thể đối chiếu những thông tin đã xác nhận trong thẻ.', [201, 202]);
    }
    if (initial.user_request === 'Cho gặp quản lý') {
        return finalReply('handoff_request', 'Mình chưa có chức năng kết nối trực tiếp với quản lý. Bạn muốn trao đổi vấn đề gì để mình hỗ trợ trong khả năng hiện có?');
    }
    if (initial.user_request === 'Còn chăm sóc Miu thì sao?') {
        assert.equal(initial.active_context.pet.name.value, 'Miu');
        assert.equal(initial.active_context.pet.species.value, 'cat');
        assert.equal(initial.active_context.pet.age.value.amount, 6);
        return finalReply('care', 'Bạn có thể giữ chỗ nghỉ khô thoáng, vệ sinh bát hằng ngày và chuẩn bị nước sạch cho bé.');
    }
    if (initial.user_request === 'Mình chỉ muốn trò chuyện một chút.') return finalReply('conversation', 'Mình đang lắng nghe. Bạn muốn chia sẻ điều gì hôm nay?');
    if (initial.user_request === 'Tìm đồ chơi khác.') {
        if (step === 0) return { name: 'search_products', args: { filters: { query: 'đồ chơi cho mèo' } } };
        return finalReply('product_search', 'Bạn xem các lựa chọn bên dưới nhé.', [201, 202]);
    }
    throw new Error('Unexpected synthetic conversation turn');
}

async function backend(t, { script = conversationScript } = {}) {
    const fixture = { inventory: products(), sql: [], generations: [], failGemini: false, failCatalog: false, failCommit: false, compactions: 0 };
    const repository = createProductRepository({ db: { async execute(sql, params) {
        assert.match(sql, /^SELECT\b/);
        fixture.sql.push({ sql, params: clone(params) });
        if (fixture.failCatalog) throw new Error('PRIVATE_MYSQL_PASSWORD');
        const selected = sql.includes('LIMIT 6') && sql.includes('p.product_id IN')
            ? fixture.inventory.filter(row => params.slice(1).includes(row.product_id))
            : fixture.inventory.filter(row => row.product_id > params.at(-1)).sort((a, b) => a.product_id - b.product_id).slice(0, 64);
        return [clone(selected)];
    } }, categoryReader: async () => [{ category_id: 1, name: 'Thức ăn' }, { category_id: 2, name: 'Đồ chơi' }] });
    let serial = 0;
    const generate = async request => {
        fixture.generations.push(clone({ ...request, config: { ...request.config, abortSignal: undefined } }));
        if (fixture.failGemini) throw Object.assign(new Error('PRIVATE_GEMINI_KEY'), { status: 429 });
        const initial = JSON.parse(request.contents[0].parts[0].text);
        const replies = request.contents.flatMap(content => content.parts).filter(part => part.functionResponse).map(part => part.functionResponse);
        for (const content of request.contents.filter(value => value.role === 'model')) {
            assert.equal(content.parts[0].thoughtSignature, 'opaque-test-signature');
            const call = content.parts[0].functionCall;
            assert.ok(replies.some(reply => reply.id === call.id && reply.name === call.name));
        }
        let action;
        if (initial.preparing && !replies.some(reply => reply.name === 'compact_memory')) {
            fixture.compactions++;
            action = { name: 'compact_memory', args: { through_sequence: initial.recent_history[3].sequence,
                text: 'Khách có Miu là mèo; nhu cầu, ngân sách và chủ đề hiện hành nằm trong trạng thái có nguồn. Những lựa chọn trước chỉ là lịch sử.' } };
        } else action = script(initial, replies);
        return { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, totalTokenCount: 200 },
            candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{
                functionCall: { id: `call:${++serial}`, name: action.name, args: action.args }, thoughtSignature: 'opaque-test-signature'
            }] } }] };
    };
    let assistant = createOrchestrator({ generate, repository });
    let persisted = new Map();
    const codec = createSessionCodec(randomBytes(48).toString('hex'));
    const publicFields = ['mode', 'intent', 'message', 'products', 'follow_up', 'warnings', 'code', 'model', 'care_advice'];
    const app = express();
    app.use(express.json());
    app.post('/api/chat', async (req, res) => {
        const { message, request_id } = req.body;
        const session_id = req.body.session_id || codec.issue();
        if (!codec.verify(session_id)) return res.status(403).json({ success: false, code: 'SESSION_FORBIDDEN' });
        const record = persisted.get(session_id) || { memory: null, replies: [] };
        const hash = createHash('sha256').update(message).digest('hex');
        const replay = record.replies.find(item => item.request_id === request_id);
        if (replay) {
            if (replay.hash !== hash) return res.status(409).json({ success: false, code: 'REQUEST_CONFLICT' });
            return res.json({ success: true, session_id, request_id, ...replay.response, replayed: true });
        }
        try {
            const response = await assistant.reply({ message, turn_id: `u:${request_id}`, memory: record.memory ? deserializeMemory(record.memory) : undefined });
            if (fixture.failCommit) throw Object.assign(new Error('PRIVATE_COMMIT_ERROR'), { code: 'SAVE_FAILED', status: 503 });
            const saved = Object.fromEntries(publicFields.filter(key => Object.hasOwn(response, key)).map(key => [key, response[key]]));
            persisted.set(session_id, { memory: serializeMemory(response.memory), replies: [...record.replies, { request_id, hash, response: clone(saved) }] });
            res.json({ success: true, session_id, request_id, ...saved, replayed: false });
        } catch (failure) {
            res.status(failure.status || 503).json({ success: false, session_id, request_id, code: failure.code || 'CHAT_UNAVAILABLE', message: 'Lượt tư vấn chưa hoàn tất.' });
        }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    let session_id;
    async function post(message, request_id = randomUUID(), overrideSession = session_id) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, request_id, ...(overrideSession ? { session_id: overrideSession } : {}) }) });
        const body = await response.json();
        if (body.session_id && !overrideSession) session_id = body.session_id;
        return { status: response.status, body, request_id };
    }
    return { fixture, post, url: `http://127.0.0.1:${server.address().port}/api/chat`,
        snapshot: () => persisted.get(session_id)?.memory,
        memory: () => deserializeMemory(persisted.get(session_id)?.memory),
        restart() { persisted = new Map(JSON.parse(JSON.stringify([...persisted]))); assistant = createOrchestrator({ generate, repository }); }
    };
}

function assertPublic(result) {
    assert.equal(result.status, 200, result.body.code);
    const answer = result.body;
    assert.equal(answer.success, true);
    assert.equal(answer.code, 'OK');
    assert.match(answer.session_id, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    assert.match(answer.request_id, /^[a-f0-9-]{36}$/i);
    assert.equal(typeof answer.message, 'string');
    assert.ok(answer.message.trim());
    assert.ok(Array.isArray(answer.products) && answer.products.length <= 3);
    assert.ok(Array.isArray(answer.warnings));
    assert.equal(Object.hasOwn(answer, 'memory'), false);
    assert.equal(Object.hasOwn(answer, 'usage'), false);
    assert.equal(Object.hasOwn(answer, 'context_search'), false);
    for (const row of answer.products) {
        assert.equal(typeof row.price, 'string');
        assert.ok(Number.isInteger(row.product_id) && Number.isInteger(row.stock_quantity));
        assert.equal(typeof row.available, 'boolean');
        assert.equal(row.source, 'MySQL');
    }
}

test('orchestrator conversation: persisted multi-turn product references use new prices after reconstruction', async t => {
    const h = await backend(t);
    const first = await h.post(opening);
    assertPublic(first);
    assert.deepEqual(first.body.products.map(row => row.product_id), [101, 102]);
    assert.equal(first.body.products[1].price, '150000.00');
    h.restart();
    h.fixture.inventory.find(row => row.product_id === 102).price = '90000.00';
    const second = await h.post('Cái thứ hai, có món nào rẻ hơn không?');
    assertPublic(second);
    assert.deepEqual(second.body.products.map(row => row.product_id), [103]);
    assert.equal(second.body.products[0].price, '80000.00');
    const active = getActiveContext(h.memory());
    assert.equal(active.pet.name.value, 'Miu');
    assert.equal(active.pet.age.value.amount, 6);
    assert.equal(active.constraints.budget.value.max, '200000.00');
    assert.equal(active.constraints.budget.source.kind, 'user');
    const callsBefore = h.fixture.generations.length;
    const memoryBefore = h.snapshot();
    const replay = await h.post('Cái thứ hai, có món nào rẻ hơn không?', second.request_id);
    assertPublic(replay);
    assert.equal(replay.body.replayed, true);
    assert.equal(h.fixture.generations.length, callsBefore);
    assert.equal(h.snapshot(), memoryBefore);
    assert.equal((await h.post('Nội dung khác.', second.request_id)).status, 409);
});

test('orchestrator conversation: replace/clear budget, change topic and compare keep pet but not food constraints', async t => {
    const h = await backend(t);
    assertPublic(await h.post(opening));
    const replaced = await h.post('Tăng ngân sách lên 300000 đồng.');
    assertPublic(replaced);
    assert.equal(getActiveContext(h.memory()).constraints.budget.value.max, '300000.00');
    assert.equal(h.memory().state.constraints.filter(entry => entry.key === 'budget').length, 1);
    h.restart();
    const toys = await h.post('Bỏ ngân sách và chuyển sang đồ chơi cho Miu.');
    assertPublic(toys);
    assert.deepEqual(toys.body.products.map(row => row.product_id), [201, 202]);
    const active = getActiveContext(h.memory());
    assert.equal(active.pet.name.value, 'Miu');
    assert.equal(active.current_topic.value, 'toys');
    assert.equal(active.constraints.budget, undefined);
    assert.equal(active.needs.product_type.value, 'toys');
    const comparison = await h.post('Hai món đó, loại nào bền hơn?');
    assertPublic(comparison);
    assert.equal(comparison.body.intent, 'compare');
    assert.match(comparison.body.message, /chưa có dữ liệu xác minh độ bền/);
    assert.deepEqual(comparison.body.products.map(row => row.product_id), [201, 202]);
});

test('orchestrator conversation: natural dialogue, human request and care follow-up use Gemini without catalog lookup', async t => {
    const h = await backend(t);
    assertPublic(await h.post(opening));
    const reads = h.fixture.sql.length;
    const conversation = await h.post('Mình chỉ muốn trò chuyện một chút.');
    assertPublic(conversation);
    assert.equal(conversation.body.intent, 'conversation');
    const human = await h.post('Cho gặp quản lý');
    assertPublic(human);
    assert.equal(human.body.intent, 'handoff_request');
    assert.match(human.body.message, /chưa có chức năng kết nối trực tiếp/);
    assert.deepEqual(human.body.products, []);
    const care = await h.post('Còn chăm sóc Miu thì sao?');
    assertPublic(care);
    assert.equal(care.body.intent, 'care');
    assert.equal(h.fixture.sql.length, reads);
    assert.equal(getActiveContext(h.memory()).pet.age.value.amount, 6);
});

test('orchestrator conversation: explicit compaction keeps early pet facts beyond the recent window and restart', async t => {
    const h = await backend(t);
    assertPublic(await h.post(opening));
    for (let index = 0; index < 8; index++) {
        assertPublic(await h.post('Mình chỉ muốn trò chuyện một chút.'));
        h.restart();
    }
    assert.ok(h.fixture.compactions > 0);
    const memory = h.memory();
    assert.ok(memory.summary.through_sequence > 0);
    assert.equal(memory.summary.kind, 'inference');
    assert.ok(memory.recent_history.length <= 12);
    const active = getActiveContext(memory);
    assert.equal(active.pet.name.value, 'Miu');
    assert.equal(active.pet.age.value.amount, 6);
    assert.equal(active.pet.name.source.kind, 'user');
    assert.equal(active.constraints.budget.value.max, '200000.00');
    assertPublic(await h.post('Còn chăm sóc Miu thì sao?'));
});

test('orchestrator conversation: Gemini/catalog/commit failures do not advance persisted memory or fake a successful reply', async t => {
    const h = await backend(t);
    assertPublic(await h.post(opening));
    const before = h.snapshot();
    h.fixture.failGemini = true;
    const quota = await h.post('Cho gặp quản lý');
    assert.equal(quota.status, 503);
    assert.equal(quota.body.success, false);
    assert.equal(quota.body.code, 'GEMINI_QUOTA');
    assert.equal(h.snapshot(), before);
    assert.doesNotMatch(JSON.stringify(quota.body), /PRIVATE_GEMINI_KEY/);
    h.fixture.failGemini = false;
    h.fixture.failCatalog = true;
    const database = await h.post('Tìm đồ chơi khác.');
    assert.equal(database.status, 503);
    assert.equal(database.body.code, 'CATALOG_UNAVAILABLE');
    assert.equal(h.snapshot(), before);
    assert.doesNotMatch(JSON.stringify(database.body), /PRIVATE_MYSQL_PASSWORD/);
    h.fixture.failCatalog = false;
    h.fixture.failCommit = true;
    const pending = await h.post('Mình chỉ muốn trò chuyện một chút.');
    assert.equal(pending.status, 503);
    assert.equal(h.snapshot(), before);
    h.fixture.failCommit = false;
    const retried = await h.post('Mình chỉ muốn trò chuyện một chút.', pending.request_id);
    assertPublic(retried);
    assert.equal(retried.body.replayed, false);
    assert.equal(h.memory().last_sequence, deserializeMemory(before).last_sequence + 2);
});

test('orchestrator conversation: the existing frontend service accepts the generated backend contract unchanged', async t => {
    const h = await backend(t);
    const { sendChatMessage } = await import('../../frontend/src/services/chat.js');
    const originalFetch = globalThis.fetch;
    // Redirect only the frontend's public API origin to this test-owned server;
    // serialization, HTTP and frontend success validation remain real.
    t.mock.method(globalThis, 'fetch', (url, init) => {
        assert.match(String(url), /^http:\/\/localhost:3000\/api\/chat$/);
        return originalFetch(h.url, init);
    });
    const first = await sendChatMessage({ message: opening, request_id: randomUUID() });
    assert.equal(first.success, true);
    assert.deepEqual(first.products.map(row => row.product_id), [101, 102]);
    assert.equal(Object.hasOwn(first, 'memory'), false);
    assert.equal(Object.hasOwn(first, 'usage'), false);
    h.restart();
    const next = await sendChatMessage({ message: 'Cho gặp quản lý', request_id: randomUUID(), session_id: first.session_id });
    assert.equal(next.session_id, first.session_id);
    assert.equal(next.code, 'OK');
    assert.deepEqual(next.products, []);
    assert.match(next.message, /chưa có chức năng kết nối trực tiếp/);
});
