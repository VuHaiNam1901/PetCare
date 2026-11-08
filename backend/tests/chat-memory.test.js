const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    MEMORY_VERSION, LIMITS, createMemory, validateMemory, appendMessage,
    applyMemoryPatch, compactMemory, serializeMemory, deserializeMemory,
    getActiveContext, resolveDisplayedProduct, needsCompaction
} = require('../ai/memory');

// Pure value tests: no server, credentials, model SDK or database is imported.
const opening = 'Miu là mèo 6 tháng, tìm hạt dưới 200000 đồng và không ăn gà.';
const source = (turn_id = 'u1', quote = opening, kind = 'user') => ({ kind, turn_id, quote });
const fact = (value, origin = source()) => ({ value, source: origin });
const patch = (memory, ...operations) => applyMemoryPatch(memory, { base_revision: memory.revision, operations });
const clone = value => JSON.parse(JSON.stringify(value));
const budget = (max, min = null) => ({ currency: 'VND', min, max });
function seeded() {
    let memory = appendMessage(createMemory(), { turn_id: 'u1', role: 'user', text: opening });
    return patch(memory,
        { op: 'add_pet', pet_id: 'miu', fields: { name: fact('Miu'), species: fact('cat'), age: fact({ amount: 6, unit: 'months' }) } },
        { op: 'switch_pet', pet_id: 'miu' },
        { op: 'switch_topic', topic: 'food', source: source() },
        { op: 'set_fact', section: 'needs', key: 'product_type', fact: fact('kibble') },
        { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact(budget('200000.00')) },
        { op: 'set_fact', section: 'preferences', key: 'excluded_ingredients', fact: fact(['chicken']) });
}

test('memory: empty state has an explicit version and independent JSON values', () => {
    const first = createMemory(), second = createMemory();
    assert.equal(MEMORY_VERSION, 1);
    assert.equal(first.schema_version, MEMORY_VERSION);
    assert.equal(first.revision, 0);
    assert.equal(first.last_sequence, 0);
    assert.deepEqual(first.recent_history, []);
    assert.equal(first.summary.through_sequence, 0);
    assert.equal(first.summary.text, '');
    assert.equal(validateMemory(first), first);
    first.state.pets.push({ pet_id: 'local-only' });
    assert.deepEqual(second.state.pets, []);
});

test('memory: operations are immutable and revision identifies each successful transition', () => {
    const initial = createMemory(), before = clone(initial);
    const next = appendMessage(initial, { turn_id: 'u1', role: 'user', text: opening });
    assert.deepEqual(initial, before);
    assert.equal(next.revision, initial.revision + 1);
    assert.equal(next.last_sequence, 1);
    assert.equal(next.recent_history[0].sequence, 1);
    const configured = patch(next, { op: 'add_pet', pet_id: 'miu', fields: { name: fact('Miu') } });
    assert.equal(configured.revision, next.revision + 1);
    assert.equal(configured.last_sequence, next.last_sequence);
    configured.state.pets[0].name.value = 'A changed returned copy';
    assert.deepEqual(next.state.pets, []);
});

test('memory: information survives many turns, explicit compaction and fresh reconstruction', () => {
    let memory = seeded();
    for (let index = 0; index < 30; index++) {
        if (memory.recent_history.length >= LIMITS.history - 1) {
            memory = compactMemory(memory, {
                through_sequence: memory.recent_history[3].sequence,
                text: 'Khách đang tìm hạt cho Miu; ngân sách và sở thích được giữ trong trạng thái có nguồn.'
            });
        }
        memory = appendMessage(memory, { turn_id: `follow:${index}`, role: index % 2 ? 'assistant' : 'user', text: `Lượt tiếp nối ${index}.` });
        memory = deserializeMemory(serializeMemory(memory));
    }
    const active = getActiveContext(memory);
    assert.equal(active.pet.name.value, 'Miu');
    assert.deepEqual(active.pet.age.value, { amount: 6, unit: 'months' });
    assert.equal(active.needs.product_type.value, 'kibble');
    assert.deepEqual(active.constraints.budget.value, budget('200000.00'));
    assert.deepEqual(active.preferences.excluded_ingredients.value, ['chicken']);
    assert.equal(active.pet.name.source.kind, 'user');
    assert.equal(active.pet.name.source.turn_id, 'u1');
    assert.equal(active.pet.name.source.quote, opening);
    assert.ok(memory.summary.through_sequence > 0);
    assert.equal(memory.summary.kind, 'inference');
    assert.ok(memory.recent_history.length <= LIMITS.history);
    assert.equal(memory.last_sequence, 31);
});

