const express = require('express');
const payments = require('../models/payment');
const router = express.Router();
// Mounted by routes/orders after authenticate + authorize('user').

const handle = action => async (req, res, next) => {
    try {
        if (Object.keys(req.query).length || !/^[1-9]\d*$/.test(req.params.id) || Number(req.params.id) > 2147483647) {
            return res.status(400).json({ success: false, message: 'Invalid order ID or query parameters' });
        }
        await action(req, res);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        next(error);
    }
};

router.get('/:id/payment', handle(async (req, res) => {
    res.json({ success: true, payment: await payments.get(req.user.user_id, Number(req.params.id)) });
}));
router.post('/:id/payment/simulate', handle(async (req, res) => {
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 1 || !Object.hasOwn(input, 'test_case') ||
        !['ONLINE_SUCCESS', 'ONLINE_FAILURE'].includes(input.test_case)) {
        return res.status(400).json({ success: false, message: 'Only test_case ONLINE_SUCCESS or ONLINE_FAILURE is accepted' });
    }
    const result = await payments.simulate(req.user.user_id, Number(req.params.id), input.test_case);
    res.json({ success: true, ...result });
}));
module.exports = router;
