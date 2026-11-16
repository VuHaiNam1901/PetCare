'use strict';

function securityHeaders(env = process.env) {
    const isProduction = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
    return function applySecurityHeaders(req, res, next) {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('X-Frame-Options', 'DENY');
        res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        if (isProduction || req.secure) {
            res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
        next();
    };
}

module.exports = { securityHeaders };