test('memory: replacing a budget replaces the complete range rather than merging old bounds', () => {
    let memory = seeded();
    memory = patch(memory, { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact(budget('200000.00', '100000.00')) });
    const text = 'Đổi ngân sách thành tối đa 300000 đồng, không giữ mức tối thiểu cũ.';
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text });
    const next = patch(memory, { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact(budget('300000.00'), source('u2', text)) });
    assert.deepEqual(getActiveContext(next).constraints.budget.value, budget('300000.00'));
    assert.deepEqual(getActiveContext(memory).constraints.budget.value, budget('200000.00', '100000.00'));
    assert.equal(next.state.constraints.filter(row => row.key === 'budget').length, 1);
    assert.equal(getActiveContext(next).constraints.budget.source.turn_id, 'u2');
});

test('memory: removing one condition preserves unrelated needs and preferences', () => {
    let memory = seeded();
    const text = 'Bỏ điều kiện ngân sách, vẫn giữ loại hạt và không ăn gà.';
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text });
    memory = patch(memory, { op: 'remove_fact', section: 'constraints', key: 'budget', source: source('u2', text) });
    const active = getActiveContext(memory);
    assert.equal(active.constraints.budget, undefined);
    assert.equal(active.needs.product_type.value, 'kibble');
    assert.deepEqual(active.preferences.excluded_ingredients.value, ['chicken']);
});

test('memory: topic changes hide topic-local conditions without destroying the earlier topic', () => {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Các lựa chọn hạt.', product_ids: [72, 31] });
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text: 'Giờ chuyển sang đồ chơi cho Miu.' });
    memory = patch(memory,
        { op: 'focus_products', product_ids: [31], source: source('u2', 'Giờ chuyển sang đồ chơi cho Miu.') },
        { op: 'switch_topic', topic: 'toys', source: source('u2', 'Giờ chuyển sang đồ chơi cho Miu.') });
    let active = getActiveContext(memory);
    assert.equal(active.pet.pet_id, 'miu');
    assert.equal(active.constraints.budget, undefined);
    assert.equal(active.needs.product_type, undefined);
    assert.equal(active.preferences.excluded_ingredients, undefined);
    assert.equal(active.displayed_product_set, null);
    assert.equal(active.focused_products, null);
    assert.equal(resolveDisplayedProduct(memory, { position: 2 }), null);
    memory = patch(memory, { op: 'switch_topic', topic: 'food', source: source() });
    active = getActiveContext(memory);
    assert.equal(active.constraints.budget.value.max, '200000.00');
    assert.equal(resolveDisplayedProduct(memory, { position: 2 }), 31);
});

test('memory: multiple pets retain separate profiles, budgets and displayed products', () => {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Hạt cho Miu.', product_ids: [72, 31] });
    const text = 'Còn Cún là chó 2 tuổi, ngân sách 500000 đồng.';
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text });
    const dogSource = source('u2', text);
    memory = patch(memory,
        { op: 'add_pet', pet_id: 'cun', fields: { name: fact('Cún', dogSource), species: fact('dog', dogSource), age: fact({ amount: 2, unit: 'years' }, dogSource) } },
        { op: 'switch_pet', pet_id: 'cun' });
    assert.equal(getActiveContext(memory).constraints.budget, undefined);
    assert.equal(resolveDisplayedProduct(memory, { position: 1 }), null);
    memory = patch(memory, { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact(budget('500000.00'), dogSource) });
    memory = appendMessage(memory, { turn_id: 'a2', role: 'assistant', text: 'Hạt cho Cún.', product_ids: [19, 8] });
    assert.equal(resolveDisplayedProduct(memory, { position: 2 }), 8);
    assert.equal(getActiveContext(memory).pet.species.value, 'dog');
    memory = patch(memory, { op: 'switch_pet', pet_id: 'miu' });
    assert.equal(getActiveContext(memory).pet.age.value.amount, 6);
    assert.equal(getActiveContext(memory).constraints.budget.value.max, '200000.00');
    assert.equal(resolveDisplayedProduct(memory, { position: 2 }), 31);
});

