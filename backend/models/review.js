const pool = require('../config/db');
const { normalizeLegacyClock } = require('./order-time');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// Legacy names/comments may contain markup. Responses are escaped plain text.
const safeText = value => value == null ? value : value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safe = row => ({ ...row, comment: safeText(row.comment), ...(Object.hasOwn(row, 'reviewer_name') ? { reviewer_name: safeText(row.reviewer_name) } : {}) });

exports.create = async (userId, productId, input) => {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const [[user]] = await db.execute('SELECT role, status FROM `user` WHERE user_id = ? FOR UPDATE', [userId]);
        if (!user || user.role !== 'user' || user.status !== 'active') fail(403, 'Active user account required');
        const [[product]] = await db.execute('SELECT product_id FROM products WHERE product_id = ? FOR SHARE', [productId]);
        if (!product) fail(404, 'Product not found');
        const [purchases] = await db.execute(`SELECT o.order_id FROM orders o
            JOIN order_details d ON d.order_id = o.order_id
            WHERE o.user_id = ? AND o.status = ? AND d.product_id = ? AND d.quantity > 0
            LIMIT 1 FOR SHARE`, [userId, 'Đã giao hàng', productId]);
        if (!purchases.length) fail(403, 'A delivered purchase of this product is required');
        const [existing] = await db.execute('SELECT review_id FROM reviews WHERE user_id = ? AND product_id = ?', [userId, productId]);
        if (existing.length) fail(409, 'You have already reviewed this product');
        const [result] = await db.execute('INSERT INTO reviews (user_id, product_id, rating, comment, created_at) VALUES (?, ?, ?, ?, NOW())', [userId, productId, input.rating, input.comment]);
        const [[review]] = await db.execute('SELECT review_id, product_id, rating, comment, created_at FROM reviews WHERE review_id = ?', [result.insertId]);
        await db.commit();
        return safe(review);
    } catch (error) {
        await db.rollback();
        if (error.code === 'ER_DUP_ENTRY') { error.status = 409; error.message = 'You have already reviewed this product'; }
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) { error.status = 409; error.message = 'Reviews are busy; retry the request'; }
        throw error;
    } finally { db.release(); }
};

async function list(userId, productId, page, limit, rating) {
    const db = await pool.getConnection();
    try {
        let product, summary;
        if (productId !== null) {
            // These settings apply to this read transaction only, so product,
            // summary, filtered count and page always describe one snapshot.
            await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await db.query('START TRANSACTION READ ONLY');
            [[product]] = await db.execute('SELECT product_id, name FROM products WHERE product_id = ?', [productId]);
            if (!product) fail(404, 'Product not found');
            const [[aggregate]] = await db.execute(`SELECT COUNT(*) AS total, AVG(rating) AS average_rating,
                SUM(rating = 1) AS star_1, SUM(rating = 2) AS star_2, SUM(rating = 3) AS star_3,
                SUM(rating = 4) AS star_4, SUM(rating = 5) AS star_5
                FROM reviews WHERE product_id = ?`, [productId]);
            summary = { total: Number(aggregate.total), average_rating: aggregate.average_rating === null ? null : Number(aggregate.average_rating),
                distribution: Object.fromEntries([1, 2, 3, 4, 5].map(star => [star, Number(aggregate[`star_${star}`] || 0)])) };
        } else await db.beginTransaction();
        let where = productId !== null ? 'r.product_id = ?' : 'r.user_id = ?';
        const params = [productId ?? userId];
        if (productId !== null && rating !== undefined) { where += ' AND r.rating = ?'; params.push(rating); }
        let total = summary?.total;
        if (total === undefined || rating !== undefined) {
            const [[count]] = await db.execute(`SELECT COUNT(*) AS total FROM reviews r WHERE ${where}`, params);
            total = Number(count.total);
        }
        const fields = productId !== null ? 'u.full_name AS reviewer_name' : 'r.product_id, p.name AS product_name, p.image_url, p.status AS product_status';
        const reviewClock = productId !== null ? ', UNIX_TIMESTAMP(r.created_at) AS __clock_created_at' : '';
        const join = productId !== null ? 'JOIN `user` u ON u.user_id = r.user_id' : 'JOIN products p ON p.product_id = r.product_id';
        const [rows] = await db.query(`SELECT r.review_id, r.rating, r.comment, r.created_at${reviewClock}, ${fields}
            FROM reviews r ${join} WHERE ${where} ORDER BY r.created_at DESC, r.review_id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
        await db.commit();
        return { total, reviews: rows.map(row => safe(productId !== null ? normalizeLegacyClock(row, ['created_at']) : row)), ...(product ? { product, summary } : {}) };
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
}
exports.forProduct = (productId, page, limit, rating) => list(null, productId, page, limit, rating);
exports.mine = (userId, page, limit) => list(userId, null, page, limit);
