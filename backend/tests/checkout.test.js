const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');

let server, base, customer, admin, productId, secondProductId;
const shipping = { recipient_name: 'Người nhận riêng 🐾', shipping_address: '123 Nguyễn Trãi\nPhường Bến Thành', phone: '+84 912345678', note: 'Gọi trước\nGiao buổi sáng 🐾', payment_method: 'COD' };

async function request(path, { method = 'GET', body, token = customer?.token, key } = {}) {
    const response = await fetch(base + path, { method, headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
}
const checkout = (body, key = randomUUID(), token) => request('/api/orders', { method: 'POST', body, key, token });
const purchase = (quantity = 1, extra = {}) => ({ ...shipping, source: 'buy-now', items: [{ product_id: productId, quantity }], ...extra });
const stock = async () => (await pool.execute('SELECT stock_quantity FROM products WHERE product_id = ?', [productId]))[0][0].stock_quantity;
const cart = async () => (await request('/api/cart')).data.cart;
const counts = async () => {
    const [[row]] = await pool.execute(`SELECT (SELECT COUNT(*) FROM orders) AS orders_count,
        (SELECT COUNT(*) FROM order_details) AS details_count, (SELECT COUNT(*) FROM payments) AS payments_count`);
    return row;
};
async function add(quantity, id = productId) {
    const result = await request('/api/cart/items', { method: 'POST', body: { product_id: id, quantity } });
    assert.equal(result.status, 200);
    return result.data.cart;
}

before(async () => {
    assert.equal(process.env.DB_NAME, process.env.PETCARE_TEST_DATABASE, 'SQL tests must target the disposable database');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    for (const role of ['user', 'admin']) {
        const email = `checkout-${randomUUID()}@example.test`;
        const registered = await request('/api/auth/register', { method: 'POST', token: null, body: { full_name: 'Test account', email, password: 'Checkout-test-2026!' } });
        assert.equal(registered.status, 201);
        const login = await request('/api/auth/login', { method: 'POST', token: null, body: { email, password: 'Checkout-test-2026!' } });
        assert.equal(login.status, 200);
        const account = { id: registered.data.user.user_id, token: login.data.token };
        if (role === 'admin') { await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', ['admin', account.id]); admin = account; }
        else customer = account;
    }
    const [[category]] = await pool.query('SELECT category_id FROM categories ORDER BY category_id LIMIT 1');
    for (const name of ['Checkout quantity fixture', 'Checkout unselected fixture']) {
        const [result] = await pool.execute('INSERT INTO products (category_id,name,description,price,stock_quantity,image_url,status,created_at) VALUES (?,?,NULL,12.35,100,?,?,NOW())', [category.category_id, name, '/images/products/test.webp', 'Đang bán']);
        if (!productId) productId = result.insertId; else secondProductId = result.insertId;
    }
});

after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
});

test('checkout validates the exact items contract and rejects browser prices without writes', async () => {
    const baseline = await counts();
    const invalid = [
        { items: [] }, { items: [{ product_id: productId, quantity: 0 }] },
        { items: [{ product_id: productId, quantity: '2' }] },
        { items: [{ product_id: productId, quantity: 1 }, { product_id: productId, quantity: 2 }] },
        { items: [{ product_id: productId, quantity: 2147483648 }] },
        { items: [{ product_id: productId, quantity: 1, price: '0.01' }] },
        { total_amount: '0.01' }, { cart_item_ids: [1] }, { source: 'guest' },
        { source: 'buy-now', items: [{ product_id: productId, quantity: 1 }, { product_id: secondProductId, quantity: 1 }] },
        { recipient_name: '' }, { recipient_name: 'x'.repeat(101) }, { recipient_name: 'Name\nBreak' },
        { shipping_address: 'abcd' }, { shipping_address: 'x'.repeat(256) },
        { phone: '------' }, { phone: '12345' }, { note: 'x'.repeat(201) }, { note: '\u0000' },
        { recipient_name: '\ud800' }, { payment_method: 'PAID' },
    ];
    for (const extra of invalid) assert.equal((await checkout(purchase(1, extra))).status, 400, JSON.stringify(extra));
    assert.deepEqual(await counts(), baseline);
});

test('cart checkout after guest merge purchases only snapshot quantity and leaves the remainder', async () => {
    await add(2);
    await add(4, secondProductId);
    const merged = await request('/api/cart/merge', { method: 'POST', body: { items: [{ product_id: productId, quantity: 3, selected: true }] }, key: randomUUID() });
    assert.equal(merged.status, 200);
    assert.equal(merged.data.cart.items.find(row => row.product_id === productId).quantity, 5);
    const beforeStock = await stock();
    const result = await checkout(purchase(3, { source: 'cart' }));
    assert.equal(result.status, 201);
    assert.equal(result.data.order.items[0].quantity, 3);
    assert.equal(result.data.order.total_amount, '37.05');
    assert.equal(result.data.order.payment_status, 'Chưa thanh toán');
    assert.equal(result.data.order.status, 'Chờ xử lý');
    assert.equal(await stock(), beforeStock - 3);
    const remaining = await cart();
    assert.equal(remaining.items.find(row => row.product_id === productId).quantity, 2);
    assert.equal(remaining.items.find(row => row.product_id === secondProductId).quantity, 4);
    const exhausted = await checkout(purchase(2, { source: 'cart' }));
    assert.equal(exhausted.status, 201);
    assert.equal((await cart()).items.some(row => row.product_id === productId), false);
    assert.equal((await cart()).items.find(row => row.product_id === secondProductId).quantity, 4);
});

test('buy-now uses MySQL prices and leaves the account cart byte-for-byte unchanged', async () => {
    await add(5);
    const beforeCart = await cart(), beforeStock = await stock();
    await pool.execute('UPDATE products SET price = ? WHERE product_id = ?', ['19.99', productId]);
    // Refresh the cart only to exclude the legitimate catalog price update from
    // the assertion about cart contents. No cart writes are made by buy-now.
    const refreshedCart = await cart();
    const result = await checkout(purchase(3));
    assert.equal(result.status, 201);
    assert.equal(result.data.order.total_amount, '59.97');
    assert.equal(result.data.order.items[0].unit_price, '19.99');
    assert.equal(await stock(), beforeStock - 3);
    const afterCart = await cart();
    assert.deepEqual(afterCart.items.map(({ cart_item_id, product_id, quantity, selected }) => ({ cart_item_id, product_id, quantity, selected })), beforeCart.items.map(({ cart_item_id, product_id, quantity, selected }) => ({ cart_item_id, product_id, quantity, selected })));
    assert.equal(afterCart.selected_subtotal, refreshedCart.selected_subtotal);
});

test('recipient snapshot and Unicode multiline delivery fields survive profile changes', async () => {
    const result = await checkout(purchase());
    assert.equal(result.status, 201);
    const id = result.data.order.order_id;
    await pool.execute('UPDATE `user` SET full_name = ? WHERE user_id = ?', ['Changed account name', customer.id]);
    const saved = (await request(`/api/orders/${id}`)).data.order;
    assert.equal(saved.recipient_name, shipping.recipient_name);
    assert.equal(saved.phone, shipping.phone);
    assert.equal(saved.shipping_address, shipping.shipping_address);
    assert.equal(saved.note, shipping.note);
});

test('insufficient stock, missing products and excessive cart quantity roll back without side effects', async () => {
    const beforeCart = await cart(), beforeStock = await stock(), baseline = await counts();
    for (const body of [purchase(beforeStock + 1), purchase(6, { source: 'cart' }), purchase(1, { items: [{ product_id: 2147483647, quantity: 1 }] })]) {
        assert.equal((await checkout(body)).status, 409);
        assert.deepEqual(await counts(), baseline);
        assert.equal(await stock(), beforeStock);
        assert.deepEqual(await cart(), beforeCart);
    }
});

test('expired session cannot create an order; reauthentication can reuse the same purchase and key', async () => {
    const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: String(customer.id), expiresIn: -1 });
    const baseline = await counts(), beforeStock = await stock(), key = randomUUID(), body = purchase();
    assert.equal((await checkout(body, key, expired)).status, 401);
    assert.deepEqual(await counts(), baseline);
    assert.equal(await stock(), beforeStock);
    assert.equal((await checkout(body, key, customer.token)).status, 201);
});

