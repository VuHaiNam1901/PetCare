const test = require('node:test');
const assert = require('node:assert/strict');

const { createOrchestrator } = require('../ai/orchestrator');
const { createProductTools } = require('../ai/tools');
const { createPetTools } = require('../ai/pet-tools');
const { createProductRepository } = require('../ai/products');
const { createMemory, appendMessage, applyMemoryPatch } = require('../ai/memory');
const { validatePlan } = require('../ai/grounding');
const { resolvePageContext } = require('../ai/page-context');

const SPECIES_CATALOG = {
    dog: { pet_type_id: 1, slug: 'dog', name: 'Chó' },
    cat: { pet_type_id: 2, slug: 'cat', name: 'Mèo' },
    bird: { pet_type_id: 3, slug: 'bird', name: 'Chim' },
    fish: { pet_type_id: 4, slug: 'fish', name: 'Cá' },
    hamster: { pet_type_id: 5, slug: 'hamster', name: 'Hamster/Chuột' },
    rabbit: { pet_type_id: 6, slug: 'rabbit', name: 'Thỏ' },
};

const SYNTHETIC_PRODUCTS = [
    {
        product_id: 101,
        category_id: 1,
        category_name: 'Thức ăn thú cưng',
        name: 'Hạt dinh dưỡng mẫu cho chó',
        description: 'Thức ăn hạt kiểm thử cho chó.',
        price: '145000.00',
        stock_quantity: 12,
        image_url: '/images/products/test-dog.webp',
        status: 'Đang bán',
        pet_types: [SPECIES_CATALOG.dog],
    },
    {
        product_id: 102,
        category_id: 1,
        category_name: 'Thức ăn thú cưng',
        name: 'Cỏ nén mẫu cho thỏ',
        description: 'Thức ăn cỏ nén kiểm thử dành cho thỏ.',
        price: '79000.00',
        stock_quantity: 20,
        image_url: '/images/products/test-rabbit.webp',
        status: 'Đang bán',
        pet_types: [SPECIES_CATALOG.rabbit],
    },
    {
        product_id: 103,
        category_id: 1,
        category_name: 'Thức ăn thú cưng',
        name: 'Pate cá ngừ mẫu cho mèo',
        description: 'Thức ăn ướt pate kiểm thử cho mèo.',
        price: '32000.00',
        stock_quantity: 18,
        image_url: '/images/products/test-cat.webp',
        status: 'Đang bán',
        pet_types: [SPECIES_CATALOG.cat],
    },
    {
        product_id: 104,
        category_id: 2,
        category_name: 'Phụ kiện vệ sinh',
        name: 'Cát vệ sinh mẫu cho mèo',
        description: 'Cát vệ sinh kiểm thử.',
        price: '95000.00',
        stock_quantity: 9,
        image_url: '/images/products/test-litter.webp',
        status: 'Đang bán',
        pet_types: [SPECIES_CATALOG.cat],
    },
];

function createSyntheticRepo(items = SYNTHETIC_PRODUCTS) {
    return {
        async listCategories() {
            return [
                { category_id: 1, name: 'Thức ăn thú cưng' },
                { category_id: 2, name: 'Phụ kiện vệ sinh' },
            ];
        },
        async getByIds(ids) {
            return items.filter(p => ids.includes(p.product_id));
        },
        async search(filters = {}) {
            const matched = items.filter(p => !filters.species || p.pet_types.some(t => t.slug === filters.species));
            return { products: matched.slice(0, filters.limit || 6), totalMatches: matched.length, catalogLimited: false };
        },
    };
}

function createFakePetModel(petsByUser, { ready = true } = {}) {
    return {
        async listByUser(userId) {
            if (!ready) {
                throw Object.assign(new Error('Not ready'), { status: 503, code: 'PET_PROFILE_NOT_READY' });
            }
            return petsByUser[userId] || [];
        },
    };
}

function fcResponse(calls) {
    return {
        candidates: [{
            finishReason: 'STOP',
            content: { role: 'model', parts: calls.map(c => ({ functionCall: { id: c.id || 'call-1', name: c.name, args: c.args } })) },
        }],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 60, totalTokenCount: 260 },
    };
}

