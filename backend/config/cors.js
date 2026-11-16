'use strict';

const DEFAULT_DEV_ORIGINS = Object.freeze([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    'http://localhost:4174',
    'http://127.0.0.1:4174',
]);

function normalizeOrigin(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed || trimmed === '*') return null;
    try {
        const url = new URL(trimmed);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
        return url.origin;
    } catch {
        return null;
    }
}

function allowedOrigins(env = process.env) {
    const origins = new Set();
    const isProduction = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';

    if (!isProduction) {
        for (const origin of DEFAULT_DEV_ORIGINS) origins.add(origin);
    }

    const configured = [env.CORS_ORIGINS, env.FRONTEND_URL]
        .filter(Boolean)
        .flatMap(entry => String(entry).split(','));

    for (const item of configured) {
        const normalized = normalizeOrigin(item);
        if (normalized) origins.add(normalized);
    }

    return origins;
}

function createCorsOptions(env = process.env) {
    const allowlist = allowedOrigins(env);
    return {
        origin(requestOrigin, callback) {
            // Non-browser requests (same-origin, server-to-server, webhooks, curl) omit Origin.
            if (!requestOrigin) return callback(null, true);
            const normalized = normalizeOrigin(requestOrigin);
            if (normalized && allowlist.has(normalized)) {
                return callback(null, true);
            }
            return callback(null, false);
        },
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
        exposedHeaders: ['Retry-After'],
        maxAge: 600,
    };
}

module.exports = { normalizeOrigin, allowedOrigins, createCorsOptions };
