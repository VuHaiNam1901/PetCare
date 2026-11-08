'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProductTools } = require('../ai/tools');
const { createProductRepository, validateFilters } = require('../ai/products');
const { createMemory, appendMessage, applyMemoryPatch } = require('../ai/memory');
const observed = '2026-11-07T10:00:00.000Z';
const row = (product_id, changes = {}) => ({ product_id, category_id: 1, category_name: 'Thức ăn',
    name: `Hạt cho mèo ${product_id}`, price: '100000.00', stock_quantity: 3,
    status: 'Đang bán', image_url: '/images/products/test.webp', description: 'Thông tin catalog kiểm thử.', ...changes });
const inventory = [row(3, { price: '150000.00' }), row(7, { price: '80000.00', stock_quantity: 0 }), row(9, { price: '250000.00' })];
function harness({ rows = inventory, categories = [{ category_id: 1, name: 'Thức ăn' }], failure } = {}) {
    const calls = [];
    const repository = {
        async listCategories() { calls.push({ name: 'categories' }); if (failure) throw failure; return categories; },
        async search(filters, options) {
            calls.push({ name: 'search', filters, options });
            if (failure) throw failure;
            const products = rows.filter(item => item.status === 'Đang bán' && (options.includeOutOfStock || item.stock_quantity > 0) &&
                (filters.minPrice === undefined || Number(item.price) >= Number(filters.minPrice)) &&
                (filters.maxPrice === undefined || Number(item.price) <= Number(filters.maxPrice)));
            return { products: products.slice(0, filters.limit), totalMatches: products.length, catalogLimited: false };
        },
        async getByIds(ids) { calls.push({ name: 'details', ids }); if (failure) throw failure; return rows.filter(item => ids.includes(item.product_id)); }
    };
    return { calls, repository, tools: createProductTools({ repository, now: () => observed }) };
}
function configuredMemory(kind = 'user') {
    let memory = appendMessage(createMemory(), { turn_id: 'u1', role: 'user', text: 'Tìm hạt, từ 50000 đến 200000 đồng.' });
    const source = { kind, turn_id: 'u1', quote: 'Tìm hạt, từ 50000 đến 200000 đồng.' };
    memory = applyMemoryPatch(memory, { base_revision: memory.revision, operations: [
        { op: 'switch_topic', topic: 'food', source },
        { op: 'set_fact', section: 'needs', key: 'product_type', fact: { value: 'kibble', source } },
        { op: 'set_fact', section: 'constraints', key: 'budget', fact: { value: { currency: 'VND', min: '50000.00', max: '200000.00' }, source } }
    ] });
    return memory;
}
function addCat(memory, kind = 'user') {
    const text = 'Miu là mèo 6 tháng.';
    memory = appendMessage(memory, { turn_id: 'pet-source', role: 'user', text });
    const source = { kind, turn_id: 'pet-source', quote: text };
    return applyMemoryPatch(memory, { base_revision: memory.revision, operations: [
        { op: 'add_pet', pet_id: 'miu', fields: { name: { value: 'Miu', source }, species: { value: 'cat', source } } },
        { op: 'switch_pet', pet_id: 'miu' }
    ] });
}
function catalogFixture() {
    const rows = [
        row(3, { name: 'Hạt khô cho mèo mẫu A' }), row(4, { name: 'Hạt khô cho chó mẫu B' }),
        row(5, { name: 'Pate cho mèo mẫu C' }), row(6, { name: 'Bánh thưởng cho mèo mẫu D' }),
        row(7, { name: 'Đồ chơi cho mèo mẫu E', category_id: 2, category_name: 'Đồ chơi' }),
        row(8, { name: 'Đồ chơi cho chó mẫu F', category_id: 2, category_name: 'Đồ chơi' }),
        row(9, { name: 'Dầu cá cho mèo mẫu G', category_name: 'Dầu cá' })
    ];
    const calls = [];
    const repository = createProductRepository({ db: { async execute(sql, params) {
        calls.push({ sql, params });
        return [rows.filter(item => item.product_id > params.at(-1))];
    } } });
    return { calls, repository, tools: createProductTools({ repository, now: () => observed }) };
}

