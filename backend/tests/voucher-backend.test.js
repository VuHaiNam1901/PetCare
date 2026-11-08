const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');
const { createOnlineOrderService } = require('../services/online-orders');
const service = createOnlineOrderService({ pool });
const provider = require('../providers/simulated-payments');
const voucherModel = require('../models/voucher');

const userId = 1, adminId = 2, otherId = 3;
const token = id => jwt.sign({}, process.env.JWT_SECRET, { subject: String(id), expiresIn: '10m' });
let server, base, legacyBefore;

async function request(path, { method = 'GET', body, user = userId, bearer, key } = {}) {
    const authorization = bearer === undefined ? user == null ? null : token(user) : bearer;
    const response = await fetch(base + path, { method, headers: {
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    assert.equal(/"(?:password|idempotency_key_hash|request_fingerprint)"/.test(JSON.stringify(data)), false);
    return { status: response.status, data };
}
async function nowUtc() {
    const [[row]] = await pool.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') now_utc");
    return new Date(row.now_utc).getTime();
}
async function voucher(changes = {}) {
    const now = await nowUtc();
    const body = { code: `V_${randomUUID().replace(/-/g, '').toUpperCase()}`, discount_type: 'percent', discount_value: '10.00',
        minimum_order_amount: '0.00', max_discount_amount: null, starts_at_utc: new Date(now - 3600000).toISOString(),
        ends_at_utc: new Date(now + 3600000).toISOString(), total_limit: null, per_user_limit: null, status: 'active', ...changes };
    const result = await request('/api/admin/vouchers', { method: 'POST', body, user: adminId });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.voucher;
}
const update = (saved, body) => request(`/api/admin/vouchers/${saved.voucher_id}`, { method: 'PATCH', body, user: adminId });
const disable = saved => request(`/api/admin/vouchers/${saved.voucher_id}/disable`, { method: 'PATCH', body: {}, user: adminId });
function checkout(code, { method = 'COD', productId = 1, quantity = 1 } = {}) {
    return { source: 'buy-now', items: [{ product_id: productId, quantity }], recipient_name: 'Voucher synthetic checkout',
        shipping_address: '123 Invented Checkout Street', phone: '0900000000', payment_method: method, note: null,
        ...(code === undefined ? {} : { voucher_code: code }) };
}
const create = (code, { user = userId, key = randomUUID(), ...options } = {}) =>
    request('/api/orders', { method: 'POST', body: checkout(code, options), user, key });
const quote = (saved, options = {}) => request('/api/vouchers/quote', { method: 'POST', body: {
    code: typeof saved === 'string' ? saved : saved.code, items: [{ product_id: options.productId || 1, quantity: options.quantity || 1 }],
    payment_method: options.method || 'COD', ...(options.extra || {}),
}, user: options.user === undefined ? userId : options.user });
const approve = order => request(`/api/admin/orders/${order.order_id}/approve`, { method: 'PATCH', body: {}, user: adminId });
const reject = (order, reason = 'Synthetic voucher rejection') => request(`/api/admin/orders/${order.order_id}/reject`, { method: 'PATCH', body: { reason }, user: adminId });
const pay = order => request(`/api/orders/${order.order_id}/payment/simulate`, { method: 'POST', body: { test_case: 'ONLINE_SUCCESS' } });
async function redemption(orderId) {
    const [rows] = await pool.execute('SELECT * FROM voucher_redemptions WHERE order_id=?', [orderId]);
    assert.equal(rows.length, 1);
    return rows[0];
}
async function stock(id = 1) {
    return (await pool.execute('SELECT stock_quantity FROM products WHERE product_id=?', [id]))[0][0].stock_quantity;
}
async function legacySnapshot() {
    const result = {};
    for (const table of ['orders', 'payments', 'order_details', 'order_status_history']) {
        result[table] = (await pool.query(`SELECT * FROM \`${table}\` WHERE order_id IN (173,174) ORDER BY 1`))[0];
    }
    return result;
}
async function backdate(order, attempt) {
    const deadline = new Date((await nowUtc()) - 3600000);
    const created = new Date(deadline.getTime() - 86400000);
    const sql = value => value.toISOString().slice(0, 23).replace('T', ' ');
    await pool.execute('UPDATE orders SET created_at_utc=?,payment_expires_at=? WHERE order_id=?', [sql(created), sql(deadline), order.order_id]);
    if (attempt) await pool.execute('UPDATE payment_attempts SET initiated_at_utc=? WHERE attempt_id=?', [sql(created), attempt.attempt_id]);
    return { deadline, paidAtUtc: new Date(deadline.getTime() - 1).toISOString() };
}
async function evidence(attempt, changes = {}) {
    return provider.issuePaymentEvent({ merchantReference: attempt.merchant_reference, amount: attempt.amount,
        status: 'succeeded', paidAtUtc: new Date(await nowUtc()).toISOString(), ...changes });
}

before(async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.PETCARE_TEST_ISOLATED, '1');
    assert.equal(process.env.DB_NAME, process.env.PETCARE_TEST_DATABASE);
    assert.match(process.env.DB_NAME || '', /^petcare_test_[a-f0-9]{32}$/);
    assert.notEqual(process.env.DB_NAME, process.env.PETCARE_TEST_SOURCE_DATABASE);
    const [[selected]] = await pool.query('SELECT DATABASE() database_name');
    assert.equal(selected.database_name, process.env.PETCARE_TEST_DATABASE);
    legacyBefore = await legacySnapshot();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    try { assert.deepEqual(await legacySnapshot(), legacyBefore); }
    finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await pool.end(); }
});

