const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const vouchers = require('../models/voucher');
const config = require('../config/vouchers');
const { bad, pagination, quoteInput, handle, featureGate } = require('./voucher-validation');
const router = express.Router();
const readiness = require('../services/voucher-readiness').createVoucherReadiness();
router.get('/readiness', handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, readiness: await readiness() });
}));
router.use(authenticate, authorize('user'));
router.use(featureGate(config.assertEnabled));

router.get('/', handle(async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) bad('Unsupported voucher list parameters');
    const filters = pagination(req.query);
    if (filters.limit > 50) bad('Voucher list limit must not exceed 50');
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...filters, ...await vouchers.listForCustomer(req.user.user_id, filters) });
}));

router.post('/quote', handle(async (req, res) => {
    // Only product IDs and quantities are accepted. The model resolves catalog
    // prices and checks quota without reserving stock or a voucher redemption.
    const input = quoteInput(req, vouchers.normalizeCode);
    res.json({ success: true, quote: await vouchers.quoteForItems(req.user.user_id, input) });
}));
module.exports = router;
