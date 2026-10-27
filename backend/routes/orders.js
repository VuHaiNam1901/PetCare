const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const orders = require('../models/order');
const router = express.Router();
router.use(authenticate, authorize('user'));
router.use(require('./payments'));
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const handle = action => async (req, res, next) => {
    try { await action(req, res); }
    catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        next(error);
    }
};

router.post('/', handle(async (req, res) => {
    if (Object.keys(req.query).length) bad('Query parameters are not supported');
    const key = req.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) bad('Idempotency-Key must contain 16-128 letters, digits, underscores or hyphens');
    const body = req.body;
    const allowed = ['cart_item_ids', 'shipping_address', 'phone', 'payment_method', 'note'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(field => !allowed.includes(field))) bad('Unsupported order fields');
    if (!Array.isArray(body.cart_item_ids) || !body.cart_item_ids.length || body.cart_item_ids.length > 100 || !body.cart_item_ids.every(id) || new Set(body.cart_item_ids).size !== body.cart_item_ids.length) bad('Select 1-100 distinct cart item IDs');
    if (typeof body.shipping_address !== 'string' || body.shipping_address.trim().length < 5 || body.shipping_address.trim().length > 255) bad('Invalid shipping address');
    if (typeof body.phone !== 'string' || !/^\+?[0-9 ()-]{6,20}$/.test(body.phone.trim()) || body.phone.replace(/\D/g, '').length < 6) bad('Invalid phone');
    if (!['COD', 'ONLINE'].includes(body.payment_method)) bad('payment_method must be COD or ONLINE');
    if (body.note != null && (typeof body.note !== 'string' || body.note.trim().length > 200)) bad('Note must be a string of at most 200 characters');
    // Current schema uses utf8mb3; reject unsupported characters before MySQL writes.
    for (const text of [body.shipping_address, body.phone, body.note ?? '']) if (/[\uD800-\uDFFF\u0000-\u001F\u007F]/u.test(text) || [...text].some(char => char.codePointAt(0) > 65535)) bad('Unsupported characters in shipping information');
    const input = { cart_item_ids: [...body.cart_item_ids].sort((a, b) => a - b), shipping_address: body.shipping_address.trim(), phone: body.phone.trim(), payment_method: body.payment_method, note: body.note?.trim() || null };
    const result = await orders.create(req.user.user_id, input, key);
    res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
}));

router.get('/', handle(async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) bad('Unsupported query parameters');
    const number = (value, fallback) => value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    const page = number(req.query.page, 1);
    const limit = number(req.query.limit, 20);
    if (!id(page) || !id(limit) || limit > 100 || !Number.isSafeInteger((page - 1) * limit)) bad('Invalid pagination');
    res.json({ success: true, page, limit, ...await orders.list(req.user.user_id, limit, (page - 1) * limit) });
}));

router.get('/:id', handle(async (req, res) => {
    if (Object.keys(req.query).length || !/^[1-9]\d*$/.test(req.params.id) || !id(Number(req.params.id))) bad('Invalid order ID or query');
    res.json({ success: true, order: await orders.get(req.user.user_id, Number(req.params.id)) });
}));
module.exports = router;