test('Voucher APIs enforce authentication and current role without accepting browser-owned prices', async () => {
    const saved = await voucher();
    assert.equal((await request('/api/admin/vouchers', { user: null })).status, 401);
    assert.equal((await request('/api/admin/vouchers', { user: userId })).status, 403);
    assert.equal((await request('/api/vouchers/quote', { method: 'POST', user: null, body: { code: saved.code, items: [{ product_id: 1, quantity: 1 }], payment_method: 'COD' } })).status, 401);
    assert.equal((await quote(saved, { user: adminId })).status, 403);
    for (const extra of [{ subtotal_amount: '0.01' }, { discount_amount: '999999.00' }, { total_amount: '0.01' }]) {
        assert.equal((await quote(saved, { extra })).status, 400);
    }
    assert.equal((await request('/api/vouchers/quote', { method: 'POST', body: { code: saved.code,
        items: [{ product_id: 1, quantity: 1, unit_price: '0.01' }], payment_method: 'COD' } })).status, 400);
    assert.equal((await request('/api/orders', { method: 'POST', body: { ...checkout(saved.code), discount_amount: '99999.00' }, key: randomUUID() })).status, 400);
});

test('Admin can create, list, update and disable vouchers; no hard-delete endpoint exists', async () => {
    const saved = await voucher({ status: 'draft' });
    const found = await request(`/api/admin/vouchers/${saved.voucher_id}`, { user: adminId });
    assert.equal(found.status, 200);
    assert.equal(found.data.voucher.code, saved.code);
    const listed = await request(`/api/admin/vouchers?page=1&limit=10&status=draft&q=${saved.code}`, { user: adminId });
    assert.equal(listed.status, 200);
    assert.ok(listed.data.vouchers.some(row => String(row.voucher_id) === String(saved.voucher_id)));
    const updated = await update(saved, { discount_type: 'fixed', discount_value: '15000.00', status: 'active' });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.voucher.discount_value, '15000.00');
    assert.equal((await disable(saved)).status, 200);
    assert.equal((await disable(saved)).status, 200);
    const [[stored]] = await pool.execute('SELECT status FROM vouchers WHERE voucher_id=?', [saved.voucher_id]);
    assert.equal(stored.status, 'disabled');
    const deleted = await fetch(base + `/api/admin/vouchers/${saved.voucher_id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token(adminId)}` } });
    assert.equal(deleted.status, 404);
});

test('Admin validation rejects malformed financial values, dates and quota fields', async () => {
    const saved = await voucher();
    for (const body of [{ discount_value: '101.00', discount_type: 'percent' }, { discount_value: 10 },
        { discount_value: '-1.00' }, { max_discount_amount: '0.00' }, { total_limit: 0 }, { per_user_limit: -1 },
        { starts_at_utc: '2026-11-06 10:00:00' }, { status: 'deleted' }, { unsupported: true }]) {
        const result = await update(saved, body);
        assert.ok([400, 409].includes(result.status), JSON.stringify({ body, result }));
    }
});

