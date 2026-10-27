const { test } = require('node:test');
const assert = require('node:assert/strict');
const evaluation = require('../ai/evaluation-questions.json');
const { createAssistant } = require('../ai/assistant');
const { LIMITS } = require('../ai/context');

// These checks exercise source boundaries and conversation logic with injected
// data. They deliberately do not claim to measure real Gemini language quality;
// the separate manual rubric in evaluation-questions.json covers that review.
const row = (id = 41, changes = {}) => ({ product_id: id, category_id: 3, category_name: 'Phụ kiện',
    name: `Bát ăn thử nghiệm ${id}`, description: 'Bát ăn cho chó mèo.', price: '125000.00',
    stock_quantity: 8, image_url: '/images/products/bat-an.webp', status: 'Đang bán', ...changes });
const response = plan => ({ text: JSON.stringify(plan), candidates: [{ finishReason: 'STOP' }] });
const careAdvice = 'Bạn có thể giữ nơi ở và bát ăn sạch sẽ, luôn chuẩn bị nước sạch và duy trì nếp sinh hoạt đều đặn cho bé.';
const shoppingAdvice = 'Bạn có thể xem các lựa chọn trong thẻ bên dưới. Mình có thể giúp thu hẹp theo nhu cầu sử dụng của bé.';

test('UC13 quality: evaluation includes Vietnamese cases with separate automated and human criteria', () => {
    assert.equal(evaluation.version, 1);
    assert.ok(evaluation.cases.length >= 20);
    assert.ok(evaluation.automated_scope.length > 0);
    assert.ok(evaluation.manual_rubric.length > 0);
    assert.equal(new Set(evaluation.cases.map(item => item.id)).size, evaluation.cases.length);
    for (const category of ['shopping', 'name', 'category', 'price', 'stock', 'compare', 'care', 'multiturn', 'negation', 'emergency', 'injection', 'dontknow']) {
        assert.ok(evaluation.cases.some(item => item.category === category), `Missing ${category} evaluation`);
    }
    for (const item of evaluation.cases) {
        assert.ok(typeof item.input.message === 'string' && item.input.message.trim());
        assert.ok(item.input.message.length <= 2000);
        assert.ok(['product', 'care'].includes(item.expected_logic.mode));
        assert.equal(typeof item.expected_logic.catalog_access, 'boolean');
        assert.equal(typeof item.expected_logic.model_access, 'boolean');
        assert.ok(item.manual_quality.length > 0);
        assert.ok(item.manual_quality.every(criterion => typeof criterion === 'string' && criterion.trim()));
    }
});

test('UC13 quality: evaluation logic runs without external models or database writes', async t => {
    for (const item of evaluation.cases) await t.test(item.id, async () => {
        const searches = [], modelCalls = [];
        const rows = item.fixture === 'empty' ? [] : item.fixture === 'two_products' ? [row(), row(42, { price: '149000.00' })]
            : [row(41, item.fixture === 'out_of_stock' ? { stock_quantity: 0 } : {})];
        const repository = { async search(filters) {
            searches.push(filters);
            if (item.fixture === 'unavailable') throw new Error('UC13_PRIVATE_CATALOG_ERROR');
            return { products: rows, totalMatches: rows.length, catalogLimited: false };
        } };
        const answer = await createAssistant({ repository, generate: async request => {
            modelCalls.push(request);
            const payload = JSON.parse(request.contents);
            return response({ advice: payload.mode === 'care' ? careAdvice : shoppingAdvice,
                product_ids: payload.mode === 'product' ? payload.catalog.products.map(product => product.product_id).slice(0, 3) : [], follow_up: null, warnings: [] });
        } }).reply(item.input);
        assert.equal(answer.mode, item.expected_logic.mode);
        assert.equal(answer.code, item.expected_logic.code);
        assert.equal(searches.length > 0, item.expected_logic.catalog_access);
        assert.equal(modelCalls.length > 0, item.expected_logic.model_access);
        assert.ok(answer.message.trim());
        assert.ok(Array.isArray(answer.products) && answer.products.length <= 3);
        assert.equal(new Set(answer.products.map(product => product.product_id)).size, answer.products.length);
        for (const product of answer.products) {
            const source = rows.find(candidate => candidate.product_id === product.product_id);
            assert.ok(source);
            for (const key of ['name', 'price', 'stock_quantity', 'image_url']) assert.equal(product[key], source[key]);
            assert.equal(product.source, 'MySQL');
            assert.equal(answer.message.includes(source.name), false);
            assert.equal(answer.message.includes(source.price), false);
        }
        if (answer.mode === 'care') assert.deepEqual(answer.products, []);
        for (const [key, expected] of Object.entries(item.expected_logic.filters || {})) assert.equal(searches[0]?.[key], expected);
        assert.equal(JSON.stringify(answer).includes('UC13_PRIVATE_CATALOG_ERROR'), false);
    });
});

