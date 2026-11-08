const bad = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_VOUCHER_REQUEST' }); };
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

function noQuery(req) {
    if (Object.keys(req.query).length) bad('Query parameters are not supported');
}
function body(req, allowEmpty = false) {
    const input = req.body === undefined && allowEmpty ? {} : req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || (!allowEmpty && !Object.keys(input).length)) bad('Expected an object with supported voucher fields');
    return input;
}
function voucherId(value) {
    // The schema uses BIGINT UNSIGNED. Do not round identifiers through Number.
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) bad('Invalid voucher ID');
    return value;
}
function pagination(query) {
    const number = (value, fallback) => value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    const page = number(query.page, 1), limit = number(query.limit, 20);
    if (!positiveInteger(page) || !positiveInteger(limit) || limit > 100 || !Number.isSafeInteger((page - 1) * limit)) bad('Invalid pagination');
    return { page, limit };
}
function quoteInput(req, normalizeCode) {
    noQuery(req);
    const input = body(req);
    if (Object.keys(input).some(key => !['code', 'items', 'payment_method'].includes(key))) bad('Only code, items and payment_method are accepted');
    const code = normalizeCode(input.code);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) bad('Select 1-100 distinct products');
    const seen = new Set();
    const items = input.items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['product_id', 'quantity'].includes(key)) ||
            !positiveInteger(item.product_id) || !positiveInteger(item.quantity) || seen.has(item.product_id)) bad('Each distinct product requires positive integer product_id and quantity');
        seen.add(item.product_id);
        return { product_id: item.product_id, quantity: item.quantity };
    }).sort((left, right) => left.product_id - right.product_id);
    const payment_method = input.payment_method === undefined ? 'COD' : input.payment_method;
    if (!['COD', 'ONLINE'].includes(payment_method)) bad('payment_method must be COD or ONLINE');
    return { code, items, payment_method };
}
function handle(action) {
    return async (req, res, next) => {
        try { await action(req, res); }
        catch (error) {
            if (error.status) return res.status(error.status).json({ success: false, message: error.message,
                ...(error.code ? { code: error.code } : {}), ...(error.retryable ? { retryable: true } : {}) });
            next(error);
        }
    };
}
function featureGate(assertEnabled) {
    return (req, res, next) => {
        try { assertEnabled(); next(); }
        catch (error) {
            if (error.status) return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}) });
            next(error);
        }
    };
}
module.exports = { bad, noQuery, body, voucherId, pagination, quoteInput, handle, featureGate };
