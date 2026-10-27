// A private loopback backend used by the restart test and opt-in evaluation.
// stdout is an allowlisted protocol: no session capability, body, or model draft.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID, createHash } = require('node:crypto');
const { REJECTION_CODES } = require('../ai/grounding');

const BACKEND = path.resolve(__dirname, '..');
const MAX_CALLS = 5;
const QUESTIONS = Object.freeze([
    'Shop có thức ăn cho mèo dưới 200k không?',
    'Trong những loại đó, loại nào rẻ nhất?',
    'Loại đó có phù hợp với mèo 6 tháng tuổi không?',
    'Chăm sóc vệ sinh bát ăn của mèo hằng ngày thế nào cho hợp lý?'
]);
const TIMINGS = Object.freeze(['mysql_products_ms', 'context_history_ms', 'mysql_history_load_ms', 'gemini_ms',
    'grounding_ms', 'mysql_history_save_ms', 'session_wait_ms', 'mysql_session_ms', 'mysql_ms', 'processing_ms', 'total_ms']);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'EVALUATION_ERROR';
const evaluationError = code => Object.assign(new Error(code), { code });
const rejectionLabels = new Set(REJECTION_CODES);
const rejectionIds = new Set(REJECTION_CODES.map(label => safeCode(label.toUpperCase().replace(/ /g, '_'))));

function guardRejectionCode(label) {
    return rejectionLabels.has(label) ? safeCode(label.toUpperCase().replace(/ /g, '_')) : 'INVALID_MODEL_RESPONSE';
}

function sanitizeGuardRejection(event) {
    return { name: 'guard_rejection', code: rejectionIds.has(event?.code) ? event.code : 'INVALID_MODEL_RESPONSE' };
}

function sanitizeMetrics(value) {
    const timings = {}, counts = {};
    for (const key of TIMINGS) if (Number.isFinite(value?.timings_ms?.[key]) && value.timings_ms[key] >= 0) timings[key] = Math.round(value.timings_ms[key] * 1000) / 1000;
    for (const [key, number] of Object.entries(value?.counts || {})) {
        if (/^[a-z][a-z0-9_]{0,59}$/.test(key) && Number.isFinite(number) && number >= 0) counts[key] = number;
    }
    return { name: 'chat_metrics', code: safeCode(value?.code), timings_ms: timings, counts };
}

function validateBudgetPath(file) {
    const absolute = path.resolve(file || '');
    const relative = path.relative(path.join(BACKEND, 'backups'), absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
        !/^chat-eval-v2-[a-z0-9-]+[\\/]budget\.json$/i.test(relative)) throw evaluationError('INVALID_BUDGET_PATH');
    return absolute;
}

async function readBudget(file) {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || Object.keys(value).length !== 1 || !Number.isInteger(value.count) || value.count < 0 || value.count > MAX_CALLS) throw evaluationError('INVALID_BUDGET');
    return value.count;
}

// The lock prevents concurrent workers from spending the same slot. There are
// no retries: an abandoned lock or malformed file fails closed on the next run.
async function consumeBudget(file) {
    file = validateBudgetPath(file);
    let lock;
    try { lock = await fs.open(`${file}.lock`, 'wx', 0o600); }
    catch { throw evaluationError('BUDGET_LOCKED'); }
    try {
        const count = await readBudget(file);
        if (count >= MAX_CALLS) throw evaluationError('EVALUATION_BUDGET_EXHAUSTED');
        const handle = await fs.open(file, 'r+');
        try {
            const serialized = JSON.stringify({ count: count + 1 }) + '\n';
            await handle.writeFile(serialized, 'utf8');
            await handle.truncate(Buffer.byteLength(serialized, 'utf8'));
            await handle.sync();
        } finally { await handle.close(); }
        return count + 1;
    } finally {
        await lock.close();
        await fs.unlink(`${file}.lock`);
    }
}

