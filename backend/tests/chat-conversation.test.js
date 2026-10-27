const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const pool = require('../config/db');
const { createAssistant } = require('../ai/assistant');
const { createChatRouter } = require('../routes/chat');
const { sessionStorageId } = require('../ai/sessions');

test('Actual MySQL + HTTP + Gemini mock: cat food, cheapest follow-up and unknown age suitability', { skip: process.env.UC13_LIVE_DB_TEST !== '1' }, async () => {
    const requests = [];
    const assistant = createAssistant({ generate: async request => {
        const data = JSON.parse(request.contents);
        requests.push(data);
        const age = data.user_request.includes('6 tháng');
        const cheapest = data.search?.sort === 'price_asc';
        const plan = {
            advice: age ? 'Mình chưa đủ dữ liệu để xác nhận lựa chọn này phù hợp với mèo ở độ tuổi bạn nêu. Bạn nên kiểm tra thông tin trên nhãn.' : cheapest ? 'Đây là lựa chọn có giá thấp nhất trong bộ lọc trước đó.' : 'Bạn có thể cân nhắc các lựa chọn thức ăn bên dưới và chọn dạng hạt hoặc pate theo thói quen của bé.',
            product_ids: data.catalog.products.slice(0, cheapest || age ? 1 : 3).map(product => product.product_id),
            follow_up: null, warnings: []
        };
        return { text: JSON.stringify(plan), candidates: [{ finishReason: 'STOP' }] };
    } });
    const app = express(); app.use(express.json()); app.use('/api/chat', createChatRouter({ assistant }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let sessionId;
    async function ask(message) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, request_id: randomUUID(), ...(sessionId ? { session_id: sessionId } : {}) }) });
        const data = await response.json();
        sessionId = data.session_id || sessionId;
        assert.equal(response.status, 200);
        assert.equal(data.code, 'OK');
        return data;
    }
    try {
        const first = await ask('Shop có thức ăn cho mèo dưới 200k không?');
        assert.ok(first.products.length > 0 && first.products.length <= 3);
        assert.ok(first.products.every(product => product.category_id === 1 && Number(product.price) <= 200000));
        const second = await ask('Loại nào rẻ nhất?');
        assert.equal(second.products.length, 1);
        assert.equal(second.products[0].product_id, 3); // Existing NEKKO is lowest-priced food for cats.
        assert.equal(requests[1].search.query, requests[0].search.query);
        assert.ok(requests[1].history.length >= 2);
        const third = await ask('Loại đó có phù hợp với mèo 6 tháng không?');
        assert.equal(third.products[0].product_id, second.products[0].product_id);
        assert.ok(third.message.includes('chưa đủ dữ liệu'));
        assert.equal(requests.length, 3);
        const [[count]] = await pool.execute('SELECT COUNT(*) AS total FROM chat_histories WHERE session_id=?', [sessionStorageId(sessionId)]);
        assert.equal(count.total, 6);
    } finally {
        try { if (sessionId) await pool.execute('DELETE FROM chat_histories WHERE session_id=?', [sessionStorageId(sessionId)]); }
        finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await pool.end(); }
    }
});