test('UC13 quality: distinct useful care prose is accepted without choosing canned topic codes', async t => {
    const examples = [
        ['Mình nên đổi thức ăn cho bé thế nào?', 'Bạn có thể chia nhỏ bữa ăn, luôn để nước sạch và đổi thức ăn dần để bé có thời gian làm quen.'],
        ['Làm sao giữ chỗ ở sạch sẽ?', 'Bạn hãy dọn vụn thức ăn, vệ sinh bát sau khi dùng và giữ chỗ nghỉ của bé khô thoáng.'],
        ['Chó hay cắn đồ, nên bắt đầu tập ra sao?', 'Bạn có thể tạo nếp vận động đều đặn, cất đồ dễ hỏng và khen thưởng khi bé chơi đúng chỗ.']
    ];
    for (const [message, advice] of examples) await t.test(message, async () => {
        let catalogReads = 0;
        const followUp = 'Bé thường gặp tình huống này vào lúc nào?';
        const answer = await createAssistant({ repository: { async search() { catalogReads++; throw new Error('Unexpected catalog access'); } },
            generate: async () => response({ advice, product_ids: [], follow_up: followUp, warnings: [] }) }).reply({ message, mode: 'care' });
        assert.equal(answer.code, 'OK');
        assert.equal(answer.message, advice);
        assert.equal(answer.follow_up, followUp);
        assert.deepEqual(answer.products, []);
        assert.equal(catalogReads, 0);
    });
});

test('UC13 quality: private conversation data is redacted and history is bounded before generation', async () => {
    const history = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `Lượt ${index}: mình đang hỏi cách vệ sinh.` }));
    history[0].text = 'UC13_OLD_HISTORY_REMOVED';
    history[10].text = 'Liên hệ uc13-private@example.com, 0912345678; api_key=UC13_PRIVATE_KEY; địa chỉ: 99 Đường Riêng';
    let request;
    const advice = 'Bạn có thể giữ khu vực sinh hoạt sạch sẽ và quan sát thói quen hằng ngày của bé.';
    const answer = await createAssistant({ repository: { async search() { throw new Error('Unexpected catalog access'); } }, generate: async value => {
        request = value;
        return response({ advice, product_ids: [], follow_up: null, warnings: [] });
    } }).reply({ message: 'Chăm sóc vệ sinh cho mèo, email của mình là uc13-current@example.com', mode: 'care', history });
    assert.equal(answer.code, 'OK');
    const payload = JSON.parse(request.contents);
    assert.ok(payload.history.length > 0 && payload.history.length <= 8);
    assert.ok(payload.history.every(entry => entry.text.length <= LIMITS.historyText));
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= LIMITS.bytes);
    for (const marker of ['UC13_OLD_HISTORY_REMOVED', 'uc13-private@example.com', 'uc13-current@example.com', '0912345678', 'UC13_PRIVATE_KEY', '99 Đường Riêng']) assert.equal(request.contents.includes(marker), false);
    assert.equal(request.config.systemInstruction.includes('Lượt 11'), false);
    assert.ok(request.contents.includes('Lượt 11'));
});

test('UC13 quality: follow-up catalog references reuse backend search and selected IDs', async () => {
    const searches = [];
    const history = [{ role: 'user', text: 'Tìm bát ăn cho mèo dưới 200k' },
        { role: 'assistant', text: 'Bạn xem các lựa chọn bên dưới nhé.', product_ids: [41], search: { query: 'bát ăn mèo', maxPrice: '200000.00' } }];
    let payload;
    const answer = await createAssistant({ repository: { async search(filters) { searches.push(filters); return { products: [row()], totalMatches: 1, catalogLimited: false }; } }, generate: async request => {
        payload = JSON.parse(request.contents);
        return response({ advice: 'Mình chưa có đủ thông tin để xác nhận độ tuổi sử dụng. Bạn kiểm tra hướng dẫn trên bao bì trước khi chọn nhé.', product_ids: [41], follow_up: null, warnings: [] });
    } }).reply({ message: 'Loại đó có phù hợp không?', mode: 'product', history });
    assert.equal(answer.code, 'OK');
    assert.deepEqual(searches[0].productIds, [41]);
    assert.equal(searches[0].maxPrice, '200000.00');
    assert.ok(payload.history.some(entry => entry.product_ids?.includes(41)));
    assert.deepEqual(answer.products.map(product => product.product_id), [41]);
});

test('UC13 quality: safe warnings and one natural follow-up remain separate from advice', async () => {
    const plan = { advice: 'Giữ bát ăn sạch và chuẩn bị nước sạch giúp bạn duy trì việc chăm sóc hằng ngày.', product_ids: [],
        follow_up: 'Bé đang ăn theo giờ cố định hay tự ăn cả ngày?', warnings: ['Nếu bé bỏ ăn kéo dài hoặc có dấu hiệu bất thường, bạn nên liên hệ bác sĩ thú y.'] };
    const answer = await createAssistant({ repository: { async search() { throw new Error('Unexpected catalog access'); } }, generate: async () => response(plan) })
        .reply({ message: 'Mình muốn sắp xếp bữa ăn cho mèo tốt hơn.', mode: 'care' });
    assert.equal(answer.code, 'OK');
    assert.equal(answer.message, plan.advice);
    assert.equal(answer.follow_up, plan.follow_up);
    assert.deepEqual(answer.warnings, plan.warnings);
});