function makeMockGenerate(observe = () => {}) {
    return async request => {
        const context = JSON.parse(request.contents);
        const history = context.history || [];
        observe({
            mock_history_entries: history.length,
            mock_history_has_first_question: Number(history.some(item => item.role === 'user' && item.text === QUESTIONS[0])),
            mock_history_has_second_question: Number(history.some(item => item.role === 'user' && item.text === QUESTIONS[1])),
            mock_history_selected_id_3: Number(history.some(item => item.role === 'assistant' && item.product_ids?.includes(3)))
        });
        const age = context.user_request === QUESTIONS[2];
        const cheapest = context.search?.sort === 'price_asc';
        const care = context.mode === 'care';
        const products = context.catalog?.products || [];
        const plan = {
            advice: care ? 'Bạn có thể đổi thức ăn dần, chia nhỏ bữa ăn và quan sát thói quen ăn uống của bé. Luôn chuẩn bị nước sạch và giữ bát ăn sạch sẽ.'
                : age ? 'Mình chưa đủ dữ liệu để xác nhận lựa chọn này phù hợp với mèo ở độ tuổi bạn nêu. Bạn nên kiểm tra thông tin trên nhãn.'
                    : cheapest ? 'Đây là lựa chọn có giá thấp nhất trong bộ lọc trước đó.'
                        : 'Bạn có thể cân nhắc các lựa chọn thức ăn bên dưới và chọn dạng hạt hoặc pate theo thói quen của bé.',
            product_ids: care ? [] : products.slice(0, age || cheapest ? 1 : 3).map(product => product.product_id),
            follow_up: null,
            warnings: []
        };
        return { text: JSON.stringify(plan), candidates: [{ finishReason: 'STOP' }] };
    };
}

function quietEnvironment() {
    process.env.DOTENV_CONFIG_QUIET = 'true';
    require('dotenv').config({ path: path.join(BACKEND, '.env'), quiet: true });
}

async function runWorker(argv = process.argv.slice(2)) {
    const live = argv.includes('--live');
    const budgetArg = argv.find(arg => arg.startsWith('--budget-file='));
    if (argv.some(arg => !['--live', '--mock'].includes(arg) && !arg.startsWith('--budget-file=')) || (live && argv.includes('--mock'))) throw evaluationError('INVALID_WORKER_ARGUMENTS');
    const budgetFile = live ? validateBudgetPath(budgetArg?.slice('--budget-file='.length)) : null;
    if (live) await readBudget(budgetFile);
    // Dependencies occasionally print configuration notices. The private protocol
    // has one writer and never forwards those notices or arbitrary error text.
    for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};
    quietEnvironment();
    const express = require('express');
    const pool = require('../config/db');
    const { createChatRouter, createChatCapacity } = require('../routes/chat');
    const { createChatStore } = require('../ai/sessions');
    const { createAssistant } = require('../ai/assistant');
    const { createGeminiClient, MODEL, HTTP_OPTIONS } = require('../config/gemini');
    if (MODEL !== 'gemini-3.5-flash-lite' || HTTP_OPTIONS.retryOptions.attempts !== 1) throw evaluationError('INVALID_LIVE_CONFIGURATION');
    const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
    let mockCounts = {};
    let client;
    const generate = live ? async request => {
        if (request.model !== MODEL) throw evaluationError('INVALID_LIVE_MODEL');
        client ||= createGeminiClient();
        await consumeBudget(budgetFile); // fsync completes before the only SDK call.
        return client.models.generateContent(request);
    } : makeMockGenerate(counts => { mockCounts = counts; });
    const assistant = createAssistant({ generate,
        onRejected: label => emit({ name: 'guard_rejection', code: guardRejectionCode(label) }) });
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '16kb' }));
    app.use('/api/chat', createChatRouter({ assistant, store: createChatStore({ pool }), capacity: createChatCapacity(1),
        onMetrics: event => {
            const metrics = sanitizeMetrics(event);
            if (!live) metrics.counts = { ...metrics.counts, ...mockCounts };
            emit(metrics);
            mockCounts = {};
        } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    emit({ name: 'ready', port: server.address().port, mode: live ? 'live' : 'mock' });
    let closing;
    function close() {
        closing ||= (async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await pool.end();
        })();
        return closing;
    }
    process.on('SIGTERM', () => { close().then(() => process.exit(0), () => process.exit(1)); });
    process.on('SIGINT', () => { close().then(() => process.exit(0), () => process.exit(1)); });
    // Parent closure closes stdin; no exposed HTTP administration route is needed.
    process.stdin.resume();
    process.stdin.once('end', () => { close().then(() => process.exit(0), () => process.exit(1)); });
    process.stdin.on('data', data => {
        if (String(data).trim() === 'stop') close().then(() => process.exit(0), () => process.exit(1));
    });
}

async function startWorker({ mode = 'mock', budgetFile, readyTimeoutMs = 15_000 } = {}) {
    if (!['mock', 'live'].includes(mode)) throw evaluationError('INVALID_WORKER_MODE');
    const argv = [__filename, mode === 'live' ? '--live' : '--mock'];
    if (mode === 'live') argv.push(`--budget-file=${validateBudgetPath(budgetFile)}`);
    const child = spawn(process.execPath, argv, { cwd: BACKEND, env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const metrics = [];
    const rejections = [];
    let startupError;
    const exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => { startupError = safeCode(error.code); resolve({ code: null }); }); });
    const lines = createInterface({ input: child.stdout });
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // Never forward child diagnostics.
    const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(evaluationError('WORKER_START_TIMEOUT')), readyTimeoutMs);
        const fail = code => { clearTimeout(timeout); reject(evaluationError(code)); };
        child.once('error', error => fail(safeCode(error.code)));
        child.once('exit', () => fail('WORKER_EXITED'));
        lines.on('line', line => {
            let event;
            try { event = JSON.parse(line); } catch { return; }
            if (event.name === 'chat_metrics') metrics.push(sanitizeMetrics(event));
            if (event.name === 'guard_rejection') rejections.push(sanitizeGuardRejection(event));
            if (event.name === 'ready' && Number.isInteger(event.port) && event.port > 0 && event.port <= 65535 && event.mode === mode) {
                clearTimeout(timeout);
                resolve(event.port);
            }
        });
    });
    const worker = { child, exited, metrics, rejections, lines, mode, port: null, get startupError() { return startupError; } };
    try { worker.port = await ready; return worker; }
    catch (error) { await stopWorker(worker); throw error; }
}

