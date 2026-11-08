const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const pool = require('../config/db');
const orders = require('../models/order');
const adminOrders = require('../models/admin-order');
const payments = require('../models/payment');
const { createOnlineOrderService } = require('../services/online-orders');
const provider = require('../providers/simulated-payments');
const service = createOnlineOrderService({ pool });

let productId, legacyBefore;
const ownerId = 1, adminId = 2;
const sqlDate = date => new Date(date).toISOString().replace('T', ' ').replace('Z', '');
const iso = value => new Date(value).toISOString();

async function snapshotLegacy() {
    const result = {};
    for (const table of ['orders', 'order_details', 'payments', 'order_status_history']) {
        result[table] = (await pool.query(`SELECT * FROM \`${table}\` WHERE order_id IN (173,174) ORDER BY 1`))[0];
    }
    return result;
}
async function stock() {
    return (await pool.execute('SELECT stock_quantity FROM products WHERE product_id=?', [productId]))[0][0].stock_quantity;
}
async function create(method = 'ONLINE', quantity = 2, key = randomUUID()) {
    const input = { source: 'buy-now', items: [{ product_id: productId, quantity }],
        recipient_name: 'Synthetic Stage 1 customer', shipping_address: '123 Synthetic Street', phone: '0900000000', payment_method: method, note: null };
    const result = await orders.create(ownerId, input, key);
    return { ...result, input, key };
}
async function attempt(order, key = randomUUID()) {
    return service.createAttempt(ownerId, order.order_id, key);
}
async function nowUtc() {
    return (await pool.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') now_utc"))[0][0].now_utc;
}
async function evidence(attempt_, extras = {}) {
    const [[row]] = await pool.execute('SELECT amount FROM payment_attempts WHERE attempt_id=?', [attempt_.attempt_id]);
    return provider.issuePaymentEvent({ merchantReference: attempt_.merchant_reference,
        providerTransactionId: randomUUID(), eventId: randomUUID(), amount: row.amount,
        currency: 'VND', status: 'succeeded', paidAtUtc: iso(await nowUtc()), ...extras });
}
async function backdate(order, attempt_, { deadlineSecondsAgo = 60, paidOffsetMs = -1000 } = {}) {
    const now = new Date(await nowUtc()).getTime();
    const deadline = new Date(now - deadlineSecondsAgo * 1000);
    const created = new Date(deadline.getTime() - 24 * 60 * 60 * 1000);
    await pool.execute('UPDATE orders SET created_at_utc=?,payment_expires_at=? WHERE order_id=?', [sqlDate(created), sqlDate(deadline), order.order_id]);
    if (attempt_) await pool.execute('UPDATE payment_attempts SET initiated_at_utc=? WHERE attempt_id=?', [sqlDate(created), attempt_.attempt_id]);
    return { deadline: deadline.toISOString(), paidAt: new Date(deadline.getTime() + paidOffsetMs).toISOString() };
}
async function refunds(orderId) { return service.readRefunds(pool, orderId); }

before(async () => {
    assert.match(process.env.DB_NAME || '', /^petcare_test_[a-f0-9]{32}$/);
    assert.equal(process.env.DB_NAME, process.env.PETCARE_TEST_DATABASE);
    const [[product]] = await pool.query("SELECT product_id FROM products WHERE status='Đang bán' ORDER BY product_id LIMIT 1");
    productId = product.product_id;
    legacyBefore = await snapshotLegacy();
});
after(async () => {
    try { assert.deepEqual(await snapshotLegacy(), legacyBefore, 'New workflow must leave synthetic legacy orders 173/174 and their history unchanged'); }
    finally { await pool.end(); }
});

test('new Online order has exactly 24 hours and is payable before approval; checkout replay keeps deadline', async () => {
    const beforeStock = await stock();
    const created = await create();
    assert.equal(created.order.workflow_version, 2);
    assert.equal(created.order.status, 'Chờ thanh toán');
    assert.equal(created.order.approved_at, null);
    assert.equal(created.order.payment_status, 'Chưa thanh toán');
    const [[timing]] = await pool.execute('SELECT TIMESTAMPDIFF(MICROSECOND,created_at_utc,payment_expires_at) delta FROM orders WHERE order_id=?', [created.order.order_id]);
    assert.equal(Number(timing.delta), 24 * 60 * 60 * 1000000);
    const replay = await orders.create(ownerId, created.input, created.key);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.order_id, created.order.order_id);
    assert.equal(String(replay.order.payment_expires_at), String(created.order.payment_expires_at));
    assert.equal(await stock(), beforeStock - 2);
    await assert.rejects(adminOrders.approve(adminId, created.order.order_id), error => error.status === 409);
    const info = await payments.get(ownerId, created.order.order_id);
    assert.equal(info.can_simulate, true);
    const paid = await payments.simulate(ownerId, created.order.order_id, 'ONLINE_SUCCESS');
    assert.equal(paid.payment.payment_status, 'Đã thanh toán');
    assert.equal(paid.payment.order_status, 'Chờ xử lý');
    assert.equal(paid.payment.approved_at, null);
    assert.equal(await stock(), beforeStock - 2, 'Payment must not deduct held stock again');
    const approved = await adminOrders.approve(adminId, created.order.order_id);
    assert.equal(approved.status, 'Chờ giao hàng');
    assert.equal(await stock(), beforeStock - 2, 'Approval must not deduct held stock again');
});

