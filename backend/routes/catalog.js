const express = require('express');
const pool = require('../config/db');
const petTypes = require('../models/pet-types');
const router = express.Router();
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const integer = (value, fallback) => value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : NaN;
const handle = action => async (req, res, next) => {
    try { await action(req, res); }
    catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}) });
        next(error);
    }
};

router.get('/pet-types', handle(async (req, res) => {
    if (Object.keys(req.query).length) bad('Unsupported filter');
    res.json({ success: true, ...await petTypes.list() });
}));

router.get('/products', handle(async (req, res) => {
    const allowed = ['pet_type', 'category', 'category_id', 'q', 'page', 'limit', 'sort'];
    if (Object.keys(req.query).some(key => !allowed.includes(key) || typeof req.query[key] !== 'string')) bad('Unsupported filter');
    const paginated = Object.keys(req.query).length > 0;
    const page = integer(req.query.page, 1);
    const limit = integer(req.query.limit, 10);
    if (!Number.isInteger(page) || !Number.isInteger(limit) || limit > 100 || !Number.isSafeInteger((page - 1) * limit)) bad('Invalid pagination');
    if (req.query.category !== undefined && req.query.category_id !== undefined) bad('Only one category filter is accepted');
    const category = req.query.category ?? req.query.category_id;
    if (category !== undefined && !Number.isInteger(integer(category))) bad('Invalid category filter');
    const petType = req.query.pet_type;
    if (petType !== undefined && !petTypes.types.some(type => type.slug === petType)) bad('Invalid pet type filter');
    const sort = req.query.sort ?? 'newest';
    const sorts = { newest: 'p.product_id DESC', 'price-asc': 'p.price ASC,p.product_id DESC', 'price-desc': 'p.price DESC,p.product_id DESC' };
    if (!Object.hasOwn(sorts, sort)) bad('Invalid sort');
    const q = req.query.q?.trim();
    if (q !== undefined && (q.length > 150 || /[\u0000-\u001F\u007F]/.test(q))) bad('Invalid search');
    const conditions = ['p.status=?'];
    const params = ['Đang bán'];
    if (category !== undefined) { conditions.push('p.category_id=?'); params.push(Number(category)); }
    if (q) {
        conditions.push("CONVERT(CONCAT(p.name,' ',c.name) USING utf8mb4) COLLATE utf8mb4_unicode_ci LIKE ? ESCAPE '='");
        params.push('%' + q.replace(/[=%_]/g, char => '=' + char) + '%');
    }
    if (petType !== undefined) {
        conditions.push('EXISTS (SELECT 1 FROM product_pet_types ppt JOIN pet_types pt ON pt.pet_type_id=ppt.pet_type_id WHERE ppt.product_id=p.product_id AND pt.slug=?)');
        params.push(petType);
    }
    const db = await pool.getConnection();
    try {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await db.query('START TRANSACTION READ ONLY');
        const current = await petTypes.state(db);
        if (petType !== undefined && !current.ready) throw petTypes.unavailable();
        const from = 'FROM products p JOIN categories c ON c.category_id=p.category_id WHERE ' + conditions.join(' AND ');
        const [[aggregate]] = await db.execute(`SELECT COUNT(*) AS total ${from}`, params);
        const [rows] = await db.query(`SELECT p.product_id,p.category_id,c.name AS category_name,p.name,p.description,
            p.price,p.stock_quantity,p.image_url,p.status,p.created_at ${from} ORDER BY ${sorts[sort]}
            ${paginated ? 'LIMIT ? OFFSET ?' : ''}`, paginated ? [...params, limit, (page - 1) * limit] : params);
        const result = await petTypes.attach(db, rows, current);
        await db.commit();
        res.json({ success: true, total: Number(aggregate.total), ...(paginated ? { page, limit } : {}), ...result });
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
}));

module.exports = router;
