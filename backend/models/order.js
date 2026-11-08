const { createHash } = require('node:crypto');
const pool = require('../config/db');
const history = require('./order-history');
const { decorate } = require('./order-policy');
const workflow = require('../config/order-workflow');
const clock = require('./order-time');

const hash = value => createHash('sha256').update(value).digest('hex');
function fail(status, message, code) { throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) }); }
const money = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
function cents(value) {
    if (!/^\d+\.\d{2}$/.test(value)) fail(409, 'Invalid product price');
    return BigInt(value.replace('.', ''));
}
function publicOrder(order) {
    delete order.idempotency_key_hash;
    delete order.request_fingerprint;
    return clock.stripClockProof(order);
}
async function detail(db, userId, orderId) {
    const [orders] = await db.execute(`SELECT o.*${clock.selectOrderClock('o')}${clock.selectPaymentClock('p')}, COALESCE(o.recipient_name, u.full_name) AS recipient_name,
        p.payment_method, p.payment_status, p.amount AS payment_amount, p.transaction_date
        FROM orders o JOIN \`user\` u ON u.user_id = o.user_id
        LEFT JOIN payments p ON p.order_id = o.order_id
        WHERE o.order_id = ? ${userId === null ? '' : 'AND o.user_id = ?'}`, userId === null ? [orderId] : [orderId, userId]);
    if (!orders.length) fail(404, 'Order not found');
    const [items] = await db.execute(`SELECT d.order_detail_id, d.product_id, p.name, p.image_url,
        d.quantity, d.unit_price, d.subtotal FROM order_details d
        JOIN products p ON p.product_id = d.product_id WHERE d.order_id = ? ORDER BY d.order_detail_id`, [orderId]);
    const order = publicOrder(decorate(clock.normalizeOrderClock(orders[0])));
    if (order.workflow_version === workflow.VERSION) {
        order.refunds = await require('../services/online-orders').readRefunds(db, orderId);
    }
    return { ...order, items, history: await history.read(db, orderId) };
}