test('COD keeps approval/delivery/cash behavior and has no payment deadline', async () => {
    const created = await create('COD');
    assert.equal(created.order.payment_expires_at ?? null, null);
    assert.equal(created.order.status, 'Chờ xử lý');
    const beforeStock = await stock();
    await adminOrders.approve(adminId, created.order.order_id);
    await adminOrders.update(adminId, created.order.order_id, 'Đang giao hàng');
    await assert.rejects(adminOrders.update(adminId, created.order.order_id, 'Đã giao hàng'), error => error.status === 409);
    const delivered = await adminOrders.update(adminId, created.order.order_id, 'Đã giao hàng', true);
    assert.equal(delivered.payment_status, 'Đã thanh toán');
    assert.equal(await stock(), beforeStock);
});

test('paid Online rejection creates one refund request, keeps payment evidence and releases stock once', async () => {
    const created = await create();
    await payments.simulate(ownerId, created.order.order_id, 'ONLINE_SUCCESS');
    const beforeStock = await stock();
    const results = await Promise.all(Array.from({ length: 4 }, () => adminOrders.reject(adminId, created.order.order_id, 'Synthetic rejection')));
    assert.ok(results.every(order => order.status === 'Đã hủy'));
    assert.equal(await stock(), beforeStock + 2);
    const saved = await orders.get(ownerId, created.order.order_id);
    assert.equal(saved.payment_status, 'Đã thanh toán');
    assert.ok(saved.transaction_date);
    const requests = await refunds(created.order.order_id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 'requested');
    assert.equal(requests[0].confirmed_at_utc, null);
    const [[counts]] = await pool.execute("SELECT COUNT(*) n FROM order_status_history WHERE order_id=? AND action='reject'", [created.order.order_id]);
    assert.equal(Number(counts.n), 1);
});

test('expiry and concurrent rejection restore inventory at most once and ignore legacy/COD', async () => {
    const created = await create();
    const beforeStock = await stock();
    await backdate(created.order);
    await Promise.allSettled([service.expireBatch({ limit: 100 }), service.expireBatch({ limit: 100 }), adminOrders.reject(adminId, created.order.order_id, 'Synthetic concurrent rejection')]);
    const saved = await orders.get(ownerId, created.order.order_id);
    assert.equal(saved.status, 'Đã hủy');
    assert.ok(saved.stock_restored_at);
    assert.equal(await stock(), beforeStock + 2);
    await service.expireBatch({ limit: 100 });
    assert.equal(await stock(), beforeStock + 2);
    const [[events]] = await pool.execute("SELECT COUNT(*) n FROM order_status_history WHERE order_id=? AND action IN ('reject','payment_expired')", [saved.order_id]);
    assert.equal(Number(events.n), 1);
    assert.deepEqual(await snapshotLegacy(), legacyBefore);
});

