const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GoogleGenAI } = require('@google/genai');
const { MODEL, HTTP_OPTIONS } = require('../config/gemini');
const { createGeminiAdapter, geminiError } = require('../ai/gemini-adapter');
const { createOrchestrator } = require('../ai/orchestrator');
const { SYSTEM_PROMPT: ORCHESTRATOR_PROMPT, FUNCTION_DECLARATIONS } = require('../ai/orchestrator-prompt');

// SDK transport is replaced at fetch. These tests never create the production
// client, read credentials, open a socket or call the real Gemini service.
test('orchestrator SDK: native tools, IDs, signatures and function responses survive the real SDK', async () => {
    const requests = [];
    const modelContent = { role: 'model', parts: [{
        functionCall: { id: 'call-search-1', name: 'search_products', args: { filters: { query: 'hạt cho mèo' } } },
        thoughtSignature: 'b2ZmbGluZS1zaWduYXR1cmU='
    }] };
    const client = new GoogleGenAI({ apiKey: 'offline-placeholder-only', vertexai: false,
        httpOptions: { ...HTTP_OPTIONS, fetch: async (url, init) => {
            assert.ok(String(url).includes(`/models/${MODEL}:generateContent`));
            requests.push({ body: JSON.parse(init.body), signal: init.signal });
            const content = requests.length === 1 ? modelContent : { role: 'model', parts: [{ text: 'Bạn xem lựa chọn bên dưới nhé.' }] };
            return new Response(JSON.stringify({ candidates: [{ content, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20, totalTokenCount: 60 } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        } }
    });
    const generate = createGeminiAdapter({ client, clientFactory: () => assert.fail('injected transport must not create the production client') });
    const controller = new AbortController();
    const declaration = { name: 'search_products', description: 'Tìm sản phẩm từ dữ liệu đã xác minh.', parameters: {
        type: 'OBJECT', properties: { filters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } }, required: ['filters']
    } };
    const config = { tools: [{ functionDeclarations: [declaration] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search_products'] } },
        systemInstruction: 'Bạn là trợ lý PetCareShop.', maxOutputTokens: 256,
        abortSignal: controller.signal, httpOptions: { timeout: 1000, retryOptions: { attempts: 1 } } };
    const contents = [{ role: 'user', parts: [{ text: 'Tìm hạt cho mèo.' }] }];
    const first = await generate({ model: MODEL, contents, config });
    assert.deepEqual(first.functionCalls, [modelContent.parts[0].functionCall]);
    assert.deepEqual(first.candidates[0].content, modelContent);
    assert.equal(first.usageMetadata.totalTokenCount, 60);
    const call = first.functionCalls[0];
    contents.push(first.candidates[0].content);
    contents.push({ role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name,
        response: { products: [{ product_id: 71, price: '100000.00' }] } } }] });
    const final = await generate({ model: MODEL, contents, config });
    assert.equal(final.text, 'Bạn xem lựa chọn bên dưới nhé.');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].body.tools[0].functionDeclarations, [declaration]);
    assert.equal(requests[0].body.toolConfig.functionCallingConfig.mode, 'ANY');
    assert.deepEqual(requests[0].body.toolConfig.functionCallingConfig.allowedFunctionNames, ['search_products']);
    assert.equal(requests[0].body.generationConfig.maxOutputTokens, 256);
    assert.equal(requests[0].body.generationConfig.responseMimeType, undefined);
    assert.equal(requests[0].body.generationConfig.responseJsonSchema, undefined);
    assert.ok(requests.every(request => request.signal instanceof AbortSignal));
    assert.equal(requests[0].body.generationConfig.abortSignal, undefined);
    assert.equal(requests[0].body.httpOptions, undefined);
    assert.deepEqual(requests[1].body.contents[1], modelContent);
    assert.equal(requests[1].body.contents[2].parts[0].functionResponse.id, 'call-search-1');
    assert.equal(requests[1].body.contents[2].parts[0].functionResponse.name, 'search_products');
});

