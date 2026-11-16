const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const vouchers = require('../models/voucher');
const config = require('../config/vouchers');
const { bad, noQuery, body, voucherId, pagination, handle, featureGate } = require('./voucher-validation');
const router = express.Router();
router.use(authenticate, authorize('admin'));
router.use(featureGate(config.assertEnabled));

router.get('/customers', handle(async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit', 'q'].includes(key))) bad('Unsupported voucher customer search parameters');
    const filters = pagination(req.query);
    if (filters.limit > 50) bad('Customer search limit must not exceed 50');
    const q = req.query.q === undefined ? '' : req.query.q;
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...filters, ...await require('../models/voucher-customer').search({ ...filters, q }) });
}));

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

router.get('/:id/assignments', handle(async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) bad('Unsupported voucher assignment filter');
    const filters = pagination(req.query);
    if (filters.limit > 50) bad('Assignment list limit must not exceed 50');
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...filters, ...await vouchers.listAssignments(req.user.user_id, voucherId(req.params.id), filters) });
}));

router.post('/:id/assignments', handle(async (req, res) => {
    noQuery(req);
    const input = body(req);
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'user_ids')) bad('Only user_ids may be supplied when granting a voucher');
    res.json({ success: true, ...await vouchers.grant(req.user.user_id, voucherId(req.params.id), input.user_ids) });
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
