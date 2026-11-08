const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const app = require('../server');
const voucherModel = require('../models/voucher');

const userId = 1, adminId = 2, otherId = 3;
const publicFields = ['code', 'discount_type', 'discount_value', 'max_discount_amount', 'minimum_order_amount', 'starts_at_utc', 'ends_at_utc'].sort();
const token = id => jwt.sign({}, process.env.JWT_SECRET, { subject: String(id), expiresIn: '10m' });
let server, base, legacyBefore;
async function request(path, { method = 'GET', body, user = userId, key } = {}) {
    const response = await fetch(base + path, { method, headers: {
        ...(user == null ? {} : { Authorization: `Bearer ${token(user)}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
}
const list = (user = userId, query = '?limit=50') => request('/api/vouchers' + query, { user });
const codes = result => result.data.vouchers.map(voucher => voucher.code);
async function voucher(changes = {}) {
    const [[clock]] = await pool.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') AS now_utc");
    const now = new Date(clock.now_utc).getTime();
    const body = { code: `L_${randomUUID().replace(/-/g, '').toUpperCase()}`, discount_type: 'percent', discount_value: '10.00',
        minimum_order_amount: '0.00', max_discount_amount: null, starts_at_utc: new Date(now - 3600000).toISOString(),
        ends_at_utc: new Date(now + 3600000).toISOString(), total_limit: null, per_user_limit: null, status: 'active', ...changes };
    const saved = await request('/api/admin/vouchers', { method: 'POST', body, user: adminId });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    return saved.data.voucher;
}
async function checkout(saved, user = userId) {
    const result = await request('/api/orders', { method: 'POST', user, key: randomUUID(), body: {
        source: 'buy-now', items: [{ product_id: 1, quantity: 1 }], recipient_name: 'Synthetic customer catalogue',
        shipping_address: '123 Invented List Street', phone: '0900000000', note: null, payment_method: 'COD', voucher_code: saved.code,
    } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.order;
}
const approve = order => request(`/api/admin/orders/${order.order_id}/approve`, { method: 'PATCH', body: {}, user: adminId });
const reject = order => request(`/api/admin/orders/${order.order_id}/reject`, { method: 'PATCH', body: { reason: 'Synthetic catalogue quota release' }, user: adminId });
async function snapshot(tables, where = '') {
    const result = {};
    for (const table of tables) result[table] = (await pool.query(`SELECT * FROM \`${table}\` ${where} ORDER BY 1`))[0];
    return result;
}
const legacy = () => snapshot(['orders', 'payments', 'order_details', 'order_status_history'], 'WHERE order_id IN (173,174)');

before(async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.PETCARE_TEST_ISOLATED, '1');
    assert.equal(process.env.DB_NAME, process.env.PETCARE_TEST_DATABASE);
    assert.match(process.env.DB_NAME || '', /^petcare_test_[a-f0-9]{32}$/);
    assert.notEqual(process.env.DB_NAME, process.env.PETCARE_TEST_SOURCE_DATABASE);
    const [[selected]] = await pool.query('SELECT DATABASE() database_name');
    assert.equal(selected.database_name, process.env.PETCARE_TEST_DATABASE);
    legacyBefore = await legacy();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    try { assert.deepEqual(await legacy(), legacyBefore); }
    finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await pool.end(); }
});

test('Customer catalogue requires an authenticated active customer and respects feature-off', async () => {
    assert.equal((await list(null)).status, 401);
    assert.equal((await list(adminId)).status, 403);
    await assert.rejects(voucherModel.listForCustomer(adminId), error => error.status === 403 && error.code === 'VOUCHER_FORBIDDEN');
    await pool.execute("INSERT INTO `user` (user_id,full_name,email,password,role,status,created_at) VALUES (4,'Inactive synthetic catalogue user','inactive-catalogue@example.test','unused-synthetic-hash','user','inactive',NOW())");
    assert.equal((await list(4)).status, 403);
    await assert.rejects(voucherModel.listForCustomer(4), error => error.status === 403 && error.code === 'VOUCHER_FORBIDDEN');
    const previous = process.env.PETCARE_VOUCHERS_ENABLED;
    process.env.PETCARE_VOUCHERS_ENABLED = '0';
    try {
        const result = await list();
        assert.equal(result.status, 503);
        assert.equal(result.data.code, 'VOUCHERS_DISABLED');
    } finally { process.env.PETCARE_VOUCHERS_ENABLED = previous; }
});

test('Customer catalogue rejects unsupported identity/filter input and bounds pagination', async () => {
    for (const query of ['?limit=51', '?limit=0', '?limit=-1', '?limit=1.5', '?limit=1e2', '?page=0', '?page=2147483648',
        '?page=1&page=2', '?limit[]=1', '?page[x]=1', '?user_id=3', '?status=draft', '?q=L_', '?limit=1%20OR%201=1']) {
        const result = await list(userId, query);
        assert.equal(result.status, 400, query + ' ' + JSON.stringify(result.data));
    }
    await assert.rejects(voucherModel.listForCustomer(userId, { page: 1, limit: 51 }), error => error.status === 400);
    const normal = await list(userId, '');
    assert.equal(normal.status, 200);
    assert.equal(normal.data.page, 1);
    assert.equal(normal.data.limit, 20);
});

