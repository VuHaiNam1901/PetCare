'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const memory = require('../ai/memory');
const { createProductTools } = require('../ai/tools');
const { createOrchestrator } = require('../ai/orchestrator');

// Focused module checks: no credentials, external network or database writes.
const opening = 'Tìm hạt cho mèo dưới 200k';
const source = { kind: 'user', turn_id: 'u:one', quote: opening };
const dto = (id, price) => ({ product_id: id, category_id: 1, category_name: 'Thức ăn',
    name: `Hạt mẫu ${id}`, price, stock_quantity: 5, status: 'Đang bán', image_url: null,
    description: null, pet_types: [{ pet_type_id: 2, slug: 'cat', name: 'Mèo' }] });
const call = (name, args) => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model',
    parts: [{ functionCall: { name, args } }] } }], usageMetadata: { totalTokenCount: 100 } });
const advice = { mode: 'product', intent: 'compare', advice: 'Lựa chọn thứ hai có giá thấp hơn.',
    product_ids: [21, 12], follow_up: null, warnings: [] };
function start() {
    let state = memory.appendMessage(memory.createMemory(), { turn_id: 'u:one', role: 'user', text: opening });
    state = memory.applyMemoryPatch(state, { base_revision: state.revision, operations: [
        { op: 'switch_topic', topic: 'food', source },
        { op: 'set_fact', section: 'constraints', key: 'budget', fact: { value: { currency: 'VND', min: null, max: '200000.00' }, source } },
    ] });
    return state;
}

test('step2: product follow-ups restore filters and positions but always read fresh catalog facts', async () => {
    let reads = 0;
    const searches = [];
    const tools = createProductTools({ repository: {
        async search(filters) { searches.push(filters); return { products: [dto(21, '140000.00'), dto(12, '180000.00')], totalMatches: 2 }; },
        async getByIds(ids) { reads++; return ids.map(id => dto(id, id === 21 ? '190000.00' : '90000.00')); },
    } });
    let round = 0;
    const orchestrator = createOrchestrator({ tools, async generate() {
        if (round++ === 0) return call('update_memory', { operations: JSON.stringify([
            { op: 'switch_topic', topic: 'food', source },
            { op: 'set_fact', section: 'constraints', key: 'budget', fact: { value: { currency: 'VND', min: null, max: '200000.00' }, source } },
        ]) });
        if (round === 2) return call('search_products', { filters: { species: 'cat', productType: 'kibble' } });
        return call('respond', { ...advice, intent: 'product_search', advice: 'Bạn có thể tham khảo hai lựa chọn này.',
            follow_up: 'Bạn muốn xem kỹ lựa chọn thứ hai không?' });
    } });
    const answer = await orchestrator.reply({ turn_id: 'u:one', message: opening });
    let state = memory.deserializeMemory(memory.serializeMemory(answer.memory));
    assert.equal(memory.promptContext(state).recent_history.at(-1).follow_up, answer.follow_up);
    assert.equal(memory.getActiveContext(state).recent_search.filters.maxPrice, '200000.00');
    const compared = await tools.execute('compare_products', { positions: [1, 2], criteria: ['price', 'durability'] }, { memory: state });
    assert.deepEqual(compared.requested_product_ids, [21, 12]);
    assert.deepEqual(compared.comparison.cheapest_product_ids, [12], 'new price reverses the earlier ordering');
    assert.deepEqual(compared.comparison.not_verified, ['durability']);
    assert.equal((await tools.execute('get_product_details', { positions: [2] }, { memory: state })).products[0].price, '90000.00');
    assert.equal(reads, 2);
    await tools.execute('search_products', { use_recent_search: true, filters: { sort: 'price_asc' } }, { memory: state });
    assert.deepEqual([searches[1].species, searches[1].productType, searches[1].maxPrice, searches[1].sort], ['cat', 'kibble', '200000.00', 'price_asc']);
    await assert.rejects(tools.execute('get_product_details', { positions: [2], product_ids: [21] }, { memory: state }), { code: 'INVALID_TOOL' });
    state = memory.appendMessage(state, { turn_id: 'u:care', role: 'user', text: 'Giờ hỏi cách chăm sóc lông.' });
    state = memory.applyMemoryPatch(state, { base_revision: state.revision, operations: [
        { op: 'switch_topic', topic: 'grooming', source: { kind: 'user', turn_id: 'u:care', quote: 'chăm sóc lông' } },
    ] });
    const active = memory.getActiveContext(state);
    assert.equal(active.recent_search, null);
    assert.equal(active.displayed_product_set, null);
    assert.equal(active.constraints.budget, undefined);
    await assert.rejects(tools.execute('search_products', { use_recent_search: true, filters: {} }, { memory: state }), { code: 'INVALID_TOOL' });
    assert.equal(searches.length, 2, 'invalid or unrelated continuations do not query the catalog');
});