test('product tools: exact repository lookup binds IDs, preserves requested order and includes zero stock', async () => {
    const calls = [];
    const repo = createProductRepository({ db: { async execute(sql, params) {
        calls.push({ sql, params });
        return [[row(3), row(7, { stock_quantity: 0 }), row(99), row(9, { status: 'Ngừng bán' })]];
    } } });
    const result = await repo.getByIds([7, 9, 3]);
    assert.deepEqual(result.map(item => item.product_id), [7, 3]);
    assert.equal(result[0].stock_quantity, 0);
    assert.match(calls[0].sql, /^SELECT/);
    assert.match(calls[0].sql, /p\.product_id IN \(\?,\s*\?,\s*\?\)/);
    assert.deepEqual(calls[0].params, ['Đang bán', 7, 9, 3]);
    assert.doesNotMatch(calls[0].sql, /stock_quantity\s*>/);
    for (const ids of [[], [3, 3], [0], ['3'], [1, 2, 3, 4, 5, 6, 7]]) await assert.rejects(() => repo.getByIds(ids), { code: 'INVALID_SEARCH' });
    assert.equal(calls.length, 1);
});

test('product tools: categories read source data and bound names/count without generation', async () => {
    const h = harness({ categories: Array.from({ length: 22 }, (_, index) => ({ category_id: index + 1, name: 'Mèo '.repeat(40) })) });
    const result = await h.tools.execute('list_categories', {});
    assert.equal(result.status, 'ok');
    assert.equal(result.observed_at, observed);
    assert.equal(result.categories.length, 20);
    assert.ok(result.categories.every(item => item.name.length <= 100));
    assert.equal(result.limited, true);
    assert.deepEqual(h.calls, [{ name: 'categories' }]);
    assert.equal((await harness({ categories: [] }).tools.execute('list_categories', {})).status, 'empty');
});

test('product tools: details use exact IDs and preserve order while missing or stopped items stay missing', async () => {
    const h = harness({ rows: [...inventory, row(10, { status: 'Ngừng bán' })] });
    const result = await h.tools.execute('get_product_details', { product_ids: [7, 10, 99, 3] });
    assert.deepEqual(result.products.map(item => item.product_id), [7, 3]);
    assert.deepEqual(result.missing_product_ids, [10, 99]);
    assert.equal(result.products[0].available, false);
    assert.equal(result.products[0].source, 'MySQL');
    assert.equal(result.products[0].price, '80000.00');
    assert.deepEqual(h.calls[0], { name: 'details', ids: [7, 10, 99, 3] });
    assert.equal((await h.tools.execute('get_product_details', { product_ids: [99] })).status, 'empty');
});

test('product tools: comparison reads fresh source data and cannot invent durability, reviews or promotions', async () => {
    const h = harness();
    const first = await h.tools.execute('compare_products', { product_ids: [3, 7], criteria: ['price', 'stock', 'category', 'durability', 'reviews', 'promotion'] });
    assert.deepEqual(first.comparison.cheapest_product_ids, [7]);
    assert.deepEqual(first.comparison.not_verified, ['durability', 'reviews', 'promotion']);
    assert.equal(first.comparison.rows[1].available, false);
    assert.deepEqual(first.products.map(item => item.product_id), [3, 7]);
    inventory[0].price = '50000.00';
    try {
        const second = await h.tools.execute('compare_products', { product_ids: [3, 7], criteria: ['price'] });
        assert.deepEqual(second.comparison.cheapest_product_ids, [3]);
        assert.equal(second.comparison.rows[0].price, '50000.00');
        assert.equal(h.calls.length, 2);
    } finally { inventory[0].price = '150000.00'; }
});

