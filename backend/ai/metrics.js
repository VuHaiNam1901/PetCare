const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

const storage = new AsyncLocalStorage();
const STAGES = Object.freeze([
    'mysql_products_ms', 'mysql_history_load_ms', 'mysql_history_save_ms', 'mysql_session_ms',
    'context_history_ms', 'gemini_ms', 'grounding_ms', 'session_wait_ms'
]);
const stageNames = new Set(STAGES);
const CODES = new Set([
    'OK', 'ERROR', 'INVALID_REQUEST', 'INVALID_SEARCH', 'SESSION_FORBIDDEN', 'SESSION_BUSY',
    'REQUEST_CONFLICT', 'RATE_LIMITED', 'CHAT_BUSY', 'CHAT_UNAVAILABLE', 'ASSISTANT_UNAVAILABLE',
    'RESPONSE_TOO_LARGE', 'AUTH_UNAUTHORIZED', 'AUTH_FORBIDDEN', 'REQUEST_ABORTED',
    'NO_PRODUCTS', 'CATALOG_UNAVAILABLE', 'VETERINARY_REFERRAL', 'GROUNDING_REJECTED',
    'GEMINI_BAD_REQUEST', 'GEMINI_AUTH', 'GEMINI_MODEL_UNAVAILABLE', 'GEMINI_QUOTA',
    'GEMINI_TIMEOUT', 'GEMINI_UNAVAILABLE',
    'MEMORY_UNAVAILABLE', 'MEMORY_INVALID', 'MEMORY_LIMIT', 'INVALID_MEMORY_UPDATE',
    'INVALID_ORCHESTRATOR_CONFIG', 'INVALID_MODEL_RESPONSE', 'ORCHESTRATOR_UNAVAILABLE',
    'CONTEXT_LIMIT', 'TOKEN_LIMIT', 'OUTPUT_LIMIT', 'MODEL_CALL_LIMIT', 'TOOL_LIMIT',
    'INVALID_TOOL', 'INVALID_TOOL_RESULT', 'TOOL_RESULT_LIMIT', 'UNSUPPORTED_ACTION', 'UNVERIFIED_STORE_FACT'
]);

function addDuration(name, milliseconds, count = 1) {
    const current = storage.getStore();
    if (!current || current.completed || !stageNames.has(name) || !Number.isFinite(milliseconds) || milliseconds < 0) return;
    current.timings[name] += milliseconds;
    if (Number.isSafeInteger(count) && count >= 0) current.counts[name] += count;
}

// These helpers preserve synchronous results and errors. Async work is timed
// until settlement, including failures, without recording values or errors.
function measure(name, fn) {
    if (!storage.getStore() || !stageNames.has(name)) return fn();
    const started = performance.now();
    let result;
    try { result = fn(); }
    catch (error) { addDuration(name, performance.now() - started); throw error; }
    if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => addDuration(name, performance.now() - started));
    }
    addDuration(name, performance.now() - started);
    return result;
}

function measureSync(name, fn) {
    if (!storage.getStore() || !stageNames.has(name)) return fn();
    const started = performance.now();
    try { return fn(); }
    finally { addDuration(name, performance.now() - started); }
}

function setCode(code, { onlyIfOk = false } = {}) {
    const current = storage.getStore();
    if (current && !current.completed && (!onlyIfOk || current.code === 'OK')) current.code = CODES.has(code) ? code : 'ERROR';
}

function diagnostic(callback, event) {
    if (typeof callback !== 'function') return;
    try {
        const result = callback(event);
        if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch { /* Diagnostics must never change the chat outcome. */ }
}

function complete(current, { onComplete, logger }) {
    const total = performance.now() - current.started;
    current.completed = true;
    const timings = { ...current.timings };
    // SQL driver calls are exclusive of JS processing. Connection/GET_LOCK
    // waits have their own bucket. Context and grounding are subcomponents of
    // processing_ms; do not add those subcomponents to the aggregate again.
    const mysql = timings.mysql_products_ms + timings.mysql_history_load_ms + timings.mysql_history_save_ms + timings.mysql_session_ms;
    timings.mysql_ms = mysql;
    timings.processing_ms = Math.max(0, total - mysql - timings.session_wait_ms - timings.gemini_ms);
    timings.total_ms = total;
    for (const key of Object.keys(timings)) timings[key] = Number(timings[key].toFixed(3));
    const event = Object.freeze({
        name: 'chat_metrics', code: current.code,
        timings_ms: Object.freeze(timings), counts: Object.freeze({ ...current.counts })
    });
    diagnostic(onComplete, event);
    if (process.env.CHAT_METRICS === '1') diagnostic(logger || (value => console.info(JSON.stringify(value))), event);
}

async function runMeasured(fn, { onComplete, logger } = {}) {
    const current = {
        started: performance.now(), completed: false, code: 'OK',
        timings: Object.fromEntries(STAGES.map(name => [name, 0])),
        counts: Object.fromEntries(STAGES.map(name => [name, 0]))
    };
    return storage.run(current, async () => {
        try { return await fn(); }
        catch (error) { setCode(error?.code); throw error; }
        finally { complete(current, { onComplete, logger }); }
    });
}

module.exports = { runMeasured, measure, measureSync, addDuration, setCode, STAGES };
