const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BACKEND, MAX_CALLS, QUESTIONS, sanitizeMetrics, guardRejectionCode, sanitizeGuardRejection, consumeBudget, readBudget, makeMockGenerate,
    quietEnvironment, startWorker, stopWorker, postQuestion, catalogSnapshot } = require('../scripts/chat-eval-worker.cjs');

test('Restart worker diagnostics include only codes, numeric timings and counts', () => {
    const event = sanitizeMetrics({ code: 'OK', session_id: 'PRIVATE_TOKEN', message: 'PRIVATE_MESSAGE', prompt: 'PRIVATE_PROMPT',
        timings_ms: { gemini_ms: 4.12345, total_ms: 12, mysql_products_ms: -1, message: 'PRIVATE_MESSAGE' },
        counts: { history_entries: 4, private_token: 'PRIVATE_TOKEN', 'bad key': 8 } });
    assert.deepEqual(event, { name: 'chat_metrics', code: 'OK', timings_ms: { gemini_ms: 4.123, total_ms: 12 }, counts: { history_entries: 4 } });
    assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
});

test('Guard diagnostics and evaluation reports retain only fixed rejection identifiers', () => {
    const { evaluationResult } = require('../scripts/evaluate-chat-v2.cjs');
    assert.equal(guardRejectionCode('Generated commercial facts'), 'GENERATED_COMMERCIAL_FACTS');
    assert.equal(guardRejectionCode('PRIVATE_PROMPT_OR_TOKEN'), 'INVALID_MODEL_RESPONSE');
    const event = sanitizeGuardRejection({ code: 'UNVERIFIED_SUITABILITY_OR_MEDICAL_ADVICE', draft: 'PRIVATE_DRAFT' });
    assert.deepEqual(event, { name: 'guard_rejection', code: 'UNVERIFIED_SUITABILITY_OR_MEDICAL_ADVICE' });
    assert.equal(sanitizeGuardRejection({ code: 'PRIVATE_TOKEN' }).code, 'INVALID_MODEL_RESPONSE');
    const result = evaluationResult(3, { status: 200, data: { success: true, code: 'GROUNDING_REJECTED', session_id: 'PRIVATE_TOKEN' },
        duration_ms: 12, rejection_code: event.code });
    assert.equal(result.rejection_code, 'UNVERIFIED_SUITABILITY_OR_MEDICAL_ADVICE');
    assert.equal(result.accepted, false);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('Durable live-call counter caps five calls across reconstructed workers', async () => {
    const directory = path.join(BACKEND, 'backups', `chat-eval-v2-test-${randomUUID()}`);
    const file = path.join(directory, 'budget.json');
    await fs.mkdir(directory, { recursive: true });
    try {
        await fs.writeFile(file, JSON.stringify({ count: 0 }) + '\n', { flag: 'wx' });
        for (let count = 1; count <= MAX_CALLS; count++) {
            assert.equal(await consumeBudget(file), count);
            assert.equal(await readBudget(file), count);
        }
        await assert.rejects(consumeBudget(file), { code: 'EVALUATION_BUDGET_EXHAUSTED' });
        assert.equal(await readBudget(file), MAX_CALLS);
        await fs.writeFile(file, 'corrupt');
        await assert.rejects(consumeBudget(file));
        assert.equal(await fs.readFile(file, 'utf8'), 'corrupt');
    } finally {
        await fs.unlink(file).catch(() => {});
        await fs.unlink(`${file}.lock`).catch(() => {});
        await fs.rmdir(directory);
    }
});

test('Restart mock observes history without returning or logging prompt contents', async () => {
    let counts;
    const generate = makeMockGenerate(value => { counts = value; });
    const response = await generate({ contents: JSON.stringify({ mode: 'product', user_request: QUESTIONS[2],
        history: [{ role: 'user', text: QUESTIONS[0] }, { role: 'user', text: QUESTIONS[1] }, { role: 'assistant', text: 'PRIVATE_HISTORY', product_ids: [3] }],
        catalog: { products: [{ product_id: 3 }] } }) });
    assert.deepEqual(counts, { mock_history_entries: 3, mock_history_has_first_question: 1, mock_history_has_second_question: 1, mock_history_selected_id_3: 1 });
    const plan = JSON.parse(response.text);
    assert.deepEqual(plan.product_ids, [3]);
    assert.match(plan.advice, /chưa đủ dữ liệu/);
    assert.equal(response.text.includes('PRIVATE_HISTORY'), false);
});

test('Actual MySQL and child backend restart preserve a guest conversation and replay without generation', {
    skip: process.env.UC13_LIVE_DB_TEST !== '1', timeout: 90_000
}, async () => {
    quietEnvironment();
    const pool = require('../config/db');
    const { sessionStorageId } = require('../ai/sessions');
    let worker, sessionId;
    const owned = new Set();
    const before = await catalogSnapshot(pool);
    async function ask(turn, options) {
        const result = await postQuestion(worker, QUESTIONS[turn - 1], sessionId, options);
        if (result.data.session_id) {
            sessionId = result.data.session_id;
            owned.add(sessionStorageId(sessionId));
        }
        // Avoid including the public body or capability in assertion diagnostics.
        assert.equal(result.status, 200, 'HTTP request should succeed');
        assert.equal(result.data.code, 'OK');
        assert.ok(result.metrics, 'Route should emit private timing metrics');
        return result;
    }
    async function count() {
        const [[row]] = await pool.execute('SELECT COUNT(*) AS total FROM chat_histories WHERE session_id = ?', [sessionStorageId(sessionId)]);
        return Number(row.total);
    }
    try {
        worker = await startWorker();
        const first = await ask(1);
        assert.ok(first.data.products.length > 0 && first.data.products.length <= 3);
        assert.ok(first.data.products.every(product => product.category_id === 1 && Number(product.price) <= 200000));
        const second = await ask(2);
        assert.deepEqual(second.data.products.map(product => product.product_id), [3]);
        assert.equal(await count(), 4);
        const oldPid = worker.child.pid;
        await stopWorker(worker); worker = null;
        worker = await startWorker();
        assert.notEqual(worker.child.pid, oldPid, 'A new backend process must start');
        assert.equal(await count(), 4);
        const replay = await ask(2, { requestId: second.requestId });
        assert.equal(replay.data.replayed, true);
        assert.equal(replay.data.message, second.data.message);
        assert.deepEqual(replay.data.products, second.data.products);
        assert.equal(replay.metrics.counts.mock_history_entries, undefined, 'Replay must not run the mock generator');
        assert.equal(await count(), 4);
        const third = await ask(3);
        assert.deepEqual(third.data.products.map(product => product.product_id), [3]);
        assert.match(third.data.message, /chưa đủ dữ liệu/);
        assert.ok(third.metrics.counts.mock_history_entries >= 4);
        assert.equal(third.metrics.counts.mock_history_has_first_question, 1);
        assert.equal(third.metrics.counts.mock_history_has_second_question, 1);
        assert.equal(third.metrics.counts.mock_history_selected_id_3, 1);
        const fourth = await ask(4);
        assert.equal(fourth.data.mode, 'care');
        assert.deepEqual(fourth.data.products, []);
        assert.equal(await count(), 8);
    } finally {
        await stopWorker(worker);
        try {
            for (const id of owned) await pool.execute('DELETE FROM chat_histories WHERE session_id = ?', [id]);
            for (const id of owned) {
                const [[row]] = await pool.execute('SELECT COUNT(*) AS total FROM chat_histories WHERE session_id = ?', [id]);
                assert.equal(Number(row.total), 0);
            }
            assert.equal(await catalogSnapshot(pool), before, 'Catalog must remain unchanged');
        } finally { await pool.end(); }
    }
});
