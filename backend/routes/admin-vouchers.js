const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const vouchers = require('../models/voucher');
const config = require('../config/vouchers');
const { bad, noQuery, body, voucherId, pagination, handle, featureGate } = require('./voucher-validation');
const router = express.Router();
router.use(authenticate, authorize('admin'));
router.use(featureGate(config.assertEnabled));

router.get('/', handle(async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit', 'q', 'status'].includes(key))) bad('Unsupported voucher filter');
    const filters = pagination(req.query);
    if (req.query.status !== undefined) {
        if (!['draft', 'active', 'disabled'].includes(req.query.status)) bad('Invalid voucher status filter');
        filters.status = req.query.status;
    }
    if (req.query.q !== undefined) {
        if (typeof req.query.q !== 'string' || !req.query.q.trim() || req.query.q.trim().length > 64 || /[^\x20-\x7e]/.test(req.query.q)) bad('Invalid voucher code search');
        filters.q = req.query.q.trim().toUpperCase();
    }
    res.json({ success: true, page: filters.page, limit: filters.limit, ...await vouchers.list(filters) });
}));

router.post('/', handle(async (req, res) => {
    noQuery(req);
    const input = body(req);
    // The model validates again at its mutation boundary. Pass the original
    // input so UTC SQL normalization is never applied twice.
    vouchers.validateCreate(input);
    res.status(201).json({ success: true, voucher: await vouchers.create(req.user.user_id, input) });
}));

router.get('/:id', handle(async (req, res) => {
    noQuery(req);
    res.json({ success: true, voucher: await vouchers.get(voucherId(req.params.id)) });
}));

router.patch('/:id', handle(async (req, res) => {
    noQuery(req);
    const id = voucherId(req.params.id), input = body(req);
    vouchers.validateUpdate(input);
    res.json({ success: true, voucher: await vouchers.update(req.user.user_id, id, input) });
}));

router.patch('/:id/disable', handle(async (req, res) => {
    noQuery(req);
    const id = voucherId(req.params.id), input = body(req, true);
    if (Object.keys(input).length) bad('Disabling a voucher does not accept request fields');
    res.json({ success: true, voucher: await vouchers.disable(req.user.user_id, id) });
}));

// There is deliberately no hard-delete endpoint. Historical references and
// order snapshots remain intact when an administrator disables a code.
module.exports = router;