test('Voucher normalization rejects Unicode expansion instead of treating sharp-s as an ASCII code', async () => {
    const suffix = randomUUID().replace(/-/g, '').toUpperCase();
    const saved = await voucher({ code: `SS${suffix}` });
    const forged = `ß${suffix}`;
    assert.equal((await quote(forged)).status, 400);
    assert.equal((await create(forged)).status, 400);
    assert.equal((await update(saved, { code: forged })).status, 400);
    const invalid = await request('/api/admin/vouchers', { method: 'POST', user: adminId, body: { code: forged,
        discount_type: 'fixed', discount_value: '1.00', starts_at_utc: new Date((await nowUtc()) - 3600000).toISOString(),
        ends_at_utc: new Date((await nowUtc()) + 3600000).toISOString() } });
    assert.equal(invalid.status, 400);
});

test('Quotes use backend prices, floor percentage minor units and apply the maximum discount', async () => {
    const saved = await voucher({ discount_value: '12.34' });
    const first = await quote(`  ${saved.code.toLowerCase()}  `, { productId: 2 });
    assert.equal(first.status, 200);
    assert.equal(first.data.quote.voucher.code, saved.code);
    assert.equal(first.data.quote.subtotal_amount, '10000.25');
    assert.equal(first.data.quote.discount_amount, '1234.03');
    assert.equal(first.data.quote.total_amount, '8766.22');
    assert.equal((await update(saved, { max_discount_amount: '1000.00' })).status, 200);
    const capped = await quote(saved, { productId: 2 });
    assert.equal(capped.data.quote.discount_amount, '1000.00');
    assert.equal(capped.data.quote.total_amount, '9000.25');
});

test('Fixed discounts never make COD payable negative, including a completely discounted order', async () => {
    const saved = await voucher({ discount_type: 'fixed', discount_value: '150000.00' });
    const preview = await quote(saved);
    assert.equal(preview.status, 200);
    assert.equal(preview.data.quote.discount_amount, '100000.00');
    assert.equal(preview.data.quote.total_amount, '0.00');
    const placed = await create(saved.code);
    assert.equal(placed.status, 201);
    assert.equal(placed.data.order.total_amount, '0.00');
    assert.equal(placed.data.order.payment_amount, '0.00');
    assert.equal((await approve(placed.data.order)).status, 200);
    assert.equal((await redemption(placed.data.order.order_id)).status, 'consumed');
});

test('Online rejects a zero-payable voucher with an explicit error and no order, stock or quota mutation', async () => {
    for (const changes of [{ discount_type: 'percent', discount_value: '100.00' }, { discount_type: 'fixed', discount_value: '150000.00' }]) {
        const saved = await voucher(changes);
        const beforeStock = await stock();
        const [[before]] = await pool.query('SELECT COUNT(*) n FROM orders');
        for (const result of [await quote(saved, { method: 'ONLINE' }), await create(saved.code, { method: 'ONLINE' })]) {
            assert.equal(result.status, 409, JSON.stringify(result.data));
            assert.equal(result.data.code, 'VOUCHER_ONLINE_ZERO_TOTAL');
            assert.match(result.data.message, /0|positive|greater|lớn|dương/i);
        }
        const [[after]] = await pool.query('SELECT COUNT(*) n FROM orders');
        const [[count]] = await pool.execute('SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?', [saved.voucher_id]);
        assert.equal(Number(after.n), Number(before.n));
        assert.equal(Number(count.n), 0);
        assert.equal(await stock(), beforeStock);
    }
});

