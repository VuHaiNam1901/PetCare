const express = require('express');
const config = require('../config/sepay');
const { signatureHeaders } = require('../sepay-test/protocol.cjs');

// Mount before express.json(): HMAC must cover the original signed bytes.
function createSePayWebhookRouter({ pool, env = process.env, logger = console, now = Date.now } = {}) {
    const router = express.Router({ caseSensitive: true, strict: true });
    const endpoints = ['/webhooks/sepay', '/webhooks/sepay/test'];
    router.all(endpoints, (req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ success: false });
        if (req.originalUrl.includes('?')) return res.status(400).json({ success: false });
        try {
            const settings = config.settings(env);
            const mode = req.path === '/webhooks/sepay/test' ? 'test' : 'live';
            if (settings.mode !== mode) return res.status(503).json({ success: false });
            config.writesEnabled(env); // Refuse mismatched bindings before reading a body.
        } catch { return res.status(503).json({ success: false }); }
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.get('content-type') || '')) {
            return res.status(415).json({ success: false });
        }
        if (!signatureHeaders(req.headers, now())) return res.status(401).json({ success: false });
        next();
    }, express.raw({ type: 'application/json', limit: 16 * 1024, inflate: false }), async (req, res) => {
        try {
            const service = require('../services/sepay-test').createSePayService({ pool, env });
            // The shared provider verifies HMAC before parsing or reading the DB.
            // ACK is sent only after reconciliation/transaction commit succeeds.
            const result = await service.reconcile(req.body, req.headers, now());
            try { logger.info('[SEPAY WEBHOOK]', { disposition: result.disposition, duplicate: result.duplicate }); }
            catch { /* Logging must not change a committed payment's ACK. */ }
            res.status(201).json({ success: true });
        } catch (error) {
            const status = [400, 401].includes(error.status) ? error.status : 503;
            res.status(status).json({ success: false });
        }
    });
    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status = error.type === 'entity.too.large' ? 413 : error.status === 415 ? 415 : 400;
        res.status(status).json({ success: false });
    });
    return router;
}
module.exports = { createSePayWebhookRouter };
