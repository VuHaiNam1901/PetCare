const { MODEL, createGeminiClient } = require('../config/gemini');
const { createProductRepository } = require('./products');
const { buildContext } = require('./context');
const { validatePlan, redactPersonal, rejectionCode } = require('./grounding');
const { measure, measureSync, setCode } = require('./metrics');
const { SYSTEM_PROMPT, PLAN_SCHEMA, CARE_TOPICS, FOLLOW_UPS } = require('./prompt');
const CHAT_OUTPUT_TOKENS = 1024;
let geminiClient;
function generateWithGemini(request) {
    geminiClient ||= createGeminiClient();
    return geminiClient.models.generateContent(request);
}

function prepareInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['message', 'mode', 'filters', 'history'].includes(key))) throw Object.assign(new Error('Unsupported assistant input'), { code: 'INVALID_SEARCH' });
    if (typeof input.message !== 'string' || [...input.message].length > 2000 || !input.message.trim()) throw Object.assign(new Error('Invalid message'), { code: 'INVALID_SEARCH' });
    if (input.history !== undefined && (!Array.isArray(input.history) || input.history.length > 30)) throw Object.assign(new Error('Invalid history'), { code: 'INVALID_SEARCH' });
    const history = (input.history || []).slice(-8).map(item => {
        if (!item || !['user', 'assistant'].includes(item.role) || typeof item.text !== 'string') throw Object.assign(new Error('Invalid history'), { code: 'INVALID_SEARCH' });
        const search = item.search && typeof item.search === 'object' ? Object.fromEntries(Object.entries(item.search).map(([key, value]) => [key, typeof value === 'string' ? redactPersonal(value) : Array.isArray(value) ? value.map(part => typeof part === 'string' ? redactPersonal(part) : part) : value])) : null;
        return { role: item.role, text: redactPersonal(item.text).slice(0, 700), ...(Array.isArray(item.product_ids) ? { product_ids: item.product_ids.filter(Number.isInteger).slice(0, 3) } : {}), ...(search ? { search } : {}) };
    });
    return { ...input, message: redactPersonal(input.message), history };
}
function render(context, plan, code = 'OK') {
    setCode(code);
    return { mode: context.mode, intent: context.intent || (context.mode === 'care' ? 'care' : 'product_search'), message: plan.advice,
        products: plan.product_ids.map(id => {
            const p = context.products.find(row => row.product_id === id);
            return { product_id: p.product_id, category_id: p.category_id, category_name: p.category_name, name: p.name, price: p.price, stock_quantity: p.stock_quantity, image_url: p.image_url, status: p.status, available: p.status === 'Đang bán' && p.stock_quantity > 0, source: 'MySQL' };
        }), follow_up: plan.follow_up, warnings: plan.warnings, code, model: MODEL,
        care_advice: context.mode === 'care' ? [{ source: 'general_knowledge', text: plan.advice }] : [], context_search: context.search || {} };
}
function fallback(context, code) {
    let advice;
    let follow_up = context.mode === 'care' ? FOLLOW_UPS.care_topic : FOLLOW_UPS.product_preferences;
    let warnings = [];
    if (code === 'VETERINARY_REFERRAL') { advice = CARE_TOPICS.veterinary; follow_up = null; warnings = ['Ưu tiên liên hệ bác sĩ thú y kịp thời; không tự cho dùng thuốc.']; }
    else if (code === 'NO_PRODUCTS') advice = 'Mình chưa tìm được sản phẩm được xác nhận phù hợp với yêu cầu này. Bạn có thể đổi từ khóa hoặc khoảng ngân sách để mình tìm lại nhé.';
    else if (code === 'CATALOG_UNAVAILABLE') { advice = 'Mình tạm thời chưa đọc được dữ liệu sản phẩm. Bạn thử lại sau nhé; mình chưa thể xác nhận giá hay tồn kho lúc này.'; follow_up = null; }
    else if (code === 'GEMINI_QUOTA') { advice = 'Trợ lý đang đạt giới hạn lượt tư vấn. Bạn vui lòng thử lại sau nhé.'; follow_up = null; }
    else if (code === 'GEMINI_TIMEOUT') { advice = 'Lần tư vấn này mất nhiều thời gian hơn dự kiến. Bạn thử gửi lại sau nhé.'; follow_up = null; }
    else if (code.startsWith('GEMINI_')) { advice = 'Trợ lý đang tạm gián đoạn. Bạn thử lại sau nhé; mình chưa có phản hồi tư vấn đáng tin cậy cho lượt này.'; follow_up = null; }
    else advice = context.mode === 'care' ? 'Mình chưa thể đưa ra lời tư vấn đủ tin cậy cho thông tin này. Bạn mô tả rõ hơn về thú cưng hoặc tình huống nhé.' : 'Mình chưa thể xác nhận gợi ý vừa nhận được. Bạn cho biết rõ hơn nhu cầu để mình đối chiếu lại với dữ liệu cửa hàng nhé.';
    return render(context, { advice, product_ids: [], follow_up, warnings }, code);
}
function errorCode(error) {
    if (error?.code === 'GEMINI_CONFIG') return 'GEMINI_AUTH';
    let status = Number(error?.status);
    if (!status) { try { status = Number(JSON.parse(error?.message)?.error?.code); } catch { /* Never expose raw errors. */ } }
    if (status === 400) return 'GEMINI_BAD_REQUEST';
    if (status === 401 || status === 403) return 'GEMINI_AUTH';
    if (status === 404) return 'GEMINI_MODEL_UNAVAILABLE';
    if (status === 429) return 'GEMINI_QUOTA';
    if (status === 504 || error?.name === 'AbortError' || /timeout|timed out|abort/i.test(String(error?.message)) || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code)) return 'GEMINI_TIMEOUT';
    return 'GEMINI_UNAVAILABLE';
}
function createAssistant({ repository = createProductRepository(), generate = generateWithGemini, onRejected = () => {} } = {}) {
    return { async reply(input) {
        const prepared = measureSync('context_history_ms', () => prepareInput(input));
        const context = await buildContext({ ...prepared, repository });
        if (context.urgent) return fallback(context, 'VETERINARY_REFERRAL');
        if (context.mode === 'product' && context.catalogStatus !== 'ok') return fallback(context, context.catalogStatus === 'empty' ? 'NO_PRODUCTS' : 'CATALOG_UNAVAILABLE');
        const request = measureSync('context_history_ms', () => ({ model: MODEL, contents: JSON.stringify(context.payload), config: { maxOutputTokens: CHAT_OUTPUT_TOKENS, systemInstruction: SYSTEM_PROMPT, responseMimeType: 'application/json', responseJsonSchema: PLAN_SCHEMA } }));
        let response;
        try { response = await measure('gemini_ms', () => generate(request)); } catch (error) { return fallback(context, errorCode(error)); }
        try { return measureSync('grounding_ms', () => render(context, validatePlan(response, context))); }
        catch (error) {
            try { onRejected(rejectionCode(error)); } catch { /* Diagnostics cannot affect the response. */ }
            return fallback(context, 'GROUNDING_REJECTED');
        }
    } };
}
module.exports = { createAssistant, CHAT_OUTPUT_TOKENS, redactPersonal };