test('Invalid time, status, minimum and unavailable products fail without reserving quota', async () => {
    const now = await nowUtc();
    const cases = [await voucher({ minimum_order_amount: '200000.00' }),
        await voucher({ starts_at_utc: new Date(now + 3600000).toISOString(), ends_at_utc: new Date(now + 7200000).toISOString() }),
        await voucher({ starts_at_utc: new Date(now - 7200000).toISOString(), ends_at_utc: new Date(now - 3600000).toISOString() }),
        await voucher({ status: 'draft' }), await voucher({ status: 'disabled' })];
    for (const saved of cases) {
        assert.equal((await quote(saved)).status, 409);
        assert.equal((await create(saved.code)).status, 409);
        const [[count]] = await pool.execute('SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?', [saved.voucher_id]);
        assert.equal(Number(count.n), 0);
    }
    const saved = await voucher();
    assert.equal((await quote(saved, { productId: 3 })).status, 409);
});

test('A quote neither reserves a voucher slot nor moves stock', async () => {
    const saved = await voucher({ total_limit: 1, per_user_limit: 1 });
    const beforeStock = await stock();
    assert.equal((await quote(saved)).status, 200);
    assert.equal((await quote(saved, { user: otherId })).status, 200);
    const [[count]] = await pool.execute('SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?', [saved.voucher_id]);
    assert.equal(Number(count.n), 0);
    assert.equal(await stock(), beforeStock);
});

test('Order creation saves immutable gross/discount/net snapshots and exactly one reserved redemption', async () => {
    const saved = await voucher();
    const placed = await create(saved.code);
    assert.equal(placed.status, 201);
    const order = placed.data.order;
    assert.equal(order.subtotal_amount, '100000.00');
    assert.equal(order.discount_amount, '10000.00');
    assert.equal(order.voucher_code_snapshot, saved.code);
    assert.equal(order.total_amount, '90000.00');
    assert.equal(order.payment_amount, '90000.00');
    assert.equal(order.items[0].unit_price, '100000.00');
    assert.equal(order.items[0].subtotal, '100000.00');
    assert.equal((await redemption(order.order_id)).status, 'reserved');
    assert.equal((await update(saved, { discount_value: '50.00' })).status, 200);
    const after = await request(`/api/orders/${order.order_id}`);
    for (const field of ['subtotal_amount', 'discount_amount', 'voucher_code_snapshot', 'total_amount', 'payment_amount']) assert.equal(after.data.order[field], order[field]);
    assert.equal((await update(saved, { code: `RENAMED_${randomUUID().replace(/-/g, '').toUpperCase()}` })).status, 409);
});

test('Checkout retry after voucher disable returns the same order, snapshot and slot; changed payload conflicts', async () => {
    const saved = await voucher({ total_limit: 1 });
    const key = randomUUID();
    const beforeStock = await stock();
    const first = await create(saved.code, { key });
    assert.equal(first.status, 201);
    await disable(saved);
    const retry = await create(saved.code, { key });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.replayed, true);
    assert.equal(retry.data.order.order_id, first.data.order.order_id);
    assert.equal(retry.data.order.total_amount, first.data.order.total_amount);
    assert.equal(await stock(), beforeStock - 1);
    const [[count]] = await pool.execute('SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?', [saved.voucher_id]);
    assert.equal(Number(count.n), 1);
    assert.equal((await create(undefined, { key })).status, 409);
});

test('Concurrent different customers cannot exceed the last global voucher slot', async () => {
    const saved = await voucher({ total_limit: 1 });
    const beforeStock = await stock();
    const results = await Promise.all([create(saved.code), create(saved.code, { user: otherId })]);
    assert.equal(results.filter(result => result.status === 201).length, 1);
    assert.equal(results.filter(result => result.status === 409).length, 1);
    assert.equal(await stock(), beforeStock - 1);
    const [[count]] = await pool.execute("SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=? AND status IN ('reserved','consumed')", [saved.voucher_id]);
    assert.equal(Number(count.n), 1);
});

test('Concurrent same-customer orders respect per-user quota and identical checkout retries reserve only once', async () => {
    const saved = await voucher({ per_user_limit: 1 });
    const beforeStock = await stock();
    const results = await Promise.all([create(saved.code), create(saved.code)]);
    assert.equal(results.filter(result => result.status === 201).length, 1);
    assert.equal(results.filter(result => result.status === 409).length, 1);
    assert.equal(await stock(), beforeStock - 1);
    const next = await voucher({ total_limit: 1 });
    const key = randomUUID();
    const replayed = await Promise.all([create(next.code, { key }), create(next.code, { key })]);
    assert.deepEqual(replayed.map(result => result.status).sort(), [200, 201]);
    assert.equal(replayed[0].data.order.order_id, replayed[1].data.order.order_id);
    const [[count]] = await pool.execute('SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?', [next.voucher_id]);
    assert.equal(Number(count.n), 1);
    assert.equal(await stock(), beforeStock - 2);
});