test('product tools: confirmed memory defaults survive an omitted filter without allowing a larger budget', async () => {
    const h = harness(), memory = configuredMemory();
    const before = JSON.stringify(memory);
    const result = await h.tools.execute('search_products', { filters: {} }, { memory });
    assert.deepEqual(result.products.map(item => item.product_id), [3]);
    assert.equal(result.search.minPrice, '50000.00');
    assert.equal(result.search.maxPrice, '200000.00');
    assert.equal(result.search.query, 'hạt');
    assert.equal(JSON.stringify(memory), before);
    for (const filters of [{ maxPrice: '300000.00' }, { minPrice: '10000.00' }]) {
        await assert.rejects(() => h.tools.execute('search_products', { filters }, { memory }), { code: 'INVALID_TOOL' });
    }
    assert.equal(h.calls.length, 1);
    const tighter = await h.tools.execute('search_products', { filters: { query: 'hạt', maxPrice: '180000.00' } }, { memory });
    assert.equal(tighter.search.maxPrice, '180000.00');
});

test('product tools: an inferred budget is not enforced as a confirmed customer restriction', async () => {
    const h = harness();
    const result = await h.tools.execute('search_products', { filters: {} }, { memory: configuredMemory('inference') });
    assert.equal(result.search.maxPrice, undefined);
    assert.equal(result.search.query, undefined);
    assert.deepEqual(result.products.map(item => item.product_id), [3, 9]);
});

test('product tools: topic changes do not carry a food budget into a new shopping topic', async () => {
    const h = harness();
    let memory = configuredMemory();
    memory = appendMessage(memory, { turn_id: 'u2', role: 'user', text: 'Chuyển sang đồ chơi.' });
    memory = applyMemoryPatch(memory, { base_revision: memory.revision, operations: [
        { op: 'switch_topic', topic: 'toys', source: { kind: 'user', turn_id: 'u2', quote: 'Chuyển sang đồ chơi.' } }
    ] });
    const result = await h.tools.execute('search_products', { filters: { query: 'đồ chơi' } }, { memory });
    assert.equal(result.search.maxPrice, undefined);
    assert.equal(result.search.query, 'đồ chơi');
});

test('product tools: source fields are bounded plain data and executable image URLs are omitted', async () => {
    const h = harness({ rows: [row(3, { name: '<b>Hạt</b> cho mèo', description: '<script>text</script>\u0000'.repeat(1000), image_url: 'javascript:alert(1)' })] });
    const result = await h.tools.execute('get_product_details', { product_ids: [3] });
    assert.equal(result.products[0].name, 'Hạt cho mèo');
    assert.ok(result.products[0].description.length <= 800);
    assert.doesNotMatch(result.products[0].description, /[<>\u0000]/);
    assert.equal(result.products[0].image_url, null);
});

test('product tools: empty search and explicit stock lookups are separate source-backed outcomes', async () => {
    const h = harness({ rows: [row(7, { stock_quantity: 0 })] });
    assert.equal((await h.tools.execute('search_products', { filters: {} })).status, 'empty');
    const stock = await h.tools.execute('search_products', { filters: {}, include_out_of_stock: true });
    assert.equal(stock.status, 'ok');
    assert.equal(stock.products[0].available, false);
    assert.equal(stock.products[0].stock_quantity, 0);
});

