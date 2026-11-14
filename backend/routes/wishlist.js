const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const wishlist = require('../models/wishlist');
const router = express.Router();
router.use(authenticate, authorize('user'));

function validate(req, res, next) {
    const body = req.body ?? {};
    if (Object.keys(req.query).length || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length ||
        (req.params.productId !== undefined && (!/^[1-9]\d*$/.test(req.params.productId) || !Number.isSafeInteger(Number(req.params.productId)) || Number(req.params.productId) > 2147483647))) {
        return res.status(400).json({ success: false, message: 'Mã sản phẩm không hợp lệ hoặc có tham số không được hỗ trợ.', code: 'INVALID_WISHLIST' });
    }
    next();
}
const handle = action => async (req, res, next) => {
    try { res.json({ success: true, ...await action(req.user.user_id, Number(req.params.productId)) }); }
    catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message,
            ...(error.code ? { code: error.code } : {}), ...(error.retryable ? { retryable: true } : {}) });
        next(error);
    }
};
router.get('/', validate, handle(wishlist.get));
router.put('/:productId', validate, handle(wishlist.add));
router.delete('/:productId', validate, handle(wishlist.remove));
module.exports = router;
