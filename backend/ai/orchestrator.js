'use strict';

// Selected by the chat router only when CHAT_PIPELINE=orchestrator. Legacy
// remains the default; failure never implicitly switches implementations.
const { randomUUID } = require('node:crypto');
const { MODEL } = require('../config/gemini');
const { createGeminiAdapter, geminiError } = require('./gemini-adapter');
const { createProductRepository, normalizeText } = require('./products');
const { createProductTools } = require('./tools');
const { validatePlan, redactPersonal } = require('./grounding');
const { measure, measureSync } = require('./metrics');
const memoryCore = require('./memory');
const { SYSTEM_PROMPT, FUNCTION_DECLARATIONS, INTENTS } = require('./orchestrator-prompt');
const DEFAULT_LIMITS = Object.freeze({ modelCalls: 4, toolCalls: 6, timeoutMs: 45000,
    inputBytes: 48000, toolResultBytes: 16000, outputTokens: 2048, totalTokens: 48000 });
const PRODUCT_TOOLS = new Set(['list_categories', 'search_products', 'get_product_details', 'compare_products']);
const clone = value => JSON.parse(JSON.stringify(value));
function failure(code, status = 503) {
    return Object.assign(new Error(status === 504 ? 'Lượt tư vấn đã hết thời gian chờ. Bạn vui lòng thử lại.' :
        'Lượt tư vấn chưa thể hoàn tất đáng tin cậy. Bạn vui lòng thử lại.'), { code, status, chatSafe: true });
}
function check(condition, code = 'INVALID_MODEL_RESPONSE') { if (!condition) throw failure(code); }
function shape(value, keys) {
    check(value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function redacted(value, key = '') {
    if (typeof value === 'string') {
        // Canonical decimal bounds are typed data, not phone-number text. A
        // restored large budget must not be changed by prose PII redaction.
        if (['min', 'max', 'minPrice', 'maxPrice'].includes(key) && /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value)) return value;
        return /(?:^|_)ids?$/.test(key) || ['turn_id', 'pet_id'].includes(key) ? value : redactPersonal(value);
    }
    if (Array.isArray(value)) return value.map(part => redacted(part, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, part]) => [name, redacted(part, name)]));
    return value;
}

// This is an output/capability guard, not a language router. No executed tool
// can contact a human, change a transaction, or supply store-policy evidence.
function validateCapabilities(plan) {
    for (const text of [plan.advice, plan.follow_up, ...plan.warnings].filter(Boolean)) {
        const folded = normalizeText(text);
        check(!/\b(?:da|dang|se)\s+(?:ket noi|chuyen (?:tiep|yeu cau|ban)|bao (?:quan ly|nhan vien)|lien he (?:quan ly|nhan vien)|goi (?:quan ly|nhan vien)|gui (?:yeu cau|tin nhan)|tao (?:ticket|don))\b/.test(folded) &&
            !/\b(?:quan ly|nhan vien)\s+se\s+(?:goi|lien he|phan hoi)\b/.test(folded), 'UNSUPPORTED_ACTION');
        if (/\b(?:chinh sach|doi tra|bao hanh|phi van chuyen|gio mo cua|hotline|dia chi cua hang)\b/.test(folded)) {
            check(/\b(?:chua co (?:thong tin|du lieu)|khong co (?:thong tin|du lieu)|(?:chua|khong) the xac nhan)\b/.test(folded) && !/\d/.test(folded), 'UNVERIFIED_STORE_FACT');
        }
        if (/\b(?:ben hon|ben nhat|do ben cao|danh gia \d|\d sao)\b/.test(folded)) {
            check(/\b(?:chua co (?:thong tin|du lieu)|khong co (?:thong tin|du lieu)|(?:chua|khong) (?:the )?(?:xac nhan|ket luan))\b/.test(folded), 'UNVERIFIED_STORE_FACT');
        }
    }
}