test('orchestrator SDK: actual handoff declarations and response use the real adapter without a catalog dependency', async () => {
    const requests = [];
    let catalogReads = 0;
    const args = { mode: 'care', intent: 'handoff_request',
        advice: 'Mình chưa có công cụ kết nối trực tiếp với quản lý. Bạn muốn trao đổi vấn đề gì?',
        product_ids: [], follow_up: null, warnings: [] };
    const client = new GoogleGenAI({ apiKey: 'offline-placeholder-only', vertexai: false,
        httpOptions: { ...HTTP_OPTIONS, fetch: async (url, init) => {
            assert.ok(String(url).includes(`/models/${MODEL}:generateContent`));
            requests.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{
                functionCall: { id: 'actual-respond', name: 'respond', args }, thoughtSignature: 'b2ZmbGluZQ=='
            }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 80, totalTokenCount: 180 } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        } }
    });
    const forbiddenRead = async () => { catalogReads++; assert.fail('handoff must not depend on MySQL'); };
    const orchestrator = createOrchestrator({ generate: createGeminiAdapter({ client }),
        repository: { listCategories: forbiddenRead, search: forbiddenRead, getByIds: forbiddenRead } });
    const result = await orchestrator.reply({ message: 'Cho gặp quản lý', turn_id: 'actual-sdk-manager' });
    assert.equal(catalogReads, 0);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tools[0].functionDeclarations, FUNCTION_DECLARATIONS);
    assert.ok(requests[0].tools[0].functionDeclarations.every(declaration =>
        declaration.parametersJsonSchema?.type === 'object' && declaration.parameters === undefined));
    assert.equal(requests[0].systemInstruction.parts[0].text, ORCHESTRATOR_PROMPT);
    assert.equal(requests[0].generationConfig.responseMimeType, undefined);
    assert.equal(requests[0].generationConfig.responseJsonSchema, undefined);
    assert.equal(result.message, args.advice);
    assert.equal(result.intent, 'handoff_request');
    assert.equal(result.mode, 'care');
    assert.equal(result.code, 'OK');
    assert.equal(result.model, MODEL);
    assert.deepEqual(result.products, []);
    assert.equal(result.follow_up, null);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.care_advice, []);
    assert.equal(result.usage.model_calls, 1);
    assert.equal(result.usage.tool_calls, 0);
    assert.equal(result.memory.recent_history.at(-1).text, args.advice);
});

test('orchestrator SDK: actual category tool loop echoes its native ID and signature through the SDK', async () => {
    const requests = [];
    let catalogReads = 0;
    const toolContent = { role: 'model', parts: [{
        functionCall: { id: 'actual-categories', name: 'list_categories', args: {} }, thoughtSignature: 'c2lnbmF0dXJl'
    }] };
    const finalArgs = { mode: 'product', intent: 'category_list',
        advice: 'Bạn muốn xem thêm nhóm sản phẩm nào?', product_ids: [], follow_up: null, warnings: [] };
    const client = new GoogleGenAI({ apiKey: 'offline-placeholder-only', vertexai: false,
        httpOptions: { ...HTTP_OPTIONS, fetch: async (_url, init) => {
            requests.push(JSON.parse(init.body));
            const content = requests.length === 1 ? toolContent : { role: 'model', parts: [{
                functionCall: { id: 'actual-category-respond', name: 'respond', args: finalArgs }
            }] };
            return new Response(JSON.stringify({ candidates: [{ content, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 30, totalTokenCount: 110 } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        } }
    });
    const orchestrator = createOrchestrator({ generate: createGeminiAdapter({ client }), repository: {
        async listCategories() { catalogReads++; return [{ category_id: 71, name: 'Đồ chơi' }]; },
        async search() { assert.fail('category request must not search inventory'); },
        async getByIds() { assert.fail('category request must not read product details'); }
    } });
    const result = await orchestrator.reply({ message: 'Có những nhóm hàng nào?', turn_id: 'actual-sdk-categories' });
    assert.equal(catalogReads, 1);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].contents[1], toolContent);
    const response = requests[1].contents[2].parts[0].functionResponse;
    assert.equal(response.id, 'actual-categories');
    assert.equal(response.name, 'list_categories');
    assert.equal(response.response.status, 'ok');
    assert.equal(response.response.categories[0].name, 'Đồ chơi');
    assert.equal(result.code, 'OK');
    assert.equal(result.message, finalArgs.advice);
    assert.equal(result.intent, 'category_list');
    assert.equal(result.usage.model_calls, 2);
    assert.equal(result.usage.tool_calls, 1);
});

test('orchestrator SDK: adapter initializes once and preserves request and response identity', async () => {
    let initialized = 0;
    const request = { model: MODEL, contents: [{ role: 'user', parts: [{ text: 'Chào bạn.' }] }] };
    const response = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'finish-1', name: 'respond', args: {} }, thoughtSignature: 'opaque' }] } }] };
    const generate = createGeminiAdapter({ clientFactory: () => {
        initialized++;
        return { models: { async generateContent(input) { assert.equal(input, request); return response; } } };
    } });
    assert.equal(initialized, 0);
    assert.equal(await generate(request), response);
    assert.equal(await generate(request), response);
    assert.equal(initialized, 1);
});