test('memory: explicit global defaults are inherited and a more specific condition wins', () => {
    let memory = seeded();
    memory = patch(memory,
        { op: 'set_fact', section: 'preferences', key: 'delivery', fact: fact('standard'), scope: { pet_id: null, topic: null } },
        { op: 'set_fact', section: 'preferences', key: 'delivery', fact: fact('slow'), scope: { pet_id: 'miu', topic: null } },
        { op: 'set_fact', section: 'preferences', key: 'delivery', fact: fact('fast') });
    assert.equal(getActiveContext(memory).preferences.delivery.value, 'fast');
    memory = patch(memory, { op: 'switch_topic', topic: 'toys', source: source() });
    assert.equal(getActiveContext(memory).preferences.delivery.value, 'slow');
    assert.equal(memory.state.preferences.filter(row => row.key === 'delivery').length, 3);
});

test('memory: product position preserves displayed order across serialization and explicit older sets', () => {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Ba lựa chọn đầu.', product_ids: [91, 7, 63] });
    memory = deserializeMemory(serializeMemory(memory));
    assert.equal(resolveDisplayedProduct(memory, { position: 2 }), 7);
    memory = appendMessage(memory, { turn_id: 'a2', role: 'assistant', text: 'Ba lựa chọn khác.', product_ids: [63, 91, 7] });
    assert.equal(resolveDisplayedProduct(memory, { position: 2 }), 91);
    assert.equal(resolveDisplayedProduct(memory, { position: 2, turn_id: 'a1' }), 7);
    assert.equal(resolveDisplayedProduct(memory, { position: 4 }), null);
    assert.equal(resolveDisplayedProduct(memory, { position: 1, turn_id: 'unknown' }), null);
    assert.throws(() => resolveDisplayedProduct(memory, { position: 0 }), { code: 'MEMORY_INVALID' });
});

test('memory: duplicate, invalid and excessive product IDs are rejected instead of changing ordinals', async t => {
    for (const product_ids of [[1, 1], [0], [-1], ['1'], [1.5], [2147483648], Array.from({ length: LIMITS.productIds + 1 }, (_, i) => i + 1)]) {
        await t.test(JSON.stringify(product_ids), () => {
            assert.throws(() => appendMessage(seeded(), { turn_id: 'a1', role: 'assistant', text: 'Các lựa chọn.', product_ids }), { code: 'MEMORY_INVALID' });
        });
    }
    assert.throws(() => appendMessage(seeded(), { turn_id: 'u2', role: 'user', text: 'Giá sản phẩm này.', product_ids: [1] }), { code: 'MEMORY_INVALID' });
});

test('memory: bounded displayed sets do not reinterpret references to removed old sets', () => {
    let memory = seeded();
    for (let i = 0; i < LIMITS.productSets + 1; i++) {
        memory = appendMessage(memory, { turn_id: `a${i}`, role: 'assistant', text: `Danh sách ${i}.`, product_ids: [100 + i, 10 + i] });
    }
    assert.equal(memory.state.displayed_product_sets.length, LIMITS.productSets);
    assert.equal(resolveDisplayedProduct(memory, { position: 2, turn_id: 'a0' }), null);
    assert.equal(resolveDisplayedProduct(memory, { position: 2 }), 10 + LIMITS.productSets);
});

test('memory: displayed sets must match the actual assistant message rather than fabricate a reference', async t => {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Hai lựa chọn.', product_ids: [91, 7] });
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text: 'Có lựa chọn khác không?' });
    memory = appendMessage(memory, { turn_id: 'a2', role: 'assistant', text: 'Hai lựa chọn khác.', product_ids: [63, 4] });

    const fabricated = clone(memory);
    fabricated.state.displayed_product_sets[0].turn_id = 'fabricated';
    const userRole = clone(memory);
    Object.assign(userRole.state.displayed_product_sets[0], { turn_id: 'u1', sequence: 1 });
    const mismatchedSequence = clone(memory);
    mismatchedSequence.state.displayed_product_sets = [{ ...mismatchedSequence.state.displayed_product_sets[0], sequence: 4 }];
    const mismatchedIds = clone(memory);
    mismatchedIds.state.displayed_product_sets[0].product_ids = [91, 99];
    const mismatchedOrder = clone(memory);
    mismatchedOrder.state.displayed_product_sets[0].product_ids = [7, 91];

    const compacted = compactMemory(memory, { through_sequence: 4, text: 'Khách đã xem hai danh sách sản phẩm.' });
    const duplicateTurns = clone(compacted);
    duplicateTurns.state.displayed_product_sets[1].turn_id = duplicateTurns.state.displayed_product_sets[0].turn_id;
    const partlyCompacted = compactMemory(memory, { through_sequence: 2, text: 'Khách đã xem danh sách đầu tiên.' });
    partlyCompacted.state.displayed_product_sets[0].turn_id = 'u2';

    for (const [name, value] of [
        ['fabricated turn', fabricated], ['user-role display', userRole],
        ['wrong sequence', mismatchedSequence], ['wrong IDs', mismatchedIds],
        ['wrong order', mismatchedOrder], ['duplicate compacted turn', duplicateTurns],
        ['compacted turn collides with recent message', partlyCompacted]
    ]) await t.test(name, () => {
        assert.throws(() => validateMemory(value), { code: 'MEMORY_INVALID' });
        assert.throws(() => deserializeMemory(JSON.stringify(value)), { code: 'MEMORY_INVALID' });
    });
});

