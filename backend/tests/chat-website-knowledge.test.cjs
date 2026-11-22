'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { createOrchestrator } = require('../ai/orchestrator');
const { validatePlan } = require('../ai/grounding');
const core = require('../ai/memory');
const { TOPICS, getWebsiteGuides } = require('../ai/website-knowledge');
const entries = require('../ai/website-knowledge-data');
const { FUNCTION_DECLARATIONS } = require('../ai/orchestrator-prompt');

// Direct, offline module checks only. Gemini selection is scripted here, not
// evidence of live model language understanding; the guard blocks live I/O.
const response = (name, args) => ({ candidates: [{ finishReason: 'STOP', content: {
    role: 'model', parts: [{ functionCall: { name, args } }],
} }], usageMetadata: { totalTokenCount: 100 } });
const answer = advice => ({ mode: 'care', intent: 'website_help', advice, product_ids: [], follow_up: null, warnings: [] });
function guideAssistant(topics, advice, inspect = () => {}) {
    let round = 0;
    return createOrchestrator({ tools: { async execute() { assert.fail('website guides must not query catalog or MySQL'); } },
        async generate({ contents }) {
            inspect(contents, round);
            if (round++ === 0) return response('get_website_guide', { topics });
            const result = contents.at(-1).parts[0].functionResponse.response;
            assert.deepEqual(result.guides.map(guide => guide.id), topics);
            assert.equal(result.current_account_data, false);
            return response('respond', answer(advice));
        } });
}

test('knowledge: source references exist; retrieval is bounded and excludes source paths or private data', () => {
    assert.equal(entries.length, 21);
    for (const entry of entries) {
        for (const key of ['id', 'name', 'purpose', 'availability']) assert.ok(typeof entry[key] === 'string' && entry[key]);
        for (const key of ['routes', 'steps', 'conditions', 'unavailable', 'notes', 'labels', 'sources']) assert.ok(Array.isArray(entry[key]) && entry[key].length);
        for (const source of entry.sources) assert.ok(existsSync(resolve(__dirname, '../..', source)), source);
    }
    const result = getWebsiteGuides({ topics: ['voucher'] });
    assert.deepEqual(result.guides.map(guide => guide.id), ['voucher']);
    assert.ok(!JSON.stringify(result).includes('backend/'));
    assert.ok(!JSON.stringify(result).includes('register'));
    result.guides[0].steps[0] = 'mutated request copy';
    assert.notEqual(getWebsiteGuides({ topics: ['voucher'] }).guides[0].steps[0], 'mutated request copy');
    for (const args of [{ topics: [] }, { topics: ['missing'] }, { topics: TOPICS }, { topics: ['voucher'], sql: 'SELECT 1' }]) {
        assert.throws(() => getWebsiteGuides(args), { code: 'INVALID_TOOL' });
    }
    const tool = FUNCTION_DECLARATIONS.find(tool => tool.name === 'get_website_guide');
    assert.equal(tool.parametersJsonSchema.properties.topics.maxItems, 2);
});

test('knowledge: cancel follow-ups survive memory reload and preserve product search context', async () => {
    let memory = core.appendMessage(core.createMemory(), { turn_id: 'product:user', role: 'user', text: 'Tìm hạt cho mèo dưới 200k' });
    memory = core.recordSearch(memory, { turn_id: 'product:user', filters: { species: 'cat', productType: 'kibble', maxPrice: '200000.00' } });
    memory = core.appendMessage(memory, { turn_id: 'product:assistant', role: 'assistant', text: 'Bạn xem các lựa chọn này.', product_ids: [21, 12] });
    const original = core.getActiveContext(memory);
    const cases = [
        ['mình mún huỷ đơn thì làm sao?', ['order_cancel'], 'Mở "Đơn hàng của tôi", chọn "Xem chi tiết". Nếu có nút "Hủy đơn hàng", chọn lý do rồi nhấn "Xác nhận hủy đơn". Chỉ hủy khi đơn chưa được duyệt và hệ thống cho phép.'],
        ['Nếu không thấy nút hủy thì sao?', ['order_cancel'], 'Nút "Hủy đơn hàng" chỉ hiện khi hệ thống cho phép. Đơn đã duyệt, đang giao, đã giao, đã hủy hoặc dữ liệu cần đối soát có thể không đủ điều kiện; nhấn "Cập nhật trạng thái" để kiểm tra lại.'],
        ['Thế đơn đã thanh toán thì sao?', ['order_cancel', 'refunds'], 'Nếu đơn Online đã thanh toán nhưng chưa được duyệt và hệ thống cho phép hủy, việc hủy hợp lệ sẽ ghi nhận yêu cầu hoàn tiền. Xem "Thông tin hoàn tiền"; yêu cầu được ghi nhận chưa có nghĩa là tiền đã hoàn.'],
    ];
    let previous;
    for (const [index, [message, topics, advice]] of cases.entries()) {
        memory = core.deserializeMemory(core.serializeMemory(memory));
        const assistant = guideAssistant(topics, advice, (contents, round) => {
            if (round === 0) {
                const initial = JSON.parse(contents[0].parts[0].text);
                assert.equal(initial.guides, undefined, 'the KB is not embedded in the bootstrap');
                if (previous) assert.ok(initial.recent_history.some(item => item.text === previous));
            }
        });
        const result = await assistant.reply({ message, memory, turn_id: `help:${index}` });
        assert.equal(result.code, 'OK');
        assert.equal(result.message, advice);
        assert.deepEqual(result.products, []);
        assert.deepEqual(core.getActiveContext(result.memory), original);
        previous = advice;
        memory = result.memory;
    }
});