test('verified provider payment before deadline can apply after callback delay while stock is held', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    const { paidAt } = await backdate(created.order, attempt_);
    const beforeStock = await stock();
    await service.confirmProviderEvent(await evidence(attempt_, { paidAtUtc: paidAt }));
    const saved = await orders.get(ownerId, created.order.order_id);
    assert.equal(saved.status, 'Chờ xử lý');
    assert.equal(saved.payment_status, 'Đã thanh toán');
    assert.equal(saved.approved_at, null);
    assert.equal(await stock(), beforeStock);
    const [[capture]] = await pool.execute("SELECT DATE_FORMAT(provider_paid_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') paid_at,disposition FROM payment_attempts WHERE attempt_id=?", [attempt_.attempt_id]);
    assert.equal(iso(capture.paid_at), paidAt);
    assert.equal(capture.disposition, 'applied');
});

test('exact-deadline provider payment is unapplied, cancels active unpaid order and requests refund', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    const { deadline } = await backdate(created.order, attempt_, { paidOffsetMs: 0 });
    const beforeStock = await stock();
    await service.confirmProviderEvent(await evidence(attempt_, { paidAtUtc: deadline }));
    const saved = await orders.get(ownerId, created.order.order_id);
    assert.equal(saved.status, 'Đã hủy');
    assert.equal(await stock(), beforeStock + 2);
    const requests = await refunds(saved.order_id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 'requested');
});

test('on-time provider capture arriving after expiry never resurrects cancelled order', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    const { paidAt } = await backdate(created.order, attempt_);
    await service.expireBatch({ limit: 100 });
    const beforeStock = await stock();
    await service.confirmProviderEvent(await evidence(attempt_, { paidAtUtc: paidAt }));
    const saved = await orders.get(ownerId, created.order.order_id);
    assert.equal(saved.status, 'Đã hủy');
    assert.equal(await stock(), beforeStock);
    assert.equal((await refunds(saved.order_id))[0].status, 'requested');
});

test('payment after Admin rejection remains cancelled and is recorded for refund', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    await adminOrders.reject(adminId, created.order.order_id, 'Reject before provider confirmation');
    const beforeStock = await stock();
    await service.confirmProviderEvent(await evidence(attempt_));
    assert.equal((await orders.get(ownerId, created.order.order_id)).status, 'Đã hủy');
    assert.equal(await stock(), beforeStock);
    assert.equal((await refunds(created.order.order_id)).length, 1);
});

test('duplicate and reordered confirmations do not downgrade payment or create duplicate refunds', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    const success = await evidence(attempt_);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.confirmProviderEvent(success)));
    assert.ok(results.every(result => result.status === 'fulfilled'));
    await backdate(created.order, attempt_);
    await service.confirmProviderEvent(success);
    const failure = await evidence(attempt_, { status: 'failed', paidAtUtc: null });
    await service.confirmProviderEvent(failure);
    const saved = await orders.get(ownerId, created.order.order_id);
    assert.equal(saved.payment_status, 'Đã thanh toán');
    assert.equal(saved.status, 'Chờ xử lý');
    assert.equal((await refunds(saved.order_id)).length, 0);
});

test('two successful attempts apply only one capture and request refund for the extra capture', async () => {
    const created = await create();
    const a = await attempt(created.order), b = await attempt(created.order);
    const beforeStock = await stock();
    await Promise.all([service.confirmProviderEvent(await evidence(a)), service.confirmProviderEvent(await evidence(b))]);
    assert.equal((await orders.get(ownerId, created.order.order_id)).status, 'Chờ xử lý');
    assert.equal(await stock(), beforeStock);
    const requests = await refunds(created.order.order_id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 'requested');
});

