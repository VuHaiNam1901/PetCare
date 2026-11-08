const { createHash } = require('node:crypto');
const pool = require('../config/db');

function fail(status, message, conflicts) {
    throw Object.assign(new Error(message), { status, ...(conflicts ? { conflicts } : {}) });
}

// Serialize every writer on the authenticated owner, including first creation.
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
    } finally { connection.release(); }
}

const cents = value => {
    const [whole, fraction = ''] = String(value).split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
};
const decimal = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

function availability(item) {
    if (item.status == null) return 'Sản phẩm không còn tồn tại';
    if (item.status !== 'Đang bán') return 'Sản phẩm đã ngừng bán';
    if (Number(item.stock_quantity) <= 0) return 'Sản phẩm đã hết hàng';
    if (item.quantity > Number(item.stock_quantity)) return `Số lượng vượt tồn kho hiện tại (${item.stock_quantity})`;
    return '';
}

function summarize(cartId, rows) {
    let subtotal = 0n, selectedSubtotal = 0n, selectedQuantity = 0, selectedCount = 0;
    const items = rows.map(row => {
        const message = availability(row);
        const lineCents = row.price == null ? 0n : cents(row.price) * BigInt(row.quantity);
        const selected = Boolean(row.selected) && !message;
        subtotal += lineCents;
        if (selected) { selectedSubtotal += lineCents; selectedQuantity += Number(row.quantity); selectedCount++; }
        return { ...row, quantity: Number(row.quantity), selected, available: !message, availability_message: message, line_total: row.price == null ? null : decimal(lineCents) };
    });
    return { cart_id: cartId ?? null, items, total_quantity: items.reduce((sum, item) => sum + item.quantity, 0), subtotal: decimal(subtotal), selected_subtotal: decimal(selectedSubtotal), selected_quantity: selectedQuantity, selected_count: selectedCount };
}

async function read(connection, cartId) {
    if (!cartId) return summarize(null, []);
    const [items] = await connection.execute(`
        SELECT ci.cart_item_id, ci.product_id, p.name, p.image_url, p.price,
               p.stock_quantity, p.status, ci.quantity, ci.selected
        FROM cart_items ci JOIN products p ON p.product_id = ci.product_id
        WHERE ci.cart_id = ? ORDER BY ci.cart_item_id`, [cartId]);
    return summarize(cartId, items);
}

async function product(connection, productId, quantity) {
    const [rows] = await connection.execute('SELECT product_id, status, stock_quantity FROM products WHERE product_id = ? FOR SHARE', [productId]);
    if (!rows.length) fail(404, 'Product not found');
    if (rows[0].status !== 'Đang bán') fail(409, 'Product is not available for sale');
    if (quantity > rows[0].stock_quantity) fail(409, 'Quantity exceeds available stock');
}

exports.get = userId => transaction(userId, (connection, cartId) => read(connection, cartId));

exports.preview = async items => {
    if (!items.length) return summarize(null, []);
    const [products] = await pool.execute(`SELECT product_id, name, image_url, price, stock_quantity, status FROM products WHERE product_id IN (${items.map(() => '?').join(',')})`, items.map(item => item.product_id));
    const byId = new Map(products.map(item => [item.product_id, item]));
    return summarize(null, items.map(item => {
        const current = byId.get(item.product_id);
        return { cart_item_id: null, ...(current || { product_id: item.product_id, name: `Sản phẩm #${item.product_id}`, image_url: null, price: null, stock_quantity: 0, status: null }), quantity: item.quantity, selected: item.selected };
    }));
};