exports.create = async (userId, input, key) => {
    // Keep the canonical legacy payload unchanged when no Voucher is supplied.
    input = { ...input };
    const suppliedCode = input.voucher_code;
    delete input.voucher_code;
    if (suppliedCode != null && suppliedCode !== '') {
        if (typeof suppliedCode !== 'string') fail(400, 'Invalid voucher code', 'INVALID_VOUCHER');
        if (suppliedCode.trim()) input.voucher_code = require('./voucher').normalizeCode(suppliedCode);
    }
    const db = await pool.getConnection();
    try {
        const newOnline = input.payment_method === 'ONLINE' && workflow.settings().enabled;
        await db.beginTransaction();
        // Same lock protocol as cart operations, shared across all server instances.
        const [[user]] = await db.execute('SELECT user_id, role, status, full_name FROM `user` WHERE user_id = ? FOR UPDATE', [userId]);
        if (!user || user.role !== 'user' || user.status !== 'active') fail(403, 'Active user account required');
        const keyHash = hash(key);
        const fingerprint = hash(JSON.stringify(input));
        const [existing] = await db.execute('SELECT order_id, request_fingerprint FROM orders WHERE user_id = ? AND idempotency_key_hash = ? FOR UPDATE', [userId, keyHash]);
        if (existing.length) {
            if (existing[0].request_fingerprint !== fingerprint) fail(409, 'Idempotency-Key already used for a different request', 'IDEMPOTENCY_CONFLICT');
            const order = await detail(db, userId, existing[0].order_id);
            await db.commit();
            return { order, replayed: true };
        }
        // A committed replay does not depend on today's flags or Voucher terms.
        if (newOnline) {
            workflow.assertWorkflowCreationAllowed();
            await require('../services/online-orders').assertReady(db);
        }
        let voucher;
        if (input.voucher_code) {
            const vouchers = require('./voucher');
            vouchers.assertEnabled();
            await vouchers.assertReady(db);
            if (input.payment_method === 'ONLINE' && !newOnline) fail(503, 'Online vouchers require the new order workflow', 'ORDER_WORKFLOW_DISABLED');
            // All Voucher mutations acquire this lock before product locks.
            voucher = await vouchers.lockByCode(db, input.voucher_code);
        }
        // Checkout owns its quantity snapshot. A merged or edited cart must never
        // silently expand the purchase. Buy now deliberately never touches carts.
        const items = [...input.items].sort((a, b) => a.product_id - b.product_id);
        let cartId;
        const cartItems = new Map();
        if (input.source === 'cart') {
            const [[cart]] = await db.execute('SELECT cart_id FROM carts WHERE user_id = ? FOR UPDATE', [userId]);
            if (!cart) fail(409, 'Selected cart items are no longer available', 'CART_CHANGED');
            cartId = cart.cart_id;
            const placeholders = items.map(() => '?').join(',');
            const [stored] = await db.execute(`SELECT cart_item_id, product_id, quantity FROM cart_items
                WHERE cart_id = ? AND product_id IN (${placeholders}) ORDER BY product_id FOR UPDATE`, [cartId, ...items.map(item => item.product_id)]);
            for (const item of stored) {
                if (cartItems.has(item.product_id)) fail(409, 'Duplicate cart items exist; data cleanup required', 'CART_CHANGED');
                cartItems.set(item.product_id, item);
            }
            if (items.some(item => !cartItems.has(item.product_id) || !Number.isInteger(cartItems.get(item.product_id).quantity) || cartItems.get(item.product_id).quantity < item.quantity)) {
                fail(409, 'Selected cart quantities have changed; review the cart', 'CART_CHANGED');
            }
        }
        const lines = [];
        let total = 0n;
        // Lock product IDs in a stable order to prevent concurrent overselling.
        for (const item of items) {
            const [[product]] = await db.execute('SELECT product_id, price, status, stock_quantity FROM products WHERE product_id = ? FOR UPDATE', [item.product_id]);
            if (!product || product.status !== 'Đang bán') fail(409, 'Product is not available for sale', 'PRODUCT_UNAVAILABLE');
            if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isInteger(product.stock_quantity) || item.quantity > product.stock_quantity) fail(409, 'Insufficient stock or invalid checkout quantity', 'OUT_OF_STOCK');
            const subtotal = cents(product.price) * BigInt(item.quantity);
            total += subtotal;
            if (total > 999999999999n) fail(409, 'Order total exceeds database capacity', 'ORDER_TOTAL_TOO_LARGE');
            lines.push({ ...item, price: product.price, subtotal: money(subtotal) });
        }
        const quote = voucher ? await require('./voucher').quoteLocked(db, { code: input.voucher_code, userId,
            subtotal: money(total), voucher, paymentMethod: input.payment_method }) : null;
        const payable = quote ? quote.total_amount : money(total);
        const [created] = await db.execute(`INSERT INTO orders
            (user_id, order_date, total_amount, recipient_name, shipping_address, phone, status, note, idempotency_key_hash, request_fingerprint, stock_reserved_at, stock_reservation_source${newOnline ? ', workflow_version, created_at_utc, payment_expires_at' : ''}${voucher ? ', subtotal_amount, discount_amount, voucher_code_snapshot' : ''})
            VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, NOW(), '${newOnline ? 'checkout-v6' : 'checkout-v5'}'${newOnline ? ', 2, UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)' : ''}${voucher ? ', ?, ?, ?' : ''})`, [userId, payable, input.recipient_name, input.shipping_address, input.phone,
            input.payment_method === 'COD' ? 'Chờ xử lý' : 'Chờ thanh toán', input.note, keyHash, fingerprint,
            ...(voucher ? [quote.subtotal_amount, quote.discount_amount, voucher.code] : [])]);
        if (voucher) await require('./voucher').reserveLocked(db, { voucher, orderId: created.insertId, userId, discountAmount: quote.discount_amount });
        for (const line of lines) {
            await db.execute('INSERT INTO order_details (order_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)', [created.insertId, line.product_id, line.quantity, line.price, line.subtotal]);
            await db.execute('UPDATE products SET stock_quantity = stock_quantity - ? WHERE product_id = ?', [line.quantity, line.product_id]);
        }
        await db.execute(`INSERT INTO payments (order_id, payment_method, payment_status, amount, transaction_date, created_at)
            VALUES (?, ?, ?, ?, NULL, NOW())`, [created.insertId, input.payment_method, 'Chưa thanh toán', payable]);
        await history.append(db, { orderId: created.insertId, fromStatus: null,
            toStatus: input.payment_method === 'COD' ? 'Chờ xử lý' : 'Chờ thanh toán',
            action: 'created', actorId: userId, actorName: user.full_name });
        if (input.source === 'cart') {
            for (const item of items) {
                const stored = cartItems.get(item.product_id);
                if (stored.quantity === item.quantity) {
                    await db.execute('DELETE FROM cart_items WHERE cart_id = ? AND cart_item_id = ?', [cartId, stored.cart_item_id]);
                } else {
                    await db.execute('UPDATE cart_items SET quantity = quantity - ? WHERE cart_id = ? AND cart_item_id = ?', [item.quantity, cartId, stored.cart_item_id]);
                }
            }
        }
        const order = await detail(db, userId, created.insertId);
        await db.commit();
        return { order, replayed: false };
    } catch (error) {
        // A lost COMMIT response is ambiguous: rollback may also fail, but the
        // caller must still retry with the original key to discover the outcome.
        try { await db.rollback(); } catch { /* Preserve the original failure. */ }
        if (error.code === 'ER_DUP_ENTRY') {
            error.status = 409;
            error.message = 'Order key already exists; retry with the same Idempotency-Key';
            error.code = 'ORDER_RETRY';
            error.retryable = true;
        }
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            error.status = 409;
            error.message = 'Order is busy; retry with the same Idempotency-Key';
            error.code = 'ORDER_RETRY';
            error.retryable = true;
        }
        throw error;
    } finally { db.release(); }
};

exports.get = async (userId, orderId) => {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const order = await detail(db, userId, orderId);
        await db.commit(); return order;
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
};
// null scope is reserved for the admin model, behind authenticate/authorize.
exports.readDetail = detail;
exports.list = async (userId, limit, offset, status) => {
    // One consistent snapshot for headers/details while future admin updates occur.
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const where = 'WHERE user_id = ?' + (status === undefined ? '' : ' AND status = ?');
        const params = status === undefined ? [userId] : [userId, status];
        const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM orders ${where}`, params);
        const [ids] = await db.query(`SELECT order_id FROM orders ${where} ORDER BY order_date DESC, order_id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
        const orders = [];
        for (const row of ids) orders.push(await detail(db, userId, row.order_id));
        await db.commit();
        return { total, orders };
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
};