test('Customer catalogue includes only active vouchers inside the UTC validity window', async () => {
    const usable = await voucher(), draft = await voucher({ status: 'draft' }), disabled = await voucher({ status: 'disabled' });
    const future = await voucher(), expired = await voucher(), boundary = await voucher();
    await pool.execute('UPDATE vouchers SET starts_at_utc=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR),ends_at_utc=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR) WHERE voucher_id=?', [future.voucher_id]);
    await pool.execute('UPDATE vouchers SET starts_at_utc=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR),ends_at_utc=UTC_TIMESTAMP(3) WHERE voucher_id=?', [expired.voucher_id]);
    await pool.execute('UPDATE vouchers SET starts_at_utc=UTC_TIMESTAMP(3),ends_at_utc=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE voucher_id=?', [boundary.voucher_id]);
    const result = await list();
    assert.equal(result.status, 200);
    const visible = codes(result);
    assert.ok(visible.includes(usable.code));
    assert.ok(visible.includes(boundary.code));
    for (const hidden of [draft, disabled, future, expired]) assert.ok(!visible.includes(hidden.code), hidden.code);
});

test('Global quota excludes both reserved and consumed slots; releasing a reservation restores discovery', async () => {
    const reserved = await voucher({ total_limit: 1 });
    const pending = await checkout(reserved, otherId);
    assert.ok(!codes(await list()).includes(reserved.code));
    assert.ok(!codes(await list(otherId)).includes(reserved.code));
    assert.equal((await reject(pending)).status, 200);
    assert.ok(codes(await list()).includes(reserved.code));
    assert.ok(codes(await list(otherId)).includes(reserved.code));
    const consumed = await voucher({ total_limit: 1 });
    const approved = await checkout(consumed, otherId);
    assert.equal((await approve(approved)).status, 200);
    assert.ok(!codes(await list()).includes(consumed.code));
    assert.ok(!codes(await list(otherId)).includes(consumed.code));
});

test('Per-customer quota belongs to the authenticated caller and ignores released redemptions', async () => {
    const saved = await voucher({ total_limit: 5, per_user_limit: 1 });
    const pending = await checkout(saved);
    assert.ok(!codes(await list()).includes(saved.code));
    assert.ok(codes(await list(otherId)).includes(saved.code));
    assert.equal((await reject(pending)).status, 200);
    assert.ok(codes(await list()).includes(saved.code));
    const consumed = await checkout(saved);
    assert.equal((await approve(consumed)).status, 200);
    assert.ok(!codes(await list()).includes(saved.code));
    assert.ok(codes(await list(otherId)).includes(saved.code));
});

test('Catalogue returns public terms only, is not cached and never reserves slots or changes orders', async () => {
    const saved = await voucher({ minimum_order_amount: '200000.00', total_limit: 10, per_user_limit: 2 });
    const tables = ['user', 'vouchers', 'voucher_redemptions', 'orders', 'order_details', 'payments', 'products', 'order_status_history'];
    const before = await snapshot(tables);
    const result = await list();
    assert.equal(result.status, 200);
    assert.equal(result.cache, 'no-store');
    for (const item of result.data.vouchers) assert.deepEqual(Object.keys(item).sort(), publicFields);
    const found = result.data.vouchers.find(item => item.code === saved.code);
    assert.ok(found, 'Minimum order condition is public information, checked by quote for the actual order');
    assert.equal(found.minimum_order_amount, '200000.00');
    await list(otherId);
    assert.deepEqual(await snapshot(tables), before);
    const quote = await request('/api/vouchers/quote', { method: 'POST', body: { code: saved.code, items: [{ product_id: 1, quantity: 1 }], payment_method: 'COD' } });
    assert.equal(quote.status, 409);
    assert.equal(quote.data.code, 'VOUCHER_MINIMUM_NOT_MET');
});

test('Pagination is bounded and stable across adjacent pages without duplicating entries', async () => {
    for (let index = 0; index < 4; index++) await voucher();
    const full = await list();
    const first = await list(userId, '?page=1&limit=2');
    const second = await list(userId, '?page=2&limit=2');
    const beyond = await list(userId, '?page=2147483647&limit=50');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.data.total, full.data.total);
    assert.equal(second.data.total, full.data.total);
    assert.deepEqual(codes(first), codes(full).slice(0, 2));
    assert.deepEqual(codes(second), codes(full).slice(2, 4));
    assert.equal(new Set([...codes(first), ...codes(second)]).size, 4);
    assert.equal(beyond.status, 200);
    assert.deepEqual(beyond.data.vouchers, []);
    assert.equal(beyond.data.total, full.data.total);
});

test('A discovered code is rechecked by quote and checkout after the last slot is taken', async () => {
    const saved = await voucher({ total_limit: 1 });
    assert.ok(codes(await list()).includes(saved.code));
    await checkout(saved, otherId);
    const input = { code: saved.code, items: [{ product_id: 1, quantity: 1 }], payment_method: 'COD' };
    const quote = await request('/api/vouchers/quote', { method: 'POST', body: input });
    assert.equal(quote.status, 409);
    assert.equal(quote.data.code, 'VOUCHER_QUOTA_EXCEEDED');
    const failed = await request('/api/orders', { method: 'POST', key: randomUUID(), body: {
        source: 'buy-now', items: input.items, recipient_name: 'Synthetic customer catalogue',
        shipping_address: '123 Invented List Street', phone: '0900000000', note: null, payment_method: 'COD', voucher_code: saved.code,
    } });
    assert.equal(failed.status, 409);
    assert.equal(failed.data.code, 'VOUCHER_QUOTA_EXCEEDED');
    const [[count]] = await pool.execute('SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?', [saved.voucher_id]);
    assert.equal(Number(count.n), 1);
});