exports.add = (userId, productId, quantity) => transaction(userId, async (connection, cartId) => {
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

exports.selection = (userId, productIds) => transaction(userId, async (connection, cartId) => {
    if (!cartId) {
        if (productIds.length) fail(404, 'Cart item not found');
        return read(connection, null);
    }
    const [items] = await connection.execute('SELECT cart_item_id, product_id, quantity FROM cart_items WHERE cart_id = ? ORDER BY product_id FOR UPDATE', [cartId]);
    const byId = new Map(items.map(item => [item.product_id, item]));
    for (const id of [...productIds].sort((a, b) => a - b)) {
        if (!byId.has(id)) fail(404, 'Cart item not found');
        await product(connection, id, byId.get(id).quantity);
    }
    await connection.execute('UPDATE cart_items SET selected = 0 WHERE cart_id = ?', [cartId]);
    if (productIds.length) await connection.execute(`UPDATE cart_items SET selected = 1 WHERE cart_id = ? AND product_id IN (${productIds.map(() => '?').join(',')})`, [cartId, ...productIds]);
    return read(connection, cartId);
});

exports.merge = (userId, items, key) => transaction(userId, async (connection, cartId) => {
    const canonical = [...items].sort((a, b) => a.product_id - b.product_id);
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const keyHash = createHash('sha256').update(key.toLowerCase()).digest('hex');
    const [previous] = await connection.execute('SELECT request_fingerprint FROM cart_merge_requests WHERE user_id = ? AND idempotency_key_hash = ?', [userId, keyHash]);
    if (previous.length) {
        if (previous[0].request_fingerprint !== fingerprint) fail(409, 'Merge key was already used for a different guest cart');
        return { cart: await read(connection, cartId), replayed: true };
    }
    if (canonical.length) {
        const [existing] = cartId ? await connection.execute('SELECT cart_item_id, product_id, quantity FROM cart_items WHERE cart_id = ? ORDER BY product_id FOR UPDATE', [cartId]) : [[]];
        const existingById = new Map();
        for (const item of existing) {
            if (existingById.has(item.product_id)) fail(409, 'Duplicate cart items exist; data cleanup required');
            existingById.set(item.product_id, item);
        }
        const [products] = await connection.execute(`SELECT product_id, name, status, stock_quantity FROM products WHERE product_id IN (${canonical.map(() => '?').join(',')}) ORDER BY product_id FOR SHARE`, canonical.map(item => item.product_id));
        const productsById = new Map(products.map(item => [item.product_id, item]));
        const conflicts = [];
        for (const item of canonical) {
            const current = productsById.get(item.product_id);
            const existingQuantity = existingById.get(item.product_id)?.quantity || 0;
            const quantity = existingQuantity + item.quantity;
            const reason = availability({ ...current, quantity });
            if (reason) conflicts.push({ product_id: item.product_id, name: current?.name || `Sản phẩm #${item.product_id}`, requested_quantity: quantity, account_quantity: existingQuantity, guest_quantity: item.quantity, stock_quantity: current?.stock_quantity ?? 0, status: current?.status ?? null, reason });
        }
        if (conflicts.length) fail(409, 'Không thể hợp nhất giỏ hàng. Hãy điều chỉnh các sản phẩm được liệt kê rồi thử lại.', conflicts);
        if (!cartId) {
            const [created] = await connection.execute('INSERT INTO carts (user_id, created_at) VALUES (?, NOW())', [userId]);
            cartId = created.insertId;
        }
        await connection.execute('UPDATE cart_items SET selected = 0 WHERE cart_id = ?', [cartId]);
        for (const item of canonical) {
            const existingItem = existingById.get(item.product_id);
            if (existingItem) await connection.execute('UPDATE cart_items SET quantity = ?, selected = ? WHERE cart_item_id = ? AND cart_id = ?', [existingItem.quantity + item.quantity, Number(item.selected), existingItem.cart_item_id, cartId]);
            else await connection.execute('INSERT INTO cart_items (cart_id, product_id, quantity, selected, created_at) VALUES (?, ?, ?, ?, NOW())', [cartId, item.product_id, item.quantity, Number(item.selected)]);
        }
    }
    await connection.execute('INSERT INTO cart_merge_requests (user_id, idempotency_key_hash, request_fingerprint, created_at) VALUES (?, ?, ?, NOW())', [userId, keyHash, fingerprint]);
    return { cart: await read(connection, cartId), replayed: false };
});
