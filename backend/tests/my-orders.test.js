const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');
const { states } = require('../models/admin-order');

let server, base, customerA, customerB, emptyCustomer, admin;
let baseline;
const ordersA = [];
const ordersB = [];
const forbiddenMetadata = /"idempotency_key_hash"|"request_fingerprint"|"password"/;

async function request(path, token = customerA?.token, method = 'GET', body) {
    const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(forbiddenMetadata.test(JSON.stringify(data)), false, 'Private metadata must never be exposed');
    return { status: response.status, data };
}

async function account(role = 'user') {
    const email = `my-orders-${randomUUID()}@example.test`;
    const credentials = { email, password: 'My-orders-test-2026!' };
    const registered = await request('/api/auth/register', null, 'POST', { ...credentials, full_name: 'Synthetic order owner' });
    assert.equal(registered.status, 201);
    const loggedIn = await request('/api/auth/login', null, 'POST', credentials);
    assert.equal(loggedIn.status, 200);
    const result = { id: registered.data.user.user_id, token: loggedIn.data.token };
    if (role === 'admin') await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', [role, result.id]);
    return result;
}

async function fixtureOrder(owner, status, date, products, quantity = 2) {
    const key = createHash('sha256').update(randomUUID()).digest('hex');
    const total = (1250 * quantity + 250).toFixed(2);
    const [created] = await pool.execute(`INSERT INTO orders
        (user_id, order_date, total_amount, recipient_name, shipping_address, phone, status, note, idempotency_key_hash, request_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [owner.id, date, total, 'Synthetic recipient', '123 Synthetic Test Street', '0123456789', status, 'Synthetic private delivery note', key, key]);
    for (const [index, product] of products.entries()) {
        const count = index === 0 ? quantity : 1;
        const unitPrice = index === 0 ? '1250.00' : '250.00';
        await pool.execute('INSERT INTO order_details (order_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)',
            [created.insertId, product.product_id, count, unitPrice, (Number(unitPrice) * count).toFixed(2)]);
    }
    await pool.execute(`INSERT INTO payments (order_id, payment_method, payment_status, amount, transaction_date, created_at)
        VALUES (?, 'COD', 'Chưa thanh toán', ?, NULL, NOW())`, [created.insertId, total]);
    return { id: created.insertId, status, date, quantity, total };
}

async function snapshot() {
    const rows = [];
    for (const table of ['orders', 'order_details', 'payments', 'products', 'carts', 'cart_items']) {
        rows.push((await pool.query(`SELECT * FROM \`${table}\` ORDER BY 1`))[0]);
    }
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

before(async () => {
    assert.equal(process.env.DB_NAME, process.env.PETCARE_TEST_DATABASE, 'Only the disposable database may hold test fixtures');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    customerA = await account();
    customerB = await account();
    emptyCustomer = await account();
    admin = await account('admin');
    const [products] = await pool.query("SELECT product_id FROM products WHERE status = 'Đang bán' ORDER BY product_id LIMIT 2");
    assert.equal(products.length, 2);
    const statuses = [...states, states[0], states[0]];
    for (const [index, status] of statuses.entries()) {
        ordersA.push(await fixtureOrder(customerA, status, index === statuses.length - 1 ? '2026-09-01 10:00:00' : '2026-10-30 10:00:00', products, index + 1));
    }
    ordersB.push(await fixtureOrder(customerB, states[0], '2026-11-01 10:00:00', products));
    ordersB.push(await fixtureOrder(customerB, states[4], '2026-11-02 10:00:00', products));
    baseline = await snapshot();
});

after(async () => {
    try {
        if (baseline) assert.equal(await snapshot(), baseline, 'Reading order history must not change orders, payments, stock or carts');
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await pool.end();
    }
});

test('my orders require active customer authentication for both list and detail', async () => {
    const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: String(customerA.id), expiresIn: -1 });
    const missingAccount = jwt.sign({}, process.env.JWT_SECRET, { subject: '2147483647', expiresIn: 60 });
    for (const token of [null, 'invalid-token', expired, missingAccount]) {
        for (const path of ['/api/orders', `/api/orders/${ordersA[0].id}`]) {
            assert.equal((await request(path, token)).status, 401);
        }
    }
    for (const path of ['/api/orders', `/api/orders/${ordersA[0].id}`]) assert.equal((await request(path, admin.token)).status, 403);
    await pool.execute('UPDATE `user` SET status = ? WHERE user_id = ?', ['inactive', customerA.id]);
    try {
        for (const path of ['/api/orders', `/api/orders/${ordersA[0].id}`]) assert.equal((await request(path)).status, 403);
    } finally {
        await pool.execute('UPDATE `user` SET status = ? WHERE user_id = ?', ['active', customerA.id]);
    }
});

