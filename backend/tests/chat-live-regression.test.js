const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../ai/assistant');
const rows = [1, 4, 3].map(id => ({ product_id: id, category_id: 1, category_name: 'Thức ăn thú cưng', name: `Thức ăn mèo ${id}`, description: null, price: '18000.00', stock_quantity: 20, status: 'Đang bán', image_url: '/images/products/test.webp' }));
const repository = { async search() { return { products: rows, totalMatches: 3 }; } };
function generate(advice) { return async () => ({ text: JSON.stringify({ advice, product_ids: [1, 4, 3], follow_up: 'Bé nhà bạn thích ăn hạt khô hay pate hơn vậy ạ?', warnings: [] }), candidates: [{ finishReason: 'STOP' }] }); }
test('Live-model regression: exact user budget is verified then removed from natural prose', async () => {
    const result = await createAssistant({ repository, generate: generate('Dạ nhà mình có nhiều loại thức ăn cho mèo dưới 200k rất phù hợp để boss nhâm nhi mỗi ngày ạ. Bạn có thể tham khảo các lựa chọn bên dưới nhé.') }).reply({ message: 'Shop có thức ăn cho mèo dưới 200k không?' });
    assert.equal(result.code, 'OK');
    assert.ok(result.message.includes('trong ngân sách bạn đã nêu'));
    assert.equal(result.message.includes('200k'), false);
    assert.equal(result.products.length, 3);
});
test('A fabricated amount that differs from the user budget remains rejected', async () => {
    const result = await createAssistant({ repository, generate: generate('Các lựa chọn dưới 123k rất đáng cân nhắc.') }).reply({ message: 'Shop có thức ăn cho mèo dưới 200k không?' });
    assert.equal(result.code, 'GROUNDING_REJECTED');
    assert.deepEqual(result.products, []);
});