test('product tools: malformed requests never reach a repository or arbitrary SQL tool', async t => {
    const cases = [
        ['run_sql', { sql: 'SELECT 1' }], ['list_categories', { sql: 'DROP TABLE products' }],
        ['search_products', {}], ['search_products', { filters: { table: 'products' } }],
        ['search_products', { filters: { productIds: [3] } }], ['search_products', { filters: { limit: 7 } }],
        ['search_products', { filters: {}, include_out_of_stock: 'true' }],
        ['get_product_details', { product_ids: [3, 3] }], ['get_product_details', { product_ids: [] }],
        ['get_product_details', { product_ids: ['3'] }], ['compare_products', { product_ids: [3], criteria: ['price'] }],
        ['compare_products', { product_ids: [3, 7], criteria: ['sql'] }],
        ['compare_products', { product_ids: [3, 7], criteria: ['price', 'price'] }]
    ];
    for (const [index, [name, args]] of cases.entries()) await t.test(`invalid ${index}`, async () => {
        const h = harness();
        await assert.rejects(() => h.tools.execute(name, args), { code: 'INVALID_TOOL' });
        assert.equal(h.calls.length, 0);
    });
});

test('product tools: database errors are sanitized and invalid source prices fail closed', async () => {
    const h = harness({ failure: new Error('PRIVATE_SQL_PASSWORD') });
    for (const [name, args] of [['list_categories', {}], ['search_products', { filters: {} }], ['get_product_details', { product_ids: [3] }]]) {
        await assert.rejects(() => h.tools.execute(name, args), failure => failure.code === 'CATALOG_UNAVAILABLE' && failure.message === 'CATALOG_UNAVAILABLE');
    }
    const malformed = harness({ rows: [row(3, { price: 'NaN' })] });
    await assert.rejects(() => malformed.tools.execute('get_product_details', { product_ids: [3] }), { code: 'CATALOG_UNAVAILABLE' });
});

test('product tools: abort prevents calls or discards a result that arrived after cancellation', async () => {
    const before = new AbortController(); before.abort();
    const h = harness();
    await assert.rejects(() => h.tools.execute('list_categories', {}, { signal: before.signal }), { code: 'TOOL_ABORTED' });
    assert.equal(h.calls.length, 0);
    const during = new AbortController();
    const tools = createProductTools({ repository: { async listCategories() { during.abort(); return []; } }, now: () => observed });
    await assert.rejects(() => tools.execute('list_categories', {}, { signal: during.signal }), { code: 'TOOL_ABORTED' });
});

test('product tools: non-JSON, prototype keys, getters and oversized arguments are rejected without execution', async () => {
    const h = harness();
    let reads = 0;
    const accessor = { filters: {} };
    Object.defineProperty(accessor.filters, 'query', { enumerable: true, get() { reads++; return 'hạt'; } });
    const cycle = { filters: {} }; cycle.filters.query = cycle;
    for (const args of [accessor, cycle, { filters: { query: undefined } }, { filters: { query: 'x'.repeat(17000) } }, JSON.parse('{"filters":{"__proto__":{"x":1}}}')]) {
        await assert.rejects(() => h.tools.execute('search_products', args), { code: 'INVALID_TOOL' });
    }
    assert.equal(reads, 0);
    assert.equal(h.calls.length, 0);
});

test('product tools: query text remains a bound data value in the existing repository', async () => {
    const marker = "hạt' OR 1=1 --";
    const calls = [];
    const repository = createProductRepository({ db: { async execute(sql, params) { calls.push({ sql, params }); return [[]]; } } });
    const tools = createProductTools({ repository, now: () => observed });
    const result = await tools.execute('search_products', { filters: { query: marker, category: marker } });
    assert.equal(result.status, 'empty');
    assert.equal(result.search.query, marker);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(call => !call.sql.includes(marker) && /^SELECT/.test(call.sql)));
});