test('same provider transaction with changed amount or payment time is flagged without changing its canonical receipt', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    const originalEvidence = await evidence(attempt_);
    await service.confirmProviderEvent(originalEvidence);
    const [[originalReceipt]] = await pool.execute('SELECT * FROM payment_attempts WHERE attempt_id=?', [attempt_.attempt_id]);
    for (const changed of [
        { amount: '1.00', paidAtUtc: originalEvidence.paidAtUtc },
        { amount: originalEvidence.amount, paidAtUtc: new Date(new Date(originalEvidence.paidAtUtc).getTime() - 1).toISOString() },
    ]) {
        const tampered = await evidence(attempt_, { providerTransactionId: originalEvidence.providerTransactionId, ...changed });
        const result = await service.confirmProviderEvent(tampered);
        assert.equal(result.disposition, 'manual_review');
    }
    const [[afterReceipt]] = await pool.execute('SELECT * FROM payment_attempts WHERE attempt_id=?', [attempt_.attempt_id]);
    assert.deepEqual(afterReceipt, originalReceipt);
    assert.equal((await refunds(created.order.order_id)).length, 0);
    assert.equal((await orders.get(ownerId, created.order.order_id)).status, 'Chờ xử lý');
});

test('second capture on the same attempt is stored/refunded once and its transaction cannot credit another order', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    await service.confirmProviderEvent(await evidence(attempt_));
    const extra = await evidence(attempt_);
    const result = await service.confirmProviderEvent(extra);
    assert.equal(result.disposition, 'excess_capture');
    await service.confirmProviderEvent(await evidence(attempt_, { providerTransactionId: extra.providerTransactionId, amount: extra.amount, paidAtUtc: extra.paidAtUtc }));
    const requests = await refunds(created.order.order_id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 'requested');
    const [[saved]] = await pool.execute("SELECT COUNT(*) n FROM payment_events WHERE attempt_id=? AND provider_transaction_id=? AND event_type='succeeded'", [attempt_.attempt_id, extra.providerTransactionId]);
    assert.ok(Number(saved.n) >= 1);
    const other = await create();
    const otherAttempt = await attempt(other.order);
    await assert.rejects(service.confirmProviderEvent(await evidence(otherAttempt, {
        providerTransactionId: extra.providerTransactionId, amount: extra.amount, paidAtUtc: extra.paidAtUtc,
    })));
    const unchanged = await orders.get(ownerId, other.order.order_id);
    assert.equal(unchanged.status, 'Chờ thanh toán');
    assert.equal(unchanged.payment_status, 'Chưa thanh toán');
});

test('provider confirmation racing expiry yields one inventory outcome and never revives a cancelled order', async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
        const created = await create();
        const attempt_ = await attempt(created.order);
        const { paidAt } = await backdate(created.order, attempt_);
        const proof = await evidence(attempt_, { paidAtUtc: paidAt });
        const beforeStock = await stock();
        const results = await Promise.allSettled([
            service.expireBatch({ limit: 100 }), service.confirmProviderEvent(proof), service.expireBatch({ limit: 100 }),
        ]);
        assert.equal(results[1].status, 'fulfilled', 'Verified receipt must be recorded regardless of which order lock wins');
        const saved = await orders.get(ownerId, created.order.order_id);
        const requests = await refunds(saved.order_id);
        if (saved.status === 'Đã hủy') {
            assert.ok(saved.stock_restored_at);
            assert.equal(await stock(), beforeStock + 2);
            assert.equal(requests.length, 1);
            assert.equal(requests[0].status, 'requested');
        } else {
            assert.equal(saved.status, 'Chờ xử lý');
            assert.equal(saved.payment_status, 'Đã thanh toán');
            assert.equal(saved.stock_restored_at, null);
            assert.equal(await stock(), beforeStock);
            assert.equal(requests.length, 0);
        }
        await service.confirmProviderEvent(proof);
        assert.equal((await orders.get(ownerId, created.order.order_id)).status, saved.status);
        assert.equal(await stock(), beforeStock + (saved.status === 'Đã hủy' ? 2 : 0));
    }
});

