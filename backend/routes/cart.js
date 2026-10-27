const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const cart = require('../models/cart');
const router = express.Router();
router.use(authenticate, authorize('user'));

const positiveInteger = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

function validate(req, res, next) {
    if (Object.keys(req.query).length) return res.status(400).json({ success: false, message: 'Query parameters are not supported' });
    if (req.params.id !== undefined && (!/^[1-9]\d*$/.test(req.params.id) || !positiveInteger(Number(req.params.id)))) {
        return res.status(400).json({ success: false, message: 'Invalid cart item id' });
    }
    const allowed = req.method === 'POST' ? ['product_id', 'quantity'] : req.method === 'PUT' ? ['quantity'] : [];
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)) || allowed.some(key => !positiveInteger(body[key]))) {
        return res.status(400).json({ success: false, message: 'Only product_id and quantity (positive integers) are accepted when applicable' });
    }
    next();
}

const handle = action => async (req, res, next) => {
    try {
        const result = await action(req);
        res.json({ success: true, cart: result });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        next(error);
    }
};

router.get('/', validate, handle(req => cart.get(req.user.user_id)));
router.post('/items', validate, handle(req => cart.add(req.user.user_id, req.body.product_id, req.body.quantity)));
router.put('/items/:id', validate, handle(req => cart.update(req.user.user_id, Number(req.params.id), req.body.quantity)));
router.delete('/items/:id', validate, handle(req => cart.remove(req.user.user_id, Number(req.params.id))));
module.exports = router;