function createOrchestrator({ generate = createGeminiAdapter(), repository = createProductRepository(),
    tools = createProductTools({ repository }), limits: overrides = {}, onUsage = () => {} } = {}) {
    check(Object.keys(overrides).every(key => Object.hasOwn(DEFAULT_LIMITS, key)), 'INVALID_ORCHESTRATOR_CONFIG');
    const limits = { ...DEFAULT_LIMITS, ...overrides };
    for (const [key, value] of Object.entries(limits)) check(Number.isSafeInteger(value) && value > 0 && value <= DEFAULT_LIMITS[key], 'INVALID_ORCHESTRATOR_CONFIG');
    check(typeof generate === 'function' && tools && typeof tools.execute === 'function', 'INVALID_ORCHESTRATOR_CONFIG');

    return { async reply(input) {
        check(input && typeof input === 'object' && !Array.isArray(input) &&
            Object.keys(input).every(key => ['message', 'history', 'memory', 'turn_id', 'signal'].includes(key)), 'INVALID_SEARCH');
        check(typeof input.message === 'string' && input.message.trim() && [...input.message].length <= 2000 &&
            !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.message), 'INVALID_SEARCH');
        check(input.signal === undefined || (input.signal && typeof input.signal.aborted === 'boolean' &&
            typeof input.signal.addEventListener === 'function' && typeof input.signal.removeEventListener === 'function'), 'INVALID_SEARCH');
        const turnId = input.turn_id ?? `u:${randomUUID()}`;
        check(typeof turnId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(turnId), 'INVALID_SEARCH');
        const message = redactPersonal(input.message);
        let memory;
        try { memory = memoryCore.deserializeMemory(redacted(input.memory ?? input.history ?? null)); }
        catch { throw failure('MEMORY_INVALID'); }
        const controller = new AbortController();
        const usage = { model_calls: 0, tool_calls: 0, prompt_tokens: 0, output_tokens: 0,
            thinking_tokens: 0, total_tokens: 0, reserved_tokens: 0, usage_reported: true };
        const started = Date.now();
        let rejectDeadline;
        const expired = new Promise((_, reject) => { rejectDeadline = reject; });
        const abort = () => { controller.abort(); rejectDeadline(failure('GEMINI_TIMEOUT', 504)); };
        const timer = setTimeout(abort, limits.timeoutMs);
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();

        async function work() {
            const evidence = new Map();
            const seenCalls = new Set();
            const contents = [];
            let preparing = memoryCore.needsCompaction(memory);
            if (!preparing) {
                try { memory = memoryCore.appendMessage(memory, { turn_id: turnId, role: 'user', text: message }); }
                catch { throw failure('MEMORY_LIMIT'); }
            }
            const initial = { user_request: message, current_turn_id: turnId, preparing,
                summary: memory.summary, active_context: memoryCore.getActiveContext(memory),
                recent_history: memory.recent_history, limits,
                capabilities: { contact_human: false, execute_transactions: false, verified_store_policies: false },
                historical_product_facts_are_current: false };
            contents.push({ role: 'user', parts: [{ text: JSON.stringify(initial) }] });

            for (let round = 0; round < limits.modelCalls; round++) {
                if (controller.signal.aborted) throw failure('GEMINI_TIMEOUT', 504);
                const lastRound = round === limits.modelCalls - 1;
                const allowedNames = preparing ? ['compact_memory'] : lastRound ? ['respond'] : FUNCTION_DECLARATIONS.map(item => item.name);
                const config = { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations: FUNCTION_DECLARATIONS.filter(item => allowedNames.includes(item.name)) }],
                    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: allowedNames } },
                    maxOutputTokens: Math.min(limits.outputTokens, limits.totalTokens - usage.total_tokens - usage.reserved_tokens),
                    abortSignal: controller.signal, httpOptions: { timeout: Math.max(1, limits.timeoutMs - (Date.now() - started)), retryOptions: { attempts: 1 } } };
                const wireBytes = Buffer.byteLength(JSON.stringify({ contents, config: { ...config, abortSignal: undefined } }), 'utf8');
                check(wireBytes <= limits.inputBytes, 'CONTEXT_LIMIT');
                // A conservative byte reservation also bounds calls whose mocks
                // or provider omit token usage. No request is an unlimited retry.
                check(config.maxOutputTokens > 0 && usage.total_tokens + usage.reserved_tokens + wireBytes + config.maxOutputTokens <= limits.totalTokens, 'TOKEN_LIMIT');
                const reservation = wireBytes + config.maxOutputTokens;
                const previousUsageReported = usage.usage_reported;
                usage.reserved_tokens += reservation;
                usage.usage_reported = false;
                usage.model_calls++;
                let response;
                try { response = await measure('gemini_ms', () => generate({ model: MODEL, contents: clone(contents), config })); }
                catch (error) { throw geminiError(error); }
                if (controller.signal.aborted) throw failure('GEMINI_TIMEOUT', 504);
                const metadata = response?.usageMetadata;
                const reported = metadata && ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
                    .every(key => metadata[key] === undefined || (Number.isSafeInteger(metadata[key]) && metadata[key] >= 0)) && Number.isSafeInteger(metadata.totalTokenCount);
                if (reported) {
                    usage.reserved_tokens -= reservation;
                    usage.usage_reported = previousUsageReported;
                    usage.prompt_tokens += metadata.promptTokenCount || 0;
                    usage.output_tokens += metadata.candidatesTokenCount || 0;
                    usage.thinking_tokens += metadata.thoughtsTokenCount || 0;
                    usage.total_tokens += Math.max(metadata.totalTokenCount,
                        (metadata.promptTokenCount || 0) + (metadata.candidatesTokenCount || 0) + (metadata.thoughtsTokenCount || 0));
                }
                check(usage.total_tokens + usage.reserved_tokens <= limits.totalTokens, 'TOKEN_LIMIT');
                const candidate = response?.candidates?.[0];
                check(!response?.promptFeedback?.blockReason && candidate?.finishReason === 'STOP' && candidate.content?.role === 'model' && Array.isArray(candidate.content.parts));
                check(Buffer.byteLength(JSON.stringify(candidate.content), 'utf8') <= limits.toolResultBytes, 'OUTPUT_LIMIT');
                const calls = candidate.content.parts.filter(part => part.functionCall).map(part => part.functionCall);
                check(calls.length > 0 && calls.length <= limits.toolCalls);
                const unnumbered = calls.filter(call => call.id === undefined).map(call => call.name);
                check(new Set(unnumbered).size === unnumbered.length);
                // Preserve complete SDK parts, signatures and call IDs. Never
                // reconstruct a tool turn from response.text/functionCalls alone.
                contents.push(clone(candidate.content));
                const replies = [];
                for (const call of calls) {
                    check(call.id === undefined || (typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 120 && !seenCalls.has(call.id)));
                    if (call.id !== undefined) seenCalls.add(call.id);
                    check(allowedNames.includes(call.name), lastRound && !preparing ? 'MODEL_CALL_LIMIT' : 'INVALID_MODEL_RESPONSE');
                    if (call.name === 'respond') {
                        check(calls.length === 1 && !preparing);
                        const args = call.args;
                        shape(args, ['mode', 'intent', 'advice', 'product_ids', 'follow_up', 'warnings']);
                        check(['care', 'product'].includes(args.mode) && INTENTS.includes(args.intent));
                        check(Array.isArray(args.warnings) && args.warnings.length <= 2);
                        validateCapabilities(args);
                        const active = memoryCore.getActiveContext(memory);
                        const confirmedBudget = active.constraints.budget?.source.kind === 'user' ? active.constraints.budget.value : null;
                        const search = {};
                        if (confirmedBudget?.min !== null && confirmedBudget?.min !== undefined) search.minPrice = confirmedBudget.min;
                        if (confirmedBudget?.max !== null && confirmedBudget?.max !== undefined) search.maxPrice = confirmedBudget.max;
                        let plan;
                        try { plan = measureSync('grounding_ms', () => validatePlan({ text: JSON.stringify({ advice: args.advice, product_ids: args.product_ids, follow_up: args.follow_up, warnings: args.warnings }), candidates: [{ finishReason: 'STOP' }] },
                            { mode: args.mode, intent: args.intent, products: [...evidence.values()], search })); }
                        catch { throw failure('GROUNDING_REJECTED'); }
                        const products = plan.product_ids.map(id => {
                            const row = evidence.get(id);
                            return { product_id: row.product_id, category_id: row.category_id, category_name: row.category_name,
                                name: row.name, price: row.price, stock_quantity: row.stock_quantity, image_url: row.image_url,
                                status: row.status, available: row.status === 'Đang bán' && row.stock_quantity > 0, source: 'MySQL' };
                        });
                        try { memory = memoryCore.appendMessage(memory, { turn_id: `${turnId}:assistant`, role: 'assistant', text: plan.advice,
                            ...(products.length ? { product_ids: plan.product_ids } : {}) }); }
                        catch { throw failure('MEMORY_LIMIT'); }
                        return { mode: args.mode, intent: args.intent, message: plan.advice, products,
                            follow_up: plan.follow_up, warnings: plan.warnings, code: 'OK', model: MODEL,
                            care_advice: args.intent === 'care' ? [{ source: 'general_knowledge', text: plan.advice }] : [],
                            memory, usage: { ...usage } };
                    }
                    check(usage.tool_calls < limits.toolCalls, 'TOOL_LIMIT');
                    usage.tool_calls++;
                    let result;
                    if (call.name === 'update_memory') {
                        check(!preparing);
                        shape(call.args, ['operations']);
                        try { memory = memoryCore.applyMemoryPatch(memory, { base_revision: memory.revision, operations: call.args.operations }); }
                        catch { throw failure('INVALID_MEMORY_UPDATE'); }
                        result = { status: 'ok', active_context: memoryCore.getActiveContext(memory), revision: memory.revision };
                    } else if (call.name === 'compact_memory') {
                        try {
                            const before = memory.recent_history.length;
                            memory = memoryCore.compactMemory(memory, call.args);
                            check(memory.recent_history.length < before, 'INVALID_MEMORY_UPDATE');
                            if (preparing) { memory = memoryCore.appendMessage(memory, { turn_id: turnId, role: 'user', text: message }); preparing = false; }
                        } catch { throw failure('INVALID_MEMORY_UPDATE'); }
                        result = { status: 'ok', summary: memory.summary, active_context: memoryCore.getActiveContext(memory), current_turn_id: turnId, preparing };
                    } else {
                        check(PRODUCT_TOOLS.has(call.name) && !preparing);
                        // Catalog state is mutable even inside one turn. A
                        // cached earlier read must not resurrect an ID revoked
                        // by a later lookup; repeated calls spend the tool budget.
                        try { result = await tools.execute(call.name, call.args, { memory, signal: controller.signal }); }
                        catch (error) { throw failure(error?.code === 'INVALID_TOOL' ? 'INVALID_TOOL' : 'CATALOG_UNAVAILABLE'); }
                        check(result && ['ok', 'empty'].includes(result.status), 'INVALID_TOOL_RESULT');
                        check(Buffer.byteLength(JSON.stringify(result), 'utf8') <= limits.toolResultBytes, 'TOOL_RESULT_LIMIT');
                        // A later exact lookup can revoke an earlier search
                        // result (deleted/stopped product or changed inventory).
                        if (['get_product_details', 'compare_products'].includes(call.name)) {
                            for (const id of call.args.product_ids) evidence.delete(id);
                        }
                        for (const id of result.missing_product_ids || []) evidence.delete(id);
                        for (const product of result.products || []) evidence.set(product.product_id, product);
                    }
                    if (controller.signal.aborted) throw failure('GEMINI_TIMEOUT', 504);
                    replies.push({ functionResponse: { ...(call.id === undefined ? {} : { id: call.id }), name: call.name, response: result } });
                }
                contents.push({ role: 'user', parts: replies });
            }
            throw failure('MODEL_CALL_LIMIT');
        }
        try { return await Promise.race([work(), expired]); }
        catch (error) { throw error?.chatSafe ? error : failure('ORCHESTRATOR_UNAVAILABLE'); }
        finally {
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', abort);
            try {
                const notified = onUsage(Object.freeze({ ...usage }));
                if (notified?.then) Promise.resolve(notified).catch(() => {});
            } catch { /* Diagnostics cannot affect results. */ }
        }
    } };
}

module.exports = { createOrchestrator, DEFAULT_LIMITS };