test('provider evidence cannot be forged by passing success/verified fields from a caller', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    assert.throws(() => provider.issuePaymentEvent({ merchantReference: attempt_.merchant_reference, amount: created.order.total_amount }));
    await assert.rejects(service.confirmProviderEvent({ verified: true, status: 'succeeded', merchantReference: attempt_.merchant_reference, amount: created.order.total_amount, paidAtUtc: iso(await nowUtc()) }));
    assert.equal((await orders.get(ownerId, created.order.order_id)).payment_status, 'Chưa thanh toán');
});

test('future provider paid time cannot mark order paid', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    const future = new Date(new Date(await nowUtc()).getTime() + 3600000).toISOString();
    await service.confirmProviderEvent(await evidence(attempt_, { paidAtUtc: future }));
    assert.notEqual((await orders.get(ownerId, created.order.order_id)).payment_status, 'Đã thanh toán');
});

test('provider success without a verifiable payment timestamp stays unapplied for reconciliation', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    await service.confirmProviderEvent(await evidence(attempt_, { paidAtUtc: null }));
    assert.equal((await orders.get(ownerId, created.order.order_id)).payment_status, 'Chưa thanh toán');
    const [[saved]] = await pool.execute('SELECT disposition,provider_paid_at_utc FROM payment_attempts WHERE attempt_id=?', [attempt_.attempt_id]);
    assert.equal(saved.disposition, 'manual_review');
    assert.equal(saved.provider_paid_at_utc, null);
});

test('amount mismatch stores actual captured amount and never credits the full order', async () => {
    const created = await create();
    const attempt_ = await attempt(created.order);
    await service.confirmProviderEvent(await evidence(attempt_, { amount: '1.00' }));
    assert.equal((await orders.get(ownerId, created.order.order_id)).payment_status, 'Chưa thanh toán');
    const [[saved]] = await pool.execute('SELECT captured_amount,disposition FROM payment_attempts WHERE attempt_id=?', [attempt_.attempt_id]);
    assert.equal(saved.captured_amount, '1.00');
    assert.equal(saved.disposition, 'amount_mismatch');
    const [request] = await refunds(created.order.order_id);
    assert.equal(request.amount, '1.00');
    assert.equal(request.status, 'requested');
});

test('attempt idempotency retains reference and rejects another user', async () => {
    const created = await create(), key = randomUUID();
    const a = await attempt(created.order, key), b = await attempt(created.order, key);
    assert.equal(String(a.attempt_id), String(b.attempt_id));
    assert.equal(a.merchant_reference, b.merchant_reference);
    await assert.rejects(service.createAttempt(adminId, created.order.order_id, randomUUID()), error => [403, 404].includes(error.status));
});

test('refund becomes succeeded only with verified provider result matching requested amount', async () => {
    const created = await create();
    await payments.simulate(ownerId, created.order.order_id, 'ONLINE_SUCCESS');
    await adminOrders.reject(adminId, created.order.order_id, 'Synthetic refund confirmation test');
    const [request] = await refunds(created.order.order_id);
    await assert.rejects(service.confirmRefundEvent({ verified: true, refundId: request.refund_id, status: 'succeeded' }));
    assert.equal((await refunds(created.order.order_id))[0].status, 'requested');
    const wrongAmount = provider.issueRefundEvent({ refundId: request.refund_id, eventId: randomUUID(), providerRefundId: randomUUID(),
        status: 'succeeded', amount: '1.00', currency: request.currency });
    await assert.rejects(service.confirmRefundEvent(wrongAmount));
    assert.equal((await refunds(created.order.order_id))[0].status, 'requested');
    const proof = provider.issueRefundEvent({ refundId: request.refund_id, eventId: randomUUID(), providerRefundId: randomUUID(),
        status: 'succeeded', amount: request.amount, currency: request.currency });
    await service.confirmRefundEvent(proof);
    await service.confirmRefundEvent(proof);
    const [confirmed] = await refunds(created.order.order_id);
    assert.equal(confirmed.status, 'succeeded');
    assert.ok(confirmed.confirmed_at_utc);
    await assert.rejects(service.confirmRefundEvent(provider.issueRefundEvent({ refundId: request.refund_id, eventId: randomUUID(),
        providerRefundId: randomUUID(), status: 'succeeded', amount: request.amount, currency: request.currency })));
    await service.confirmRefundEvent(provider.issueRefundEvent({ refundId: request.refund_id, eventId: randomUUID(),
        status: 'failed', amount: request.amount, currency: request.currency }));
    assert.equal((await refunds(created.order.order_id))[0].status, 'succeeded');
});

