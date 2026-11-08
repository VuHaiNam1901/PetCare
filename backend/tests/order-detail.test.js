const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');
const { states } = require('../models/admin-order');

let server, base, customerA, customerB, admin, baseline;
const fixtures = {};
const recipient = 'Nguyễn Thị Ánh 🐾';
const address = 'Căn hộ 1208, Tòa nhà Biển Xanh, đường Nguyễn Văn Cừ, phường An Khánh, thành phố Hồ Chí Minh\nGiao tại quầy lễ tân tầng trệt; gọi trước khi đến.';
const note = 'Xin gọi trước 15 phút.\nKhông để ngoài cửa — cảm ơn! 🐈';
const privateMetadata = /"idempotency_key_hash"|"request_fingerprint"|"password"/;

async function snapshot() {
    const rows = [];
    for (const table of ['orders', 'order_details', 'payments', 'products', 'carts', 'cart_items', 'cart_merge_requests', 'user']) {
        rows.push((await pool.query(`SELECT * FROM \`${table}\` ORDER BY 1`))[0]);
    }
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function request(path, token = customerA?.token, method = 'GET', body) {
    // Every read, including denied/invalid reads, must leave all business data
    // unchanged. Fixtures and authentication setup exist only in the runner's DB.
    const beforeRead = method === 'GET' ? await snapshot() : null;
    const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(privateMetadata.test(JSON.stringify(data)), false, 'Private authentication and retry metadata must stay private');
    if (beforeRead) assert.equal(await snapshot(), beforeRead, `${path} changed stored data`);
    return { status: response.status, data };
}

async function account(role = 'user') {
    const credentials = { email: `order-detail-${randomUUID()}@example.test`, password: 'Order-detail-test-2026!' };
    const registered = await request('/api/auth/register', null, 'POST', { ...credentials, full_name: 'Synthetic detail owner' });
    assert.equal(registered.status, 201);
    const login = await request('/api/auth/login', null, 'POST', credentials);
    assert.equal(login.status, 200);
    const result = { id: registered.data.user.user_id, token: login.data.token };
    if (role !== 'user') await pool.execute('UPDATE `user` SET role = ? WHERE user_id = ?', [role, result.id]);
    return result;
}

async function fixtureOrder(owner, products, changes = {}) {
    const settings = {
        status: 'Chờ xử lý', method: 'COD', paymentStatus: 'Chưa thanh toán',
        approval: null, transactionDate: null, restored: null, payment: true,
        paymentAmount: '2501.25', ...changes,
    };
    const key = createHash('sha256').update(randomUUID()).digest('hex');
    const [created] = await pool.execute(`INSERT INTO orders
        (user_id, order_date, total_amount, recipient_name, shipping_address, phone, status, note,
         approved_at, stock_restored_at, idempotency_key_hash, request_fingerprint, stock_reserved_at, stock_reservation_source)
        VALUES (?, '2026-01-15 09:30:00', '2501.25', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-15 09:30:00', 'test-fixture')`,
        [owner.id, recipient, address, '+84 912 345 678', settings.status, note,
            settings.approval, settings.restored, key, key]);
    const lines = [
        { productId: products[0].product_id, quantity: 2, price: '1000.50', subtotal: '2001.00' },
        { productId: products[1].product_id, quantity: 1, price: '500.25', subtotal: '500.25' },
    ];
    for (const line of lines) {
        await pool.execute('INSERT INTO order_details (order_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)',
            [created.insertId, line.productId, line.quantity, line.price, line.subtotal]);
    }
    if (settings.payment) {
        await pool.execute(`INSERT INTO payments (order_id, payment_method, payment_status, amount, transaction_date, created_at)
            VALUES (?, ?, ?, ?, ?, '2026-01-15 09:30:00')`,
            [created.insertId, settings.method, settings.paymentStatus, settings.paymentAmount, settings.transactionDate]);
    }
    return { id: created.insertId, ownerId: owner.id, lines, ...settings };
}

const paths = fixture => [`/api/orders/${fixture.id}`, `/api/orders/${fixture.id}/payment`];

before(async () => {
    assert.equal(process.env.DB_NAME, process.env.PETCARE_TEST_DATABASE);
    assert.match(process.env.DB_NAME, /^petcare_test_[a-f0-9]{32}$/);
    assert.notEqual(process.env.DB_NAME, process.env.PETCARE_TEST_SOURCE_DATABASE);
    assert.equal(process.env.PETCARE_TEST_ISOLATED, '1');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    customerA = await account();
    customerB = await account();
    admin = await account('admin');
    const [products] = await pool.query("SELECT product_id FROM products WHERE status = 'Đang bán' ORDER BY product_id LIMIT 2");
    assert.equal(products.length, 2);
    const approved = '2026-01-15 10:00:00';
    const paid = '2026-01-15 10:30:00';
    fixtures.cod = await fixtureOrder(customerA, products);
    fixtures.codReady = await fixtureOrder(customerA, products, { status: 'Chờ giao hàng', approval: approved });
    fixtures.codShipping = await fixtureOrder(customerA, products, { status: 'Đang giao hàng', approval: approved });
    fixtures.codDelivered = await fixtureOrder(customerA, products, { status: 'Đã giao hàng', approval: approved, paymentStatus: 'Đã thanh toán', transactionDate: paid });
    fixtures.onlinePending = await fixtureOrder(customerA, products, { status: 'Chờ thanh toán', method: 'ONLINE' });
    fixtures.onlineApproved = await fixtureOrder(customerA, products, { status: 'Chờ thanh toán', method: 'ONLINE', approval: approved });
    fixtures.onlineFailed = await fixtureOrder(customerA, products, { status: 'Chờ thanh toán', method: 'ONLINE', approval: approved, paymentStatus: 'Thất bại' });
    fixtures.onlinePaid = await fixtureOrder(customerA, products, { status: 'Chờ giao hàng', method: 'ONLINE', approval: approved, paymentStatus: 'Đã thanh toán', transactionDate: paid });
    fixtures.cancelled = await fixtureOrder(customerA, products, { status: 'Đã hủy', method: 'ONLINE', paymentStatus: 'Đã hủy', restored: '2026-01-15 11:00:00' });
    fixtures.futureApproval = await fixtureOrder(customerA, products, { status: 'Chờ thanh toán', method: 'ONLINE', approval: '2999-01-01 00:00:00' });
    fixtures.wrongAmount = await fixtureOrder(customerA, products, { status: 'Chờ thanh toán', method: 'ONLINE', approval: approved, paymentAmount: '1.00' });
    fixtures.noPayment = await fixtureOrder(customerA, products, { payment: false });
    fixtures.foreign = await fixtureOrder(customerB, products);
    // Deliberately change catalog prices after purchase. Reads must continue to
    // use the historical detail rows instead of silently repricing the order.
    for (const product of products) await pool.execute('UPDATE products SET price = ? WHERE product_id = ?', ['987654.32', product.product_id]);
    for (const owner of [customerA, customerB]) {
        const [cart] = await pool.execute('INSERT INTO carts (user_id, created_at) VALUES (?, NOW())', [owner.id]);
        await pool.execute('INSERT INTO cart_items (cart_id, product_id, quantity, selected, created_at) VALUES (?, ?, 17, 1, NOW())', [cart.insertId, products[0].product_id]);
    }
    baseline = await snapshot();
});

after(async () => {
    try {
        if (baseline) assert.equal(await snapshot(), baseline, 'Viewing detail/payment information mutated data');
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await pool.end();
    }
});

test('detail and payment information require the active authenticated customer', async () => {
    const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: String(customerA.id), expiresIn: -1 });
    const missing = jwt.sign({}, process.env.JWT_SECRET, { subject: '2147483647', expiresIn: 60 });
    for (const token of [null, 'invalid-token', expired, missing]) {
        for (const path of paths(fixtures.cod)) assert.equal((await request(path, token)).status, 401);
    }
    for (const path of paths(fixtures.cod)) assert.equal((await request(path, admin.token)).status, 403);
    await pool.execute('UPDATE `user` SET status = ? WHERE user_id = ?', ['inactive', customerA.id]);
    try {
        for (const path of paths(fixtures.cod)) assert.equal((await request(path)).status, 403);
    } finally {
        await pool.execute('UPDATE `user` SET status = ? WHERE user_id = ?', ['active', customerA.id]);
    }
});