test('An older REPEATABLE READ snapshot cannot hide a newly committed voucher reservation', async () => {
    const saved = await voucher({ total_limit: 1 });
    const db = await pool.getConnection();
    try {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await db.beginTransaction();
        const [[before]] = await db.execute('SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?', [saved.voucher_id]);
        assert.equal(Number(before.n), 0);
        assert.equal((await create(saved.code, { user: otherId })).status, 201);
        const [[snapshot]] = await db.execute('SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?', [saved.voucher_id]);
        assert.equal(Number(snapshot.n), 0, 'The deliberately old snapshot must still be stale');
        const locked = await voucherModel.lockByCode(db, saved.code);
        await assert.rejects(voucherModel.quoteLocked(db, { code: saved.code, userId,
            subtotal: '100000.00', voucher: locked, paymentMethod: 'COD' }), error => error.code === 'VOUCHER_QUOTA_EXCEEDED');
    } finally { await db.rollback(); db.release(); }
});

test('Retry after voucher edits and expiry preserves the original financial snapshot', async () => {
    const saved = await voucher();
    const key = randomUUID();
    const placed = await create(saved.code, { key });
    assert.equal(placed.status, 201);
    const now = await nowUtc();
    assert.equal((await update(saved, { discount_value: '50.00', starts_at_utc: new Date(now - 7200000).toISOString(),
        ends_at_utc: new Date(now - 3600000).toISOString() })).status, 200);
    const retry = await create(saved.code, { key });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.order.order_id, placed.data.order.order_id);
    assert.equal(retry.data.order.discount_amount, '10000.00');
    assert.equal(retry.data.order.total_amount, '90000.00');
    assert.equal((await create(saved.code)).status, 409);
});

test('Per-customer quota counts reserved orders and cancellation releases that quota once', async () => {
    const saved = await voucher({ total_limit: 10, per_user_limit: 1 });
    const first = await create(saved.code);
    assert.equal(first.status, 201);
    assert.equal((await create(saved.code)).status, 409);
    assert.equal((await create(saved.code, { user: otherId })).status, 201);
    const beforeStock = await stock();
    await Promise.all([reject(first.data.order), reject(first.data.order)]);
    assert.equal(await stock(), beforeStock + 1);
    assert.equal((await redemption(first.data.order.order_id)).status, 'released');
    assert.equal((await create(saved.code)).status, 201);
});

test('COD consumes quota at approval and cash collection uses the discounted total', async () => {
    const saved = await voucher({ discount_type: 'fixed', discount_value: '15000.00' });
    const placed = await create(saved.code);
    const order = placed.data.order;
    const beforeStock = await stock();
    assert.equal((await redemption(order.order_id)).status, 'reserved');
    assert.equal((await approve(order)).status, 200);
    const used = await redemption(order.order_id);
    assert.equal(used.status, 'consumed');
    assert.ok(used.consumed_at_utc);
    assert.equal((await approve(order)).status, 200);
    assert.equal(await stock(), beforeStock);
    assert.equal((await request(`/api/admin/orders/${order.order_id}/status`, { method: 'PATCH', user: adminId, body: { status: 'Đang giao hàng' } })).status, 200);
    const delivered = await request(`/api/admin/orders/${order.order_id}/status`, { method: 'PATCH', user: adminId, body: { status: 'Đã giao hàng', cod_payment_received: true } });
    assert.equal(delivered.status, 200);
    assert.equal(delivered.data.order.payment_status, 'Đã thanh toán');
    assert.equal(delivered.data.order.payment_amount, '85000.00');
    assert.equal((await redemption(order.order_id)).status, 'consumed');
});

