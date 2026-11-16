'use strict';

// Selected by the chat router only when CHAT_PIPELINE=orchestrator. Legacy
// remains the default; failure never implicitly switches implementations.
const { randomUUID } = require('node:crypto');
const { MODEL } = require('../config/gemini');
const { createGeminiAdapter, geminiError } = require('./gemini-adapter');
const { createProductRepository, normalizeText } = require('./products');
const { createProductTools } = require('./tools');
const { validatePlan, redactPersonal, rejectionCode } = require('./grounding');
const { measure, measureSync } = require('./metrics');
const memoryCore = require('./memory');
const { getWebsiteGuides } = require('./website-knowledge');
const { isResolvedPageContext } = require('./page-context');
const { SYSTEM_PROMPT, FUNCTION_DECLARATIONS, INTENTS } = require('./orchestrator-prompt');
const DEFAULT_LIMITS = Object.freeze({ modelCalls: 4, toolCalls: 6, timeoutMs: 45000,
    inputBytes: 48000, toolResultBytes: 16000, outputTokens: 2048, totalTokens: 48000 });
const PRODUCT_TOOLS = new Set(['list_categories', 'search_products', 'get_product_details', 'compare_products']);
const EPHEMERAL_FACT = /^(?:page|route|current_page|cart(?:_.*)?|quantity|selected_quantity|order(?:_.*)?|can_cancel|checkout(?:_.*)?|ui(?:_.*)?|loading|busy|phase|logged_in|authenticated|payment(?:_.*)?)$/;
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
function validateCapabilities(plan, websiteGuides) {
    for (const text of [plan.advice, plan.follow_up, ...plan.warnings].filter(Boolean)) {
        const folded = normalizeText(text);
        check(!/\b(?:da|dang|se)\s+(?:ket noi|chuyen (?:tiep|yeu cau|ban)|bao (?:quan ly|nhan vien)|lien he (?:quan ly|nhan vien)|goi (?:quan ly|nhan vien)|gui (?:yeu cau|tin nhan)|tao (?:ticket|don))\b/.test(folded) &&
            !/\b(?:quan ly|nhan vien)\s+se\s+(?:goi|lien he|phan hoi)\b/.test(folded), 'UNSUPPORTED_ACTION');
        if (!(plan.intent === 'website_help' && websiteGuides.length) && /\b(?:chinh sach|doi tra|bao hanh|phi van chuyen|gio mo cua|hotline|dia chi cua hang)\b/.test(folded)) {
            check(/\b(?:chua co (?:thong tin|du lieu)|khong co (?:thong tin|du lieu)|(?:chua|khong) the xac nhan)\b/.test(folded) && !/\d/.test(folded), 'UNVERIFIED_STORE_FACT');
        }
        if (!(plan.intent === 'website_help' && websiteGuides.length) && /\b(?:ben hon|ben nhat|do ben cao|danh gia \d|\d sao)\b/.test(folded)) {
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
            Object.keys(input).every(key => ['message', 'history', 'memory', 'turn_id', 'signal', 'page_context'].includes(key)), 'INVALID_SEARCH');
        check(input.page_context == null || isResolvedPageContext(input.page_context), 'INVALID_SEARCH');
        const pageContext = input.page_context ?? null;
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
            const websiteGuides = new Map();
            const comparedIds = new Set();
            let catalogObserved = false;
            const seenCalls = new Set();
            const contents = [];
            let preparing = memoryCore.needsCompaction(memory);
            let compaction;
            if (preparing) {
                try { compaction = memoryCore.compactionInput(memory); }
                catch { throw failure('MEMORY_LIMIT'); }
            }
            if (!preparing) {
                try { memory = memoryCore.appendMessage(memory, { turn_id: turnId, role: 'user', text: message }); }
                catch { throw failure('MEMORY_LIMIT'); }
            }
            function bootstrap() {
                const context = memoryCore.promptContext(memory);
                return { role: 'user', parts: [{ text: JSON.stringify({
                    user_request: message, current_turn_id: turnId, preparing,
                    ...(preparing ? { active_context: context.active_context, compaction,
                        recent_history: context.recent_history.filter(item => item.sequence > compaction.through_sequence) } : context), limits,
                    capabilities: { contact_human: false, execute_transactions: false, read_account_orders: false,
                        website_usage_guides: true, verified_store_policies: false, current_page_awareness: Boolean(pageContext) },
                    ...(pageContext ? { current_page: pageContext } : {}),
                    historical_product_facts_are_current: false,
                }) }] };
            }
            contents.push(bootstrap());

            for (let round = 0; round < limits.modelCalls; round++) {
                if (controller.signal.aborted) throw failure('GEMINI_TIMEOUT', 504);
                const lastRound = round === limits.modelCalls - 1;
                const allowedNames = preparing ? ['compact_memory'] : lastRound ? ['respond'] : FUNCTION_DECLARATIONS.filter(item => item.name !== 'compact_memory').map(item => item.name);
                const finalInstruction = lastRound && !preparing
                    ? websiteGuides.size ? '\nĐây là lượt kết thúc. Với website_help, hướng dẫn tối đa bốn bước ngắn từ guides đã đọc, giữ điều kiện và giới hạn. Không suy đoán trạng thái tài khoản/đơn, không tạo nút hoặc đường dẫn. Với sản phẩm, chỉ chọn tối đa ba thẻ đã xác minh, không viết tên/giá/tồn hoặc placeholder trong lời văn.'
                        : '\nĐây là lượt kết thúc: respond chỉ 1–2 câu ngắn, tối đa ba thẻ đã xác minh. Không liệt kê tên, biến thể, khối lượng, giá, ngân sách bằng số, số tồn hoặc mã placeholder. Không tham chiếu lựa chọn thứ tư trở đi. Chỉ kết luận hữu ích dựa trên công cụ và hỏi làm rõ nếu thiếu đối tượng; không bổ sung dữ kiện mới.' : '';
                const config = { systemInstruction: SYSTEM_PROMPT + finalInstruction, tools: [{ functionDeclarations: FUNCTION_DECLARATIONS.filter(item => allowedNames.includes(item.name)) }],
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
                let resetContext = false;
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
                        check(args.mode !== 'product' || catalogObserved, 'GROUNDING_REJECTED');
                        if (args.intent === 'compare' && Array.isArray(args.product_ids) && args.product_ids.length) {
                            check(args.product_ids.every(id => comparedIds.has(id)), 'GROUNDING_REJECTED');
                        }
                        validateCapabilities(args, [...websiteGuides.values()]);
                        const active = memoryCore.getActiveContext(memory);
                        const confirmedBudget = active.constraints.budget?.source.kind === 'user' ? active.constraints.budget.value : null;
                        const search = {};
                        if (confirmedBudget?.min !== null && confirmedBudget?.min !== undefined) search.minPrice = confirmedBudget.min;
                        if (confirmedBudget?.max !== null && confirmedBudget?.max !== undefined) search.maxPrice = confirmedBudget.max;
                        let plan;
                        try {
                            // List ordinals are formatting, not stock/price claims.
                            // Keep all numbers within sentences for the existing fact guard.
                            const advice = typeof args.advice === 'string'
                                ? args.advice.replace(/\\n/g, '\n').replace(/(^|\n)[ \t]*\d{1,2}[.)][ \t]+/g, '$1- ') : args.advice;
                            plan = measureSync('grounding_ms', () => validatePlan({ text: JSON.stringify({ advice, product_ids: args.product_ids, follow_up: args.follow_up, warnings: args.warnings }), candidates: [{ finishReason: 'STOP' }] },
                                { mode: args.mode, intent: args.intent, products: [...evidence.values()], search,
                                    website_guides: [...websiteGuides.values()], page_context: pageContext }));
                        }
                        catch (error) {
                            if (lastRound) throw failure('GROUNDING_REJECTED');
                            replies.push({ functionResponse: { ...(call.id === undefined ? {} : { id: call.id }), name: call.name,
                                response: { status: 'invalid_response', reason: rejectionCode(error),
                                    verified_product_ids: [...evidence.keys()],
                                    message: args.intent === 'website_help'
                                        ? 'Diễn đạt lại guides và current_page của lượt này. Chỉ chỉ dẫn bấm nút đang visible=true, enabled=true trên trang hiện tại; nếu đi tới trang khác phải nói rõ trang đích. Không dùng trạng thái/quyền hủy từ lịch sử hoặc frontend. Không bịa URL/số liệu/chính sách, không nói đã thao tác, không gợi ý VNPAY. Dùng mode=care, product_ids=[]. Nếu chưa có guides, gọi get_website_guide; nếu thiếu ngữ cảnh, hỏi làm rõ.'
                                        : 'Viết lại ngắn gọn bằng tiếng Việt. Không nhắc tên/nhãn hiệu, kể cả tên không tìm thấy; không viết số tiền, ngay cả giới hạn ngân sách, hoặc số tồn và khẳng định còn/hết hàng. Không dùng placeholder [product:...]. Các dữ kiện nằm trong thẻ; chỉ gọi ngân sách là "ngân sách bạn đã nêu". Chỉ dùng ID đã xác minh; so sánh theo thứ tự thẻ và kết quả compare_products. Nếu không có kết quả, chỉ nói chưa tìm được sản phẩm phù hợp yêu cầu.' } } });
                            continue;
                        }
                        const products = plan.product_ids.map(id => {
                            const row = evidence.get(id);
                            return { product_id: row.product_id, category_id: row.category_id, category_name: row.category_name,
                                name: row.name, price: row.price, stock_quantity: row.stock_quantity, image_url: row.image_url,
                                status: row.status, pet_types: row.pet_types,
                                available: row.status === 'Đang bán' && row.stock_quantity > 0, source: 'MySQL' };
                        });
                        try { memory = memoryCore.appendMessage(memory, { turn_id: `${turnId}:assistant`, role: 'assistant', text: plan.advice,
                            ...(plan.follow_up ? { follow_up: plan.follow_up } : {}),
                            ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
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
                        try {
                            const operations = typeof call.args.operations === 'string' ? JSON.parse(call.args.operations) : call.args.operations;
                            check(Array.isArray(operations) && operations.every(operation => !EPHEMERAL_FACT.test(operation?.key || '')), 'INVALID_MEMORY_UPDATE');
                            memory = memoryCore.applyMemoryPatch(memory, { base_revision: memory.revision, operations });
                        }
                        catch {
                            result = { status: 'invalid_arguments', revision: memory.revision, current_turn_id: turnId,
                                message: 'Memory chưa thay đổi. Chỉ lưu thông tin khách xác nhận, quote phải nguyên văn và turn_id đúng tin user. Bỏ qua cập nhật memory nếu chỉ cần lọc sản phẩm tức thời; tiếp tục dùng filters chính xác hoặc hỏi làm rõ.' };
                        }
                        result ||= { status: 'ok', active_context: memoryCore.getActiveContext(memory), revision: memory.revision };
                    } else if (call.name === 'get_website_guide') {
                        check(!preparing);
                        try { result = getWebsiteGuides(call.args); }
                        catch (error) {
                            if (error?.code !== 'INVALID_TOOL') throw failure('WEBSITE_KNOWLEDGE_UNAVAILABLE');
                            result = { status: 'invalid_arguments', message: 'Chọn 1–2 topics trong schema. Với chức năng chưa rõ chọn feature_limits; không tạo tên topic hoặc hướng dẫn mới.' };
                        }
                        check(Buffer.byteLength(JSON.stringify(result), 'utf8') <= limits.toolResultBytes, 'TOOL_RESULT_LIMIT');
                        for (const guide of result.guides || []) websiteGuides.set(guide.id, guide);
                    } else if (call.name === 'compact_memory') {
                        try {
                            check(preparing && calls.length === 1 && call.args?.through_sequence === compaction.through_sequence, 'INVALID_MEMORY_UPDATE');
                            memory = memoryCore.compactMemory(memory, call.args);
                            memory = memoryCore.appendMessage(memory, { turn_id: turnId, role: 'user', text: message });
                            preparing = false;
                            resetContext = true;
                        } catch { throw failure('INVALID_MEMORY_UPDATE'); }
                        result = { status: 'ok', summary: memory.summary, active_context: memoryCore.getActiveContext(memory), current_turn_id: turnId, preparing };
                    } else {
                        check(PRODUCT_TOOLS.has(call.name) && !preparing);
                        // Catalog state is mutable even inside one turn. A
                        // cached earlier read must not resurrect an ID revoked
                        // by a later lookup; repeated calls spend the tool budget.
                        try { result = await tools.execute(call.name, call.args, { memory, signal: controller.signal }); }
                        catch (error) {
                            if (error?.code !== 'INVALID_TOOL') throw failure('CATALOG_UNAVAILABLE');
                            // Give Gemini one bounded opportunity per remaining
                            // round to correct typed arguments, without exposing SQL/errors.
                            replies.push({ functionResponse: { ...(call.id === undefined ? {} : { id: call.id }), name: call.name,
                                response: { status: 'invalid_arguments', message: 'Tham số không hợp lệ. Dùng đúng schema, tiền VND dạng decimal và ID từ kết quả đã đọc; không nới điều kiện khách đã xác nhận.' } } });
                            continue;
                        }
                        check(result && ['ok', 'empty'].includes(result.status), 'INVALID_TOOL_RESULT');
                        if (call.name === 'search_products') {
                            try { memory = memoryCore.recordSearch(memory, { turn_id: turnId, filters: result.search }); }
                            catch { throw failure('MEMORY_LIMIT'); }
                        }
                        catalogObserved = true;
                        if (call.name === 'compare_products') {
                            comparedIds.clear();
                            for (const product of result.products || []) comparedIds.add(product.product_id);
                        }
                        check(Buffer.byteLength(JSON.stringify(result), 'utf8') <= limits.toolResultBytes, 'TOOL_RESULT_LIMIT');
                        // A later exact lookup can revoke an earlier search
                        // result (deleted/stopped product or changed inventory).
                        if (['get_product_details', 'compare_products'].includes(call.name)) {
                            for (const id of result.requested_product_ids || call.args.product_ids || []) evidence.delete(id);
                        }
                        for (const id of result.missing_product_ids || []) evidence.delete(id);
                        for (const product of result.products || []) evidence.set(product.product_id, product);
                    }
                    if (controller.signal.aborted) throw failure('GEMINI_TIMEOUT', 504);
                    replies.push({ functionResponse: { ...(call.id === undefined ? {} : { id: call.id }), name: call.name, response: result } });
                }
                if (resetContext) {
                    // Drop the entire completed compaction exchange, including
                    // its old history. Retaining it would defeat token savings.
                    contents.splice(0, contents.length, bootstrap());
                } else contents.push({ role: 'user', parts: replies });
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
