const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const orders = require('../models/admin-order');
const router = express.Router();
router.use(authenticate, authorize('admin'));
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const handle = action => async (req, res, next) => {
    try { await action(req, res); }
    catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        next(error);
    }
};
const integer = (value, fallback) => value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : NaN;
function validateId(req) {
    if (Object.keys(req.query).length || !Number.isInteger(integer(req.params.id))) bad('Invalid order ID or query parameters');
    return Number(req.params.id);
}
function body(req, allowed) {
    const input = req.body ?? {};
    if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) bad('Unsupported request fields');
    return input;
}

router.get('/', handle(async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit', 'status'].includes(key))) bad('Unsupported query parameters');
    const page = integer(req.query.page, 1);
    const limit = integer(req.query.limit, 20);
    if (!Number.isInteger(page) || !Number.isInteger(limit) || limit > 100) bad('Invalid pagination');
    const status = req.query.status;
    if (status !== undefined && !orders.states.includes(status)) bad('Invalid status filter');
    res.json({ success: true, page, limit, ...await orders.list(page, limit, status) });
}));
router.get('/:id', handle(async (req, res) => res.json({ success: true, order: await orders.get(validateId(req)) })));
router.patch('/:id/approve', handle(async (req, res) => {
    const id = validateId(req);
    body(req, []);
    res.json({ success: true, order: await orders.approve(req.user.user_id, id) });
}));
router.patch('/:id/status', handle(async (req, res) => {
    const id = validateId(req);
    const input = body(req, ['status', 'cod_payment_received']);
    if (!orders.states.includes(input.status) || (input.cod_payment_received !== undefined && typeof input.cod_payment_received !== 'boolean')) bad('Invalid status or COD receipt confirmation');
    res.json({ success: true, order: await orders.update(req.user.user_id, id, input.status, input.cod_payment_received) });
}));
module.exports = router;