test('a provider refund reference cannot confirm two different refund requests', async () => {
    const requests = [];
    for (let index = 0; index < 2; index++) {
        const created = await create();
        await payments.simulate(ownerId, created.order.order_id, 'ONLINE_SUCCESS');
        await adminOrders.reject(adminId, created.order.order_id, 'Synthetic duplicate refund reference test');
        requests.push({ ...(await refunds(created.order.order_id))[0], orderId: created.order.order_id });
    }
    const providerRefundId = randomUUID();
    const first = requests[0], second = requests[1];
    await service.confirmRefundEvent(provider.issueRefundEvent({ refundId: first.refund_id, eventId: randomUUID(), providerRefundId,
        status: 'succeeded', amount: first.amount, currency: first.currency }));
    await assert.rejects(service.confirmRefundEvent(provider.issueRefundEvent({ refundId: second.refund_id, eventId: randomUUID(), providerRefundId,
        status: 'succeeded', amount: second.amount, currency: second.currency })));
    assert.equal((await refunds(first.orderId))[0].status, 'succeeded');
    const [unchanged] = await refunds(second.orderId);
    assert.equal(unchanged.status, 'requested');
    assert.equal(unchanged.confirmed_at_utc, null);
});

test('failure after stock restoration rolls back cancellation, inventory and history together', async () => {
    const created = await create();
    const beforeStock = await stock();
    const original = pool.getConnection;
    let sawStockWrite = false;
    pool.getConnection = async function () {
        const db = await original.call(pool), execute = db.execute.bind(db), release = db.release.bind(db);
        db.execute = async (sql, values) => {
            if (sawStockWrite && /^INSERT INTO order_status_history/.test(sql)) throw new Error('Synthetic failure after inventory restoration');
            const result = await execute(sql, values);
            if (/UPDATE products SET stock_quantity\s*=\s*stock_quantity\s*\+/.test(sql)) sawStockWrite = true;
            return result;
        };
        db.release = () => { db.execute = execute; db.release = release; release(); };
        return db;
    };
    try { await assert.rejects(adminOrders.reject(adminId, created.order.order_id, 'Synthetic rollback')); }
    finally { pool.getConnection = original; }
    assert.equal(sawStockWrite, true);
    assert.equal(await stock(), beforeStock);
    const saved = await orders.get(ownerId, created.order.order_id);
    assert.equal(saved.status, 'Chờ thanh toán');
    assert.equal(saved.stock_restored_at, null);
});

test('new flow remains disabled when frontend readiness is absent', async () => {
    const previous = process.env.PETCARE_ORDER_FRONTEND_READY;
    process.env.PETCARE_ORDER_FRONTEND_READY = '0';
    try {
        const beforeStock = await stock();
        const [[beforeCount]] = await pool.query('SELECT COUNT(*) n FROM orders');
        await assert.rejects(create(), error => error.status === 503);
        const [[afterCount]] = await pool.query('SELECT COUNT(*) n FROM orders');
        assert.equal(Number(afterCount.n), Number(beforeCount.n));
        assert.equal(await stock(), beforeStock);
    } finally { process.env.PETCARE_ORDER_FRONTEND_READY = previous; }
});

test('disabled workflow flag retains legacy creation instead of activating a new policy', async () => {
    const previous = process.env.PETCARE_ORDER_WORKFLOW_ENABLED;
    process.env.PETCARE_ORDER_WORKFLOW_ENABLED = '0';
    try {
        const created = await create();
        assert.equal(created.order.workflow_version ?? null, null);
        assert.equal(created.order.payment_expires_at ?? null, null);
    } finally { process.env.PETCARE_ORDER_WORKFLOW_ENABLED = previous; }
});