test('memory: valid displayed sets remain usable after their assistant messages are compacted', () => {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Các lựa chọn đầu.', product_ids: [91, 7] });
    memory = appendMessage(memory, { turn_id: 'a2', role: 'assistant', text: 'Các lựa chọn tiếp theo.', product_ids: [63, 4] });
    memory = compactMemory(memory, { through_sequence: memory.last_sequence, text: 'Khách đã xem hai danh sách, thứ tự ID được giữ riêng.' });
    assert.deepEqual(memory.recent_history, []);
    assert.equal(validateMemory(memory), memory);
    memory = deserializeMemory(serializeMemory(memory));
    assert.equal(resolveDisplayedProduct(memory, { position: 2, turn_id: 'a1' }), 7);
    assert.equal(resolveDisplayedProduct(memory, { position: 2 }), 4);
});

test('memory: focusing requires a known active product and new displays clear the old focus', () => {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Các lựa chọn.', product_ids: [91, 7, 63] });
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text: 'Chọn cái thứ hai.' });
    memory = patch(memory, { op: 'focus_products', product_ids: [7], source: source('u2', 'Chọn cái thứ hai.') });
    assert.deepEqual(getActiveContext(memory).focused_products.value, [7]);
    assert.throws(() => patch(memory, { op: 'focus_products', product_ids: [999], source: source('u2', 'Chọn cái thứ hai.') }), { code: 'MEMORY_INVALID' });
    memory = appendMessage(memory, { turn_id: 'a2', role: 'assistant', text: 'Các lựa chọn mới.', product_ids: [6, 4] });
    assert.equal(getActiveContext(memory).focused_products, null);
});

function inferredPreference() {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Mình đoán Miu thích pate.' });
    return patch(memory, { op: 'set_fact', section: 'preferences', key: 'favorite_food', fact: fact('pate', source('a1', 'Mình đoán Miu thích pate.', 'inference')) });
}

test('memory: inference stays inference through compaction and serialization', () => {
    let memory = inferredPreference();
    memory = compactMemory(memory, { through_sequence: memory.last_sequence, text: 'Miu thích pate.' });
    memory = deserializeMemory(serializeMemory(memory));
    const preference = getActiveContext(memory).preferences.favorite_food;
    assert.equal(preference.source.kind, 'inference');
    assert.equal(preference.source.turn_id, 'a1');
    assert.equal(memory.summary.kind, 'inference');
    assert.equal(memory.recent_history.length, 0);
});

test('memory: only explicit evidence-backed confirmation promotes an inferred condition', () => {
    let memory = inferredPreference();
    const text = 'Đúng, Miu thích pate.';
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text });
    const explicit = source('u2', text);
    assert.throws(() => patch(memory, { op: 'set_fact', section: 'preferences', key: 'favorite_food', fact: fact('pate', explicit) }), { code: 'MEMORY_PROVENANCE' });
    const confirmed = patch(memory, { op: 'confirm_fact', section: 'preferences', key: 'favorite_food', source: explicit });
    assert.equal(getActiveContext(confirmed).preferences.favorite_food.value, 'pate');
    assert.equal(getActiveContext(confirmed).preferences.favorite_food.source.kind, 'user');
    assert.equal(getActiveContext(memory).preferences.favorite_food.source.kind, 'inference');
    assert.throws(() => patch(confirmed, { op: 'set_fact', section: 'preferences', key: 'favorite_food', fact: fact('snack', source('a1', 'Mình đoán Miu thích pate.', 'inference')) }), { code: 'MEMORY_PROVENANCE' });
});