test('concurrent double-click and lost-response retry commit one order and consume stock once', async () => {
    const key = randomUUID(), body = purchase(2), baseline = await counts(), beforeStock = await stock();
    const responses = await Promise.all(Array.from({ length: 5 }, () => checkout(body, key)));
    assert.equal(responses.filter(result => result.status === 201).length, 1);
    assert.ok(responses.every(result => [200, 201].includes(result.status)));
    const id = responses[0].data.order.order_id;
    assert.ok(responses.every(result => result.data.order.order_id === id));
    const replay = await checkout(body, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);
    assert.equal(replay.data.order.order_id, id);
    assert.equal(await stock(), beforeStock - 2);
    assert.deepEqual(await counts(), { orders_count: baseline.orders_count + 1, details_count: baseline.details_count + 1, payments_count: baseline.payments_count + 1 });
    assert.equal((await checkout({ ...body, note: 'Different purchase' }, key)).status, 409);
});

test('payment insert failure rolls back header, details, stock and cart; retry with the same key succeeds', async () => {
    const baseline = await counts(), beforeStock = await stock(), beforeCart = await cart();
    const key = randomUUID(), body = purchase(2, { source: 'cart' });
    const originalGetConnection = pool.getConnection;
    pool.getConnection = async function () {
        const db = await originalGetConnection.call(pool), execute = db.execute.bind(db), release = db.release.bind(db);
        db.execute = (sql, params) => { if (sql.startsWith('INSERT INTO payments')) throw new Error('Injected checkout payment write failure'); return execute(sql, params); };
        db.release = () => { db.execute = execute; db.release = release; release(); };
        return db;
    };
    try { assert.equal((await checkout(body, key)).status, 500); }
    finally { pool.getConnection = originalGetConnection; }
    assert.deepEqual(await counts(), baseline);
    assert.equal(await stock(), beforeStock);
    assert.deepEqual(await cart(), beforeCart);
    assert.equal((await checkout(body, key)).status, 201);
});

