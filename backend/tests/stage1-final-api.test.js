// Final-review regressions. The Stage 1 runner supplies only synthetic rows in
// an isolated schema; importing the HTTP app does not start the expiry worker.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');

let server, base, productId, foreignId, legacyBefore;
const ownerId = 1, adminId = 2;
const token = id => jwt.sign({}, process.env.JWT_SECRET, { subject: String(id), expiresIn: '5m' });
const ownerToken = token(ownerId), adminToken = token(adminId);
const query = values => new URLSearchParams(values).toString();

async function legacySnapshot() {
    const result = {};
    for (const table of ['orders', 'payments', 'order_details', 'order_status_history']) {
        result[table] = (await pool.query(`SELECT * FROM \`${table}\` WHERE order_id IN (173,174) ORDER BY 1`))[0];
    }
    return result;
}
async function stock() {
    return (await pool.execute('SELECT stock_quantity FROM products WHERE product_id=?', [productId]))[0][0].stock_quantity;
}
async function request(path, { method = 'GET', body, bearer = ownerToken, key } = {}) {
    const response = await fetch(base + path, { method, headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    assert.equal(/"(?:idempotency_key_hash|request_fingerprint|password)"/.test(JSON.stringify(data)), false);
    return { status: response.status, data };
}
function input(method = 'ONLINE') {
    return { source: 'buy-now', items: [{ product_id: productId, quantity: 2 }],
        recipient_name: 'Final review synthetic recipient', shipping_address: '123 Synthetic Review Street',
        phone: '0900000000', payment_method: method, note: 'Synthetic HTTP coverage only' };
}
async function create(method = 'ONLINE') {
    const result = await request('/api/orders', { method: 'POST', body: input(method), key: randomUUID() });
    assert.equal(result.status, 201);
    return result.data.order;
}
async function pay(order) {
    const result = await request(`/api/orders/${order.order_id}/payment/simulate`, {
        method: 'POST', body: { test_case: 'ONLINE_SUCCESS' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.payment.order_status, 'Chờ xử lý');
    assert.equal(result.data.payment.payment_status, 'Đã thanh toán');
    return result.data.payment;
}
const approve = order => request(`/api/admin/orders/${order.order_id}/approve`, { method: 'PATCH', body: {}, bearer: adminToken });
const reject = (order, reason) => request(`/api/admin/orders/${order.order_id}/reject`, { method: 'PATCH', body: { reason }, bearer: adminToken });
const status = (order, value, extra = {}) => request(`/api/admin/orders/${order.order_id}/status`, {
    method: 'PATCH', body: { status: value, ...extra }, bearer: adminToken,
});

before(async () => {
    assert.match(process.env.DB_NAME || '', /^petcare_test_[a-f0-9]{32}$/);
    assert.equal(process.env.DB_NAME, process.env.PETCARE_TEST_DATABASE);
    assert.equal(process.env.PETCARE_TEST_ISOLATED, '1');
    const [[selected]] = await pool.query('SELECT DATABASE() name');
    assert.equal(selected.name, process.env.PETCARE_TEST_DATABASE);
    const [[category]] = await pool.query('SELECT category_id FROM categories ORDER BY category_id LIMIT 1');
    const [product] = await pool.execute(`INSERT INTO products
        (category_id,name,description,price,stock_quantity,image_url,status,created_at)
        VALUES (?,'Final review synthetic item','Invented HTTP fixture','12345.67',1000,'/images/products/test.webp','Đang bán',NOW())`, [category.category_id]);
    productId = product.insertId;
    const [foreign] = await pool.execute(`INSERT INTO \`user\`
        (full_name,email,password,phone,address,role,status,created_at)
        VALUES ('Synthetic foreign HTTP user',?,'unused-synthetic-password-hash',NULL,NULL,'user','active',NOW())`, [`final-review-${randomUUID()}@example.test`]);
    foreignId = foreign.insertId;
    legacyBefore = await legacySnapshot();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    try { assert.deepEqual(await legacySnapshot(), legacyBefore, 'Final HTTP tests must not alter synthetic legacy orders 173/174'); }
    finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await pool.end();
    }
});

test('v2 HTTP payment remains owner-scoped and cannot accept caller payment/provider assertions', async () => {
    const order = await create();
    assert.equal(order.workflow_version, 2);
    assert.equal(order.approval_state, 'awaiting_payment');
    const info = await request(`/api/orders/${order.order_id}/payment`);
    assert.equal(info.status, 200);
    assert.equal(info.data.payment.can_simulate, true);
    assert.equal(info.data.payment.approved_at, null);
    for (const path of [`/api/orders/${order.order_id}`, `/api/orders/${order.order_id}/payment`]) {
        assert.equal((await request(path, { bearer: null })).status, 401);
        assert.equal((await request(path, { bearer: token(foreignId) })).status, 404);
    }
    assert.equal((await request(`/api/orders/${order.order_id}/payment/simulate`, {
        method: 'POST', bearer: token(foreignId), body: { test_case: 'ONLINE_SUCCESS' },
    })).status, 404);
    for (const extra of [{ verified: true }, { amount: '1.00' }, { paid_at_utc: new Date().toISOString() }, { payment_status: 'Đã thanh toán' }]) {
        assert.equal((await request(`/api/orders/${order.order_id}/payment/simulate`, {
            method: 'POST', body: { test_case: 'ONLINE_SUCCESS', ...extra },
        })).status, 400);
    }
    assert.equal((await request(`/api/admin/orders/${order.order_id}/approve`, { method: 'PATCH', body: {} })).status, 403);
    assert.equal((await request(`/api/admin/orders/${order.order_id}/approve`, {
        method: 'PATCH', body: { payment_status: 'Đã thanh toán' }, bearer: adminToken,
    })).status, 400);
    assert.equal((await approve(order)).status, 409);
    assert.equal((await request(`/api/orders/${order.order_id}`)).data.order.payment_status, 'Chưa thanh toán');
});

test('Admin HTTP pending filters distinguish v2 unpaid, v2 paid and legacy orders without duplicate pagination', async () => {
    const unpaid = await create(), paid = await create();
    await pay(paid);
    const filtered = async id => request(`/api/admin/orders?${query({ approval: 'pending', q: `#${id}` })}`, { bearer: adminToken });
    assert.equal((await filtered(unpaid.order_id)).data.total, 0);
    const paidList = await filtered(paid.order_id);
    assert.equal(paidList.status, 200);
    assert.equal(paidList.data.total, 1);
    assert.equal(paidList.data.orders[0].approval_state, 'pending');
    assert.deepEqual(paidList.data.orders[0].allowed_actions, ['approve', 'reject']);
    for (const id of [173, 174]) {
        const legacy = await filtered(id);
        assert.equal(legacy.status, 200);
        assert.equal(legacy.data.total, 1, `Synthetic legacy #${id} keeps its pending approval semantics`);
        assert.equal(legacy.data.orders[0].workflow_version, null);
    }
    const first = await request('/api/admin/orders?approval=pending&limit=2&page=1', { bearer: adminToken });
    const second = await request('/api/admin/orders?approval=pending&limit=2&page=2', { bearer: adminToken });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.data.total, second.data.total);
    assert.ok(first.data.total >= 3);
    assert.equal(new Set([...first.data.orders, ...second.data.orders].map(order => order.order_id)).size,
        first.data.orders.length + second.data.orders.length);
    const detail = await request(`/api/admin/orders/${paid.order_id}`, { bearer: adminToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.order.payment_status, 'Đã thanh toán');
    assert.deepEqual(detail.data.order.refunds, []);
});

test('paid v2 HTTP approval, shipping and delivery are ordered and repeated actions do not move stock or history twice', async () => {
    const order = await create();
    const held = await stock();
    await pay(order);
    assert.equal((await status(order, 'Đang giao hàng')).status, 409);
    const approved = await approve(order);
    assert.equal(approved.status, 200);
    assert.equal(approved.data.order.status, 'Chờ giao hàng');
    assert.equal((await approve(order)).status, 200);
    assert.equal((await status(order, 'Đã giao hàng')).status, 409);
    assert.equal((await status(order, 'Đang giao hàng', { cod_payment_received: true })).status, 409);
    assert.equal((await status(order, 'Đang giao hàng')).status, 200);
    assert.equal((await status(order, 'Đang giao hàng')).status, 200);
    assert.equal((await status(order, 'Đã giao hàng')).status, 200);
    assert.equal((await status(order, 'Đã giao hàng')).status, 200);
    const final = (await request(`/api/orders/${order.order_id}`)).data.order;
    assert.equal(final.status, 'Đã giao hàng');
    assert.equal(final.payment_status, 'Đã thanh toán');
    assert.equal(final.history.filter(event => event.action === 'approve').length, 1);
    assert.equal(final.history.filter(event => event.action === 'status').length, 2);
    assert.equal(await stock(), held);
    assert.equal((await reject(order, 'Already approved order')).status, 409);
});

test('concurrent paid v2 HTTP rejections retain payment evidence and one requested refund/inventory release', async () => {
    const order = await create();
    await pay(order);
    const held = await stock();
    const results = await Promise.all(Array.from({ length: 4 }, () => reject(order, 'Synthetic final review rejection')));
    assert.ok(results.every(result => result.status === 200));
    const final = (await request(`/api/orders/${order.order_id}`)).data.order;
    assert.equal(final.status, 'Đã hủy');
    assert.equal(final.payment_status, 'Đã thanh toán');
    assert.ok(final.transaction_date);
    assert.equal(final.refunds.length, 1);
    assert.equal(final.refunds[0].status, 'requested');
    assert.equal(final.refunds[0].confirmed_at_utc, null);
    assert.equal(final.history.filter(event => event.action === 'reject').length, 1);
    assert.equal(await stock(), held + 2);
    assert.equal((await reject(order, 'Different reason')).status, 409);
    assert.equal((await approve(order)).status, 409);
});

test('paid v2 HTTP approval racing rejection commits one Admin decision and one inventory outcome', async () => {
    for (let index = 0; index < 3; index++) {
        const order = await create();
        await pay(order);
        const held = await stock();
        const results = await Promise.all([approve(order), reject(order, 'Synthetic paid decision race')]);
        assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
        const final = (await request(`/api/orders/${order.order_id}`)).data.order;
        assert.equal(final.payment_status, 'Đã thanh toán');
        assert.equal(final.history.filter(event => ['approve', 'reject'].includes(event.action)).length, 1);
        if (final.status === 'Đã hủy') {
            assert.equal(await stock(), held + 2);
            assert.equal(final.refunds.length, 1);
            assert.equal(final.refunds[0].status, 'requested');
        } else {
            assert.equal(final.status, 'Chờ giao hàng');
            assert.equal(await stock(), held);
            assert.deepEqual(final.refunds, []);
        }
    }
});

test('v2 Admin HTTP approval and fulfillment refuse a paid summary without a verified applied receipt', async () => {
    const order = await create(), held = await stock();
    // Deliberate corruption is confined to this invented fixture. A future
    // provider writer/repair must not bypass receipt proof by updating summary.
    await pool.execute("UPDATE payments SET payment_status='Đã thanh toán',transaction_date=NOW() WHERE order_id=?", [order.order_id]);
    await pool.execute("UPDATE orders SET status='Chờ xử lý' WHERE order_id=?", [order.order_id]);
    assert.equal((await approve(order)).status, 409);
    await pool.execute("UPDATE orders SET status='Chờ giao hàng',approved_at=NOW() WHERE order_id=?", [order.order_id]);
    assert.equal((await status(order, 'Đang giao hàng')).status, 409);
    await pool.execute("UPDATE orders SET status='Đang giao hàng' WHERE order_id=?", [order.order_id]);
    assert.equal((await status(order, 'Đã giao hàng')).status, 409);
    assert.equal(await stock(), held);
    const final = (await request(`/api/orders/${order.order_id}`)).data.order;
    assert.equal(final.history.filter(event => ['approve', 'status'].includes(event.action)).length, 0);
});

test('v2 Admin HTTP decisions reject mismatched canonical receipt amount/time and permit the intact receipt', async () => {
    const order = await create(), held = await stock();
    await pay(order);
    const [[capture]] = await pool.execute(`SELECT a.attempt_id,a.captured_amount,e.event_id,e.amount,
        DATE_FORMAT(e.provider_paid_at_utc,'%Y-%m-%d %H:%i:%s.%f') paid_sql
        FROM payment_attempts a JOIN payments p ON p.payment_id=a.payment_id
        JOIN payment_events e ON e.attempt_id=a.attempt_id
          AND e.event_key=SHA2(CONCAT('receipt:',a.provider,':',a.provider_environment,':',a.provider_transaction_id),256)
        WHERE p.order_id=? AND a.status='succeeded' AND a.disposition='applied'`, [order.order_id]);
    assert.ok(capture, 'The fixture must start with a genuine controlled-provider canonical receipt');
    await pool.execute("UPDATE payment_events SET amount='1.00' WHERE event_id=?", [capture.event_id]);
    try { assert.equal((await approve(order)).status, 409); }
    finally { await pool.execute('UPDATE payment_events SET amount=? WHERE event_id=?', [capture.amount, capture.event_id]); }
    await pool.execute('UPDATE payment_events SET provider_paid_at_utc=(SELECT payment_expires_at FROM orders WHERE order_id=?) WHERE event_id=?',
        [order.order_id, capture.event_id]);
    try { assert.equal((await approve(order)).status, 409); }
    finally { await pool.execute('UPDATE payment_events SET provider_paid_at_utc=? WHERE event_id=?', [capture.paid_sql, capture.event_id]); }
    assert.equal((await approve(order)).status, 200);
    await pool.execute("UPDATE payment_attempts SET captured_amount='1.00' WHERE attempt_id=?", [capture.attempt_id]);
    try { assert.equal((await status(order, 'Đang giao hàng')).status, 409); }
    finally { await pool.execute('UPDATE payment_attempts SET captured_amount=? WHERE attempt_id=?', [capture.captured_amount, capture.attempt_id]); }
    assert.equal((await status(order, 'Đang giao hàng')).status, 200);
    await pool.execute("UPDATE payment_events SET amount='1.00' WHERE event_id=?", [capture.event_id]);
    try { assert.equal((await status(order, 'Đã giao hàng')).status, 409); }
    finally { await pool.execute('UPDATE payment_events SET amount=? WHERE event_id=?', [capture.amount, capture.event_id]); }
    assert.equal((await status(order, 'Đã giao hàng')).status, 200);
    assert.equal(await stock(), held);
});

test('paid v2 HTTP rejection refuses corrupt receipt proof without releasing stock or creating a wrong refund', async () => {
    const order = await create(), held = await stock();
    await pay(order);
    const [[capture]] = await pool.execute(`SELECT e.event_id,e.amount,
        DATE_FORMAT(e.provider_paid_at_utc,'%Y-%m-%d %H:%i:%s.%f') paid_sql
        FROM payment_attempts a JOIN payments p ON p.payment_id=a.payment_id
        JOIN payment_events e ON e.attempt_id=a.attempt_id
          AND e.event_key=SHA2(CONCAT('receipt:',a.provider,':',a.provider_environment,':',a.provider_transaction_id),256)
        WHERE p.order_id=? AND a.status='succeeded' AND a.disposition='applied'`, [order.order_id]);
    assert.ok(capture);
    const refusedWithoutWrites = async () => {
        const result = await reject(order, 'Synthetic corrupt receipt rejection');
        const detail = (await request(`/api/orders/${order.order_id}`)).data.order;
        assert.deepEqual({ httpStatus: result.status, stock: await stock(), orderStatus: detail.status,
            refunds: detail.refunds.length, rejectionEvents: detail.history.filter(event => event.action === 'reject').length },
        { httpStatus: 409, stock: held, orderStatus: 'Chờ xử lý', refunds: 0, rejectionEvents: 0 });
    };
    await pool.execute("UPDATE payment_events SET amount='1.00' WHERE event_id=?", [capture.event_id]);
    try { await refusedWithoutWrites(); }
    finally { await pool.execute('UPDATE payment_events SET amount=? WHERE event_id=?', [capture.amount, capture.event_id]); }
    await pool.execute('UPDATE payment_events SET provider_paid_at_utc=(SELECT payment_expires_at FROM orders WHERE order_id=?) WHERE event_id=?',
        [order.order_id, capture.event_id]);
    try { await refusedWithoutWrites(); }
    finally { await pool.execute('UPDATE payment_events SET provider_paid_at_utc=? WHERE event_id=?', [capture.paid_sql, capture.event_id]); }
    const valid = await reject(order, 'Synthetic intact receipt rejection');
    assert.equal(valid.status, 200);
    assert.equal(valid.data.order.refunds.length, 1);
    assert.equal(valid.data.order.refunds[0].amount, capture.amount);
    assert.equal(valid.data.order.refunds[0].status, 'requested');
    assert.equal(await stock(), held + 2);
});
