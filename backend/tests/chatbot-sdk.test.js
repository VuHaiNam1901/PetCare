const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GoogleGenAI } = require('@google/genai');
const { MODEL, TIMEOUT_MS, MAX_OUTPUT_TOKENS, HTTP_OPTIONS } = require('../config/gemini');
const { SYSTEM_PROMPT, PLAN_SCHEMA } = require('../ai/prompt');

test('Gemini SDK serializes shared config/System Prompt/JSON schema without network', async () => {
    assert.equal(MODEL, 'gemini-3.5-flash-lite');
    assert.equal(TIMEOUT_MS, 45000);
    assert.equal(MAX_OUTPUT_TOKENS, 512);
    assert.equal(HTTP_OPTIONS.retryOptions.attempts, 1);
    let calls = 0;
    let sent;
    const plan = { advice: 'Luôn chuẩn bị nước sạch và thay đổi thức ăn từ từ.', product_ids: [], follow_up: 'Mèo của bạn bao nhiêu tuổi?', warnings: [] };
    const client = new GoogleGenAI({ apiKey: 'offline-test-placeholder', vertexai: false,
        httpOptions: { ...HTTP_OPTIONS, fetch: async (input, init) => {
            calls++;
            assert.ok(String(input).includes(`/models/${MODEL}:generateContent`));
            sent = JSON.parse(init.body);
            return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(plan) }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } }
    });
    const result = await client.models.generateContent({ model: MODEL, contents: JSON.stringify({ mode: 'care', user_request: 'Dinh dưỡng cho mèo' }),
        config: { maxOutputTokens: MAX_OUTPUT_TOKENS, systemInstruction: SYSTEM_PROMPT, responseMimeType: 'application/json', responseJsonSchema: PLAN_SCHEMA } });
    assert.equal(calls, 1);
    assert.equal(sent.generationConfig.maxOutputTokens, 512);
    assert.equal(sent.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(sent.generationConfig.responseJsonSchema, PLAN_SCHEMA);
    assert.equal(sent.systemInstruction.parts[0].text, SYSTEM_PROMPT);
    assert.deepEqual(JSON.parse(result.text), plan);
});