test('memory: pet attributes cannot be silently promoted or overwritten by an inference', () => {
    let memory = appendMessage(createMemory(), { turn_id: 'a1', role: 'assistant', text: 'Có lẽ thú cưng là mèo.' });
    const inferred = source('a1', 'Có lẽ thú cưng là mèo.', 'inference');
    memory = patch(memory, { op: 'add_pet', pet_id: 'pet1', fields: { species: fact('cat', inferred) } });
    memory = appendMessage(memory, { turn_id: 'u1', role: 'user', text: 'Đúng, đó là mèo.' });
    const explicit = source('u1', 'Đúng, đó là mèo.');
    assert.throws(() => patch(memory, { op: 'update_pet', pet_id: 'pet1', fields: { species: fact('cat', explicit) } }), { code: 'MEMORY_PROVENANCE' });
    memory = patch(memory, { op: 'confirm_pet_field', pet_id: 'pet1', field: 'species', source: explicit });
    assert.equal(memory.state.pets[0].species.source.kind, 'user');
    assert.throws(() => patch(memory, { op: 'update_pet', pet_id: 'pet1', fields: { species: fact('dog', inferred) } }), { code: 'MEMORY_PROVENANCE' });
});

test('memory: claimed user evidence must identify an actual user message and matching quote', async t => {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Bạn có muốn pate không?' });
    for (const invalidSource of [
        source('missing', opening), source('u1', 'Khách chưa từng nói câu này.'),
        source('a1', 'Bạn có muốn pate không?')
    ]) await t.test(JSON.stringify(invalidSource), () => {
        assert.throws(() => patch(memory, { op: 'set_fact', section: 'preferences', key: 'new_fact', fact: fact('pate', invalidSource) }), { code: 'MEMORY_PROVENANCE' });
    });
    assert.throws(() => patch(memory, { op: 'set_fact', section: 'preferences', key: 'new_fact', fact: fact('pate', source('u1', '')) }), { code: 'MEMORY_INVALID' });
});

test('memory: a saved source cannot reference an absent turn before any compaction', () => {
    const fabricated = seeded();
    fabricated.state.constraints[0].fact.source.turn_id = 'missing';
    assert.equal(fabricated.summary.through_sequence, 0);
    assert.throws(() => validateMemory(fabricated), { code: 'MEMORY_PROVENANCE' });
    assert.throws(() => deserializeMemory(JSON.stringify(fabricated)), { code: 'MEMORY_PROVENANCE' });

    const compacted = compactMemory(seeded(), { through_sequence: 1, text: 'Khách đã cung cấp thông tin Miu, loại hạt, ngân sách và sở thích.' });
    assert.deepEqual(compacted.recent_history, []);
    const restored = deserializeMemory(serializeMemory(compacted));
    assert.equal(getActiveContext(restored).constraints.budget.source.kind, 'user');
    assert.equal(getActiveContext(restored).constraints.budget.source.turn_id, 'u1');
    assert.equal(getActiveContext(restored).constraints.budget.source.quote, opening);
});

test('memory: explicit confirmation can correct a previously inferred value', () => {
    let memory = inferredPreference();
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text: 'Thực ra Miu thích snack.' });
    memory = patch(memory, { op: 'confirm_fact', section: 'preferences', key: 'favorite_food', value: 'snack', source: source('u2', 'Thực ra Miu thích snack.') });
    assert.equal(getActiveContext(memory).preferences.favorite_food.value, 'snack');
    assert.equal(getActiveContext(memory).preferences.favorite_food.source.kind, 'user');

    let profile = appendMessage(createMemory(), { turn_id: 'a1', role: 'assistant', text: 'Có lẽ bé khoảng 3 tháng.' });
    profile = patch(profile, { op: 'add_pet', pet_id: 'miu', fields: { age: fact({ amount: 3, unit: 'months' }, source('a1', 'Có lẽ bé khoảng 3 tháng.', 'inference')) } });
    profile = appendMessage(profile, { turn_id: 'u1', role: 'user', text: 'Bé 6 tháng rồi.' });
    profile = patch(profile, { op: 'confirm_pet_field', pet_id: 'miu', field: 'age', value: { amount: 6, unit: 'months' }, source: source('u1', 'Bé 6 tháng rồi.') });
    assert.deepEqual(profile.state.pets[0].age.value, { amount: 6, unit: 'months' });
    assert.equal(profile.state.pets[0].age.source.kind, 'user');
});