test('Online consumes only on applied payment; paid rejection refunds the actual net amount and releases one slot', async () => {
    const saved = await voucher({ total_limit: 1, discount_value: '20.00' });
    const placed = await create(saved.code, { method: 'ONLINE' });
    assert.equal(placed.status, 201);
    const order = placed.data.order;
    assert.equal((await redemption(order.order_id)).status, 'reserved');
    const paid = await pay(order);
    assert.equal(paid.status, 200);
    assert.equal(paid.data.payment.amount, '80000.00');
    assert.equal(paid.data.payment.order_status, 'Chờ xử lý');
    assert.equal((await redemption(order.order_id)).status, 'consumed');
    const beforeStock = await stock();
    const results = await Promise.all([reject(order), reject(order)]);
    assert.ok(results.every(result => result.status === 200));
    assert.equal(await stock(), beforeStock + 1);
    const released = await redemption(order.order_id);
    assert.equal(released.status, 'released');
    assert.ok(released.consumed_at_utc);
    assert.ok(released.released_at_utc);
    const refunds = await service.readRefunds(pool, order.order_id);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, '80000.00');
    assert.equal(refunds[0].status, 'requested');
    assert.equal(refunds[0].confirmed_at_utc, null);
    assert.equal((await create(saved.code, { user: otherId })).status, 201);
});

test('Unpaid Online expiry releases stock and the reserved voucher once across concurrent workers', async () => {
    const saved = await voucher({ total_limit: 1 });
    const placed = await create(saved.code, { method: 'ONLINE' });
    const order = placed.data.order;
    await pool.execute(`UPDATE orders SET created_at_utc=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 25 HOUR),
        payment_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE order_id=?`, [order.order_id]);
    const beforeStock = await stock();
    await Promise.all([service.expireBatch({ limit: 100 }), service.expireBatch({ limit: 100 })]);
    assert.equal((await redemption(order.order_id)).status, 'released');
    assert.equal(await stock(), beforeStock + 1);
    await service.expireBatch({ limit: 100 });
    assert.equal(await stock(), beforeStock + 1);
    const read = await request(`/api/orders/${order.order_id}`);
    assert.equal(read.data.order.status, 'Đã hủy');
    assert.equal((await create(saved.code, { user: otherId })).status, 201);
});

test('Online expiry racing Admin rejection releases stock and its voucher exactly once', async () => {
    const saved = await voucher({ total_limit: 1 });
    const placed = await create(saved.code, { method: 'ONLINE' });
    assert.equal(placed.status, 201);
    const order = placed.data.order;
    await backdate(order);
    const beforeStock = await stock();
    await Promise.allSettled([service.expireBatch({ limit: 100 }), reject(order)]);
    assert.equal((await redemption(order.order_id)).status, 'released');
    assert.equal(await stock(), beforeStock + 1);
    const read = await request(`/api/orders/${order.order_id}`);
    assert.equal(read.data.order.status, 'Đã hủy');
    const [[events]] = await pool.execute("SELECT COUNT(*) n FROM order_status_history WHERE order_id=? AND action IN ('reject','payment_expired')", [order.order_id]);
    assert.equal(Number(events.n), 1);
    assert.equal((await create(saved.code, { user: otherId })).status, 201);
});

test('Duplicate payment callbacks and a second actual capture cannot consume the voucher twice', async () => {
    const saved = await voucher({ total_limit: 1, discount_value: '25.00' });
    const placed = await create(saved.code, { method: 'ONLINE' });
    assert.equal(placed.status, 201);
    const order = placed.data.order;
    const first = await service.createAttempt(userId, order.order_id, randomUUID());
    const second = await service.createAttempt(userId, order.order_id, randomUUID());
    const receipt = await evidence(first);
    assert.equal((await service.confirmProviderEvent(receipt)).disposition, 'applied');
    assert.equal((await service.confirmProviderEvent(receipt)).replayed, true);
    assert.equal((await service.confirmProviderEvent(await evidence(second))).disposition, 'excess_capture');
    assert.equal((await redemption(order.order_id)).status, 'consumed');
    const [[count]] = await pool.execute('SELECT COUNT(*) n FROM voucher_redemptions WHERE order_id=?', [order.order_id]);
    assert.equal(Number(count.n), 1);
    const refunds = await service.readRefunds(pool, order.order_id);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, '75000.00');
    assert.equal(refunds[0].status, 'requested');
    assert.equal((await create(saved.code, { user: otherId })).status, 409);
});

