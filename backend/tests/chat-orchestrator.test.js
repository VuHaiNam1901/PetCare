'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOrchestrator } = require('../ai/orchestrator');
const { SYSTEM_PROMPT } = require('../ai/orchestrator-prompt');
const { createMemory, appendMessage, applyMemoryPatch, serializeMemory } = require('../ai/memory');

const row = (id = 1, changes = {}) => ({ product_id: id, category_id: 1, category_name: 'Thức ăn',
    name: `Hạt cho mèo mẫu ${id}`, price: '90000.00', stock_quantity: 3, status: 'Đang bán',
    image_url: '/images/products/test.webp', description: 'Thông tin thử nghiệm.', ...changes });
const answer = (changes = {}) => ({ mode: 'care', intent: 'conversation',
    advice: 'Mình đang lắng nghe. Bạn muốn chia sẻ thêm điều gì?', product_ids: [], follow_up: null, warnings: [], ...changes });
const call = (name, args, id = `${name}-1`) => ({ functionCall: { name, args, ...(id === null ? {} : { id }) }, thoughtSignature: 'opaque-unchanged-signature' });
const response = (parts, usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 20, totalTokenCount: 170 }) => ({ usageMetadata,
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] });
function harness(steps, { repository, limits, onUsage } = {}) {
    const requests = [], reads = [];
    const repo = repository || {
        async listCategories() { reads.push('categories'); return [{ category_id: 1, name: 'Thức ăn' }]; },
        async search() { reads.push('search'); return { products: [row()], totalMatches: 1, catalogLimited: false }; },
        async getByIds(ids) { reads.push({ details: ids }); return ids.map(id => row(id)); }
    };
    const orchestrator = createOrchestrator({ repository: repo, limits, onUsage, generate: async request => {
        requests.push(request);
        const step = steps[requests.length - 1];
        assert.ok(step, 'no hidden model retries');
        return typeof step === 'function' ? step(request) : response(step);
    } });
    return { requests, reads, reply: input => orchestrator.reply(typeof input === 'string' ? { message: input } : input) };
}

