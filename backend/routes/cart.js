const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const cart = require('../models/cart');
const router = express.Router();

const positiveInteger = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const validKey = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const bad = message => Object.assign(new Error(message), { status: 400 });

function itemsInput(req) {
    const body = req.body;
    if (Object.keys(req.query).length || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'items') || !Array.isArray(body.items) || body.items.length > 100) throw bad('Expected at most 100 guest cart items');
    const seen = new Set();
    return body.items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['product_id', 'quantity', 'selected'].includes(key)) || !positiveInteger(item.product_id) || !positiveInteger(item.quantity) || (item.selected !== undefined && typeof item.selected !== 'boolean') || seen.has(item.product_id)) throw bad('Each distinct product requires positive integer product_id/quantity and optional boolean selected');
        seen.add(item.product_id);
        return { product_id: item.product_id, quantity: item.quantity, selected: item.selected ?? false };
    });
}

const handle = (action, merge = false) => async (req, res, next) => {
    try {
        const result = await action(req);
        res.json(merge ? { success: true, ...result } : { success: true, cart: result });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message, ...(error.conflicts ? { conflicts: error.conflicts } : {}) });
        next(error);
    }
};

// Catalog resolution only: no account cart access and no database writes.
router.post('/preview', handle(req => cart.preview(itemsInput(req))));
router.use(authenticate, authorize('user'));

function validate(req, res, next) {
    if (Object.keys(req.query).length) return res.status(400).json({ success: false, message: 'Query parameters are not supported' });
    if (req.params.id !== undefined && (!/^[1-9]\d*$/.test(req.params.id) || !positiveInteger(Number(req.params.id)))) return res.status(400).json({ success: false, message: 'Invalid cart item id' });
    const allowed = req.method === 'POST' ? ['product_id', 'quantity'] : req.method === 'PUT' ? ['quantity'] : [];
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)) || allowed.some(key => !positiveInteger(body[key]))) return res.status(400).json({ success: false, message: 'Only product_id and quantity (positive integers) are accepted when applicable' });
    next();
}

router.get('/', validate, handle(req => cart.get(req.user.user_id)));
router.post('/items', validate, handle(req => cart.add(req.user.user_id, req.body.product_id, req.body.quantity)));
router.put('/items/:id', validate, handle(req => cart.update(req.user.user_id, Number(req.params.id), req.body.quantity)));
router.delete('/items/:id', validate, handle(req => cart.remove(req.user.user_id, Number(req.params.id))));
router.put('/selection', handle(req => {
    const body = req.body;
    if (Object.keys(req.query).length || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'product_ids') || !Array.isArray(body.product_ids) || body.product_ids.length > 100 || !body.product_ids.every(positiveInteger) || new Set(body.product_ids).size !== body.product_ids.length) throw bad('Expected at most 100 distinct product_ids');
    return cart.selection(req.user.user_id, body.product_ids);
}));
router.post('/merge', handle(req => {
    const items = itemsInput(req);
    const key = req.get('Idempotency-Key');
    if (!validKey(key)) throw bad('Idempotency-Key must be a UUID');
    return cart.merge(req.user.user_id, items, key);
}, true));

module.exports = router;
