// Focused service checks with SQL doubles only; this file never opens MySQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOnlineOrderService } = require('../services/online-orders');

const service = createOnlineOrderService();
const created = Date.parse('2025-01-01T00:00:00.000Z');
const options = { reason: 'Tôi muốn đổi sản phẩm.', actorId: 10, actorName: 'Khách hàng' };

function fixture({ paid = false, failed = false, verified = true, lines, stock } = {}) {
    const order = {
        order_id: 20, user_id: 10, workflow_version: 2, total_amount: '80000.00',
        status: paid ? 'Chờ xử lý' : 'Chờ thanh toán', approved_at: null,
        stock_reserved_at: '2025-01-01 00:00:00', stock_reservation_source: 'checkout-v6',
        stock_restored_at: null, rejection_reason: null, cancelled_at: null, cancellation_reason_code: null,
        created_at_utc: new Date(created).toISOString(), payment_expires_at: new Date(created + 86400000).toISOString()
    };
    const payment = {
        payment_id: 30, order_id: order.order_id, payment_method: 'ONLINE', amount: order.total_amount,
        payment_status: paid ? 'Đã thanh toán' : failed ? 'Thất bại' : 'Chưa thanh toán',
        transaction_date: paid ? '2025-01-01 00:00:02' : null
    };
    const attempt = {
        attempt_id: 40, payment_id: payment.payment_id, status: 'succeeded', disposition: 'applied',
        provider: 'SIMULATOR', provider_environment: 'test', provider_transaction_id: 'verified-capture',
        amount: payment.amount, captured_amount: payment.amount, currency: 'VND', captured_currency: 'VND',
        initiated_ms: created + 1000, provider_paid_ms: created + 2000,
        confirmed_at_utc: '2025-01-01 00:00:03', received_at_utc: '2025-01-01 00:00:03'
    };
    const receipt = {
        event_id: 50, event_type: 'succeeded', disposition: 'applied', verification_source: verified ? 'test-provider' : null,
        provider_transaction_id: attempt.provider_transaction_id, amount: payment.amount, currency: 'VND',
        received_at_utc: '2025-01-01 00:00:03', provider_paid_ms: attempt.provider_paid_ms
    };
    const calls = [];
    const db = {
        async query(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('AS now_ms')) return [[{ now_ms: created + 3000, now_sql: '2025-01-01 00:00:03.000' }]];
            throw new Error(`Unexpected query: ${sql}`);
        },
        async execute(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('FROM payment_attempts')) return [[{ ...attempt }]];
            if (sql.includes('FROM payment_events')) return [[{ ...receipt }]];
            if (sql.includes('AS created_ms')) return [[{ created_ms: created, expires_ms: created + 86400000 }]];
            if (sql.startsWith('SELECT * FROM refund_requests')) return [[]];
            if (sql.includes('SUM(amount)')) return [[{ total: '0.00' }]];
            if (sql.startsWith('SELECT product_id,quantity')) return [lines || [{ product_id: 2, quantity: 2 }]];
            if (sql.startsWith('SELECT stock_quantity')) return [[{ stock_quantity: stock ?? 0 }]];
            if (sql.startsWith('UPDATE ')) return [{ affectedRows: 1 }];
            if (sql.startsWith('INSERT ')) return [{ insertId: 60, affectedRows: 1 }];
            throw new Error(`Unexpected execute: ${sql}`);
        }
    };
    return { db, calls, order, payment };
}

for (const failed of [false, true]) {
    test(`customer cancels ${failed ? 'failed' : 'unpaid'} Online payment with one stock release and audit event`, async () => {
        const value = fixture({ failed });
        assert.deepEqual(await service.cancelLocked(value.db, value.order, value.payment, options), { changed: true });
        const cancellation = value.calls.find(call => call.sql.includes('rejection_reason = ?'));
        assert.deepEqual(cancellation.values, [null, '2025-01-01 00:00:03.000', 'customer_cancelled', 20]);
        assert.equal(value.calls.filter(call => call.sql.startsWith('UPDATE products')).length, 1);
        assert.equal(value.calls.filter(call => call.sql.startsWith('UPDATE payments')).length, 1);
        assert.equal(value.calls.some(call => call.sql.includes('INSERT INTO refund_requests')), false);
        const audit = value.calls.find(call => call.sql.includes('INSERT INTO order_status_history'));
        assert.deepEqual(audit.values, [20, 'Chờ thanh toán', 'Đã hủy', 'cancel', 10, 'Khách hàng', options.reason, 'customer-cancel:20']);
    });
}

test('paid customer cancellation requests the captured net amount without marking refund or payment complete', async () => {
    const value = fixture({ paid: true });
    await service.cancelLocked(value.db, value.order, value.payment, options);
    const refund = value.calls.find(call => call.sql.includes('INSERT INTO refund_requests'));
    assert.equal(refund.values[5], '80000.00');
    assert.equal(refund.values[7], 'customer_cancelled');
    assert.match(refund.sql, /'requested'/);
    assert.equal(refund.sql.includes('confirmed_at_utc'), false);
    assert.equal(value.calls.some(call => call.sql.startsWith('UPDATE payments')), false);
    assert.equal(value.payment.payment_status, 'Đã thanh toán');
    assert.equal(value.calls.filter(call => call.sql.includes('INSERT INTO refund_events')).length, 1);
});