test('memory: inference cannot remove confirmed information or bypass an explicit global constraint', () => {
    let memory = seeded();
    memory = patch(memory, { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact(budget('150000.00')), scope: { pet_id: null, topic: null } });
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Có lẽ có thể tăng ngân sách.' });
    const inferred = source('a1', 'Có lẽ có thể tăng ngân sách.', 'inference');
    assert.throws(() => patch(memory, { op: 'remove_fact', section: 'constraints', key: 'budget', source: inferred }), { code: 'MEMORY_PROVENANCE' });
    assert.throws(() => patch(memory, { op: 'remove_pet', pet_id: 'miu', source: inferred }), { code: 'MEMORY_PROVENANCE' });
    // A different scope must not provide a side door around a user-confirmed
    // constraint. This new inferred topic-level field is excluded or rejected.
    const changed = patch(memory, { op: 'switch_topic', topic: 'toys', source: source() });
    const proposed = patch(changed, { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact(budget('500000.00'), inferred) });
    assert.equal(getActiveContext(proposed).constraints.budget.source.kind, 'user');
    assert.equal(getActiveContext(proposed).constraints.budget.value.max, '150000.00');
});

test('memory: failed multi-operation patches are atomic and reject stale revisions', () => {
    const memory = seeded(), before = clone(memory);
    assert.throws(() => patch(memory,
        { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact(budget('300000.00')) },
        { op: 'switch_pet', pet_id: 'missing' }), { code: 'MEMORY_INVALID' });
    assert.deepEqual(memory, before);
    assert.throws(() => applyMemoryPatch(memory, { base_revision: memory.revision - 1, operations: [{ op: 'switch_pet', pet_id: 'miu' }] }), { code: 'MEMORY_REVISION_CONFLICT' });
    assert.deepEqual(memory, before);
});

test('memory: clearing a pet removes its scoped conditions and references', () => {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'a1', role: 'assistant', text: 'Các lựa chọn.', product_ids: [1, 2] });
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text: 'Xóa thông tin Miu.' });
    memory = patch(memory, { op: 'remove_pet', pet_id: 'miu', source: source('u2', 'Xóa thông tin Miu.') });
    assert.deepEqual(memory.state.pets, []);
    assert.equal(memory.state.active_pet_id, null);
    assert.deepEqual(memory.state.constraints, []);
    assert.deepEqual(memory.state.displayed_product_sets, []);
});

test('memory: compaction requires an existing contiguous prefix and never invents a summary', () => {
    let memory = createMemory();
    for (let i = 0; i < LIMITS.history; i++) memory = appendMessage(memory, { turn_id: `u${i}`, role: 'user', text: `Lượt ${i}.` });
    const before = clone(memory);
    assert.equal(needsCompaction(memory), true);
    assert.throws(() => appendMessage(memory, { turn_id: 'overflow', role: 'user', text: 'Một lượt nữa.' }), { code: 'MEMORY_COMPACTION_REQUIRED' });
    assert.deepEqual(memory, before);
    assert.equal(memory.summary.text, '');
    for (const through_sequence of [0, memory.last_sequence + 1, 1.5]) {
        assert.throws(() => compactMemory(memory, { through_sequence, text: 'Tóm tắt.' }), { code: 'MEMORY_INVALID' });
    }
    const next = compactMemory(memory, { through_sequence: 4, text: 'Khách đã trao đổi bốn tin đầu.' });
    assert.equal(next.summary.through_sequence, 4);
    assert.equal(next.recent_history[0].sequence, 5);
    assert.equal(next.last_sequence, memory.last_sequence);
    assert.equal(next.revision, memory.revision + 1);
    assert.throws(() => compactMemory(next, { through_sequence: 3, text: 'Không được quay lui.' }), { code: 'MEMORY_INVALID' });
});

