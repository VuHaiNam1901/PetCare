const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const reviews = require('../models/review');
const router = express.Router();
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const positive = (value, fallback) => value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : NaN;
const handle = action => async (req, res, next) => {
    try { await action(req, res); }
    catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        next(error);
    }
};
function productId(req) {
    const id = positive(req.params.id);
    if (!Number.isInteger(id)) bad('Invalid product ID');
    return id;
}
function pagination(req) {
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) bad('Unsupported query parameters');
    const page = positive(req.query.page, 1);
    const limit = positive(req.query.limit, 20);
    if (!Number.isInteger(page) || !Number.isInteger(limit) || limit > 100) bad('Invalid pagination');
    return { page, limit };
}
router.get('/products/:id/reviews', handle(async (req, res) => {
    const id = productId(req);
    const { page, limit } = pagination(req);
    res.json({ success: true, page, limit, ...await reviews.forProduct(id, page, limit) });
}));
router.post('/products/:id/reviews', authenticate, authorize('user'), handle(async (req, res) => {
    const id = productId(req);
    const body = req.body;
    if (Object.keys(req.query).length || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['rating', 'comment'].includes(key))) bad('Only rating and comment are accepted');
    if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) bad('Rating must be an integer from 1 to 5');
    if (typeof body.comment !== 'string' || !body.comment.trim() || body.comment.length > 2000) bad('Comment must contain 1-2000 characters');
    if (/[<>\uD800-\uDFFF]/u.test(body.comment) || [...body.comment].some(char => char.codePointAt(0) > 65535)) bad('Comment must be plain text without HTML or unsupported characters');
    const comment = body.comment.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').trim();
    if (!comment) bad('Comment is empty after removing unsafe control characters');
    res.status(201).json({ success: true, review: await reviews.create(req.user.user_id, id, { rating: body.rating, comment }) });
}));
router.get('/users/me/reviews', authenticate, authorize('user'), handle(async (req, res) => {
    const { page, limit } = pagination(req);
    res.json({ success: true, page, limit, ...await reviews.mine(req.user.user_id, page, limit) });
}));
module.exports = router;