test('paid cancellation rejects unverified receipt before refund, inventory or cancellation writes', async () => {
    const value = fixture({ paid: true, verified: false });
    await assert.rejects(service.cancelLocked(value.db, value.order, value.payment, options), { status: 409 });
    assert.equal(value.calls.some(call => /^(?:INSERT|UPDATE)\b/.test(call.sql)), false);
});

test('customer cannot cancel an already cancelled or approved Online order', async () => {
    for (const [status, reasonCode] of [['Đã hủy', 'admin_rejected'], ['Đã hủy', 'customer_cancelled'], ['Chờ giao hàng', null]]) {
        const value = fixture({ paid: true });
        Object.assign(value.order, status === 'Đã hủy' ? {
            status, stock_restored_at: '2025-01-01 00:00:03', cancelled_at: '2025-01-01 00:00:03',
            cancellation_reason_code: reasonCode, rejection_reason: reasonCode === 'admin_rejected' ? options.reason : null
        } : { status, approved_at: '2025-01-01 00:00:03' });
        await assert.rejects(service.cancelLocked(value.db, value.order, value.payment, options), { status: 409 });
        assert.equal(value.calls.length, 0);
    }
});

test('expiration skips a customer-cancelled order without releasing inventory again', async () => {
    const value = fixture();
    Object.assign(value.order, { status: 'Đã hủy', stock_restored_at: '2025-01-01 00:00:03',
        cancelled_at: '2025-01-01 00:00:03', cancellation_reason_code: 'customer_cancelled' });
    value.payment.payment_status = 'Đã hủy';
    assert.deepEqual(await service.expireLocked(value.db, value.order, value.payment), { expired: false });
    assert.equal(value.calls.length, 0);
});

test('Admin paid rejection retains its reason, pending refund and idempotent retry', async () => {
    const value = fixture({ paid: true });
    await service.rejectLocked(value.db, value.order, value.payment, options);
    const refund = value.calls.find(call => call.sql.includes('INSERT INTO refund_requests'));
    assert.equal(refund.values[7], 'admin_rejected');
    const cancellation = value.calls.find(call => call.sql.includes('rejection_reason = ?'));
    assert.equal(cancellation.values[0], options.reason);
    assert.equal(cancellation.values[2], 'admin_rejected');
    const audit = value.calls.find(call => call.sql.includes('INSERT INTO order_status_history'));
    assert.equal(audit.values[3], 'reject');
    assert.equal(audit.values[7], 'reject:20');
    Object.assign(value.order, { status: 'Đã hủy', cancelled_at: '2025-01-01 00:00:03',
        cancellation_reason_code: 'admin_rejected', rejection_reason: options.reason });
    const callCount = value.calls.length;
    assert.deepEqual(await service.rejectLocked(value.db, value.order, value.payment, options), { changed: false });
    assert.equal(value.calls.length, callCount);
    await assert.rejects(service.rejectLocked(value.db, value.order, value.payment, { ...options, reason: 'Khác' }), { status: 409 });
});

test('stock release supports verified legacy reservations, aggregates duplicate lines and runs once', async () => {
    const value = fixture({ lines: [{ product_id: 3, quantity: 2 }, { product_id: 2, quantity: 1 }, { product_id: 3, quantity: 4 }] });
    Object.assign(value.order, { workflow_version: null, stock_reserved_at: null, stock_reservation_source: 'checkout-v4-fingerprint' });
    assert.equal(await service.releaseStockLocked(value.db, value.order), true);
    const updates = value.calls.filter(call => call.sql.startsWith('UPDATE products'));
    assert.deepEqual(updates.map(call => call.values.slice(0, 2)), [[1, 2], [6, 3]]);
    const callCount = value.calls.length;
    assert.equal(await service.releaseStockLocked(value.db, value.order), false);
    assert.equal(value.calls.length, callCount);
});

test('invalid or overflowing inventory prevents every inventory mutation', async () => {
    for (const input of [{ stock: 2147483647 }, { lines: [{ product_id: 2, quantity: 0 }] }, { stock: -1 }]) {
        const value = fixture(input);
        await assert.rejects(service.releaseStockLocked(value.db, value.order), { status: 409 });
        assert.equal(value.calls.some(call => call.sql.startsWith('UPDATE ')), false);
    }
});

test('a valid legacy reservation timestamp is sufficient without a source marker', async () => {
    const value = fixture();
    Object.assign(value.order, { workflow_version: null, stock_reservation_source: null, stock_reservation_valid: 1 });
    assert.equal(await service.releaseStockLocked(value.db, value.order), true);
    assert.equal(value.calls.filter(call => call.sql.startsWith('UPDATE products')).length, 1);
});

test('missing or database-invalid reservation proof blocks stock restoration', async () => {
    for (const proof of [{ stock_reserved_at: null }, { stock_reservation_valid: 0 }, { stock_reserved_at: 'invalid', stock_reservation_valid: undefined }]) {
        const value = fixture();
        Object.assign(value.order, { workflow_version: null, stock_reservation_source: null }, proof);
        await assert.rejects(service.releaseStockLocked(value.db, value.order), { status: 409 });
        assert.equal(value.calls.length, 0);
    }
});
