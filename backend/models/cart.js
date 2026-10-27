const pool = require('../config/db');

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
}

// Serialize all cart operations for the same account, even before its cart exists.
// Every writer must use this protocol until the composite UNIQUE is added.
async function transaction(userId, action) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [users] = await connection.execute('SELECT user_id, role, status FROM `user` WHERE user_id = ? FOR UPDATE', [userId]);
        if (!users.length || users[0].role !== 'user' || users[0].status !== 'active') fail(403, 'Active user account required');
        const [carts] = await connection.execute('SELECT cart_id FROM carts WHERE user_id = ? FOR UPDATE', [userId]);
        const result = await action(connection, carts[0]?.cart_id);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            error.status = 409;
            error.message = 'Cart is busy; retry the request';
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function read(connection, cartId) {
    if (!cartId) return { cart_id: null, items: [], total_quantity: 0, subtotal: '0.00' };
    const [items] = await connection.execute(`
        SELECT ci.cart_item_id, ci.product_id, p.name, p.image_url, p.price,
               p.stock_quantity, p.status, ci.quantity,
               CAST(p.price * ci.quantity AS CHAR) AS line_total
        FROM cart_items ci JOIN products p ON p.product_id = ci.product_id
        WHERE ci.cart_id = ? ORDER BY ci.cart_item_id`, [cartId]);
    // Calculate money in MySQL DECIMAL; return decimal strings to avoid JS rounding.
    const [[totals]] = await connection.execute(`
        SELECT CAST(COALESCE(SUM(p.price * ci.quantity), 0.00) AS CHAR) AS subtotal,
               COALESCE(SUM(ci.quantity), 0) AS total_quantity
        FROM cart_items ci JOIN products p ON p.product_id = ci.product_id
        WHERE ci.cart_id = ?`, [cartId]);
    return { cart_id: cartId, items, total_quantity: Number(totals.total_quantity), subtotal: totals.subtotal };
}

async function product(connection, productId, quantity) {
    const [rows] = await connection.execute('SELECT product_id, status, stock_quantity FROM products WHERE product_id = ? FOR SHARE', [productId]);
    if (!rows.length) fail(404, 'Product not found');
    if (rows[0].status !== 'Đang bán') fail(409, 'Product is not available for sale');
    if (quantity > rows[0].stock_quantity) fail(409, 'Quantity exceeds available stock');
}

exports.get = userId => transaction(userId, (connection, cartId) => read(connection, cartId));

exports.add = (userId, productId, quantity) => transaction(userId, async (connection, cartId) => {
    // Lock product before inserting the FK child row; shared locks allow other carts.
    await product(connection, productId, quantity);
    if (!cartId) {
        const [result] = await connection.execute('INSERT INTO carts (user_id, created_at) VALUES (?, NOW())', [userId]);
        cartId = result.insertId;
    }
    const [items] = await connection.execute('SELECT cart_item_id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ? FOR UPDATE', [cartId, productId]);
    if (items.length > 1) fail(409, 'Duplicate cart items exist; data cleanup required');
    if (items.length) {
        const nextQuantity = items[0].quantity + quantity;
        await product(connection, productId, nextQuantity);
        await connection.execute('UPDATE cart_items SET quantity = ? WHERE cart_item_id = ? AND cart_id = ?', [nextQuantity, items[0].cart_item_id, cartId]);
    } else {
        await connection.execute('INSERT INTO cart_items (cart_id, product_id, quantity, selected, created_at) VALUES (?, ?, ?, ?, NOW())', [cartId, productId, quantity, 0]);
    }
    return read(connection, cartId);
});

exports.update = (userId, itemId, quantity) => transaction(userId, async (connection, cartId) => {
    if (!cartId) fail(404, 'Cart item not found');
    const [items] = await connection.execute('SELECT product_id FROM cart_items WHERE cart_item_id = ? AND cart_id = ? FOR UPDATE', [itemId, cartId]);
    if (!items.length) fail(404, 'Cart item not found');
    await product(connection, items[0].product_id, quantity);
    await connection.execute('UPDATE cart_items SET quantity = ? WHERE cart_item_id = ? AND cart_id = ?', [quantity, itemId, cartId]);
    return read(connection, cartId);
});

exports.remove = (userId, itemId) => transaction(userId, async (connection, cartId) => {
    if (!cartId) fail(404, 'Cart item not found');
    const [result] = await connection.execute('DELETE FROM cart_items WHERE cart_item_id = ? AND cart_id = ?', [itemId, cartId]);
    if (!result.affectedRows) fail(404, 'Cart item not found');
    return read(connection, cartId);
});