test('detail and payment reads enforce ownership and conceal foreign or absent orders', async () => {
    for (const path of paths(fixtures.cod)) {
        assert.equal((await request(path)).status, 200);
        assert.equal((await request(path, customerB.token)).status, 404);
    }
    for (const path of paths(fixtures.foreign)) {
        assert.equal((await request(path, customerB.token)).status, 200);
        assert.equal((await request(path)).status, 404);
    }
    for (const path of paths({ id: 2147483647 })) assert.equal((await request(path)).status, 404);
    const misleadingClaims = jwt.sign({ user_id: customerB.id, role: 'admin' }, process.env.JWT_SECRET, { subject: String(customerA.id), expiresIn: 60 });
    for (const path of paths(fixtures.foreign)) assert.equal((await request(path, misleadingClaims)).status, 404);
});

test('IDs and every query parameter are validated without widening owner access', async () => {
    for (const id of ['0', '-1', '1.5', '01', '2147483648', '9007199254740993', 'NaN', 'invalid', '1%20OR%201%3D1']) {
        for (const path of paths({ id })) assert.equal((await request(path)).status, 400, path);
    }
    for (const suffix of [`user_id=${customerB.id}`, `userId=${customerB.id}`, `owner=${customerB.id}`, 'status=all', 'id=1&id=2', 'unknown=1']) {
        for (const path of paths(fixtures.foreign)) assert.equal((await request(`${path}?${suffix}`)).status, 400);
    }
});

