// Transaction/HTTP contract tests with synthetic in-memory rows. No MySQL,
// migration, backup, environment change, or application data is accessed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
let active;
const users = [
    { user_id: 10, role: 'user', status: 'active', full_name: 'Synthetic customer' },
    { user_id: 11, role: 'user', status: 'active', full_name: 'Other customer' },
    { user_id: 12, role: 'admin', status: 'active', full_name: 'Synthetic admin' },
    { user_id: 13, role: 'user', status: 'inactive', full_name: 'Inactive customer' },
];
function replace(module, exports) {
    const filename = require.resolve(module);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
replace('../config/db', { getConnection: () => active.connection(), execute: (...args) => active.connection().then(db => db.execute(...args)) });
replace('../config/auth', { secret: 'synthetic-cancellation-test-secret' });
replace('../models/user', { byId: async id => users.find(user => user.user_id === Number(id)) });
const orders = require('../models/order');
const adminOrders = require('../models/admin-order');
const paymentModel = require('../models/payment');
const policy = require('../models/order-policy');

function fixture(changes = {}, options = {}) {
    const state = {
        order: { order_id: 1, user_id: 10, status: 'Chờ xử lý', total_amount: '100.00',
            approved_at: null, stock_restored_at: null, rejection_reason: null,
            stock_reserved_at: null, stock_reservation_source: 'checkout-v4-fingerprint', ...changes },
        payment: { payment_id: 2, amount: '100.00', payment_method: options.method || 'COD', payment_status: 'Chưa thanh toán', transaction_date: null },
        stock: { 3: 7, 4: 9 },
        lines: [{ product_id: 3, quantity: 2 }, { product_id: 3, quantity: 1 }, { product_id: 4, quantity: 1 }],
        history: [], refunds: [],
        redemption: { redemption_id: '5', voucher_id: '6', user_id: '10', discount_amount: '10.00', status: options.redemption || 'reserved' },
    };
    const created = Date.parse('2025-01-01T00:00:00Z');
    const capture = { attempt_id: 21, payment_id: 2, status: 'succeeded', disposition: 'applied', provider: 'SIMULATOR', provider_environment: 'test',
        provider_transaction_id: 'synthetic-capture', amount: '100.00', captured_amount: '100.00', currency: 'VND', captured_currency: 'VND',
        initiated_ms: created + 1000, provider_paid_ms: created + 2000, confirmed_at_utc: '2025-01-01 00:00:03', received_at_utc: '2025-01-01 00:00:03' };
    const receipt = { event_id: 31, event_type: 'succeeded', disposition: 'applied', verification_source: 'synthetic-proof',
        provider_transaction_id: capture.provider_transaction_id, amount: '100.00', currency: 'VND', received_at_utc: '2025-01-01 00:00:03', provider_paid_ms: created + 2000 };
    if (options.paid) Object.assign(state.payment, { payment_method: 'ONLINE', payment_status: 'Đã thanh toán', transaction_date: '2025-01-01 00:00:02' });
    const log = [];
    let tail = Promise.resolve();
    async function connection() {
        let unlock, snapshot;
        return {
            async beginTransaction() {},
            async query(sql) {
                assert.match(sql, /AS now_ms/);
                return [[{ now_ms: created + 3000, now_sql: '2025-01-01 00:00:03.000' }]];
            },
            async execute(statement, values = []) {
                const sql = statement.replace(/\s+/g, ' ').trim();
                log.push({ sql, values });
                if (sql.startsWith('SELECT role')) return [[users.find(user => user.user_id === values[0])].filter(Boolean)];
                if (sql.includes('FROM payment_attempts')) return [[{ ...capture }]];
                if (sql.includes('FROM payment_events')) return [[{ ...receipt }]];
                if (sql.includes('AS created_ms')) return [[{ created_ms: created, expires_ms: created + 86400000 }]];
                if (sql.includes('FROM refund_requests r')) return [structuredClone(state.refunds)];
                if (sql.startsWith('SELECT * FROM refund_requests')) return [[]];
                if (sql.includes('SUM(amount)')) return [[{ total: '0.00' }]];
                if (sql.startsWith('SELECT *') && sql.includes('FROM orders')) {
                    assert.match(sql, /FOR UPDATE$/);
                    if (!unlock) {
                        const prior = tail;
                        tail = new Promise(resolve => { unlock = resolve; });
                        await prior;
                        snapshot = structuredClone(state);
                    }
                    return [[state.order].filter(order => order.order_id === values[0] && (values[1] === undefined || order.user_id === values[1])).map(order => ({ ...order }))];
                }
                if (sql.startsWith('SELECT *') && sql.includes('FROM payments')) return [[{ ...state.payment }]];
                if (sql.includes('FROM orders o')) {
                    const order = state.order;
                    if (order.order_id !== values[0] || (values[1] !== undefined && order.user_id !== values[1])) return [[]];
                    return [[{ ...order, ...state.payment, payment_amount: state.payment.amount }]];
                }
                if (sql.includes('FROM order_details')) return [[...state.lines.map((line, index) => ({ ...line, order_detail_id: index + 1, name: `Product ${line.product_id}`, unit_price: '25.00', subtotal: '25.00' }))]];
                if (sql.includes('FROM order_status_history')) return [structuredClone(state.history)];
                if (sql.includes('FROM products')) return [Object.hasOwn(state.stock, values[0]) ? [{ product_id: values[0], name: 'Synthetic product', stock_quantity: state.stock[values[0]] }] : []];
                if (sql.includes('FROM vouchers')) return [[{ voucher_id: '6' }]];
                if (sql.includes('FROM voucher_redemptions')) return [[{ ...state.redemption }]];
                if (sql.startsWith('UPDATE voucher_redemptions')) { state.redemption.status = 'released'; return [{ affectedRows: 1 }]; }
                if (sql.startsWith('UPDATE orders SET stock_restored_at')) {
                    if (state.order.stock_restored_at) return [{ affectedRows: 0 }];
                    state.order.stock_restored_at = new Date().toISOString(); return [{ affectedRows: 1 }];
                }
                if (sql.startsWith('UPDATE products')) {
                    if (options.failProduct === values[1]) throw Object.assign(new Error('Synthetic update failure'), { code: 'SYNTHETIC_FAILURE' });
                    const stock = state.stock[values[1]];
                    if (stock < 0 || stock > values[2]) return [{ affectedRows: 0 }];
                    state.stock[values[1]] += values[0]; return [{ affectedRows: 1 }];
                }
                if (sql.startsWith('UPDATE orders SET approved_at')) { state.order.approved_at = new Date().toISOString(); state.order.status = values[0]; return [{ affectedRows: 1 }]; }
                if (sql.startsWith("UPDATE orders SET status = 'Đã hủy', rejection_reason")) {
                    Object.assign(state.order, { status: 'Đã hủy', rejection_reason: values[0], cancelled_at: values[1], cancellation_reason_code: values[2] });
                    return [{ affectedRows: 1 }];
                }
                if (sql.startsWith('UPDATE orders SET status')) { state.order.status = 'Đã hủy'; return [{ affectedRows: 1 }]; }
                if (sql.startsWith('UPDATE payments SET payment_status')) { state.payment.payment_status = 'Đã hủy'; return [{ affectedRows: 1 }]; }
                if (sql.startsWith('INSERT INTO refund_requests')) {
                    state.refunds.push({ refund_id: 41, amount: values[5], currency: values[6], reason_code: values[7], status: 'requested', confirmed_at_utc: null });
                    return [{ insertId: 41, affectedRows: 1 }];
                }
                if (sql.startsWith('INSERT INTO refund_events')) return [{ affectedRows: 1 }];
                if (sql.startsWith('INSERT INTO order_status_history')) {
                    const [order_id, from_status, to_status, action, actor_id, actor_name, reason] = values;
                    state.history.push({ history_id: state.history.length + 1, order_id, from_status, to_status, action, actor_id, actor_name, reason, created_at: new Date().toISOString() });
                    return [{ affectedRows: 1 }];
                }
                throw new Error(`Unsupported synthetic SQL: ${sql}`);
            },
            async commit() { if (options.failCommit) throw new Error('Synthetic COMMIT failure'); },
            async rollback() { if (snapshot) Object.assign(state, snapshot); },
            release() { unlock?.(); },
        };
    }
    return { state, log, connection };
}

let server, base;
before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/orders', require('../routes/orders'));
    app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, message: error.message }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function request(path = '1/cancel', body = { reason_code: 'changed_mind' }, userId = 10) {
    const headers = { 'Content-Type': 'application/json' };
    if (userId) headers.Authorization = `Bearer ${jwt.sign({}, 'synthetic-cancellation-test-secret', { subject: String(userId), expiresIn: 60 })}`;
    const response = await fetch(`${base}/api/orders/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
}

test('cancellation authenticates active customers and conceals other owners', async () => {
    for (const [userId, expected] of [[null, 401], [12, 403], [13, 403], [11, 404]]) {
        active = fixture();
        const before = structuredClone(active.state);
        assert.equal((await request(undefined, undefined, userId)).status, expected);
        assert.deepEqual(active.state, before);
    }
});

test('cancellation validates IDs, body, reasons and owner spoofing before writes', async () => {
    active = fixture();
    const before = structuredClone(active.state);
    for (const path of ['0/cancel', '01/cancel', '2147483648/cancel', '1/cancel?user_id=11']) assert.equal((await request(path)).status, 400);
    for (const body of [null, [], {}, { reason_code: 'unknown' }, { reason_code: 'other', reason: ' ' },
        { reason_code: 'other', reason: 'x'.repeat(501) }, { reason_code: 'other', reason: '\u0000' },
        { reason_code: 'changed_mind', user_id: 11 }, { reason_code: 'changed_mind', reason: 'extra' }]) {
        assert.equal((await request('1/cancel', body)).status, 400);
    }
    assert.deepEqual(active.state, before);
});

test('legacy COD restores aggregated stock once, records customer history and payment metadata', async () => {
    active = fixture();
    const result = await request('1/cancel', { reason_code: 'other', reason: '  Tôi muốn đổi địa chỉ 🐾\nCảm ơn  ' });
    assert.equal(result.status, 200);
    assert.deepEqual(active.state.stock, { 3: 10, 4: 10 });
    assert.equal(result.data.order.status, 'Đã hủy');
    assert.equal(result.data.order.payment_status, 'Đã hủy');
    assert.equal(result.data.order.approval_state, 'cancelled');
    assert.equal(result.data.order.rejection_reason, null);
    assert.equal(result.data.order.cancellation_reason_code, 'customer_cancelled');
    assert.equal(result.data.order.cancellation_reason, 'Tôi muốn đổi địa chỉ 🐾\nCảm ơn');
    assert.ok(result.data.order.cancelled_at);
    assert.equal(result.data.order.can_cancel, false);
    assert.equal(result.data.order.review_required, false);
    assert.equal(result.data.order.history[0].actor_id, 10);
    const payment = await paymentModel.get(10, 1);
    assert.equal(payment.cancellation_reason, result.data.order.cancellation_reason);
    assert.equal(payment.approval_state, 'cancelled');
    const before = structuredClone(active.state);
    assert.equal((await request()).status, 409);
    assert.deepEqual(active.state, before);
});

test('legacy Online can cancel before approval without any refund or receipt', async () => {
    active = fixture({ status: 'Chờ thanh toán' }, { method: 'ONLINE' });
    assert.equal((await request()).status, 200);
    assert.equal(active.state.payment.payment_status, 'Đã hủy');
    assert.equal(active.log.some(entry => /refund|payment_attempts/.test(entry.sql)), false);
});

test('approved, shipped, delivered, corrupt and unproven orders never change on cancellation', async () => {
    for (const changes of [
        { status: 'Chờ giao hàng', approved_at: new Date().toISOString() },
        { status: 'Đang giao hàng', approved_at: new Date().toISOString() },
        { status: 'Đã giao hàng', approved_at: new Date().toISOString() },
        { stock_reservation_source: null }, { total_amount: '99.00' },
    ]) {
        active = fixture(changes);
        const before = structuredClone(active.state);
        assert.equal((await request()).status, 409);
        assert.deepEqual(active.state, before);
    }
});

test('concurrent cancellation requests share the order lock and restore only once', async () => {
    active = fixture();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => orders.cancel(10, 1, { reason_code: 'changed_mind' })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.status, 409);
    assert.deepEqual(active.state.stock, { 3: 10, 4: 10 });
    assert.equal(active.state.history.length, 1);
    const orderLock = active.log.findIndex(entry => entry.sql.includes('FROM orders') && entry.sql.endsWith('FOR UPDATE'));
    const paymentLock = active.log.findIndex(entry => entry.sql.includes('FROM payments') && entry.sql.endsWith('FOR UPDATE'));
    assert.ok(orderLock < paymentLock);
});

test('Admin approval and customer cancellation serialize in either order', async () => {
    for (const approvalFirst of [true, false]) {
        active = fixture();
        const approve = () => adminOrders.approve(12, 1);
        const cancel = () => orders.cancel(10, 1, { reason_code: 'changed_mind' });
        const results = await Promise.allSettled((approvalFirst ? [approve, cancel] : [cancel, approve]).map(action => action()));
        assert.equal(results[0].status, 'fulfilled');
        assert.equal(results[1].status, 'rejected');
        assert.equal(results[1].reason.status, 409);
        assert.equal(active.state.history.length, 1);
        assert.deepEqual(active.state.stock, approvalFirst ? { 3: 7, 4: 9 } : { 3: 10, 4: 10 });
    }
});

test('voucher reservation releases before product locks and rolls back with stock/commit errors', async () => {
    for (const options of [{}, { failProduct: 4 }, { failCommit: true }, { overflow: true }]) {
        active = fixture({ voucher_code_snapshot: 'SYNTHETIC', subtotal_amount: '110.00', discount_amount: '10.00' }, options);
        if (options.overflow) active.state.stock[4] = 2147483647;
        const before = structuredClone(active.state);
        if (Object.keys(options).length) {
            await assert.rejects(orders.cancel(10, 1, { reason_code: 'changed_mind' }));
            assert.deepEqual(active.state, before, 'All order, voucher, inventory and history writes must roll back');
        } else {
            await orders.cancel(10, 1, { reason_code: 'changed_mind' });
            assert.equal(active.state.redemption.status, 'released');
            const voucherLock = active.log.findIndex(entry => entry.sql.includes('FROM vouchers'));
            const productLock = active.log.findIndex(entry => entry.sql.includes('FROM products'));
            assert.ok(voucherLock >= 0 && voucherLock < productLock);
        }
    }
});

test('eligibility distinguishes legacy, Online v2 unpaid/failed/paid and completed orders', () => {
    const order = { ...fixture().state.order, workflow_version: 2, stock_reserved_at: new Date(Date.now() - 1000).toISOString(),
        created_at_utc: '2026-11-12T00:00:00Z', payment_expires_at: '2026-11-13T00:00:00Z' };
    for (const status of ['Chưa thanh toán', 'Thất bại', 'Đã thanh toán']) {
        const paid = status === 'Đã thanh toán';
        const payment = { ...fixture().state.payment, payment_method: 'ONLINE', payment_status: status, transaction_date: paid ? new Date().toISOString() : null };
        const current = { ...order, status: paid ? 'Chờ xử lý' : 'Chờ thanh toán' };
        assert.equal(policy.customerCanCancel(current, payment), true);
        assert.equal(policy.customerCanCancel({ ...current, approved_at: new Date().toISOString() }, payment), false);
        assert.equal(policy.customerCanCancel({ ...current, status: 'Đã hủy' }, payment), false);
    }
});

test('paid Online cancellation releases consumed voucher and records only a pending refund atomically', async () => {
    const order = { workflow_version: 2, status: 'Chờ xử lý', stock_reserved_at: '2025-01-01 00:00:00', stock_reservation_source: 'checkout-v6',
        created_at_utc: '2025-01-01T00:00:00Z', payment_expires_at: '2025-01-02T00:00:00Z',
        voucher_code_snapshot: 'SYNTHETIC', subtotal_amount: '110.00', discount_amount: '10.00' };
    for (const failProduct of [undefined, 4]) {
        active = fixture(order, { paid: true, redemption: 'consumed', failProduct });
        const before = structuredClone(active.state);
        if (failProduct) {
            await assert.rejects(orders.cancel(10, 1, { reason_code: 'changed_mind' }));
            assert.deepEqual(active.state, before, 'Refund, voucher, stock and cancellation must roll back together');
        } else {
            const cancelled = await orders.cancel(10, 1, { reason_code: 'changed_mind' });
            assert.equal(cancelled.status, 'Đã hủy');
            assert.equal(cancelled.payment_status, 'Đã thanh toán');
            assert.equal(cancelled.cancellation_reason_code, 'customer_cancelled');
            assert.equal(cancelled.refunds.length, 1);
            assert.equal(cancelled.refunds[0].amount, '100.00');
            assert.equal(cancelled.refunds[0].status, 'requested');
            assert.equal(cancelled.refunds[0].confirmed_at_utc, null);
            assert.equal(active.state.redemption.status, 'released');
            const saved = structuredClone(active.state);
            await assert.rejects(orders.cancel(10, 1, { reason_code: 'changed_mind' }), { status: 409 });
            assert.deepEqual(active.state, saved);
        }
    }
});