async function stopWorker(worker) {
    if (!worker) return;
    if (worker.child.exitCode === null && !worker.startupError) {
        worker.child.stdin.end('stop\n');
        let timeout;
        await Promise.race([worker.exited, new Promise(resolve => { timeout = setTimeout(resolve, 5_000); })]);
        clearTimeout(timeout);
        if (worker.child.exitCode === null) {
            // Only this child's handle is killed; no port/PID scan or taskkill.
            worker.child.kill();
            await worker.exited;
        }
    }
    worker.lines.close();
}

async function postQuestion(worker, message, sessionId, { requestId = randomUUID() } = {}) {
    const started = performance.now();
    const index = worker.metrics.length;
    const rejectionIndex = worker.rejections.length;
    const response = await fetch(`http://127.0.0.1:${worker.port}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, request_id: requestId, ...(sessionId ? { session_id: sessionId } : {}) }),
        signal: AbortSignal.timeout(65_000)
    });
    const data = await response.json();
    // stdout and HTTP are separate pipes; allow a final metrics event to arrive.
    const deadline = Date.now() + 1000;
    while (worker.metrics.length <= index && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    return { status: response.status, data, requestId, duration_ms: Math.round(performance.now() - started), metrics: worker.metrics[index] || null,
        ...(worker.rejections[rejectionIndex] ? { rejection_code: worker.rejections[rejectionIndex].code } : {}) };
}

async function catalogSnapshot(pool) {
    const [products] = await pool.query('SELECT * FROM products ORDER BY product_id');
    const [categories] = await pool.query('SELECT * FROM categories ORDER BY category_id');
    return createHash('sha256').update(JSON.stringify([products, categories])).digest('hex');
}

module.exports = { BACKEND, MAX_CALLS, QUESTIONS, TIMINGS, safeCode, sanitizeMetrics, guardRejectionCode, sanitizeGuardRejection, validateBudgetPath, readBudget,
    consumeBudget, makeMockGenerate, quietEnvironment, runWorker, startWorker, stopWorker, postQuestion, catalogSnapshot };

if (require.main === module) runWorker().catch(error => {
    process.stdout.write(JSON.stringify({ name: 'worker_error', code: safeCode(error.code) }) + '\n');
    process.exitCode = 1;
});