test('detail preserves recipient Unicode and newlines, all products and historical prices', async () => {
    const { status, data: { order } } = await request(`/api/orders/${fixtures.cod.id}`);
    assert.equal(status, 200);
    assert.equal(order.order_id, fixtures.cod.id);
    assert.equal(order.user_id, customerA.id);
    assert.equal(order.recipient_name, recipient);
    assert.equal(order.shipping_address, address);
    assert.equal(order.phone, '+84 912 345 678');
    assert.equal(order.note, note);
    assert.equal(order.total_amount, '2501.25');
    assert.equal(order.payment_amount, '2501.25');
    assert.ok(order.order_date);
    assert.equal(order.items.length, 2);
    for (const [index, line] of order.items.entries()) {
        const expected = fixtures.cod.lines[index];
        assert.equal(line.product_id, expected.productId);
        assert.equal(line.quantity, expected.quantity);
        assert.equal(line.unit_price, expected.price);
        assert.equal(line.subtotal, expected.subtotal);
        assert.equal(typeof line.name, 'string');
        assert.ok(line.name.length);
        assert.equal(typeof line.image_url, 'string');
        assert.notEqual(line.unit_price, '987654.32');
    }
});

test('real order statuses remain separate from the real payment method/status', async () => {
    const known = new Set();
    for (const fixture of Object.values(fixtures).filter(order => order.payment && order.ownerId === customerA.id)) {
        const { data: { order } } = await request(`/api/orders/${fixture.id}`);
        assert.equal(order.status, fixture.status);
        assert.equal(order.payment_method, fixture.method);
        assert.equal(order.payment_status, fixture.paymentStatus);
        assert.equal(Boolean(order.approved_at), Boolean(fixture.approval));
        assert.equal(Boolean(order.transaction_date), Boolean(fixture.transactionDate));
        known.add(order.status);
    }
    assert.deepEqual([...known].sort(), [...states].sort());
    const cancelled = (await request(`/api/orders/${fixtures.cancelled.id}`)).data.order;
    assert.equal(cancelled.status, 'Đã hủy');
    assert.equal(cancelled.payment_status, 'Đã hủy');
    assert.ok(cancelled.stock_restored_at);
});

test('ONLINE eligibility requires valid admin approval and an unpaid consistent order', async () => {
    for (const [name, expected] of [
        ['onlinePending', false], ['onlineApproved', true], ['onlineFailed', true],
        ['onlinePaid', false], ['cancelled', false], ['futureApproval', false], ['wrongAmount', false],
    ]) {
        const fixture = fixtures[name];
        const result = await request(`/api/orders/${fixture.id}/payment`);
        assert.equal(result.status, 200);
        assert.equal(result.data.payment.order_id, fixture.id);
        assert.equal(result.data.payment.order_status, fixture.status);
        assert.equal(result.data.payment.payment_status, fixture.paymentStatus);
        assert.equal(result.data.payment.payment_method, 'ONLINE');
        assert.equal(result.data.payment.can_simulate, expected, name);
        assert.equal(result.data.payment.simulation_only, true);
        assert.equal(result.data.payment.amount, fixture.paymentAmount);
    }
});

test('COD information never allows simulated payment at any delivery stage', async () => {
    for (const fixture of [fixtures.cod, fixtures.codReady, fixtures.codShipping, fixtures.codDelivered]) {
        const result = await request(`/api/orders/${fixture.id}/payment`);
        assert.equal(result.status, 200);
        assert.equal(result.data.payment.payment_method, 'COD');
        assert.equal(result.data.payment.payment_status, fixture.paymentStatus);
        assert.equal(result.data.payment.can_simulate, false);
        assert.equal(Boolean(result.data.payment.transaction_date), Boolean(fixture.transactionDate));
    }
});

test('a legacy order without payment stays readable while eligibility reports a real conflict', async () => {
    const detail = await request(`/api/orders/${fixtures.noPayment.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.order.payment_method, null);
    assert.equal(detail.data.order.payment_status, null);
    assert.equal(detail.data.order.items.length, 2);
    const payment = await request(`/api/orders/${fixtures.noPayment.id}/payment`);
    assert.equal(payment.status, 409);
    assert.equal(payment.data.success, false);
});
