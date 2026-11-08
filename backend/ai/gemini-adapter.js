'use strict';

const { createGeminiClient } = require('../config/gemini');

const MESSAGES = Object.freeze({
    GEMINI_AUTH: 'Không thể xác thực dịch vụ tư vấn lúc này. Vui lòng thử lại sau.',
    GEMINI_BAD_REQUEST: 'Dịch vụ tư vấn chưa chấp nhận cấu hình yêu cầu. Vui lòng thử lại sau.',
    GEMINI_MODEL_UNAVAILABLE: 'Model tư vấn hiện chưa khả dụng. Vui lòng thử lại sau.',
    GEMINI_QUOTA: 'Dịch vụ tư vấn đang đạt giới hạn sử dụng. Vui lòng thử lại sau.',
    GEMINI_TIMEOUT: 'Lượt tư vấn đã hết thời gian chờ. Vui lòng thử lại.',
    GEMINI_UNAVAILABLE: 'Dịch vụ tư vấn đang tạm thời gián đoạn. Vui lòng thử lại.'
});

// Inspect errors only in memory. Never attach the SDK error, its cause, HTTP
// URL, headers, prompt or provider message to the public/diagnostic error.
function geminiError(error) {
    let details;
    try { details = JSON.parse(error?.message)?.error; } catch { /* Non-JSON SDK/transport error. */ }
    const status = Number(error?.status || error?.statusCode || error?.error?.code || details?.code || error?.response?.status);
    const apiStatus = details?.status || error?.error?.status;
    const reasons = (Array.isArray(details?.details) ? details.details : [])
        .map(item => item?.reason).filter(reason => typeof reason === 'string');
    const message = String(details?.message || error?.message || '');
    const networkCode = [error?.code, error?.cause?.code, error?.cause?.cause?.code];
    let code;
    if (Object.hasOwn(MESSAGES, error?.code)) code = error.code;
    else if (error?.code === 'GEMINI_CONFIG' || status === 401 || status === 403 ||
        ['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(apiStatus) ||
        reasons.some(reason => reason.startsWith('API_KEY')) || /api.?key.*(?:invalid|expired|not valid)/i.test(message)) code = 'GEMINI_AUTH';
    else if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') code = 'GEMINI_QUOTA';
    else if (status === 404 || apiStatus === 'NOT_FOUND') code = 'GEMINI_MODEL_UNAVAILABLE';
    else if (status === 504 || error?.name === 'AbortError' || /timeout|timed out|abort/i.test(message) ||
        networkCode.some(value => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(value))) code = 'GEMINI_TIMEOUT';
    else if (status === 400) code = 'GEMINI_BAD_REQUEST';
    else code = 'GEMINI_UNAVAILABLE';
    return Object.assign(new Error(MESSAGES[code]), { code, status: code === 'GEMINI_TIMEOUT' ? 504 : 503, chatSafe: true });
}

// Native function-calling contents pass through untouched. In particular, do
// not reconstruct model parts from response.text or lose call IDs/signatures.
// The orchestrator supplies one deadline via config.abortSignal and remaining
// config.httpOptions.timeout; cancelling the client does not undo API billing.
function createGeminiAdapter({ client, clientFactory = createGeminiClient } = {}) {
    let current = client;
    return async function generate(request) {
        try {
            if (request?.config?.abortSignal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
            current ||= clientFactory();
            return await current.models.generateContent(request);
        } catch (error) {
            throw geminiError(error);
        }
    };
}

module.exports = { createGeminiAdapter, geminiError };