test('memory: serialized storage is ASCII-safe and independent after load', () => {
    let memory = seeded();
    memory = appendMessage(memory, { turn_id: 'emoji', role: 'assistant', text: 'Chăm sóc Miu 🐾 và giữ nước sạch.' });
    const stored = serializeMemory(memory);
    assert.equal(typeof stored, 'string');
    assert.match(stored, /^[\x00-\x7f]*$/);
    assert.deepEqual(JSON.parse(stored), memory);
    const restored = deserializeMemory(stored);
    assert.deepEqual(restored, memory);
    restored.state.pets[0].name.value = 'Changed';
    assert.equal(memory.state.pets[0].name.value, 'Miu');
    assert.ok(Buffer.byteLength(stored, 'utf8') <= LIMITS.bytes);
});

test('memory: escaped storage limit is enforced even below the raw UTF-8 byte limit', () => {
    const oversized = createMemory();
    oversized.recent_history = Array.from({ length: 6 }, (_, i) => ({ turn_id: `u${i}`, sequence: i + 1, role: 'user', text: '漢'.repeat(1000) }));
    oversized.last_sequence = 6;
    oversized.revision = 6;
    assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') < LIMITS.bytes);
    assert.throws(() => validateMemory(oversized), { code: 'MEMORY_TOO_LARGE' });
    assert.throws(() => serializeMemory(oversized), { code: 'MEMORY_TOO_LARGE' });
    assert.throws(() => deserializeMemory(JSON.stringify(oversized)), { code: 'MEMORY_TOO_LARGE' });
});

test('memory: empty and missing saved values are compatible while unknown versions fail explicitly', async t => {
    for (const value of [undefined, null, '', '   ', {}, 'null', '{}']) await t.test(String(value), () => {
        assert.deepEqual(deserializeMemory(value), createMemory());
    });
    for (const version of [0, 2, 100]) await t.test(`version ${version}`, () => {
        assert.throws(() => deserializeMemory({ ...createMemory(), schema_version: version }), { code: 'MEMORY_VERSION_UNSUPPORTED' });
        assert.throws(() => deserializeMemory({ schema_version: version }), { code: 'MEMORY_VERSION_UNSUPPORTED' });
    });
    assert.throws(() => deserializeMemory('{not JSON'), { code: 'MEMORY_INVALID' });
    assert.throws(() => deserializeMemory({ ...createMemory(), schema_version: '1' }), { code: 'MEMORY_INVALID' });
    assert.throws(() => deserializeMemory({ unrelated: true }), { code: 'MEMORY_INVALID' });
});

test('memory: legacy history remains conversation data, not confirmed product or profile facts', () => {
    const history = [
        { role: 'user', text: 'Tìm hạt cho mèo dưới 200k.' },
        { role: 'assistant', text: 'Hai lựa chọn.', product_ids: [71, 12], search: { query: 'hạt cho mèo', maxPrice: '200000.00' } }
    ];
    for (const legacy of [history, { history }]) {
        const memory = deserializeMemory(legacy);
        assert.equal(memory.schema_version, MEMORY_VERSION);
        assert.equal(memory.recent_history.length, 2);
        assert.equal(memory.recent_history[0].text, history[0].text);
        assert.deepEqual(memory.state.pets, []);
        assert.deepEqual(memory.state.constraints, []);
        assert.equal(resolveDisplayedProduct(memory, { position: 2 }), 12);
        assert.deepEqual(deserializeMemory(serializeMemory(memory)), memory);
    }
});

test('memory: invalid JSON shapes, unknown fields and unsafe keys are rejected', async t => {
    const cyclic = createMemory();
    cyclic.loop = cyclic;
    const invalid = [
        { ...createMemory(), unexpected: true },
        { ...createMemory(), state: { ...createMemory().state, catalog_price: '1000.00' } },
        { ...createMemory(), revision: -1 }, { ...createMemory(), last_sequence: Infinity },
        { ...createMemory(), recent_history: [{ turn_id: 'u1', sequence: 2, role: 'user', text: 'Gap.' }], last_sequence: 2 },
        { ...createMemory(), recent_history: new Date() },
        { ...createMemory(), summary: { text: 'Summary', through_sequence: 999, kind: 'inference' } },
        { ...createMemory(), state: { ...createMemory().state, pets: [new Date()] } },
        Object.assign(createMemory(), { revision: NaN }),
        Object.assign(createMemory(), { revision: 1n }),
        Object.assign(createMemory(), { helper() {} }), cyclic,
        JSON.parse('{"schema_version":1,"__proto__":{"polluted":true}}'),
        JSON.parse('{"schema_version":1,"constructor":{"prototype":{"polluted":true}}}')
    ];
    for (const [index, value] of invalid.entries()) await t.test(`shape ${index}`, () => {
        assert.throws(() => deserializeMemory(value), { code: 'MEMORY_INVALID' });
    });
    assert.equal({}.polluted, undefined);
});

