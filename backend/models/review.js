const pool = require('../config/db');
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

async function list(userId, productId, page, limit) {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        if (productId !== null) {
            const [products] = await db.execute('SELECT product_id FROM products WHERE product_id = ?', [productId]);
            if (!products.length) fail(404, 'Product not found');
        }
        const where = productId !== null ? 'r.product_id = ?' : 'r.user_id = ?';
        const params = [productId ?? userId];
        const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM reviews r WHERE ${where}`, params);
        const fields = productId !== null ? 'u.full_name AS reviewer_name' : 'r.product_id, p.name AS product_name, p.image_url, p.status AS product_status';
        const join = productId !== null ? 'JOIN `user` u ON u.user_id = r.user_id' : 'JOIN products p ON p.product_id = r.product_id';
        const [rows] = await db.query(`SELECT r.review_id, r.rating, r.comment, r.created_at, ${fields}
            FROM reviews r ${join} WHERE ${where} ORDER BY r.created_at DESC, r.review_id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
        await db.commit();
        return { total, reviews: rows.map(safe) };
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
}
exports.forProduct = (productId, page, limit) => list(null, productId, page, limit);
exports.mine = (userId, page, limit) => list(userId, null, page, limit);
