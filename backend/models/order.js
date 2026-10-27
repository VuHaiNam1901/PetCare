const { createHash } = require('node:crypto');
const pool = require('../config/db');

const hash = value => createHash('sha256').update(value).digest('hex');
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const money = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
function cents(value) {
    if (!/^\d+\.\d{2}$/.test(value)) fail(409, 'Invalid product price');
    return BigInt(value.replace('.', ''));
}
function publicOrder(order) {
    delete order.idempotency_key_hash;
    delete order.request_fingerprint;
    return order;
}
async function detail(db, userId, orderId) {
    const [orders] = await db.execute(`SELECT o.*, u.full_name AS recipient_name,
        p.payment_method, p.payment_status, p.amount AS payment_amount, p.transaction_date
        FROM orders o JOIN \`user\` u ON u.user_id = o.user_id
        LEFT JOIN payments p ON p.order_id = o.order_id
        WHERE o.order_id = ? ${userId === null ? '' : 'AND o.user_id = ?'}`, userId === null ? [orderId] : [orderId, userId]);
    if (!orders.length) fail(404, 'Order not found');
    const [items] = await db.execute(`SELECT d.order_detail_id, d.product_id, p.name, p.image_url,
        d.quantity, d.unit_price, d.subtotal FROM order_details d
        JOIN products p ON p.product_id = d.product_id WHERE d.order_id = ? ORDER BY d.order_detail_id`, [orderId]);
    return { ...publicOrder(orders[0]), items };
}

exports.create = async (userId, input, key) => {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        // Same lock protocol as cart operations, shared across all server instances.
        const [[user]] = await db.execute('SELECT user_id, role, status FROM `user` WHERE user_id = ? FOR UPDATE', [userId]);
        if (!user || user.role !== 'user' || user.status !== 'active') fail(403, 'Active user account required');
        const keyHash = hash(key);
        const fingerprint = hash(JSON.stringify(input));
        const [existing] = await db.execute('SELECT order_id, request_fingerprint FROM orders WHERE user_id = ? AND idempotency_key_hash = ? FOR UPDATE', [userId, keyHash]);
        if (existing.length) {
            if (existing[0].request_fingerprint !== fingerprint) fail(409, 'Idempotency-Key already used for a different request');
            const order = await detail(db, userId, existing[0].order_id);
            await db.commit();
            return { order, replayed: true };
        }
        const [[cart]] = await db.execute('SELECT cart_id FROM carts WHERE user_id = ? FOR UPDATE', [userId]);
        if (!cart) fail(409, 'Selected cart items are no longer available');
        const placeholders = input.cart_item_ids.map(() => '?').join(',');
        const [items] = await db.execute(`SELECT cart_item_id, product_id, quantity FROM cart_items
            WHERE cart_id = ? AND cart_item_id IN (${placeholders}) ORDER BY product_id FOR UPDATE`, [cart.cart_id, ...input.cart_item_ids]);
        if (items.length !== input.cart_item_ids.length) fail(409, 'Selected cart items are no longer available');
        const lines = [];
        let total = 0n;
        // Lock product IDs in a stable order to prevent concurrent overselling.
        for (const item of items) {
            const [[product]] = await db.execute('SELECT product_id, price, status, stock_quantity FROM products WHERE product_id = ? FOR UPDATE', [item.product_id]);
            if (!product || product.status !== 'Đang bán') fail(409, 'Product is not available for sale');
            if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > product.stock_quantity) fail(409, 'Insufficient stock or invalid cart quantity');
            const subtotal = cents(product.price) * BigInt(item.quantity);
            total += subtotal;
            if (total > 999999999999n) fail(409, 'Order total exceeds database capacity');
            lines.push({ ...item, price: product.price, subtotal: money(subtotal) });
        }
        const [created] = await db.execute(`INSERT INTO orders
            (user_id, order_date, total_amount, shipping_address, phone, status, note, idempotency_key_hash, request_fingerprint)
            VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?)`, [userId, money(total), input.shipping_address, input.phone,
            input.payment_method === 'COD' ? 'Chờ xử lý' : 'Chờ thanh toán', input.note, keyHash, fingerprint]);
        for (const line of lines) {
            await db.execute('INSERT INTO order_details (order_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)', [created.insertId, line.product_id, line.quantity, line.price, line.subtotal]);
            await db.execute('UPDATE products SET stock_quantity = stock_quantity - ? WHERE product_id = ?', [line.quantity, line.product_id]);
        }
        await db.execute(`INSERT INTO payments (order_id, payment_method, payment_status, amount, transaction_date, created_at)
            VALUES (?, ?, ?, ?, NULL, NOW())`, [created.insertId, input.payment_method, 'Chưa thanh toán', money(total)]);
        await db.execute(`DELETE FROM cart_items WHERE cart_id = ? AND cart_item_id IN (${placeholders})`, [cart.cart_id, ...input.cart_item_ids]);
        const order = await detail(db, userId, created.insertId);
        await db.commit();
        return { order, replayed: false };
    } catch (error) {
        await db.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
            error.status = 409;
            error.message = 'Order key already exists; retry with the same Idempotency-Key';
        }
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            error.status = 409;
            error.message = 'Order is busy; retry with the same Idempotency-Key';
        }
        throw error;
    } finally { db.release(); }
};

exports.get = (userId, orderId) => detail(pool, userId, orderId);
// null scope is reserved for the admin model, behind authenticate/authorize.
exports.readDetail = detail;
exports.list = async (userId, limit, offset) => {
    // One consistent snapshot for headers/details while future admin updates occur.
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const [[{ total }]] = await db.execute('SELECT COUNT(*) AS total FROM orders WHERE user_id = ?', [userId]);
        const [ids] = await db.query('SELECT order_id FROM orders WHERE user_id = ? ORDER BY order_date DESC, order_id DESC LIMIT ? OFFSET ?', [userId, limit, offset]);
        const orders = [];
        for (const row of ids) orders.push(await detail(db, userId, row.order_id));
        await db.commit();
        return { total, orders };
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
};
