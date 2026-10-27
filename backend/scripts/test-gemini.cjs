const path = require('node:path');
const { performance } = require('node:perf_hooks');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');
const { MODEL, TIMEOUT_MS, MAX_OUTPUT_TOKENS } = require('../config/gemini');

const PROMPT = 'Xin chào! Hãy giới thiệu ngắn gọn về bản thân bằng tiếng Việt và cho biết bạn có thể tư vấn chăm sóc chó mèo như thế nào.';

// Resolve from this file, so running from the repository root also works.
// Use the value in backend/.env explicitly; never print the parsed configuration.
const environment = dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const apiKey = environment.parsed?.GEMINI_API_KEY?.trim();

function redact(value) {
    let result = String(value);
    if (apiKey) result = result.split(apiKey).join('[REDACTED]');
    return result
        .replace(/AIza[\w-]+/g, '[REDACTED]')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
        .replace(/([?&](?:key|api_key|token|access_token)=)[^\s&#"']+/gi, '$1[REDACTED]');
}

function diagnose(error) {
    // Inspect errors in memory only. Raw errors/stacks may contain URLs or headers.
    let details;
    try { details = JSON.parse(error.message)?.error; } catch { /* Non-JSON transport error. */ }
    const status = Number(error.status || details?.code) || null;
    const apiStatus = typeof details?.status === 'string' && /^[A-Z_]+$/.test(details.status) ? details.status : null;
    const reasons = (Array.isArray(details?.details) ? details.details : [])
        .map(item => item.reason).filter(reason => typeof reason === 'string' && /^[A-Z_]+$/.test(reason));
    const message = String(details?.message || error.message || '').toLowerCase();
    const causes = [error, error.cause, error.cause?.cause].filter(Boolean);
    const networkCode = causes.map(item => item.code).find(code => typeof code === 'string' && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(code));
    let cause;
    if (reasons.some(reason => reason.startsWith('API_KEY')) || /api.?key.*(?:invalid|expired|not valid)/i.test(message)) {
        cause = 'API Key không hợp lệ, hết hiệu lực hoặc bị hạn chế quyền sử dụng.';
    } else if (status === 429 || /quota|resource_exhausted/.test(message)) {
        cause = 'Hết hoặc chưa được cấp quota cho model/dự án; kiểm tra hạn mức và billing trong Google AI Studio.';
    } else if (status === 404) {
        cause = 'Model không tồn tại, chưa được cấp cho dự án hoặc không hỗ trợ generateContent trên phiên bản API này.';
    } else if (status === 401 || status === 403) {
        cause = 'Yêu cầu bị từ chối xác thực/quyền truy cập; có thể do hạn chế khóa, API chưa bật, tier hoặc billing của dự án.';
    } else if (status === 400 && /country|region|billing|free tier/.test(message)) {
        cause = 'Dự án/khu vực hoặc tier hiện tại không đủ điều kiện; kiểm tra cấu hình billing và khả năng truy cập model.';
    } else if (status === 400) {
        cause = 'Gemini từ chối tham số hoặc cấu hình yêu cầu; kiểm tra khả năng hỗ trợ model và API Key.';
    } else if (status >= 500) {
        cause = 'Dịch vụ Gemini đang lỗi hoặc quá tải; script không tự động thử lại.';
    } else if (networkCode || /fetch failed|network|socket|dns|timeout|timed out|abort/i.test(message) || error.name === 'AbortError') {
        cause = 'Lỗi kết nối hoặc hết thời gian chờ; kiểm tra DNS, Internet, proxy/firewall và quyền truy cập generativelanguage.googleapis.com.';
    } else {
        cause = 'Chưa xác định được nguyên nhân từ lỗi SDK; không in lỗi thô để tránh lộ bí mật.';
    }
    return { code: [status && `HTTP_${status}`, apiStatus, ...reasons, networkCode].filter(Boolean).join(' / ') || 'SDK_ERROR', cause };
}

async function main() {
    console.log(`Model: ${MODEL}`);
    if (environment.error || !apiKey) {
        console.error('Mã lỗi: CONFIG_GEMINI_API_KEY');
        console.error('Không đọc được backend/.env hoặc thiếu GEMINI_API_KEY. Chưa gửi yêu cầu API.');
        process.exitCode = 1;
        return;
    }

    const started = performance.now();
    try {
        const ai = new GoogleGenAI({
            apiKey,
            vertexai: false,
            httpOptions: { timeout: TIMEOUT_MS, retryOptions: { attempts: 1 } }
        });
        // Exactly one generation call: no model probing, fallback or retry loop.
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: PROMPT,
            config: { maxOutputTokens: MAX_OUTPUT_TOKENS }
        });
        const elapsed = ((performance.now() - started) / 1000).toFixed(3);
        const reply = response.text?.trim();
        if (!reply) {
            console.error('Mã lỗi: EMPTY_RESPONSE');
            const reason = response.promptFeedback?.blockReason || response.candidates?.[0]?.finishReason;
            console.error('Gemini phản hồi nhưng không có nội dung văn bản.');
            if (typeof reason === 'string' && /^[A-Z_]+$/.test(reason)) console.error(`Lý do: ${reason}`);
            console.log(`Thời gian xử lý: ${elapsed} giây`);
            process.exitCode = 1;
            return;
        }
        console.log('Kết quả: THÀNH CÔNG');
        console.log(`Thời gian xử lý: ${elapsed} giây`);
        console.log('Phản hồi Gemini:');
        console.log(redact(reply));
    } catch (error) {
        const diagnostic = diagnose(error);
        console.error('Kết quả: THẤT BẠI');
        console.error(`Mã lỗi: ${diagnostic.code}`);
        console.error(`Nguyên nhân: ${diagnostic.cause}`);
        console.log(`Thời gian xử lý: ${((performance.now() - started) / 1000).toFixed(3)} giây`);
        process.exitCode = 1;
    }
}

main().catch(() => {
    console.error('Mã lỗi: SCRIPT_ERROR. Không hiển thị lỗi thô để bảo vệ thông tin bí mật.');
    process.exitCode = 1;
});
