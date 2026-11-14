const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const catalog = require('../models/catalog');
const petTypes = require('../models/pet-types');
const router = express.Router();
router.use(authenticate, authorize('admin'));
const states = ['Đang bán', 'Ngừng bán'];
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const integer = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
function text(value, max, nullable = false, multiline = false) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string') bad('Text fields must be strings');
    const result = value.trim();
    if ((!nullable && !result) || result.length > max || /[\uD800-\uDFFF]/u.test(result) || [...result].some(char => char.codePointAt(0) > 65535) ||
        (multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(result)) bad('Invalid or oversized text');
    return result;
}
function price(value) {
    if (typeof value !== 'string' && typeof value !== 'number') bad('Invalid price');
    const raw = String(value).trim();
    if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(raw)) bad('Price must be nonnegative, max 9999999999.99 with at most two decimal places');
    const [whole, fraction = ''] = raw.split('.');
    return whole + '.' + fraction.padEnd(2, '0');
}
function image(value) {
    const result = text(value, 500);
    const prefix = '/images/products/';
    if (!result.startsWith(prefix)) bad('Image must use /images/products/...');
    const parts = result.slice(prefix.length).split('/');
    if (!parts.every(part => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && !part.includes('..')) || !/\.(?:webp|png|jpe?g|gif|avif)$/i.test(parts.at(-1))) bad('Invalid product image path');
    return result;
}
function input(req, kind) {
    if (Object.keys(req.query).length) bad('Query parameters are not supported');
    const body = req.body;
    const allowed = kind === 'product' ? ['category_id', 'name', 'description', 'price', 'stock_quantity', 'image_url', 'status', 'pet_type_ids'] : ['name', 'description'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) bad('Unsupported or missing fields');
    const data = {};
    if ('name' in body) data.name = text(body.name, kind === 'product' ? 150 : 100);
    if ('description' in body) {
        data.description = text(body.description, kind === 'product' ? 65535 : 255, true, true);
        if (kind === 'product' && data.description !== null && Buffer.byteLength(data.description, 'utf8') > 65535) bad('Description exceeds MySQL TEXT capacity');
    }
    if (kind === 'product') {
        if ('pet_type_ids' in body) {
            if (!Array.isArray(body.pet_type_ids) || body.pet_type_ids.length > petTypes.types.length ||
                body.pet_type_ids.some(value => !integer(value) || value === 0 || value > petTypes.types.length) ||
                new Set(body.pet_type_ids).size !== body.pet_type_ids.length) bad('Invalid pet_type_ids');
            data.pet_type_ids = [...body.pet_type_ids].sort((a, b) => a - b);
        }
        if ('category_id' in body) { if (!integer(body.category_id) || body.category_id === 0) bad('Invalid category_id'); data.category_id = body.category_id; }
        if ('price' in body) data.price = price(body.price);
        if ('stock_quantity' in body) { if (!integer(body.stock_quantity)) bad('Stock must be a nonnegative integer'); data.stock_quantity = body.stock_quantity; }
        if ('image_url' in body) data.image_url = image(body.image_url);
        if ('status' in body) { if (!states.includes(body.status)) bad('Invalid product status'); data.status = body.status; }
    }
    if (req.method === 'POST') {
        const required = kind === 'product' ? ['name', 'category_id', 'price', 'stock_quantity', 'image_url'] : ['name'];
        if (required.some(key => !Object.hasOwn(data, key))) bad('Required fields are missing');
        data.description ??= null;
        if (kind === 'product') data.status ??= 'Đang bán';
    }
    return data;
}
function id(req) {
    if (Object.keys(req.query).length || !/^[1-9]\d*$/.test(req.params.id) || Number(req.params.id) > 2147483647) bad('Invalid ID or query parameters');
    return Number(req.params.id);
}
const handle = action => async (req, res, next) => {
    try { await action(req, res); }
    catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}) });
        next(error);
    }
};

router.get('/products', handle(async (req, res) => {
    const allowed = ['page', 'limit', 'q', 'category_id', 'status', 'min_price', 'max_price'];
    if (Object.keys(req.query).some(key => !allowed.includes(key))) bad('Unsupported filter');
    const number = (value, fallback) => value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    const filters = { page: number(req.query.page, 1), limit: number(req.query.limit, 20) };
    if (!integer(filters.page) || !filters.page || !integer(filters.limit) || !filters.limit || filters.limit > 100) bad('Invalid pagination');
    if (req.query.category_id !== undefined) { filters.category_id = number(req.query.category_id); if (!integer(filters.category_id) || !filters.category_id) bad('Invalid category filter'); }
    if (req.query.q !== undefined) filters.q = text(req.query.q, 150);
    if (req.query.status !== undefined) { if (!states.includes(req.query.status)) bad('Invalid status filter'); filters.status = req.query.status; }
    for (const key of ['min_price', 'max_price']) if (req.query[key] !== undefined) filters[key] = price(req.query[key]);
    if (filters.min_price !== undefined && filters.max_price !== undefined && BigInt(filters.min_price.replace('.', '')) > BigInt(filters.max_price.replace('.', ''))) bad('min_price exceeds max_price');
    res.json({ success: true, page: filters.page, limit: filters.limit, ...await catalog.listProducts(filters) });
}));
router.get('/pet-types', handle(async (req, res) => {
    if (Object.keys(req.query).length) bad('Query parameters are not supported');
    res.json({ success: true, ...await petTypes.list({ availableOnly: false }) });
}));
router.post('/products', handle(async (req, res) => res.status(201).json({ success: true, product: await catalog.createProduct(req.user.user_id, input(req, 'product')) })));
router.put('/products/:id', handle(async (req, res) => res.json({ success: true, product: await catalog.updateProduct(req.user.user_id, id(req), input(req, 'product')) })));
router.delete('/products/:id', handle(async (req, res) => {
    const productId = id(req);
    if (req.body && Object.keys(req.body).length) bad('DELETE does not accept request fields');
    res.json({ success: true, action: 'discontinued', product: await catalog.stopProduct(req.user.user_id, productId) });
}));
router.get('/categories', handle(async (req, res) => {
    if (Object.keys(req.query).length) bad('Query parameters are not supported');
    const categories = await catalog.listCategories();
    res.json({ success: true, total: categories.length, categories });
}));
router.post('/categories', handle(async (req, res) => res.status(201).json({ success: true, category: await catalog.createCategory(req.user.user_id, input(req, 'category')) })));
router.put('/categories/:id', handle(async (req, res) => res.json({ success: true, category: await catalog.updateCategory(req.user.user_id, id(req), input(req, 'category')) })));
router.delete('/categories/:id', handle(async (req, res) => {
    const categoryId = id(req);
    if (req.body && Object.keys(req.body).length) bad('DELETE does not accept request fields');
    res.json({ success: true, ...await catalog.removeCategory(req.user.user_id, categoryId) });
}));
module.exports = router;
