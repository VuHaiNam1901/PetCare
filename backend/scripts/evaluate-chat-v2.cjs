// Explicit opt-in only. Four fresh turns, one process restart, and at most one
// manually requested fifth generation. Session capabilities stay in memory.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const { BACKEND, MAX_CALLS, QUESTIONS, safeCode, sanitizeGuardRejection, quietEnvironment, startWorker, stopWorker,
    postQuestion, catalogSnapshot, readBudget } = require('./chat-eval-worker.cjs');

const PUBLIC_FIELDS = ['message', 'products', 'follow_up', 'warnings', 'code', 'model', 'intent', 'mode', 'care_advice'];
const terminal = value => process.stdout.write(JSON.stringify(value) + '\n');
const fail = code => Object.assign(new Error(code), { code });

function publicResponse(data) {
    return Object.fromEntries(PUBLIC_FIELDS.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
}

function evaluationResult(turn, result, { retry = false } = {}) {
    const accepted = result.status === 200 && result.data.success === true && result.data.code === 'OK';
    return { turn, question: QUESTIONS[turn - 1], manual_retry: retry, http_status: result.status, accepted,
        code: safeCode(result.data.code), duration_ms: result.duration_ms,
        timings_ms: result.metrics?.timings_ms || {}, counts: result.metrics?.counts || {},
        ...(result.rejection_code ? { rejection_code: sanitizeGuardRejection({ code: result.rejection_code }).code } : {}),
        ...(accepted ? { response: publicResponse(result.data) } : {}) };
}

function manualCommand() {
    return new Promise(resolve => {
        const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
        let settled = false;
        const finish = value => { if (settled) return; settled = true; input.close(); resolve(value); };
        input.once('line', line => finish(line.trim()));
        input.once('close', () => finish('finish'));
    });
}

async function runEvaluation(argv = process.argv.slice(2)) {
    if (argv.some(arg => !['--live', '--manual-retry'].includes(arg))) throw fail('INVALID_EVALUATION_ARGUMENTS');
    if (!argv.includes('--live')) {
        terminal({ name: 'evaluation', code: 'LIVE_OPT_IN_REQUIRED', real_gemini_calls: 0 });
        return null;
    }
    // Quiet all dependency diagnostics. Only terminal() prints safe protocol data.
    for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};
    quietEnvironment();
    const pool = require('../config/db');
    const { sessionStorageId } = require('../ai/sessions');
    const { MODEL, HTTP_OPTIONS } = require('../config/gemini');
    const runId = randomUUID();
    const runDirectory = path.join(BACKEND, 'backups', `chat-eval-v2-${runId}`);
    const budgetFile = path.join(runDirectory, 'budget.json');
    const reportPath = path.join(BACKEND, 'ai', 'live-evaluation-v2.json');
    const report = { version: 2, run_id: runId, model: MODEL, created_at: new Date().toISOString(), max_gemini_calls: MAX_CALLS,
        real_gemini_calls: 0, automatic_retries: 0, results: [], restart: { performed: false, between_turns: [2, 3],
            child_process_changed: false, persisted_rows_before: 0, persisted_rows_after: 0, replay_ok: false, replay_spent_calls: null },
        test_histories_cleaned: false, catalog_unchanged: false };
    let worker, sessionId, before, failure;
    let quota = false;
    let second;
    const ownedSessions = new Set();
    async function persistReport() {
        report.real_gemini_calls = await readBudget(budgetFile);
        report.updated_at = new Date().toISOString();
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    }
    async function rows() {
        if (!sessionId) return 0;
        const [[value]] = await pool.execute('SELECT COUNT(*) AS total FROM chat_histories WHERE session_id = ?', [sessionStorageId(sessionId)]);
        return Number(value.total);
    }
    async function ask(turn, retry = false) {
        if (await readBudget(budgetFile) >= MAX_CALLS) throw fail('EVALUATION_BUDGET_EXHAUSTED');
        const result = await postQuestion(worker, QUESTIONS[turn - 1], sessionId);
        if (result.data.session_id) {
            if (sessionId && result.data.session_id !== sessionId) throw fail('SESSION_CHANGED');
            sessionId = result.data.session_id;
            ownedSessions.add(sessionStorageId(sessionId));
        }
        const item = evaluationResult(turn, result, { retry });
        report.results.push(item);
        quota = item.code === 'GEMINI_QUOTA';
        terminal({ name: 'evaluation_turn', turn, manual_retry: retry, code: item.code, duration_ms: item.duration_ms, timings_ms: item.timings_ms,
            ...(item.rejection_code ? { rejection_code: item.rejection_code } : {}) });
        await persistReport();
        return result;
    }
    async function restartAndReplay() {
        report.restart.persisted_rows_before = await rows();
        const oldPid = worker.child.pid;
        await stopWorker(worker); worker = null;
        worker = await startWorker({ mode: 'live', budgetFile });
        report.restart.performed = true;
        report.restart.child_process_changed = worker.child.pid !== oldPid;
        report.restart.persisted_rows_after = await rows();
        const calls = await readBudget(budgetFile);
        const replay = await postQuestion(worker, QUESTIONS[1], sessionId, { requestId: second.requestId });
        report.restart.replay_spent_calls = (await readBudget(budgetFile)) - calls;
        report.restart.replay_duration_ms = replay.duration_ms;
        report.restart.replay_timings_ms = replay.metrics?.timings_ms || {};
        report.restart.replay_ok = replay.status === 200 && replay.data.replayed === true &&
            JSON.stringify(publicResponse(replay.data)) === JSON.stringify(publicResponse(second.data));
        if (!report.restart.child_process_changed || report.restart.persisted_rows_before !== 4 ||
            report.restart.persisted_rows_after !== 4 || !report.restart.replay_ok || report.restart.replay_spent_calls !== 0) throw fail('RESTART_PROOF_FAILED');
        terminal({ name: 'evaluation_restart', code: 'RESTART_REPLAY_OK', duration_ms: replay.duration_ms, timings_ms: report.restart.replay_timings_ms });
    }
    try {
        if (MODEL !== 'gemini-3.5-flash-lite' || HTTP_OPTIONS.retryOptions.attempts !== 1) throw fail('INVALID_LIVE_CONFIGURATION');
        await fs.mkdir(runDirectory, { recursive: true });
        await fs.writeFile(budgetFile, JSON.stringify({ count: 0 }) + '\n', { flag: 'wx', mode: 0o600 });
        before = await catalogSnapshot(pool);
        report.catalog_hash_before = before;
        await persistReport();
        worker = await startWorker({ mode: 'live', budgetFile });
        for (let turn = 1; turn <= 4; turn++) {
            if (turn === 3) await restartAndReplay();
            const result = await ask(turn);
            if (turn === 2) second = result;
            // A rejected model draft has already become a safe, persisted public
            // fallback. Keep the fixed care turn so it can be assessed separately.
            if (quota || result.status !== 200 || !['OK', 'GROUNDING_REJECTED'].includes(result.data.code)) break;
        }
        if (!quota && report.results.length === 4 && argv.includes('--manual-retry') && await readBudget(budgetFile) < MAX_CALLS) {
            terminal({ name: 'evaluation_manual', code: 'MANUAL_RETRY_AVAILABLE' });
            const command = await manualCommand();
            const match = /^(?:retry\s+|--retry-turn=)([1-4])$/.exec(command);
            if (command !== 'finish' && !match) throw fail('INVALID_MANUAL_RETRY');
            if (match) {
                await stopWorker(worker); worker = null;
                worker = await startWorker({ mode: 'live', budgetFile });
                await ask(Number(match[1]), true);
            }
        }
        const latest = new Map(report.results.map(item => [item.turn, item]));
        report.stop_code = quota ? 'GEMINI_QUOTA' : latest.size === 4 && [...latest.values()].every(item => item.accepted) ? 'COMPLETE' : 'TURN_NOT_ACCEPTED';
    } catch (error) {
        failure = error;
        report.stop_code = safeCode(error.code);
        terminal({ name: 'evaluation_error', code: report.stop_code });
    } finally {
        await stopWorker(worker);
        try {
            for (const id of ownedSessions) await pool.execute('DELETE FROM chat_histories WHERE session_id = ?', [id]);
            report.test_histories_cleaned = true;
            report.catalog_hash_after = await catalogSnapshot(pool);
            report.catalog_unchanged = before !== undefined && report.catalog_hash_after === before;
            if (before !== undefined && !report.catalog_unchanged) { report.stop_code = 'CATALOG_CHANGED'; failure ||= fail('CATALOG_CHANGED'); }
        } catch (error) {
            report.cleanup_error_code = safeCode(error.code);
            failure ||= fail('EVALUATION_CLEANUP_FAILED');
        } finally {
            try { await persistReport(); }
            catch { failure ||= fail('EVALUATION_REPORT_FAILED'); }
            await pool.end();
        }
    }
    terminal({ name: 'evaluation_finished', code: report.stop_code, real_gemini_calls: report.real_gemini_calls });
    if (failure) throw fail(safeCode(failure.code));
    return report;
}

module.exports = { runEvaluation, evaluationResult, publicResponse, manualCommand };
if (require.main === module) runEvaluation().catch(error => {
    terminal({ name: 'evaluation_error', code: safeCode(error.code) });
    process.exitCode = 1;
});