test('logged-in user asks by pet name and receives grounded species-matched advice within default limits', async () => {
    const petModel = createFakePetModel({
        1: [{
            pet_id: 11, user_id: 1, pet_type_id: 1, species_slug: 'dog', species_name: 'Chó',
            name: 'Bông', breed: 'Poodle', age_months: 18, weight_kg: 4, gender: 'female',
            activity_level: 'high', health_notes: 'Liên hệ test 0912345678, ăn hạt mềm', is_default: true,
        }],
        2: [{
            pet_id: 22, user_id: 2, pet_type_id: 2, species_slug: 'cat', species_name: 'Mèo',
            name: 'Bông', breed: 'Scottish Fold', age_months: 24, weight_kg: 3.8, gender: 'male',
            activity_level: 'low', health_notes: 'Bí mật user 2', is_default: true,
        }],
    });

    const repo = createSyntheticRepo();
    const seenAllowed = [];
    let step = 0;

    const orchestrator = createOrchestrator({
        repository: repo,
        tools: createProductTools({ repository: repo }),
        petTools: createPetTools({ petModel }),
        generate: async ({ config }) => {
            seenAllowed.push(config.toolConfig.functionCallingConfig.allowedFunctionNames);
            step++;
            if (step === 1) return fcResponse([{ id: 'p1', name: 'get_my_pets', args: { name_query: 'Bông' } }]);
            if (step === 2) return fcResponse([{ id: 's1', name: 'search_products', args: { filters: { query: 'đồ ăn', species: 'dog' } } }]);
            return fcResponse([{
                id: 'r1',
                name: 'respond',
                args: {
                    mode: 'product',
                    intent: 'product_advice',
                    product_ids: [101],
                    advice: 'Hồ sơ của bé Bông ghi nhận loài chó giống Poodle, 18 tháng tuổi, nặng 4kg. Lựa chọn thứ nhất thuộc nhóm sản phẩm cho chó trong danh mục hiện có.',
                    follow_up: 'Bạn có muốn mình lọc thêm theo ngân sách không?',
                    warnings: ['Dữ liệu lịch sử đã mua của từng thú cưng chưa được liên kết nên chưa xác nhận sản phẩm bé từng dùng.'],
                },
            }]);
        },
    });

    const result = await orchestrator.reply({
        user_id: 1,
        message: 'Bông sắp hết đồ ăn rồi.',
        turn_id: 'turn-pet-1',
    });

    assert.ok(seenAllowed[0].includes('get_my_pets'));
    assert.equal(result.mode, 'product');
    assert.deepEqual(result.products.map(p => p.product_id), [101]);
    assert.ok(result.usage.model_calls <= 4);
    assert.ok(result.usage.tool_calls <= 6);
    assert.doesNotMatch(JSON.stringify(result), /Scottish Fold|Bí mật user 2|0912345678/);
});

test('duplicate pet names trigger ambiguous_name clarification without picking a wrong pet', async () => {
    const petModel = createFakePetModel({
        1: [
            { pet_id: 11, user_id: 1, pet_type_id: 1, species_slug: 'dog', species_name: 'Chó', name: 'Bông', breed: 'Poodle', age_months: 18, weight_kg: 4, is_default: false },
            { pet_id: 12, user_id: 1, pet_type_id: 2, species_slug: 'cat', species_name: 'Mèo', name: 'Bông', breed: 'Mèo Mướp', age_months: 24, weight_kg: 3.5, is_default: false },
        ],
    });
    const repo = createSyntheticRepo();
    let step = 0;

    const orchestrator = createOrchestrator({
        repository: repo,
        tools: createProductTools({ repository: repo }),
        petTools: createPetTools({ petModel }),
        generate: async () => {
            step++;
            if (step === 1) return fcResponse([{ id: 'p1', name: 'get_my_pets', args: { name_query: 'Bông' } }]);
            return fcResponse([{
                id: 'r1',
                name: 'respond',
                args: {
                    mode: 'care',
                    intent: 'clarification',
                    product_ids: [],
                    advice: 'Bạn đang có hai bé cùng tên Bông gồm một bé chó giống Poodle 4kg và một bé mèo giống Mèo Mướp 3.5kg. Bạn đang muốn tìm đồ ăn cho bé Bông nào để mình tư vấn chính xác nhé?',
                    follow_up: null,
                    warnings: [],
                },
            }]);
        },
    });

    const result = await orchestrator.reply({
        user_id: 1,
        message: 'Bông nhà mình sắp hết đồ ăn rồi',
        turn_id: 'turn-dup-1',
    });

    assert.equal(result.mode, 'care');
    assert.equal(result.intent, 'clarification');
    assert.deepEqual(result.products, []);
    assert.match(result.message, /Bông/);
});

