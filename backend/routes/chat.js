const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const { createSessionCodec, createChatStore, requestHash, chatError } = require('../ai/sessions');
const { createChatLimiter } = require('../ai/rate-limit');
const { runMeasured, setCode } = require('../ai/metrics');
const { readChatPipeline } = require('../config/chat-pipeline');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSIENT = new Set(['CATALOG_UNAVAILABLE', 'GEMINI_BAD_REQUEST', 'GEMINI_AUTH', 'GEMINI_MODEL_UNAVAILABLE', 'GEMINI_QUOTA', 'GEMINI_TIMEOUT', 'GEMINI_UNAVAILABLE']);
const PUBLIC_FIELDS = ['message', 'products', 'follow_up', 'warnings', 'code', 'model', 'intent', 'mode', 'care_advice'];

function createChatCapacity(maximum = 3) {
    // The default MySQL pool has ten connections. Keep at least one free for
    // product queries made while session connections hold their advisory locks.
    const limit = Number.isSafeInteger(Number(maximum)) && Number(maximum) >= 1 && Number(maximum) <= 9 ? Number(maximum) : 3;
    let active = 0;
    return {
        acquire() {
            if (active >= limit) return null;
            active++;
            let released = false;
            return () => { if (!released) { released = true; active--; } };
        }
    };
}

const sharedCapacity = createChatCapacity(process.env.CHAT_MAX_CONCURRENT);

function publicResponse(response) {
    return Object.fromEntries(PUBLIC_FIELDS.filter(key => Object.hasOwn(response, key)).map(key => [key, response[key]]));
}

