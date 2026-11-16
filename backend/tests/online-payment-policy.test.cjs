// Synthetic rows only. No MySQL driver, .env, migration or real data is loaded.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const originalLoad = Module._load;
Module._load = function (request) {
    assert.ok(!/^mysql2(?:\/|$)/.test(request), 'These checks must not open MySQL');
    return originalLoad.apply(this, arguments);
};
after(() => { Module._load = originalLoad; });
let active;
const pool = { async getConnection() { active.connections++; return active.db; },
    execute: (...args) => active.db.execute(...args) };
const dbFile = require.resolve('../config/db');
require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: pool };
const orders = require('../models/order');
const payments = require('../models/payment');
const admin = require('../models/admin-order');
const policy = require('../models/order-policy');
const sepay = require('../config/sepay');
const online = require('../services/online-orders');
const target = 'petcare_test_' + 'b'.repeat(32);
const environment = {
    NODE_ENV: 'test', DB_NAME: target, PETCARE_TEST_DATABASE: target, PETCARE_TEST_SOURCE_DATABASE: 'petcare_db', PETCARE_TEST_ISOLATED: '1',
    SEPAY_INTEGRATION_ENABLED: '1', SEPAY_LIVE_ENABLED: '0', SEPAY_TEST_MODE: '1', SEPAY_ENVIRONMENT: 'test',
    SEPAY_TEST_ACCOUNT_CONFIRMED: '1', SEPAY_TEST_ACCOUNT_NUMBER: '999999000003', SEPAY_TEST_ACCOUNT_NAME: 'SYNTHETIC',
    SEPAY_TEST_WEBHOOK_SECRET: 'synthetic-only-secret-never-used-for-network', SEPAY_TEST_WRITE_DATABASE: target,
    PETCARE_ORDER_WORKFLOW_ENABLED: '1', PETCARE_ORDER_FRONTEND_READY: '1', PETCARE_ORDER_EXPIRY_ENABLED: '1', PETCARE_PAYMENT_SIMULATION_ENABLED: '0',
};
function configure(t, changes = {}) {
    const keys = Object.keys(environment), previous = new Map(keys.map(key => [key, process.env[key]]));
    for (const key of keys) process.env[key] = { ...environment, ...changes }[key];
    t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const input = { source: 'buy-now', items: [{ product_id: 3, quantity: 1 }], recipient_name: 'Synthetic customer',
    shipping_address: '123 Synthetic Street', phone: '0900000000', payment_method: 'ONLINE', note: null };
function fixture({ replay = false, selected = target, approved = false } = {}) {
    const order = { order_id: 1, user_id: 1, total_amount: '150000.00', status: 'Chờ thanh toán',
        approved_at: approved ? new Date(Date.now() - 1000).toISOString() : null, stock_restored_at: null, rejection_reason: null,
        stock_reserved_at: null, stock_reservation_source: 'checkout-v4-fingerprint',
        request_fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
    const payment = { payment_id: 2, payment_method: 'ONLINE', payment_status: 'Chưa thanh toán', amount: '150000.00', transaction_date: null };
    const sql = [];
    const row = () => ({ ...order, ...payment, payment_amount: payment.amount });
    return { order, payment, sql, connections: 0, db: {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(statement) { sql.push(statement); assert.equal(statement, 'SELECT DATABASE() AS database_name'); return [[{ database_name: selected }]]; },
        async execute(statement) {
            const statementText = statement.replace(/\s+/g, ' ').trim();
            sql.push(statementText);
            if (statementText.startsWith('SELECT user_id')) return [[{ user_id: 1, role: 'user', status: 'active' }]];
            if (statementText.startsWith('SELECT role')) return [[{ user_id: 2, role: 'admin', status: 'active' }]];
            if (statementText.startsWith('SELECT order_id, request_fingerprint')) return [replay ? [{ order_id: 1, request_fingerprint: order.request_fingerprint }] : []];
            if (statementText.includes('FROM orders o')) return [[row()]];
            if (statementText.includes('FROM orders WHERE')) return [[{ ...order }]];
            if (statementText.includes('FROM payments WHERE')) return [[{ ...payment }]];
            if (statementText.includes('FROM order_details') || statementText.includes('FROM order_status_history')) return [[]];
            assert.fail('Unexpected SQL: ' + statementText);
        },
    } };
}
const assertNoWrites = () => assert.equal(active.sql.some(sql => /^(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE)\b/i.test(sql)), false);

test('SePay OFF or workflow OFF cannot create a legacy fallback Online order', async t => {
    configure(t, { SEPAY_INTEGRATION_ENABLED: '0' });
    active = fixture();
    assert.deepEqual(await payments.options(), { online_available: false, online_mode: null });
    assert.equal(active.connections, 0);
    await assert.rejects(orders.create(1, input, 'synthetic-idempotency-key'), { status: 503, code: 'ONLINE_PAYMENT_UNAVAILABLE' });
    assertNoWrites();
    process.env.SEPAY_INTEGRATION_ENABLED = '1'; process.env.PETCARE_ORDER_WORKFLOW_ENABLED = '0';
    active = fixture();
    await assert.rejects(orders.create(1, input, 'synthetic-idempotency-key'), { status: 503, code: 'ONLINE_PAYMENT_UNAVAILABLE' });
    assertNoWrites();
});

test('a previously committed request remains replayable after payment is disabled', async t => {
    configure(t, { SEPAY_INTEGRATION_ENABLED: '0' });
    active = fixture({ replay: true });
    const result = await orders.create(1, input, 'synthetic-idempotency-key');
    assert.equal(result.replayed, true);
    assert.equal(result.order.order_id, 1);
    assertNoWrites();
});

test('misdirected SQL connections and read-only Test mode cannot authorize new Online checkout', async t => {
    configure(t);
    active = fixture({ selected: 'petcare_db' });
    await assert.rejects(orders.create(1, input, 'synthetic-idempotency-key'), { status: 503, code: 'ONLINE_PAYMENT_UNAVAILABLE' });
    assertNoWrites();
    process.env.SEPAY_TEST_WRITE_DATABASE = '';
    assert.deepEqual(await payments.options(), { online_available: false, online_mode: null });
    assertNoWrites();
});

test('Online availability verifies existing schema and only accepts amounts that can produce a payable QR', async t => {
    configure(t);
    active = fixture();
    const originalReady = online.assertReady;
    t.after(() => { online.assertReady = originalReady; });
    online.assertReady = async db => { assert.equal(db, active.db); };
    assert.deepEqual(await payments.options(), { online_available: true, online_mode: 'test' });
    online.assertReady = async () => { throw new Error('Synthetic missing schema'); };
    assert.deepEqual(await payments.options(), { online_available: false, online_mode: null });
    for (const amount of ['1000.00', '150000.00', '499000000.00']) assert.equal(sepay.supportsAmount(amount), true);
    for (const amount of ['0.00', '999.00', '150000.50', '499000001.00', null]) assert.equal(sepay.supportsAmount(amount), false);
    assertNoWrites();
});

test('unpaid Online v2 needs no approval to pay; only paid Online can enter the approval queue', () => {
    const base = fixture().order;
    const order = { ...base, workflow_version: 2, stock_reserved_at: new Date(Date.now() - 1000).toISOString(), stock_reservation_source: 'checkout-v6',
        created_at_utc: '2026-11-16T00:00:00Z', payment_expires_at: '2026-11-17T00:00:00Z' };
    const payment = fixture().payment;
    assert.doesNotThrow(() => policy.consistent(order, payment));
    const unpaid = policy.decorate({ ...order, ...payment, payment_amount: payment.amount });
    assert.equal(unpaid.approval_state, 'awaiting_payment');
    assert.deepEqual(unpaid.allowed_actions, ['reject']);
    const paid = policy.decorate({ ...order, ...payment, status: 'Chờ xử lý', payment_status: 'Đã thanh toán', transaction_date: '2026-11-16T01:00:00Z', payment_amount: payment.amount });
    assert.equal(paid.approval_state, 'pending');
    assert.deepEqual(paid.allowed_actions, ['approve', 'reject']);
    const historical = policy.decorate({ ...base, ...payment, payment_amount: payment.amount });
    assert.equal(historical.approval_state, 'legacy');
    assert.deepEqual(historical.allowed_actions, ['reject']);
});

test('historical Online cannot use approval or the retired simulator payment path', async t => {
    configure(t, { PETCARE_PAYMENT_SIMULATION_ENABLED: '1', SEPAY_INTEGRATION_ENABLED: '0' });
    for (const approved of [false, true]) {
        active = fixture({ approved });
        const payment = await payments.get(1, 1);
        assert.equal(payment.can_simulate, false);
        assert.equal(payment.can_pay, false);
        await assert.rejects(payments.simulate(1, 1, 'ONLINE_SUCCESS'), { status: 409 });
        await assert.rejects(admin.approve(2, 1), { status: 409 });
        assertNoWrites();
    }
});