test('An on-time payment received after cancellation never revives or reconsumes a released voucher', async () => {
    const saved = await voucher({ total_limit: 1 });
    const placed = await create(saved.code, { method: 'ONLINE' });
    assert.equal(placed.status, 201);
    const order = placed.data.order;
    const attempt = await service.createAttempt(userId, order.order_id, randomUUID());
    const { paidAtUtc } = await backdate(order, attempt);
    await service.expireBatch({ limit: 100 });
    const next = await create(saved.code, { user: otherId });
    assert.equal(next.status, 201);
    const beforeStock = await stock();
    const result = await service.confirmProviderEvent(await evidence(attempt, { paidAtUtc }));
    assert.equal(result.disposition, 'cancelled_order');
    assert.equal((await redemption(order.order_id)).status, 'released');
    assert.equal((await redemption(next.data.order.order_id)).status, 'reserved');
    assert.equal(await stock(), beforeStock);
    const refunds = await service.readRefunds(pool, order.order_id);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, '90000.00');
    assert.equal(refunds[0].status, 'requested');
});

test('Voucher disabled after checkout does not invalidate payment or mutate an existing order', async () => {
    const saved = await voucher({ discount_value: '15.00' });
    const placed = await create(saved.code, { method: 'ONLINE' });
    await disable(saved);
    const paid = await pay(placed.data.order);
    assert.equal(paid.status, 200);
    assert.equal(paid.data.payment.amount, '85000.00');
    assert.equal((await redemption(placed.data.order.order_id)).status, 'consumed');
    assert.equal((await approve(placed.data.order)).status, 200);
    assert.equal((await create(saved.code)).status, 409);
});

test('Voucher input is optional and non-voucher/legacy orders retain their previous behavior', async () => {
    const placed = await create(undefined);
    assert.equal(placed.status, 201);
    assert.equal(placed.data.order.total_amount, '100000.00');
    assert.equal(placed.data.order.voucher_code_snapshot, null);
    assert.equal(placed.data.order.discount_amount, null);
    const [rows] = await pool.execute('SELECT * FROM voucher_redemptions WHERE order_id=?', [placed.data.order.order_id]);
    assert.equal(rows.length, 0);
    assert.equal((await approve(placed.data.order)).status, 200);
    assert.deepEqual(await legacySnapshot(), legacyBefore);
});

test('Feature disable blocks new voucher use but leaves checkout without vouchers operational', async () => {
    const saved = await voucher();
    const replayKey = randomUUID();
    const codReserved = await create(saved.code, { key: replayKey });
    const onlineReserved = await create(saved.code, { method: 'ONLINE' });
    const rejected = await create(saved.code);
    for (const result of [codReserved, onlineReserved, rejected]) assert.equal(result.status, 201);
    const previous = process.env.PETCARE_VOUCHERS_ENABLED;
    process.env.PETCARE_VOUCHERS_ENABLED = '0';
    try {
        assert.equal((await quote(saved)).status, 503);
        assert.equal((await create(saved.code)).status, 503);
        assert.equal((await create(undefined)).status, 201);
        const replay = await create(saved.code, { key: replayKey });
        assert.equal(replay.status, 200);
        assert.equal(replay.data.order.order_id, codReserved.data.order.order_id);
        assert.equal((await approve(codReserved.data.order)).status, 200);
        assert.equal((await redemption(codReserved.data.order.order_id)).status, 'consumed');
        assert.equal((await pay(onlineReserved.data.order)).status, 200);
        assert.equal((await redemption(onlineReserved.data.order.order_id)).status, 'consumed');
        assert.equal((await reject(onlineReserved.data.order)).status, 200);
        assert.equal((await redemption(onlineReserved.data.order.order_id)).status, 'released');
        assert.equal((await reject(rejected.data.order)).status, 200);
        assert.equal((await redemption(rejected.data.order.order_id)).status, 'released');
    } finally { process.env.PETCARE_VOUCHERS_ENABLED = previous; }
});