test('my orders return only the authenticated owner including details, totals and quantities', async () => {
    const first = await request('/api/orders');
    assert.equal(first.status, 200);
    assert.equal(first.data.total, ordersA.length);
    assert.deepEqual(first.data.statuses, states);
    const expected = [...ordersA.slice(0, -1)].reverse().concat(ordersA.at(-1)).map(order => order.id);
    assert.deepEqual(first.data.orders.map(order => order.order_id), expected, 'Order date precedes the order-id tie breaker');
    for (const order of first.data.orders) {
        const fixture = ordersA.find(candidate => candidate.id === order.order_id);
        assert.equal(order.user_id, customerA.id);
        assert.equal(order.status, fixture.status);
        assert.equal(order.total_amount, fixture.total);
        assert.ok(order.order_date);
        assert.equal(order.items.length, 2);
        assert.equal(order.items[0].quantity, fixture.quantity);
        assert.equal(order.items[0].unit_price, '1250.00');
        assert.equal(typeof order.items[0].name, 'string');
    }
    const second = await request('/api/orders', customerB.token);
    assert.equal(second.data.total, ordersB.length);
    assert.ok(second.data.orders.every(order => order.user_id === customerB.id));
    const detail = await request(`/api/orders/${ordersA[0].id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.order.user_id, customerA.id);
    assert.equal((await request(`/api/orders/${ordersA[0].id}`, customerB.token)).status, 404);
    assert.equal((await request(`/api/orders/${ordersB[0].id}`)).status, 404);
});

test('owner identity cannot be supplied through query parameters or extra JWT claims', async () => {
    for (const query of [`user_id=${customerB.id}`, `userId=${customerB.id}`, `owner=${customerB.id}`]) {
        assert.equal((await request(`/api/orders?${query}`)).status, 400);
        assert.equal((await request(`/api/orders/${ordersB[0].id}?${query}`)).status, 400);
    }
    const misleadingClaims = jwt.sign({ user_id: customerB.id, role: 'admin' }, process.env.JWT_SECRET, { subject: String(customerA.id), expiresIn: 60 });
    const result = await request('/api/orders', misleadingClaims);
    assert.equal(result.status, 200);
    assert.equal(result.data.total, ordersA.length);
    assert.ok(result.data.orders.every(order => order.user_id === customerA.id));
    assert.equal((await request(`/api/orders/${ordersB[0].id}`, misleadingClaims)).status, 404);
});

test('status filtering scopes the SQL count and every paginated page to the current owner', async () => {
    const filter = encodeURIComponent(states[0]);
    const expected = [ordersA[6].id, ordersA[0].id, ordersA[7].id];
    const first = await request(`/api/orders?status=${filter}&limit=2&page=1`);
    assert.equal(first.status, 200);
    assert.equal(first.data.total, 3);
    assert.equal(first.data.page, 1);
    assert.equal(first.data.limit, 2);
    assert.deepEqual(first.data.orders.map(order => order.order_id), expected.slice(0, 2));
    const second = await request(`/api/orders?status=${filter}&limit=2&page=2`);
    assert.equal(second.data.total, 3);
    assert.deepEqual(second.data.orders.map(order => order.order_id), expected.slice(2));
    assert.equal(new Set([...first.data.orders, ...second.data.orders].map(order => order.order_id)).size, 3);
    for (const status of states) {
        const result = await request(`/api/orders?status=${encodeURIComponent(status)}`);
        const matches = ordersA.filter(order => order.status === status);
        assert.equal(result.status, 200);
        assert.equal(result.data.total, matches.length);
        assert.equal(result.data.orders.length, matches.length);
        assert.ok(result.data.orders.every(order => order.status === status && order.user_id === customerA.id));
    }
});

test('empty customer, empty status and out-of-range pages return real empty results', async () => {
    for (const path of ['/api/orders', `/api/orders?status=${encodeURIComponent(states[0])}`]) {
        const result = await request(path, emptyCustomer.token);
        assert.equal(result.status, 200);
        assert.equal(result.data.total, 0);
        assert.deepEqual(result.data.orders, []);
        assert.deepEqual(result.data.statuses, states);
    }
    const absentStatus = await request(`/api/orders?status=${encodeURIComponent(states[1])}`, customerB.token);
    assert.equal(absentStatus.status, 200);
    assert.equal(absentStatus.data.total, 0);
    assert.deepEqual(absentStatus.data.orders, []);
    const outside = await request('/api/orders?page=999&limit=2');
    assert.equal(outside.status, 200);
    assert.equal(outside.data.total, ordersA.length);
    assert.deepEqual(outside.data.orders, []);
});

test('invalid filters, duplicate parameters and pagination never broaden order access', async () => {
    const queries = [
        'status=', 'status=all', 'status=Delivered', 'status=Ch%E1%BB%9D',
        'status=__proto__', 'status%5B%5D=Ch%E1%BB%9D',
        `status=${encodeURIComponent(states[0])}&status=${encodeURIComponent(states[1])}`,
        "status=%27%20OR%201%3D1--", 'page=0', 'page=-1', 'page=1.5', 'page=2147483648',
        'page=1&page=2', 'limit=0', 'limit=101', 'limit=2.5', 'limit=2&limit=3', 'unknown=1',
    ];
    for (const query of queries) assert.equal((await request(`/api/orders?${query}`)).status, 400, query);
    for (const id of ['0', '-1', '1.5', '2147483648', 'invalid']) assert.equal((await request(`/api/orders/${id}`)).status, 400, id);
});