test('memory: invalid field values and patch schemas fail before changing existing data', async t => {
    const memory = seeded(), before = clone(memory);
    const operations = [
        { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact(budget('100000.00', '200000.00')) },
        { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact(budget(null)) },
        { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact({ currency: 'USD', min: null, max: '100.00' }) },
        { op: 'set_fact', section: 'constraints', key: 'budget', fact: fact({ currency: 'VND', min: null, max: 200000 }) },
        { op: 'set_fact', section: 'preferences', key: 'budget', fact: fact(budget('200000.00')) },
        { op: 'set_fact', section: 'preferences', key: '__proto__', fact: fact('unsafe') },
        { op: 'set_fact', section: 'preferences', key: 'new_value', fact: fact({ catalog_price: 100 }) },
        { op: 'set_fact', section: 'preferences', key: 'new_value', fact: fact(undefined) },
        { op: 'update_pet', pet_id: 'miu', fields: { age: fact({ amount: -1, unit: 'months' }) } },
        { op: 'update_pet', pet_id: 'miu', fields: { age: fact({ amount: 6, unit: 'minutes' }) } },
        { op: 'update_pet', pet_id: 'miu', fields: { species: fact('laptop') } },
        { op: 'update_pet', pet_id: 'miu', fields: { name: fact(123) } },
        { op: 'update_pet', pet_id: 'miu', fields: { name: fact('x'.repeat(81)) } },
        { op: 'add_pet', pet_id: 'miu', fields: { name: fact('Duplicate') } },
        { op: 'add_pet', pet_id: 'blank', fields: {} },
        { op: 'set_fact', section: 'constraints', key: 'x', fact: fact('y'), scope: { pet_id: 'missing', topic: 'food' } },
        { op: 'set_fact', section: 'constraints', key: 'x', fact: fact('y'), scope: null },
        { op: 'set_fact', section: 'invented', key: 'x', fact: fact('y') },
        { op: 'run_sql', sql: 'SELECT 1' },
        { op: 'switch_pet', pet_id: 'miu', unexpected: true }
    ];
    for (const [index, operation] of operations.entries()) await t.test(`operation ${index}`, () => {
        assert.throws(() => patch(memory, operation), { code: 'MEMORY_INVALID' });
        assert.deepEqual(memory, before);
    });
});

test('memory: message, summary and operation count limits reject oversized data explicitly', () => {
    const memory = seeded();
    assert.throws(() => appendMessage(memory, { turn_id: 'long', role: 'user', text: 'a'.repeat(LIMITS.message + 1) }), { code: 'MEMORY_INVALID' });
    assert.throws(() => compactMemory(memory, { through_sequence: 1, text: 'a'.repeat(LIMITS.summary + 1) }), { code: 'MEMORY_INVALID' });
    assert.throws(() => patch(memory, ...Array.from({ length: LIMITS.operations + 1 }, () => ({ op: 'switch_pet', pet_id: 'miu' }))), { code: 'MEMORY_INVALID' });
    assert.throws(() => appendMessage(memory, { turn_id: 'u1', role: 'user', text: opening }), { code: 'MEMORY_INVALID' });
    assert.throws(() => applyMemoryPatch(memory, { base_revision: String(memory.revision), operations: [{ op: 'switch_pet', pet_id: 'miu' }] }), { code: 'MEMORY_INVALID' });
});

test('memory: accessors, symbol keys and non-JSON containers never execute or cross the storage boundary', () => {
    const withGetter = createMemory();
    let evaluated = 0;
    Object.defineProperty(withGetter, 'revision', { enumerable: true, get() { evaluated++; return 0; } });
    assert.throws(() => deserializeMemory(withGetter), { code: 'MEMORY_INVALID' });
    assert.equal(evaluated, 0);
    const withSymbol = createMemory();
    withSymbol[Symbol('hidden')] = 'not JSON';
    assert.throws(() => deserializeMemory(withSymbol), { code: 'MEMORY_INVALID' });
    for (const container of [new Map(), new Set(), new Uint8Array([1, 2]), new Array(2)]) {
        assert.throws(() => deserializeMemory({ ...createMemory(), recent_history: container }), { code: 'MEMORY_INVALID' });
    }
});