test('pet-tools distinguishes default pet, needs_selection with multiple pets, and 503 readiness', async () => {
    const multiNoDefault = createPetTools({
        petModel: createFakePetModel({
            1: [
                { pet_id: 1, user_id: 1, pet_type_id: 1, species_slug: 'dog', species_name: 'Chó', name: 'Cún', is_default: false },
                { pet_id: 2, user_id: 1, pet_type_id: 6, species_slug: 'rabbit', species_name: 'Thỏ', name: 'Nâu', is_default: false },
            ],
        }),
    });
    const genericNoDefault = await multiNoDefault.execute({ include_default: true }, { userId: 1 });
    assert.equal(genericNoDefault.needs_selection, true);
    assert.equal(genericNoDefault.default_pet_id, null);
    assert.equal(genericNoDefault.matched_pets.length, 0);
    assert.equal(genericNoDefault.purchase_history_available, false);

    const notReadyTools = createPetTools({ petModel: createFakePetModel({}, { ready: false }) });
    const fallback = await notReadyTools.execute({}, { userId: 1 });
    assert.equal(fallback.ready, false);
    assert.equal(fallback.authenticated, true);
    assert.deepEqual(fallback.pets, []);
});

test('guest user never exposes get_my_pets tool and cannot invoke it', async () => {
    const repo = createSyntheticRepo();
    const seenAllowed = [];
    const seenDeclarations = [];
    let toolCalled = false;

    const orchestrator = createOrchestrator({
        repository: repo,
        tools: createProductTools({ repository: repo }),
        petTools: createPetTools({ petModel: createFakePetModel({ 1: [{ pet_id: 1, user_id: 1, pet_type_id: 1, species_slug: 'dog', species_name: 'Chó', name: 'Bông' }] }) }),
        generate: async ({ config }) => {
            seenAllowed.push(config.toolConfig.functionCallingConfig.allowedFunctionNames);
            seenDeclarations.push(config.tools[0].functionDeclarations.map(d => d.name));
            if (!toolCalled) {
                toolCalled = true;
                return fcResponse([{ id: 's1', name: 'search_products', args: { filters: { query: 'pate mèo', species: 'cat' } } }]);
            }
            return fcResponse([{
                id: 'r1',
                name: 'respond',
                args: {
                    mode: 'product',
                    intent: 'product_search',
                    product_ids: [103],
                    advice: 'Lựa chọn thứ nhất là sản phẩm cho mèo đang có sẵn để bạn tham khảo.',
                    follow_up: null,
                    warnings: [],
                },
            }]);
        },
    });

    const result = await orchestrator.reply({
        message: 'Tìm pate cho mèo',
        turn_id: 'turn-guest-1',
    });

    assert.ok(!seenAllowed[0].includes('get_my_pets'));
    assert.ok(!seenDeclarations[0].includes('get_my_pets'));
    assert.deepEqual(result.products.map(p => p.product_id), [103]);
});