test('product tools: confirmed pet/type constraints survive an omitted or conflicting natural-language query', async () => {
    const memory = addCat(configuredMemory());
    const h = catalogFixture();
    const omitted = await h.tools.execute('search_products', { filters: {} }, { memory });
    assert.equal(omitted.search.species, 'cat');
    assert.equal(omitted.search.productType, 'kibble');
    assert.deepEqual(omitted.products.map(item => item.product_id), [3]);
    const conflictingWords = await h.tools.execute('search_products', { filters: { query: 'hạt cho chó' } }, { memory });
    assert.deepEqual(conflictingWords.products.map(item => item.product_id), [3]);
    assert.equal(conflictingWords.search.species, 'cat');
    const unrelatedType = await h.tools.execute('search_products', { filters: { query: 'đồ chơi cho chó' } }, { memory });
    // Relevance may find shared query words, but it must never broaden the
    // confirmed species/type gate to return toys or dog-only products.
    assert.ok(unrelatedType.products.every(item => item.product_id === 3));
    assert.equal(unrelatedType.search.productType, 'kibble');
    const before = h.calls.length;
    for (const filters of [{ species: 'dog' }, { productType: 'toys' }]) {
        await assert.rejects(() => h.tools.execute('search_products', { filters }, { memory }), { code: 'INVALID_TOOL' });
    }
    assert.equal(h.calls.length, before);
});

test('product tools: changing product type requires a memory transition and keeps the confirmed pet', async () => {
    const h = catalogFixture();
    let memory = addCat(configuredMemory());
    await assert.rejects(() => h.tools.execute('search_products', { filters: { productType: 'toys' } }, { memory }), { code: 'INVALID_TOOL' });
    const text = 'Giờ tìm đồ chơi cho Miu, không tìm hạt nữa.';
    memory = appendMessage(memory, { turn_id: 'change-topic', role: 'user', text });
    const source = { kind: 'user', turn_id: 'change-topic', quote: text };
    memory = applyMemoryPatch(memory, { base_revision: memory.revision, operations: [
        { op: 'switch_topic', topic: 'toys', source },
        { op: 'set_fact', section: 'needs', key: 'product_type', fact: { value: 'toys', source } }
    ] });
    const result = await h.tools.execute('search_products', { filters: { productType: 'toys' } }, { memory });
    assert.equal(result.search.species, 'cat');
    assert.equal(result.search.productType, 'toys');
    assert.equal(result.search.maxPrice, undefined);
    assert.deepEqual(result.products.map(item => item.product_id), [7]);
});

test('product tools: unconfirmed species/type do not silently override explicit structured filters', async () => {
    const h = catalogFixture();
    const memory = addCat(configuredMemory('inference'), 'inference');
    const result = await h.tools.execute('search_products', { filters: { species: 'dog', productType: 'toys' } }, { memory });
    assert.equal(result.search.species, 'dog');
    assert.equal(result.search.productType, 'toys');
    assert.equal(result.search.maxPrice, undefined);
    assert.deepEqual(result.products.map(item => item.product_id), [8]);
});

test('product tools: typed product enums reuse retrieval gates without changing untyped search', async t => {
    const h = catalogFixture();
    for (const [productType, expected] of [
        ['food', [3, 5, 6]], ['kibble', [3]], ['wet_food', [5]],
        ['snack', [6]], ['toys', [7]], ['fish_oil', [9]]
    ]) await t.test(productType, async () => {
        const result = await h.repository.search({ species: 'cat', productType });
        assert.deepEqual(result.products.map(item => item.product_id), expected);
    });
    assert.deepEqual((await h.repository.search({ query: 'đồ chơi' })).products.map(item => item.product_id), [7, 8]);
    assert.equal(validateFilters({ species: 'dog', productType: 'kibble' }).species, 'dog');
});

test('product tools: malformed typed enums fail before any SQL', async t => {
    const h = catalogFixture();
    for (const filters of [{ species: 'fish' }, { species: 1 }, { productType: 'laptop' }, { productType: '__proto__' }, { productType: null }]) {
        await t.test(JSON.stringify(filters), async () => {
            await assert.rejects(() => h.repository.search(filters), { code: 'INVALID_SEARCH' });
            await assert.rejects(() => h.tools.execute('search_products', { filters }), { code: 'INVALID_TOOL' });
        });
    }
    assert.equal(h.calls.length, 0);
});
