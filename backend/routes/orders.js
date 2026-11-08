const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const orders = require('../models/order');
const orderStatuses = require('../models/admin-order').states;
const router = express.Router();
router.use(authenticate, authorize('user'));
router.use(require('./payments'));
const id = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const bad = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_ORDER' }); };
function shippingText(value, minimum, maximum, multiline = false) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (text.length < minimum || text.length > maximum) return false;
    // Multiline delivery instructions are supported. Reject malformed Unicode and
    // control characters, while allowing every valid Unicode scalar value.
    if ((multiline ? /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(value)) return false;
    return !/[\uD800-\uDFFF]/u.test(value);
}
const handle = action => async (req, res, next) => {
    try { await action(req, res); }
    catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.retryable ? { retryable: true } : {}) });
        console.error('[ORDERS API ERROR]', error);
        next(error);
    }
};

router.post('/', handle(async (req, res) => {
    if (Object.keys(req.query).length) bad('Query parameters are not supported');
    const key = req.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) bad('Idempotency-Key must contain 16-128 letters, digits, underscores or hyphens');
    const body = req.body;
    const allowed = ['source', 'items', 'recipient_name', 'shipping_address', 'phone', 'payment_method', 'note', 'voucher_code'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(field => !allowed.includes(field))) bad('Unsupported order fields');
    if (!['cart', 'buy-now'].includes(body.source)) bad('source must be cart or buy-now');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100 || body.items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(field => !['product_id', 'quantity'].includes(field)) || !id(item.product_id) || !id(item.quantity)) || new Set(body.items.map(item => item.product_id)).size !== body.items.length) bad('Select 1-100 distinct products with positive integer quantities');
    if (body.source === 'buy-now' && body.items.length !== 1) bad('Buy now requires exactly one product');
    if (!shippingText(body.recipient_name, 1, 100)) bad('Invalid recipient name');
    if (!shippingText(body.shipping_address, 5, 255, true)) bad('Invalid shipping address');
    if (typeof body.phone !== 'string' || !/^\+?[0-9 ()-]{6,20}$/.test(body.phone.trim()) || body.phone.replace(/\D/g, '').length < 6) bad('Invalid phone');
    if (!['COD', 'ONLINE'].includes(body.payment_method)) bad('payment_method must be COD or ONLINE');
    if (body.note != null && !shippingText(body.note, 0, 200, true)) bad('Invalid note; maximum 200 characters');
    const input = {
        source: body.source,
        items: body.items.map(({ product_id, quantity }) => ({ product_id, quantity })).sort((a, b) => a.product_id - b.product_id),
        recipient_name: body.recipient_name.trim(), shipping_address: body.shipping_address.trim(),
        phone: body.phone.trim(), payment_method: body.payment_method, note: body.note?.trim() || null
    };
    // Omit absent/empty codes to preserve existing checkout fingerprints.
    if (body.voucher_code != null && body.voucher_code !== '') {
        if (typeof body.voucher_code !== 'string') bad('Invalid voucher code');
        if (body.voucher_code.trim()) input.voucher_code = require('../models/voucher').normalizeCode(body.voucher_code);
    }
    const result = await orders.create(req.user.user_id, input, key);
    res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
}));

router.get('/', handle(async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit', 'status'].includes(key))) bad('Unsupported query parameters');
    const number = (value, fallback) => value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    const page = number(req.query.page, 1);
    const limit = number(req.query.limit, 20);
    if (!id(page) || !id(limit) || limit > 100 || !Number.isSafeInteger((page - 1) * limit)) bad('Invalid pagination');
    const status = req.query.status;
    if (status !== undefined && !orderStatuses.includes(status)) bad('Invalid status filter');
    res.json({ success: true, page, limit, statuses: orderStatuses, ...await orders.list(req.user.user_id, limit, (page - 1) * limit, status) });
}));

router.get('/:id', handle(async (req, res) => {
    if (Object.keys(req.query).length || !/^[1-9]\d*$/.test(req.params.id) || !id(Number(req.params.id))) bad('Invalid order ID or query');
    res.json({ success: true, order: await orders.get(req.user.user_id, Number(req.params.id)) });
}));
module.exports = router;
