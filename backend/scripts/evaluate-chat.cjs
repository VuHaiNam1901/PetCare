// Opt-in live evaluation: at most THREE generation calls, no retries/fallback models.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID, createHash } = require('node:crypto');
const { createGeminiClient, MODEL } = require('../config/gemini');
const { createAssistant, redactPersonal } = require('../ai/assistant');
const { createChatRouter } = require('../routes/chat');
const { sessionStorageId } = require('../ai/sessions');
const pool = require('../config/db');

async function main() {
    if (!process.argv.includes('--live')) {
        console.log('Không gọi Gemini. Dùng --live khi chủ động muốn kiểm thử tối đa 3 request.');
        await pool.end();
        return;
    }
    const reportPath = path.join(__dirname, '..', 'ai', 'live-evaluation.json');
    let report;
    try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')); } catch { /* First opt-in evaluation. */ }
    report ||= { model: MODEL, created_at: new Date().toISOString(), real_gemini_calls: 0, results: [] };
    const requested = Number(process.argv.find(arg => arg.startsWith('--max-requests='))?.split('=')[1] || 3);
    if (!Number.isInteger(requested) || requested < 1 || requested > 3 || report.real_gemini_calls >= 3) {
        console.log('Không gọi Gemini: ngân sách kiểm thử tối đa 3 request đã hết hoặc tham số không hợp lệ.');
        await pool.end(); return;
    }
    const remaining = Math.min(requested, 3 - report.real_gemini_calls);
    const snapshots = async () => {
        const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
        return createHash('sha256').update(JSON.stringify([products, categories])).digest('hex');
    };
    const before = await snapshots();
    const storedSessions = new Set();
    let validationIssue;
    let modelOutput;
    const assistant = createAssistant({ onRejected: reason => { validationIssue = reason; }, generate: async request => {
        if (report.real_gemini_calls >= 3) throw new Error('Live evaluation request budget reached');
        report.real_gemini_calls++;
        const response = await createGeminiClient().models.generateContent(request);
        try {
            const plan = JSON.parse(response.text);
            const strings = [plan.advice, plan.follow_up, ...(Array.isArray(plan.warnings) ? plan.warnings : [])].filter(value => typeof value === 'string');
            if (!strings.some(value => /prompt|schema|instruction|catalog|GEMINI_API_KEY|JWT_SECRET|quy tắc hệ thống/i.test(value))) {
                modelOutput = { advice: typeof plan.advice === 'string' ? redactPersonal(plan.advice).slice(0, 1800) : null,
                    product_ids: Array.isArray(plan.product_ids) ? plan.product_ids.filter(Number.isInteger).slice(0, 3) : [],
                    follow_up: typeof plan.follow_up === 'string' ? redactPersonal(plan.follow_up).slice(0, 250) : null,
                    warnings: Array.isArray(plan.warnings) ? plan.warnings.filter(value => typeof value === 'string').slice(0, 2).map(value => redactPersonal(value).slice(0, 300)) : [] };
            }
        } catch { /* Never store arbitrary non-JSON model output. */ }
        return response;
    } });
    const app = express();
    app.use(express.json());
    app.use('/api/chat', createChatRouter({ assistant }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let sessionId;
    const questions = ['Shop có thức ăn cho mèo dưới 200k không?', 'Loại nào rẻ nhất?', 'Loại đó có phù hợp với mèo 6 tháng không?'];
    try {
        for (const question of questions.slice(0, remaining)) {
            validationIssue = undefined; modelOutput = undefined;
            const started = performance.now();
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: question, request_id: randomUUID(), ...(sessionId ? { session_id: sessionId } : {}) })
            });
            const data = await response.json();
            if (data.session_id) { sessionId = data.session_id; storedSessions.add(sessionStorageId(sessionId)); }
            const result = { question, http_status: response.status, code: data.code, intent: data.intent,
                duration_ms: Math.round(performance.now() - started), message: data.message,
                follow_up: data.follow_up, warnings: data.warnings,
                products: (data.products || []).map(p => ({ product_id: p.product_id, name: p.name, price: p.price, stock_quantity: p.stock_quantity, available: p.available })),
                ...(validationIssue ? { validation_issue: validationIssue } : {}), ...(modelOutput ? { model_output: modelOutput } : {}) };
            report.results.push(result);
            console.log(JSON.stringify(result));
            if (response.status !== 200 || data.code !== 'OK') break;
        }
    } finally {
        try {
            for (const id of storedSessions) await pool.execute('DELETE FROM chat_histories WHERE session_id=?', [id]);
            assert.equal(await snapshots(), before, 'Catalog must remain unchanged');
            report.catalog_unchanged = true;
            report.test_histories_cleaned = true;
            await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
            console.log(`Đã gọi Gemini ${report.real_gemini_calls} lần; dọn lịch sử thử và xác nhận catalog giữ nguyên.`);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await pool.end();
        }
    }
}
main().catch(() => { console.error('Kiểm thử dừng do lỗi; không in chi tiết thô để bảo vệ bí mật.'); process.exitCode = 1; });
