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
    const identify = (req, res, next) => {
        if (req.headers.authorization === undefined) return next();
        authenticate(req, res, error => error ? next(error) : allowedUser(req, res, next));
    };
    const metricLifecycles = new WeakMap();
    function permission(sessionId, userId) {
        codec ||= createSessionCodec(require('../config/auth').secret);
        if (codec.verify(sessionId, userId)) return { requireOwned: false };
        // A claimed guest capability requires positive DB ownership AND JWT.
        // Never attach an unclaimed/empty guest session on an ordinary POST.
        if (userId != null && codec.verify(sessionId, null)) return { requireOwned: true };
        throw chatError(403, 'SESSION_FORBIDDEN', 'Phiên trò chuyện không thuộc tài khoản này hoặc không hợp lệ.');
    }
    function sessionFailure(error, res, next) {
        if (!error.chatSafe) return next(error);
        if (error.code === 'SESSION_BUSY') res.set('Retry-After', '2');
        res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    function quota(res, result) {
        if (result.allowed) return false;
        setCode('RATE_LIMITED');
        res.set('Retry-After', String(result.retryAfterSeconds));
        res.status(429).json({ success: false, code: 'RATE_LIMITED', retry_after_ms: result.retryAfterSeconds * 1000,
            message: 'Bạn đã gửi quá nhiều tin nhắn. Vui lòng thử lại sau.' });
        return true;
    }
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('Access-Control-Expose-Headers', 'Retry-After');
        next();
    });
    // Capability issuance itself is stateless: no model or chat-history write.
    // Authentication still uses the existing middleware. The client persists
    // the capability BEFORE sending the message.
    router.post('/session', (req, res, next) => {
        if (!quota(res, limiter.consumeIp(req.ip || req.socket.remoteAddress || 'unknown'))) next();
    }, identify, async (req, res, next) => {
        try {
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
                Object.keys(req.body).some(key => !['request_id', 'session_id', 'restore_history'].includes(key)) || typeof req.body.request_id !== 'string' || !UUID.test(req.body.request_id) ||
                (Object.hasOwn(req.body, 'session_id') && typeof req.body.session_id !== 'string') ||
                (Object.hasOwn(req.body, 'restore_history') && (typeof req.body.restore_history !== 'boolean' || !req.body.session_id))) {
                return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: 'Yêu cầu phiên trò chuyện không hợp lệ.' });
            }
            codec ||= createSessionCodec(require('../config/auth').secret);
            const userId = req.user?.user_id ?? null;
            let turns;
            if (req.body.session_id !== undefined) {
                const access = permission(req.body.session_id, userId);
                chatStore ||= createChatStore();
                turns = await chatStore.withSession({ sessionId: req.body.session_id, userId, ...access }, async session => {
                    if (!req.body.restore_history) return undefined;
                    if (typeof session.recentTurns !== 'function') throw chatError(503, 'MEMORY_UNAVAILABLE', 'Chưa thể khôi phục lịch sử. Vui lòng thử lại.');
                    return session.recentTurns();
                });
            }
            res.json({ success: true, request_id: req.body.request_id.toLowerCase(), session_id: req.body.session_id ?? codec.issue(userId),
                ...(turns === undefined ? {} : { turns }) });
        } catch (error) { sessionFailure(error, res, next); }
    });
    router.post('/session/claim', (req, res, next) => {
        if (!quota(res, limiter.consumeIp(req.ip || req.socket.remoteAddress || 'unknown'))) next();
    }, identify, allowedUser, async (req, res, next) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 ||
                typeof body.request_id !== 'string' || !UUID.test(body.request_id) || typeof body.session_id !== 'string') {
                throw chatError(400, 'INVALID_REQUEST', 'Yêu cầu chuyển phiên trò chuyện không hợp lệ.');
            }
            codec ||= createSessionCodec(require('../config/auth').secret);
            if (!codec.verify(body.session_id, null)) throw chatError(403, 'SESSION_FORBIDDEN', 'Không thể chuyển phiên trò chuyện này.');
            chatStore ||= createChatStore();
            const result = await chatStore.claimGuestSession({ sessionId: body.session_id, userId: req.user.user_id });
            res.json({ success: true, request_id: body.request_id.toLowerCase(),
                session_id: result.empty ? codec.issue(req.user.user_id) : body.session_id });
        } catch (error) { sessionFailure(error, res, next); }
    });
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
    }, identify, async (req, res) => {
        const metricLifecycle = metricLifecycles.get(req);
        if (metricLifecycle) metricLifecycle.started = true;
        let sessionId;
        let requestId;
        let releaseCapacity;
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableFinished) controller.abort(); };
        res.once('close', disconnected);
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
            let access = { requireOwned: false };
            if (Object.hasOwn(body, 'session_id')) {
                access = permission(body.session_id, userId);
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
            const result = await chatStore.withSession({ sessionId, userId, ...access }, async session => {
                if (controller.signal.aborted) throw chatError(503, 'REQUEST_ABORTED', 'Yêu cầu trò chuyện đã được hủy.');
                const previous = await session.findRequest(requestId);
                if (previous) {
                    if (previous.request_hash !== hash) throw chatError(409, 'REQUEST_CONFLICT', 'Mã yêu cầu này đã được dùng cho một tin nhắn khác.');
                    return { response: previous.response, replayed: true };
                }
                let assistantInput;
                if (selectedPipeline === 'orchestrator') {
                    if (typeof session.loadMemory !== 'function') throw chatError(503, 'MEMORY_UNAVAILABLE', 'Chưa thể khôi phục ngữ cảnh cuộc trò chuyện. Bạn vui lòng thử lại.');
                    const memory = await session.loadMemory();
                    assistantInput = { message: body.message, turn_id: `u:${requestId}`, signal: controller.signal,
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
                if (controller.signal.aborted) throw chatError(503, 'REQUEST_ABORTED', 'Yêu cầu trò chuyện đã được hủy.');
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
            if (res.destroyed) return;
            const known = error.chatSafe === true && [400, 403, 409, 503, 504].includes(error.status);
            setCode(known ? error.code : 'CHAT_UNAVAILABLE');
            const retrySeconds = error.code === 'GEMINI_QUOTA' ? 60 : ['CHAT_BUSY', 'SESSION_BUSY'].includes(error.code) ? 2 : 0;
            if (retrySeconds) res.set('Retry-After', String(retrySeconds));
            res.status(known ? error.status : 503).json({ success: false, code: known ? error.code : 'CHAT_UNAVAILABLE',
                message: known ? error.message : 'Chưa thể lưu cuộc trò chuyện. Bạn vui lòng thử lại.',
                ...(retrySeconds ? { retry_after_ms: retrySeconds * 1000 } : {}),
                ...(sessionId ? { session_id: sessionId } : {}), ...(requestId ? { request_id: requestId } : {}) });
        } finally {
            res.off('close', disconnected);
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