test('step2: cumulative compaction removes old prompt history and preserves scoped references', async () => {
    let state = memory.appendMessage(start(), { turn_id: 'a:one', role: 'assistant', text: 'OLD_PREFIX_SENTINEL' });
    state = memory.compactMemory(state, { through_sequence: 2, text: 'Khách tìm hạt cho mèo, ngân sách đã nêu.' });
    for (let i = 2; i <= 6; i++) {
        state = memory.appendMessage(state, { turn_id: `u:${i}`, role: 'user', text: `Nhu cầu tiếp nối lượt ${i}` });
        state = memory.appendMessage(state, { turn_id: `a:${i}`, role: 'assistant', text: `Lời tư vấn lượt ${i}`, ...(i === 6 ? { product_ids: [21, 12] } : {}) });
    }
    let round = 0, reads = 0;
    const orchestrator = createOrchestrator({ repository: { async getByIds(ids) { reads++; return ids.map(id => dto(id, id === 21 ? '190000.00' : '90000.00')); } },
        async generate({ contents }) {
            const initial = JSON.parse(contents[0].parts[0].text);
            if (round++ === 0) {
                assert.equal(initial.preparing, true);
                assert.equal(initial.compaction.previous_summary.text, state.summary.text);
                assert.equal(initial.compaction.history.length, 6);
                assert.equal(initial.compaction.through_sequence, 8);
                return call('compact_memory', { through_sequence: 8, text: 'Khách tìm hạt cho mèo theo ngân sách đã nêu; cần so sánh lựa chọn.' });
            }
            assert.equal(initial.preparing, false);
            assert.equal(initial.compaction, undefined);
            assert.ok(initial.recent_history.length <= 6);
            assert.ok(!JSON.stringify(contents).includes('Nhu cầu tiếp nối lượt 2'));
            assert.deepEqual(initial.active_context.displayed_product_set.product_ids, [21, 12]);
            if (round === 2) { assert.equal(contents.length, 1); return call('compare_products', { positions: [1, 2], criteria: ['price'] }); }
            return call('respond', advice);
        } });
    const answer = await orchestrator.reply({ memory: state, turn_id: 'u:next', message: 'Loại nào rẻ hơn?' });
    assert.equal(answer.code, 'OK');
    assert.equal(reads, 1);
    assert.equal(answer.memory.recent_history.length, 6);
    assert.equal(answer.memory.summary.through_sequence, 8);
    assert.equal(memory.getActiveContext(answer.memory).constraints.budget.value.max, '200000.00');
    assert.equal(memory.resolveDisplayedProduct(answer.memory, { position: 2 }), 12);
});

test('step2: bounded prompt redacts private text and a care topic needs no catalog query', async () => {
    let state = start();
    for (let i = 0; i < 7; i++) state = memory.appendMessage(state, { turn_id: `bounded:${i}`, role: i % 2 ? 'user' : 'assistant', text: 'a'.repeat(1000) });
    const context = memory.promptContext(state);
    assert.ok(context.recent_history.length <= 6);
    assert.ok(context.recent_history.reduce((size, item) => size + item.text.length, 0) <= 6000);
    const privateState = memory.appendMessage(memory.createMemory(), { turn_id: 'private', role: 'user', text: 'Email me@example.com, mật khẩu: hidden-value' });
    assert.ok(!memory.serializeMemory(privateState).includes('me@example.com'));
    assert.ok(!memory.serializeMemory(privateState).includes('hidden-value'));
    assert.throws(() => memory.applyMemoryPatch(privateState, { base_revision: privateState.revision, operations: [
        { op: 'set_fact', section: 'preferences', key: 'email', fact: { value: 'hidden', source: { kind: 'inference', turn_id: 'private', quote: '' } } },
    ] }), { code: 'MEMORY_SENSITIVE' });
    state = memory.appendMessage(start(), { turn_id: 'a:one', role: 'assistant', text: 'Bạn xem các lựa chọn.' });
    let round = 0;
    const orchestrator = createOrchestrator({ tools: { async execute() { assert.fail('care must not query catalog'); } },
        async generate() {
            if (round++ === 0) return call('update_memory', { operations: JSON.stringify([{ op: 'switch_topic', topic: 'grooming',
                source: { kind: 'user', turn_id: 'u:care', quote: 'chăm sóc lông' } }]) });
            return call('respond', { mode: 'care', intent: 'care', advice: 'Bạn có thể chải lông nhẹ nhàng và giữ chỗ nằm sạch sẽ.', product_ids: [], follow_up: null, warnings: [] });
        } });
    const answer = await orchestrator.reply({ memory: state, turn_id: 'u:care', message: 'Giờ hỏi về cách chăm sóc lông.' });
    assert.equal(answer.code, 'OK');
    assert.equal(memory.getActiveContext(answer.memory).constraints.budget, undefined);
});