test('failure after actual cart quantity update or deletion rolls back the entire order', async () => {
    // The previous rollback case fails before cart changes. This one lets SQL
    // modify/delete the cart row, then fails the final receipt read before COMMIT.
    for (const exhaust of [false, true]) {
        const current = (await cart()).items.find(item => item.product_id === productId)?.quantity || 0;
        if (current < 3) await add(3 - current);
        const beforeCart = await cart(), beforeStock = await stock(), baseline = await counts();
        const available = beforeCart.items.find(item => item.product_id === productId).quantity;
        const body = purchase(exhaust ? available : 1, { source: 'cart' }), key = randomUUID();
        const originalGetConnection = pool.getConnection;
        let cartWritten = false;
        pool.getConnection = async function () {
            const db = await originalGetConnection.call(pool), execute = db.execute.bind(db), release = db.release.bind(db);
            db.execute = async (sql, params) => {
                if (cartWritten && sql.startsWith('SELECT o.*')) throw new Error('Injected failure after cart write');
                const result = await execute(sql, params);
                if (/^(?:UPDATE cart_items SET quantity|DELETE FROM cart_items)/.test(sql)) cartWritten = true;
                return result;
            };
            db.release = () => { db.execute = execute; db.release = release; release(); };
            return db;
        };
        try { assert.equal((await checkout(body, key)).status, 500); }
        finally { pool.getConnection = originalGetConnection; }
        assert.equal(cartWritten, true, 'The failure must follow a real cart SQL mutation');
        assert.deepEqual(await counts(), baseline);
        assert.equal(await stock(), beforeStock);
        assert.deepEqual(await cart(), beforeCart);
        assert.equal((await checkout(body, key)).status, 201);
    }
});

test('ONLINE stays unpaid until admin approval and explicit simulation', async () => {
    const created = await checkout(purchase(1, { payment_method: 'ONLINE' }));
    assert.equal(created.status, 201);
    const order = created.data.order;
    assert.equal(order.status, 'Chờ thanh toán');
    assert.equal(order.payment_status, 'Chưa thanh toán');
    assert.equal(order.approved_at, null);
    assert.equal(order.transaction_date, null);
    const simulation = () => request(`/api/orders/${order.order_id}/payment/simulate`, { method: 'POST', body: { test_case: 'ONLINE_SUCCESS' } });
    assert.equal((await simulation()).status, 409);
    assert.equal((await request(`/api/admin/orders/${order.order_id}/approve`, { method: 'PATCH', token: admin.token, body: {} })).status, 200);
    assert.equal((await request(`/api/orders/${order.order_id}`)).data.order.payment_status, 'Chưa thanh toán');
    assert.equal((await simulation()).status, 200);
    assert.equal((await request(`/api/orders/${order.order_id}`)).data.order.payment_status, 'Đã thanh toán');
});