test('orchestrator: manager request reaches Gemini first without requiring a working catalog', async () => {
    let reads = 0;
    const h = harness([[call('respond', answer({ intent: 'handoff_request',
        advice: 'Mình chưa có công cụ kết nối trực tiếp với quản lý. Bạn muốn trao đổi vấn đề gì?' }))]], {
        repository: { async search() { reads++; throw new Error('PRIVATE_DATABASE'); }, async listCategories() { reads++; throw Error('PRIVATE_DATABASE'); } }
    });
    const result = await h.reply({ message: 'Cho gặp quản lý', turn_id: 'manager' });
    assert.equal(result.code, 'OK');
    assert.equal(result.intent, 'handoff_request');
    assert.equal(reads, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(result.usage.model_calls, 1);
    assert.equal(result.usage.tool_calls, 0);
    assert.equal(result.usage.total_tokens, 170);
    assert.equal(result.usage.thinking_tokens, 20);
    assert.equal(result.usage.reserved_tokens, 0);
    assert.equal(result.usage.usage_reported, true);
    assert.equal(JSON.parse(h.requests[0].contents[0].parts[0].text).user_request, 'Cho gặp quản lý');
});

test('orchestrator: flexible conversational utterances are not classified by the legacy router', async t => {
    for (const message of ['Mình đang hơi buồn, nói chuyện chút nhé', 'Ừm...', 'Shop ơi', 'Cảm ơn, còn bạn thì sao?', 'Tại sao mèo thích hộp giấy?']) {
        await t.test(message, async () => {
            const h = harness([[call('respond', answer())]]);
            assert.equal((await h.reply(message)).code, 'OK');
            assert.equal(h.requests.length, 1);
            assert.equal(h.reads.length, 0);
            assert.match(h.requests[0].config.systemInstruction, /PetCareShop/);
            assert.equal(h.requests[0].config.responseJsonSchema, undefined);
        });
    }
});

test('orchestrator: sends native tools, correct call ID, complete parts and signatures to the next round', async () => {
    const part = call('search_products', { filters: { query: 'hạt mèo' } }, 'call-search');
    const h = harness([[part], [call('respond', answer({ mode: 'product', intent: 'product_search',
        advice: 'Bạn có thể xem lựa chọn trong thẻ bên dưới.', product_ids: [1] }), 'call-finish')]]);
    const result = await h.reply('Tìm hạt cho mèo');
    assert.equal(result.products[0].product_id, 1);
    assert.equal(result.products[0].source, 'MySQL');
    assert.deepEqual(h.requests[1].contents[1], { role: 'model', parts: [part] });
    assert.equal(h.requests[1].contents[2].parts[0].functionResponse.id, 'call-search');
    assert.equal(h.requests[1].contents[2].parts[0].functionResponse.name, 'search_products');
    assert.equal(h.requests[1].contents[2].parts[0].functionResponse.response.products[0].price, '90000.00');
    assert.ok(h.requests[0].config.tools[0].functionDeclarations.some(tool => tool.name === 'respond'));
    assert.equal(h.requests[0].config.toolConfig.functionCallingConfig.mode, 'ANY');
    assert.deepEqual(h.requests[0].config.httpOptions.retryOptions, { attempts: 1 });
});

test('orchestrator: optional native IDs remain absent instead of inventing correlation metadata', async () => {
    const h = harness([[call('list_categories', {}, null)], [call('respond', answer(), null)]]);
    assert.equal((await h.reply('Có nhóm hàng nào?')).code, 'OK');
    assert.equal(Object.hasOwn(h.requests[1].contents[2].parts[0].functionResponse, 'id'), false);
    assert.equal(h.requests[1].contents[1].parts[0].thoughtSignature, 'opaque-unchanged-signature');
});

test('orchestrator: missing current evidence or later deleted products cannot use an earlier card', async t => {
    await t.test('no lookup in current turn', async () => {
        const h = harness([[call('respond', answer({ mode: 'product', intent: 'product_search', product_ids: [1] }))]]);
        await assert.rejects(() => h.reply({ message: 'Loại đó còn không?', history: [
            { role: 'assistant', text: 'Lựa chọn cũ.', product_ids: [1] }
        ] }), { code: 'GROUNDING_REJECTED' });
    });
    await t.test('exact lookup revokes stale evidence', async () => {
        const h = harness([
            [call('search_products', { filters: { query: 'hạt' } }, 'search')],
            [call('get_product_details', { product_ids: [1] }, 'details')],
            [call('respond', answer({ mode: 'product', intent: 'price_stock', product_ids: [1] }), 'finish')]
        ], { repository: { async search() { return { products: [row()], totalMatches: 1 }; }, async getByIds() { return []; } } });
        await assert.rejects(() => h.reply('Giá lựa chọn đó?'), { code: 'GROUNDING_REJECTED' });
    });
});

test('orchestrator: repeated catalog calls cannot restore revoked evidence from an earlier cache', async t => {
    await t.test('search after a missing detail is a new read', async () => {
        let reads = 0;
        const h = harness([
            [call('search_products', { filters: { query: 'hạt' } }, 'search-one')],
            [call('get_product_details', { product_ids: [1] }, 'missing')],
            [call('search_products', { filters: { query: 'hạt' } }, 'search-two')],
            [call('respond', answer({ mode: 'product', intent: 'price_stock', product_ids: [1] }), 'finish')]
        ], { repository: {
            async search() { reads++; return { products: reads === 1 ? [row()] : [], totalMatches: reads === 1 ? 1 : 0 }; },
            async getByIds() { return []; }
        } });
        await assert.rejects(() => h.reply('Loại đó còn không?'), { code: 'GROUNDING_REJECTED' });
        assert.equal(reads, 2);
    });
    await t.test('an identical detail lookup is also read again', async () => {
        let reads = 0;
        const h = harness([
            [call('get_product_details', { product_ids: [1] }, 'detail-one')],
            [call('get_product_details', { product_ids: [1] }, 'detail-two')],
            [call('respond', answer({ mode: 'product', intent: 'price_stock', product_ids: [1] }), 'finish')]
        ], { repository: { async getByIds() { return ++reads === 1 ? [row()] : []; } } });
        await assert.rejects(() => h.reply('Kiểm tra lại lựa chọn này.'), { code: 'GROUNDING_REJECTED' });
        assert.equal(reads, 2);
    });
});

test('orchestrator: unsupported actions, fabricated store policies, prices and medical claims are rejected', async t => {
    for (const [advice, code] of [
        ['Mình đã kết nối với quản lý.', 'UNSUPPORTED_ACTION'],
        ['Mình đã báo quản lý, quản lý sẽ gọi lại cho bạn.', 'UNSUPPORTED_ACTION'],
        ['Mình sẽ gửi yêu cầu tới nhân viên.', 'UNSUPPORTED_ACTION'],
        ['Cửa hàng có chính sách đổi trả trong 30 ngày.', 'UNVERIFIED_STORE_FACT'],
        ['Lựa chọn thứ hai bền hơn.', 'UNVERIFIED_STORE_FACT'],
        ['Sản phẩm được đánh giá 5 sao.', 'UNVERIFIED_STORE_FACT'],
        ['Giá sản phẩm là 100000đ.', 'GROUNDING_REJECTED'],
        ['Cho mèo uống paracetamol 5mg.', 'GROUNDING_REJECTED']
    ]) await t.test(advice, async () => {
        const h = harness([[call('respond', answer({ advice }))]]);
        await assert.rejects(() => h.reply('Bạn giúp mình nhé'), { code });
    });
});

test('orchestrator: safe care and honest missing knowledge remain generated replies', async () => {
    const advice = 'Nếu bé đang khó thở, bạn nên liên hệ bác sĩ thú y ngay. Mình không thể chẩn đoán hay kê thuốc.';
    const h = harness([[call('respond', answer({ intent: 'care', advice, warnings: ['Ưu tiên liên hệ bác sĩ thú y kịp thời.'] }))]]);
    const result = await h.reply('Mèo khó thở, phải làm sao?');
    assert.equal(result.message, advice);
    assert.deepEqual(result.care_advice, [{ source: 'general_knowledge', text: advice }]);
    assert.equal(h.reads.length, 0);
    const policies = harness([[call('respond', answer({ advice: 'Mình chưa có thông tin chính sách đổi trả đã xác minh.' }))]]);
    assert.equal((await policies.reply('Đổi trả thế nào?')).code, 'OK');
});

test('orchestrator: provider errors are classified without a fake answer, catalog lookup or known-zero billing', async () => {
    let measured;
    const h = harness([() => { throw Object.assign(new Error('PRIVATE_PROMPT_KEY'), { status: 429 }); }], { onUsage: value => { measured = value; } });
    await assert.rejects(() => h.reply('Cho gặp quản lý'), error => {
        assert.equal(error.code, 'GEMINI_QUOTA');
        assert.equal(error.status, 503);
        assert.equal(error.chatSafe, true);
        assert.equal(JSON.stringify(error).includes('PRIVATE_PROMPT_KEY'), false);
        return true;
    });
    assert.equal(h.reads.length, 0);
    assert.equal(measured.model_calls, 1);
    assert.equal(measured.usage_reported, false);
    assert.ok(measured.reserved_tokens > 0);
});

test('orchestrator: compacts an existing checkpoint before appending beyond the history window', async () => {
    let memory = createMemory();
    for (let index = 0; index < 12; index++) memory = appendMessage(memory, { turn_id: `old:${index}`, role: index % 2 ? 'assistant' : 'user', text: `Tin ${index}.` });
    const before = serializeMemory(memory);
    const h = harness([[call('compact_memory', { through_sequence: 8, text: 'Khách đã trao đổi tám tin đầu, chưa cung cấp yêu cầu sản phẩm.' }, 'compact')],
        [call('respond', answer(), 'finish')]]);
    const result = await h.reply({ message: 'Bạn còn nhớ không?', memory, turn_id: 'next' });
    assert.equal(JSON.parse(h.requests[0].contents[0].parts[0].text).preparing, true);
    assert.deepEqual(h.requests[0].config.toolConfig.functionCallingConfig.allowedFunctionNames, ['compact_memory']);
    assert.equal(result.memory.summary.through_sequence, 8);
    assert.equal(result.memory.recent_history.at(-2).turn_id, 'next');
    assert.equal(serializeMemory(memory), before);
});

test('orchestrator: one deadline cancels a hung model even if the injected function ignores the signal', async () => {
    let submitted, measured;
    const h = harness([request => { submitted = request; return new Promise(() => {}); }],
        { limits: { timeoutMs: 15 }, onUsage: value => { measured = value; } });
    await assert.rejects(() => h.reply('Chào bạn'), { code: 'GEMINI_TIMEOUT', status: 504 });
    assert.equal(submitted.config.abortSignal.aborted, true);
    assert.equal(measured.model_calls, 1);
    assert.equal(measured.usage_reported, false);
    assert.ok(measured.reserved_tokens > 0);
});

test('orchestrator: caller cancellation prevents a model call', async () => {
    const controller = new AbortController(); controller.abort();
    const h = harness([]);
    await assert.rejects(() => h.reply({ message: 'Chào', signal: controller.signal }), { code: 'GEMINI_TIMEOUT', status: 504 });
    assert.equal(h.requests.length, 0);
});

test('orchestrator: model/tool/input/output/token budgets are enforced without unbounded retries', async t => {
    await t.test('last model call cannot start another lookup', async () => {
        const h = harness([[call('list_categories', {})]], { limits: { modelCalls: 1 } });
        await assert.rejects(() => h.reply('Có gì?'), { code: 'MODEL_CALL_LIMIT' });
        assert.equal(h.requests.length, 1); assert.equal(h.reads.length, 0);
    });
    await t.test('second tool is never executed above its budget', async () => {
        const h = harness([[call('list_categories', {}, 'one')], [call('list_categories', {}, 'two')]], { limits: { toolCalls: 1 } });
        await assert.rejects(() => h.reply('Có gì?'), { code: 'TOOL_LIMIT' });
        assert.equal(h.requests.length, 2); assert.equal(h.reads.length, 1);
    });
    await t.test('input too large', async () => {
        const h = harness([], { limits: { inputBytes: 10 } });
        await assert.rejects(() => h.reply('Chào'), { code: 'CONTEXT_LIMIT' });
        assert.equal(h.requests.length, 0);
    });
    await t.test('insufficient token reservation', async () => {
        const h = harness([], { limits: { totalTokens: 100 } });
        await assert.rejects(() => h.reply('Chào'), { code: 'TOKEN_LIMIT' });
        assert.equal(h.requests.length, 0);
    });
    await t.test('provider usage over budget', async () => {
        const h = harness([() => response([call('respond', answer())], { totalTokenCount: 1e9 })]);
        await assert.rejects(() => h.reply('Chào'), { code: 'TOKEN_LIMIT' });
    });
    await t.test('model response too large', async () => {
        const h = harness([[call('respond', answer({ advice: 'x'.repeat(20000) }))]]);
        await assert.rejects(() => h.reply('Chào'), { code: 'OUTPUT_LIMIT' });
    });
});

test('orchestrator: invalid protocol, tool names and memory patches fail closed', async t => {
    for (const [parts, code] of [
        [[{ text: 'A free-text response outside the required protocol.' }], 'INVALID_MODEL_RESPONSE'],
        [[call('run_sql', { sql: 'SELECT 1' })], 'INVALID_MODEL_RESPONSE'],
        [[call('update_memory', { operations: [{ op: 'run_sql' }] })], 'INVALID_MEMORY_UPDATE'],
        [[call('respond', answer()), call('list_categories', {})], 'INVALID_MODEL_RESPONSE'],
        [[call('list_categories', {}, null), call('list_categories', {}, null)], 'INVALID_MODEL_RESPONSE']
    ]) await t.test(code + JSON.stringify(parts).slice(0, 40), async () => {
        const h = harness([parts]);
        await assert.rejects(() => h.reply('Chào'), { code });
    });
});

test('orchestrator: a tool database failure is not reported as an empty catalog or successful advice', async () => {
    const h = harness([[call('search_products', { filters: { query: 'hạt' } })]], { repository: {
        async search() { throw new Error('SQL_PASSWORD_PRIVATE'); }
    } });
    await assert.rejects(() => h.reply('Tìm hạt'), error => error.code === 'CATALOG_UNAVAILABLE' && !JSON.stringify(error).includes('SQL_PASSWORD_PRIVATE'));
    assert.equal(h.requests.length, 1);
});

test('orchestrator: memory stays untouched on a failed candidate and model inputs are redacted', async () => {
    const memory = createMemory(), before = serializeMemory(memory);
    const h = harness([[call('update_memory', { operations: [{ op: 'run_sql' }] })]]);
    await assert.rejects(() => h.reply({ message: 'Email private@example.test, điện thoại 0912345678', memory }), { code: 'INVALID_MEMORY_UPDATE' });
    assert.equal(serializeMemory(memory), before);
    const sent = JSON.stringify(h.requests[0].contents);
    assert.equal(sent.includes('private@example.test'), false);
    assert.equal(sent.includes('0912345678'), false);
    assert.match(SYSTEM_PROMPT, /KHÔNG có công cụ/);
});

test('orchestrator: restoring a typed large budget preserves decimals while redacting free-text PII', async () => {
    const text = 'Ngân sách tối đa 10000000.00 đồng; email private@example.test.';
    let memory = appendMessage(createMemory(), { turn_id: 'budget-source', role: 'user', text });
    memory = applyMemoryPatch(memory, { base_revision: memory.revision, operations: [{
        op: 'set_fact', section: 'constraints', key: 'budget', fact: {
            value: { currency: 'VND', min: null, max: '10000000.00' },
            source: { kind: 'user', turn_id: 'budget-source', quote: text }
        }
    }] });
    const before = serializeMemory(memory);
    const h = harness([[call('respond', answer())]]);
    const result = await h.reply({ message: 'Bạn còn nhớ ngân sách không?', memory });
    const payload = JSON.parse(h.requests[0].contents[0].parts[0].text);
    assert.equal(payload.active_context.constraints.budget.value.max, '10000000.00');
    assert.equal(result.memory.state.constraints[0].fact.value.max, '10000000.00');
    assert.equal(JSON.stringify(h.requests[0].contents).includes('private@example.test'), false);
    assert.equal(serializeMemory(memory), before);
});

test('orchestrator: real route metrics retain Gemini/grounding stages and explicit limit error codes', async () => {
    const { runMeasured } = require('../ai/metrics');
    let successEvent, failureEvent;
    const success = harness([[call('respond', answer())]]);
    await runMeasured(() => success.reply('Chào bạn'), { onComplete: event => { successEvent = event; } });
    assert.equal(successEvent.code, 'OK');
    assert.equal(successEvent.counts.gemini_ms, 1);
    assert.equal(successEvent.counts.grounding_ms, 1);
    const rejected = harness([() => response([call('respond', answer())], { totalTokenCount: 1e9 })]);
    await assert.rejects(() => runMeasured(() => rejected.reply('PRIVATE_USER_TEXT'), {
        onComplete: event => { failureEvent = event; }
    }), { code: 'TOKEN_LIMIT' });
    assert.equal(failureEvent.code, 'TOKEN_LIMIT');
    assert.equal(failureEvent.counts.gemini_ms, 1);
    assert.equal(JSON.stringify(failureEvent).includes('PRIVATE_USER_TEXT'), false);
});