test('products search and product tools support all 6 species and pet species switching via observedPets', async () => {
    const dbRows = SYNTHETIC_PRODUCTS.map(p => ({ ...p, created_at: '2026-11-22', pet_types: JSON.stringify(p.pet_types) }));
    const repo = createProductRepository({
        categoryReader: async () => [],
        db: {
            async execute(sql, params) {
                const cursor = params[params.length - 1];
                const speciesSlug = sql.includes('pt.slug = ?') ? params[params.length - 2] : null;
                const filtered = dbRows.filter(r => r.product_id > cursor && (!speciesSlug || JSON.parse(r.pet_types).some(pt => pt.slug === speciesSlug)));
                return [filtered];
            },
        },
    });

    const rabbitSearch = await repo.search({ query: 'đồ ăn cho thỏ' });
    assert.deepEqual(rabbitSearch.products.map(p => p.product_id), [102]);

    const tools = createProductTools({ repository: createSyntheticRepo() });
    let memory = createMemory();
    memory = appendMessage(memory, { turn_id: 't1', role: 'user', text: 'Tìm đồ cho mèo nhà mình' });
    memory = applyMemoryPatch(memory, {
        base_revision: memory.revision,
        operations: [
            {
                op: 'add_pet',
                pet_id: 'pet_cat',
                fields: {
                    species: { value: 'cat', source: { kind: 'user', turn_id: 't1', quote: 'mèo' } },
                },
            },
            { op: 'switch_pet', pet_id: 'pet_cat' },
        ],
    });
    await assert.rejects(
        () => tools.execute('search_products', { filters: { species: 'rabbit', query: 'đồ ăn' } }, { memory }),
        err => err.code === 'INVALID_TOOL'
    );
    const switched = await tools.execute(
        'search_products',
        { filters: { species: 'rabbit', query: 'đồ ăn' } },
        { memory, observedPets: [{ pet_id: 99, species_slug: 'rabbit', name: 'Nâu' }] }
    );
    assert.deepEqual(switched.products.map(p => p.product_id), [102]);
});

test('grounding still blocks leaked catalog product name even when pet_profiles are verified, and page-context validates /my-pets routes', async () => {
    assert.throws(() => validatePlan(
        {
            text: JSON.stringify({
                mode: 'product',
                intent: 'product_advice',
                product_ids: [101],
                advice: 'Hạt dinh dưỡng mẫu cho chó rất hợp cho Bông.',
                follow_up: null,
                warnings: [],
            }),
            candidates: [{ finishReason: 'STOP' }],
        },
        {
            mode: 'product',
            intent: 'product_advice',
            products: [SYNTHETIC_PRODUCTS[0]],
            pet_profiles: [{ pet_id: 1, name: 'Bông', breed: 'Poodle' }],
        }
    ));

    const petsCtx = await resolvePageContext({ version: 1, route: '/my-pets', cart: { item_count: 0, selected_count: 0, loading: false, selectable_count: 0, editable_quantity_count: 0, error: false, busy: false, merging: false, merge_can_edit: false }, state: { phase: 'ready', has_pets: true, busy: false } }, { userId: 1 });
    assert.equal(petsCtx.page.key, 'pets');
    assert.ok(petsCtx.ui.actions.some(a => a.id === 'add_pet' && a.visible));

    const petDetailCtx = await resolvePageContext({ version: 1, route: '/my-pets/5', cart: { item_count: 0, selected_count: 0, loading: false, selectable_count: 0, editable_quantity_count: 0, error: false, busy: false, merging: false, merge_can_edit: false }, state: { phase: 'ready', editing: true, has_pets: true, busy: false } }, { userId: 1 });
    assert.equal(petDetailCtx.page.key, 'pet');
    assert.equal(petDetailCtx.page.pet_id, 5);

    const petsStripped = await resolvePageContext({ version: 1, route: '/my-pets', cart: { item_count: 0, selected_count: 0, loading: false, selectable_count: 0, editable_quantity_count: 0, error: false, busy: false, merging: false, merge_can_edit: false }, state: { phase: 'ready', editing: true, has_pets: false } }, { userId: 1 });
    assert.equal(petsStripped.state.editing, undefined);
    await assert.rejects(() => resolvePageContext({ version: 1, route: '/my-pets', cart: { item_count: 0, selected_count: 0, loading: false, selectable_count: 0, editable_quantity_count: 0, error: false, busy: false, merging: false, merge_can_edit: false }, state: { phase: 'ready', has_pets: 'yes' } }, { userId: 1 }), err => err.status === 400);
});
