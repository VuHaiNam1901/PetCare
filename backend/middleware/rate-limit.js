'use strict';

function setting(value, fallback, max = 3600000) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number <= max ? number : fallback;
}

function createWindowLimiter({ windowMs, limit, maxKeys = 10000, clock = Date.now }) {
    const store = new Map();
    let nextSweep = 0;

    function prune(now) {
        for (const [key, entry] of store) {
            if (entry.resetAt <= now) store.delete(key);
        }
    }

    return function consume(rawKey) {
        const key = String(rawKey || 'unknown');
        const now = clock();
        if (now >= nextSweep) {
            prune(now);
            nextSweep = now + Math.min(windowMs, 1000);
        }
        let entry = store.get(key);
        if (entry && entry.resetAt <= now) {
            store.delete(key);
            entry = null;
        }
        if (!entry) {
            if (store.size >= maxKeys) prune(now);
            if (store.size >= maxKeys) {
                return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)) };
            }
            entry = { count: 0, resetAt: now + windowMs };
            store.set(key, entry);
        }
        if (entry.count >= limit) {
            return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
        }
        entry.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
    };
}

function clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rejectRateLimited(res, retryAfterSeconds, message) {
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        retry_after_ms: retryAfterSeconds * 1000,
        message,
    });
}

function createAuthLoginLimiter(options = {}) {
    const windowMs = setting(options.windowMs ?? process.env.AUTH_LOGIN_RATE_WINDOW_MS, 15 * 60 * 1000, 86400000);
    const ipLimit = setting(options.ipLimit ?? process.env.AUTH_LOGIN_IP_LIMIT, 30, 10000);
    const accountLimit = setting(options.accountLimit ?? process.env.AUTH_LOGIN_ACCOUNT_LIMIT, 10, 10000);
    const consumeIp = createWindowLimiter({ windowMs, limit: ipLimit, clock: options.clock });
    const consumeAccount = createWindowLimiter({ windowMs, limit: accountLimit, clock: options.clock });

    return function authLoginRateLimit(req, res, next) {
        const ip = clientIp(req);
        const ipResult = consumeIp(ip);
        if (!ipResult.allowed) {
            return rejectRateLimited(res, ipResult.retryAfterSeconds, 'Quá nhiều lần thử đăng nhập. Vui lòng thử lại sau.');
        }
        const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (rawEmail && rawEmail.length <= 150) {
            const accountResult = consumeAccount(`${ip}:${rawEmail}`);
            if (!accountResult.allowed) {
                return rejectRateLimited(res, accountResult.retryAfterSeconds, 'Quá nhiều lần thử đăng nhập. Vui lòng thử lại sau.');
            }
        }
        next();
    };
}

function createAuthRegisterLimiter(options = {}) {
    const windowMs = setting(options.windowMs ?? process.env.AUTH_REGISTER_RATE_WINDOW_MS, 15 * 60 * 1000, 86400000);
    const limit = setting(options.limit ?? process.env.AUTH_REGISTER_RATE_LIMIT, 15, 10000);
    const consumeIp = createWindowLimiter({ windowMs, limit, clock: options.clock });

    return function authRegisterRateLimit(req, res, next) {
        const result = consumeIp(clientIp(req));
        if (!result.allowed) {
            return rejectRateLimited(res, result.retryAfterSeconds, 'Quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau.');
        }
        next();
    };
}

function createVoucherQuoteLimiter(options = {}) {
    const windowMs = setting(options.windowMs ?? process.env.VOUCHER_QUOTE_RATE_WINDOW_MS, 60 * 1000, 3600000);
    const limit = setting(options.limit ?? process.env.VOUCHER_QUOTE_RATE_LIMIT, 30, 10000);
    const consume = createWindowLimiter({ windowMs, limit, clock: options.clock });

    return function voucherQuoteRateLimit(req, res, next) {
        const key = req.user?.user_id ? `user:${req.user.user_id}` : `ip:${clientIp(req)}`;
        const result = consume(key);
        if (!result.allowed) {
            return rejectRateLimited(res, result.retryAfterSeconds, 'Bạn đang kiểm tra mã giảm giá quá nhanh. Vui lòng thử lại sau ít giây.');
        }
        next();
    };
}

function createOrderCreateLimiter(options = {}) {
    const windowMs = setting(options.windowMs ?? process.env.ORDER_CREATE_RATE_WINDOW_MS, 60 * 1000, 3600000);
    const limit = setting(options.limit ?? process.env.ORDER_CREATE_RATE_LIMIT, 20, 10000);
    const consume = createWindowLimiter({ windowMs, limit, clock: options.clock });

    return function orderCreateRateLimit(req, res, next) {
        const key = req.user?.user_id ? `user:${req.user.user_id}` : `ip:${clientIp(req)}`;
        const result = consume(key);
        if (!result.allowed) {
            return rejectRateLimited(res, result.retryAfterSeconds, 'Bạn đang gửi yêu cầu đặt hàng quá nhanh. Vui lòng đợi ít giây rồi thử lại.');
        }
        next();
    };
}

module.exports = {
    createWindowLimiter,
    createAuthLoginLimiter,
    createAuthRegisterLimiter,
    createVoucherQuoteLimiter,
    createOrderCreateLimiter,
};