function createChatRouter({ assistant, store, limiter = createChatLimiter(), sessionCodec, capacity = sharedCapacity, onMetrics,
    pipeline, assistantFactories } = {}) {
    // Snapshot configuration per router/process; clients cannot select a
    // pipeline, and an error never silently retries through another pipeline.
    const selectedPipeline = readChatPipeline(pipeline === undefined ? process.env : { CHAT_PIPELINE: pipeline });
    if (assistantFactories !== undefined && (!assistantFactories || typeof assistantFactories !== 'object' ||
        Object.keys(assistantFactories).some(key => !['legacy', 'orchestrator'].includes(key) || typeof assistantFactories[key] !== 'function'))) {
        throw new TypeError('Invalid chat assistant factories');
    }
    const router = express.Router();
    const allowedUser = authorize('user');
    // Defaults are initialized only when the route is used. Tests can inject the
    // model and store without a Gemini connection or a database connection.
    let chatAssistant = assistant;
    let chatStore = store;
    let codec = sessionCodec;
    const metricLifecycles = new WeakMap();
    function quota(res, result) {
        if (result.allowed) return false;
        setCode('RATE_LIMITED');
        res.set('Retry-After', String(result.retryAfterSeconds));
        res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Bạn đã gửi quá nhiều tin nhắn. Vui lòng thử lại sau.' });
        return true;
    }
    router.post('/', (req, res, next) => {
        // Establish one async scope before quotas/authentication and finish only
        // after the session store (including save/release) and response finish.
        runMeasured(() => new Promise(resolve => {
            let completed = false;
            const lifecycle = { started: false, done: false, responseDone: false, finish };
            metricLifecycles.set(req, lifecycle);
            function finish() {
                lifecycle.responseDone = lifecycle.responseDone || res.writableFinished || res.destroyed;
                if (completed || !lifecycle.responseDone || (lifecycle.started && !lifecycle.done)) return;
                completed = true;
                metricLifecycles.delete(req);
                res.off('finish', finish);
                res.off('close', finish);
                if (!res.writableFinished) setCode('REQUEST_ABORTED');
                else if (res.statusCode === 401) setCode('AUTH_UNAUTHORIZED', { onlyIfOk: true });
                else if (res.statusCode === 403) setCode('AUTH_FORBIDDEN', { onlyIfOk: true });
                else if (res.statusCode >= 400) setCode('CHAT_UNAVAILABLE', { onlyIfOk: true });
                resolve();
            }
            res.once('finish', finish);
            res.once('close', finish);
            next();
        }), { onComplete: onMetrics }).catch(next);
    }, (req, res, next) => {
        if (!quota(res, limiter.consumeIp(req.ip || req.socket.remoteAddress || 'unknown'))) next();
    }, (req, res, next) => {
        if (req.headers.authorization === undefined) return next();
        authenticate(req, res, error => error ? next(error) : allowedUser(req, res, next));
    }, async (req, res) => {
        const metricLifecycle = metricLifecycles.get(req);
        if (metricLifecycle) metricLifecycle.started = true;
        let sessionId;
        let requestId;
        let releaseCapacity;
        try {
            const body = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['message', 'session_id', 'request_id'].includes(key)) ||
                typeof body.message !== 'string' || !body.message.trim() || [...body.message].length > 2000 ||
                /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(body.message) ||
                typeof body.request_id !== 'string' || !UUID.test(body.request_id) ||
                (Object.hasOwn(body, 'session_id') && typeof body.session_id !== 'string')) {
                throw chatError(400, 'INVALID_REQUEST', 'Yêu cầu trò chuyện không hợp lệ. Vui lòng gửi tin nhắn từ 1–2000 ký tự.');
            }
            requestId = body.request_id.toLowerCase();
            const userId = req.user?.user_id ?? null;
            codec ||= createSessionCodec(require('../config/auth').secret);
            if (Object.hasOwn(body, 'session_id')) {
                if (!codec.verify(body.session_id, userId)) throw chatError(403, 'SESSION_FORBIDDEN', 'Phiên trò chuyện không thuộc tài khoản này hoặc không hợp lệ.');
                sessionId = body.session_id;
            } else sessionId = codec.issue(userId);
            if (quota(res, limiter.consumeSession(sessionId))) return;
            releaseCapacity = capacity.acquire();
            if (!releaseCapacity) {
                res.set('Retry-After', '2');
                throw chatError(503, 'CHAT_BUSY', 'Trợ lý đang bận. Bạn vui lòng thử lại sau ít giây.');
            }
            chatStore ||= createChatStore();
            const hash = requestHash(body.message);
            const result = await chatStore.withSession({ sessionId, userId }, async session => {
                const previous = await session.findRequest(requestId);
                if (previous) {
                    if (previous.request_hash !== hash) throw chatError(409, 'REQUEST_CONFLICT', 'Mã yêu cầu này đã được dùng cho một tin nhắn khác.');
                    return { response: previous.response, replayed: true };
                }
                let assistantInput;
                if (selectedPipeline === 'orchestrator') {
                    if (typeof session.loadMemory !== 'function') throw chatError(503, 'MEMORY_UNAVAILABLE', 'Chưa thể khôi phục ngữ cảnh cuộc trò chuyện. Bạn vui lòng thử lại.');
                    const memory = await session.loadMemory();
                    assistantInput = { message: body.message, turn_id: `u:${requestId}`,
                        ...(memory === null ? { history: await session.history() } : { memory }) };
                } else assistantInput = { message: body.message, history: await session.history() };
                // Replayed or invalid requests do not initialize either model.
                if (!chatAssistant) {
                    const factory = assistantFactories?.[selectedPipeline];
                    chatAssistant = factory ? factory() : selectedPipeline === 'orchestrator'
                        ? require('../ai/orchestrator').createOrchestrator()
                        : require('../ai/assistant').createAssistant();
                }
                if (!chatAssistant || typeof chatAssistant.reply !== 'function') throw chatError(503, 'ASSISTANT_UNAVAILABLE', 'Trợ lý đang tạm thời gián đoạn. Bạn vui lòng thử lại.');
                let response;
                try { response = await chatAssistant.reply(assistantInput); }
                catch (error) {
                    if (error.code === 'INVALID_SEARCH') throw chatError(400, 'INVALID_SEARCH', 'Yêu cầu trò chuyện không hợp lệ. Vui lòng kiểm tra nội dung tin nhắn.');
                    throw error;
                }
                if (!response || typeof response.message !== 'string' || !response.message.trim()) throw chatError(503, 'ASSISTANT_UNAVAILABLE', 'Trợ lý đang tạm thời gián đoạn. Bạn vui lòng thử lại.');
                if (TRANSIENT.has(response.code)) throw chatError(response.code === 'GEMINI_TIMEOUT' ? 504 : 503, response.code, 'Trợ lý đang tạm thời gián đoạn. Bạn vui lòng thử lại.');
                if (selectedPipeline === 'orchestrator' && (response.code !== 'OK' || !response.memory)) {
                    throw chatError(503, 'MEMORY_INVALID', 'Chưa thể xác minh ngữ cảnh cuộc trò chuyện. Bạn vui lòng thử lại.');
                }
                // Persist only the documented response fields and the grounded
                // search state used by future turns; never persist model prompts.
                const saved = publicResponse(response);
                if (response.context_search) saved.context_search = response.context_search;
                await session.savePair({ message: body.message, requestId, hash, response: saved,
                    pipeline: selectedPipeline, ...(selectedPipeline === 'orchestrator' ? { memory: response.memory } : {}) });
                return { response: saved, replayed: false };
            });
            setCode(result.response.code || 'OK');
            res.json({ success: true, session_id: sessionId, request_id: requestId, ...publicResponse(result.response), replayed: result.replayed });
        } catch (error) {
            const known = error.chatSafe === true && [400, 403, 409, 503, 504].includes(error.status);
            setCode(known ? error.code : 'CHAT_UNAVAILABLE');
            res.status(known ? error.status : 503).json({ success: false, code: known ? error.code : 'CHAT_UNAVAILABLE',
                message: known ? error.message : 'Chưa thể lưu cuộc trò chuyện. Bạn vui lòng thử lại.',
                ...(sessionId ? { session_id: sessionId } : {}), ...(requestId ? { request_id: requestId } : {}) });
        } finally {
            releaseCapacity?.();
            if (metricLifecycle) { metricLifecycle.done = true; metricLifecycle.finish(); }
        }
    });
    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        setCode('CHAT_UNAVAILABLE');
        res.status(503).json({ success: false, code: 'CHAT_UNAVAILABLE', message: 'Trợ lý đang tạm thời gián đoạn. Bạn vui lòng thử lại.' });
    });
    return router;
}

module.exports = { createChatRouter, createChatCapacity };