test('orchestrator SDK: an already aborted turn never creates a client or sends a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = createGeminiAdapter({ clientFactory: () => assert.fail('aborted turn must not initialize the client') });
    await assert.rejects(() => generate({ config: { abortSignal: controller.signal } }), { code: 'GEMINI_TIMEOUT', status: 504, chatSafe: true });
});

test('orchestrator SDK: provider and transport errors expose only fixed safe diagnostics', async t => {
    const privateValue = 'PRIVATE_API_KEY_PROMPT_AND_URL';
    for (const [error, code] of [
        [{ code: 'GEMINI_CONFIG', message: privateValue }, 'GEMINI_AUTH'],
        [{ status: 400, message: privateValue }, 'GEMINI_BAD_REQUEST'],
        [{ status: 401, message: privateValue }, 'GEMINI_AUTH'],
        [{ status: 403, message: privateValue }, 'GEMINI_AUTH'],
        [{ status: 404, message: privateValue }, 'GEMINI_MODEL_UNAVAILABLE'],
        [{ status: 429, message: privateValue }, 'GEMINI_QUOTA'],
        [{ status: 504, message: privateValue }, 'GEMINI_TIMEOUT'],
        [{ status: 503, message: privateValue }, 'GEMINI_UNAVAILABLE'],
        [{ name: 'AbortError', message: privateValue }, 'GEMINI_TIMEOUT'],
        [{ message: privateValue, cause: { code: 'ETIMEDOUT' } }, 'GEMINI_TIMEOUT'],
        [{ message: privateValue, cause: { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } } }, 'GEMINI_TIMEOUT'],
        [{ message: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: privateValue } }) }, 'GEMINI_QUOTA'],
        [{ message: JSON.stringify({ error: { code: 400, message: privateValue, details: [{ reason: 'API_KEY_INVALID' }] } }) }, 'GEMINI_AUTH'],
        [{ code: 'GEMINI_QUOTA', message: privateValue }, 'GEMINI_QUOTA'],
        [{ message: privateValue }, 'GEMINI_UNAVAILABLE'],
        [null, 'GEMINI_UNAVAILABLE']
    ]) await t.test(code + ':' + (error?.status || error?.code || error?.name || 'sdk'), async () => {
        const safe = geminiError(error);
        assert.ok(safe instanceof Error);
        assert.equal(safe.code, code);
        assert.equal(safe.status, code === 'GEMINI_TIMEOUT' ? 504 : 503);
        assert.equal(safe.chatSafe, true);
        assert.equal(safe.cause, undefined);
        assert.equal(safe.message.includes(privateValue), false);
        assert.equal(safe.stack.includes(privateValue), false);
        assert.equal(JSON.stringify(safe).includes(privateValue), false);
        const generate = createGeminiAdapter({ client: { models: { async generateContent() { throw error; } } } });
        await assert.rejects(() => generate({}), caught => caught.code === code && caught.message === safe.message && caught.cause === undefined);
    });
});
