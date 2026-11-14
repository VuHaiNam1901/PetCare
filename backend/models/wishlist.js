// Every writer locks the authenticated owner, as cart mutations already do.
// The database composite primary key independently prevents duplicate saves.
function createWishlistModel({ pool } = {}) {
    const database = () => pool || require('../config/db');
    const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };

    async function read(db, userId) {
        const [products] = await db.execute(`SELECT p.product_id,p.category_id,c.name AS category_name,
            p.name,p.description,p.price,p.stock_quantity,p.image_url,p.status,p.created_at,
            w.created_at AS favorited_at
            FROM wishlists w JOIN products p ON p.product_id=w.product_id
            LEFT JOIN categories c ON c.category_id=p.category_id
            WHERE w.user_id=? ORDER BY w.created_at DESC,w.product_id DESC`, [userId]);
        return products;
    }
    async function transaction(userId, action, write = false) {
        const db = await database().getConnection();
        try {
            await db.beginTransaction();
            const [[user]] = await db.execute(`SELECT user_id,role,status FROM \`user\` WHERE user_id=? FOR ${write ? 'UPDATE' : 'SHARE'}`, [userId]);
            if (!user || user.role !== 'user' || user.status !== 'active') fail(403, 'Tài khoản khách hàng đang hoạt động là bắt buộc.', 'WISHLIST_FORBIDDEN');
            const result = await action(db);
            const products = await read(db, userId);
            await db.commit();
            return { products, ...result };
        } catch (error) {
            try { await db.rollback(); } catch { /* Preserve the original error. */ }
            if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') {
                error.status = 503; error.code = 'WISHLIST_SCHEMA_NOT_READY';
                error.message = 'Danh sách yêu thích chưa sẵn sàng. Vui lòng thử lại sau.';
            } else if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_DUP_ENTRY'].includes(error.code)) {
                error.status = 409; error.code = 'WISHLIST_RETRY'; error.retryable = true;
                error.message = 'Danh sách yêu thích đang được cập nhật. Vui lòng thử lại.';
            }
            throw error;
        } finally { db.release(); }
    }

    const get = userId => transaction(userId, async () => ({}));
    const add = (userId, productId) => transaction(userId, async db => {
        const [[existing]] = await db.execute('SELECT product_id FROM wishlists WHERE user_id=? AND product_id=? FOR UPDATE', [userId, productId]);
        if (existing) return { added: false };
        const [[product]] = await db.execute('SELECT product_id,status FROM products WHERE product_id=? FOR SHARE', [productId]);
        if (!product) fail(404, 'Không tìm thấy sản phẩm.', 'WISHLIST_PRODUCT_NOT_FOUND');
        if (product.status !== 'Đang bán') fail(409, 'Sản phẩm đã ngừng bán.', 'WISHLIST_PRODUCT_UNAVAILABLE');
        await db.execute('INSERT INTO wishlists (user_id,product_id,created_at) VALUES (?,?,NOW(3))', [userId, productId]);
        return { added: true };
    }, true);
    const remove = (userId, productId) => transaction(userId, async db => {
        const [result] = await db.execute('DELETE FROM wishlists WHERE user_id=? AND product_id=?', [userId, productId]);
        return { removed: result.affectedRows > 0 };
    }, true);
    return { get, add, remove };
}

let singleton;
const defaultModel = () => singleton ||= createWishlistModel();
module.exports = { createWishlistModel };
for (const name of ['get', 'add', 'remove']) module.exports[name] = (...args) => defaultModel()[name](...args);