test('knowledge: voucher and review instructions use verified UI labels and conditional rules', async () => {
    for (const [topic, message, advice] of [
        ['voucher', 'áp mã giảm já ở đâu vậy?', 'Ở phần "Voucher của bạn", nhập mã rồi nhấn "Áp dụng", hoặc mở "Chọn Voucher". Mỗi đơn dùng một mã; mã phải còn hiệu lực, đủ điều kiện và chức năng đang sẵn sàng.'],
        ['review_create', 'mua rồi sao chưa đánh giá đc?', 'Đơn cần ở trạng thái "Đã giao hàng". Mở "Đánh giá sản phẩm", chọn từ 1 đến 5 sao, nhập nội dung rồi nhấn "Gửi đánh giá". Mỗi tài khoản chỉ đánh giá một lần cho mỗi sản phẩm.'],
    ]) {
        const result = await guideAssistant([topic], advice).reply({ message });
        assert.equal(result.message, advice);
        assert.equal(result.intent, 'website_help');
    }
});

test('knowledge: unfinished VNPAY is described honestly without enabling a payment flow', async () => {
    const advice = 'VNPAY Sandbox chưa hoàn thiện; cổng thanh toán trực tuyến chưa được tích hợp trên giao diện. Bạn có thể xem "Thông tin thanh toán" ở chi tiết đơn hoặc liên hệ shop.';
    const result = await guideAssistant(['payment'], advice).reply({ message: 'thanh toán vnpay thế nào?' });
    assert.equal(result.message, advice);
    assert.equal(result.memory.recent_history.at(-1).text, advice);
    const unknown = await guideAssistant(['feature_limits'], 'Mình chưa có thông tin chắc chắn về chức năng này. Bạn có thể xem phần "Liên hệ" để hỏi shop.').reply({ message: 'có đăng ký dịch vụ trông thú cưng không?' });
    assert.equal(unknown.code, 'OK');
});

test('knowledge: unsupported buttons, routes, deadlines, live account claims and action claims are rejected', () => {
    const guides = getWebsiteGuides({ topics: ['order_cancel', 'refunds'] }).guides;
    const context = { mode: 'care', intent: 'website_help', products: [], website_guides: guides };
    const validate = (advice, ctx = context) => validatePlan({ text: JSON.stringify({ advice, product_ids: [], follow_up: null, warnings: [] }), candidates: [{ finishReason: 'STOP' }] }, ctx);
    for (const advice of ['Nhấn nút "Hủy ngay".', 'Mở /orders/cancel để hủy đơn.', 'Tiền sẽ được hoàn trong 30 ngày.',
        'Đơn của bạn đã thanh toán.', 'Mình đã hủy đơn cho bạn.', 'Nhấn VNPAY để thanh toán ngay.']) assert.throws(() => validate(advice));
    assert.throws(() => validate('Chỉ hủy trước khi duyệt.', { ...context, website_guides: [] }));
    assert.throws(() => validate('Sản phẩm được đánh giá 5 sao.', { mode: 'care', intent: 'care', products: [] }));
    const review = { ...context, website_guides: getWebsiteGuides({ topics: ['review_create'] }).guides };
    assert.throws(() => validate('Giá sản phẩm là 5đ.', review));
    assert.throws(() => validate('Tồn kho hiện có 5 sản phẩm.', review));
    assert.throws(() => validate('Nhấn [Xem đơn](/my-orders).'));
});
