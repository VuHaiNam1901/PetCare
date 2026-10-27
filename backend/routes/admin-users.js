const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const users = require('../models/admin-user');
const router = express.Router();
router.use(authenticate, authorize('admin'));
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const integer = (value, fallback) => value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : NaN;
const handle = action => async (req, res, next) => {
    try { await action(req, res); }
    catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        next(error);
    }
};
function id(req) {
    const value = integer(req.params.id);
    if (!Number.isInteger(value) || Object.keys(req.query).length) bad('Invalid user ID or query parameters');
    return value;
}

router.get('/', handle(async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit', 'q', 'status'].includes(key))) bad('Unsupported query parameters');
    const page = integer(req.query.page, 1);
    const limit = integer(req.query.limit, 20);
    if (!Number.isInteger(page) || !Number.isInteger(limit) || limit > 100) bad('Invalid pagination');
    const { q, status } = req.query;
    if (q !== undefined && (typeof q !== 'string' || !q.trim() || q.trim().length > 150 || /[\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(q) || [...q].some(char => char.codePointAt(0) > 65535))) bad('Invalid search query');
    if (status !== undefined && !users.statuses.includes(status)) bad('Invalid account status');
    res.json({ success: true, page, limit, ...await users.list({ page, limit, q: q?.trim(), status }) });
}));
router.get('/:id', handle(async (req, res) => res.json({ success: true, user: await users.get(id(req)) })));
router.patch('/:id/status', handle(async (req, res) => {
    const userId = id(req);
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'status') || !users.statuses.includes(input.status)) bad('Only status active or inactive may be updated');
    res.json({ success: true, user: await users.setStatus(req.user.user_id, userId, input.status) });
}));
module.exports = router;
