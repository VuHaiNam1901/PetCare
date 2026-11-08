const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const pool = require('../config/db');
const orders = require('../models/order');
const catalog = require('../models/catalog');
const { createOnlineOrderService } = require('../services/online-orders');
const provider = require('../providers/simulated-payments');
const service = createOnlineOrderService({ pool });
const ownerId = 1, adminId = 2;
const hash = value => createHash('sha256').update(value).digest('hex');
const sqlDate = value => new Date(value).toISOString().slice(0, 23).replace('T', ' ');

async function nowUtc() {
    const [[row]] = await pool.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') now_utc");
    return new Date(row.now_utc).toISOString();
}
async function fixture({ expired = true, overflow = false } = {}) {
    const [[category]] = await pool.query('SELECT category_id FROM categories ORDER BY category_id LIMIT 1');
    const [product] = await pool.execute(`INSERT INTO products
        (category_id,name,description,price,stock_quantity,image_url,status,created_at)
        VALUES (?,?,'Synthetic final-review fixture','125000.00',20,'/images/products/test.webp','Đang bán',NOW())`,
    [category.category_id, `Synthetic final finance ${randomUUID()}`]);
    const input = { source: 'buy-now', items: [{ product_id: product.insertId, quantity: 2 }],
        recipient_name: 'Synthetic final finance owner', shipping_address: '123 Invented Street', phone: '0900000000', payment_method: 'ONLINE', note: null };
    const { order } = await orders.create(ownerId, input, randomUUID());
    const attempt = await service.createAttempt(ownerId, order.order_id, randomUUID());
    if (expired) {
        const deadline = new Date(new Date(await nowUtc()).getTime() - 60000);
        const created = new Date(deadline.getTime() - 86400000);
        await pool.execute('UPDATE orders SET created_at_utc=?,payment_expires_at=? WHERE order_id=?', [sqlDate(created), sqlDate(deadline), order.order_id]);
        await pool.execute('UPDATE payment_attempts SET initiated_at_utc=? WHERE attempt_id=?', [sqlDate(created), attempt.attempt_id]);
    }
    // This is accepted by the existing Admin catalog API/model. It must not
    // prevent the backend from recording independent evidence of money received.
    if (overflow) await catalog.updateProduct(adminId, product.insertId, { stock_quantity: 2147483647 });
    return { order, attempt, productId: product.insertId };
}
async function proof(fixture_, status = 'succeeded') {
    return provider.issuePaymentEvent({ merchantReference: fixture_.attempt.merchant_reference,
        providerTransactionId: randomUUID(), eventId: randomUUID(), amount: fixture_.attempt.amount, currency: 'VND',
        status, paidAtUtc: status === 'succeeded' ? await nowUtc() : null });
}
async function stored(fixture_, evidence) {
    const [[attempt]] = await pool.execute('SELECT * FROM payment_attempts WHERE attempt_id=?', [fixture_.attempt.attempt_id]);
    const [events] = await pool.execute('SELECT * FROM payment_events WHERE attempt_id=? ORDER BY event_id', [fixture_.attempt.attempt_id]);
    const [refunds] = await pool.execute('SELECT * FROM refund_requests WHERE attempt_id=? ORDER BY refund_id', [fixture_.attempt.attempt_id]);
    const [[product]] = await pool.execute('SELECT stock_quantity FROM products WHERE product_id=?', [fixture_.productId]);
    const order = await orders.get(ownerId, fixture_.order.order_id);
    const canonical = evidence && events.find(event => event.event_key === hash(`receipt:SIMULATOR:test:${evidence.providerTransactionId}`));
    return { attempt, events, refunds, stock: product.stock_quantity, order, canonical };
}
function faultPool({ failInsert = false, failCommit = false, loseCommitResponse = false }) {
    return {
        async getConnection() {
            const db = await pool.getConnection();
            return {
                query: db.query.bind(db), beginTransaction: db.beginTransaction.bind(db), rollback: db.rollback.bind(db), release: db.release.bind(db),
                async execute(sql, values) {
                    if (failInsert && /^INSERT INTO payment_events/.test(sql)) throw Object.assign(new Error('Synthetic event insert failure'), { code: 'SYNTHETIC_INSERT_FAILURE' });
                    return db.execute(sql, values);
                },
                async commit() {
                    if (failCommit) throw Object.assign(new Error('Synthetic failure before COMMIT'), { code: 'SYNTHETIC_COMMIT_FAILURE' });
                    await db.commit();
                    if (loseCommitResponse) throw Object.assign(new Error('Synthetic lost COMMIT response'), { code: 'SYNTHETIC_COMMIT_RESPONSE_LOST' });
                },
            };
        },
    };
}

before(() => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.PETCARE_TEST_ISOLATED, '1');
    assert.match(process.env.DB_NAME || '', /^petcare_test_[a-f0-9]{32}$/);
    assert.equal(process.env.DB_NAME, process.env.PETCARE_TEST_DATABASE);
    assert.notEqual(process.env.DB_NAME, process.env.PETCARE_TEST_SOURCE_DATABASE);
});
after(async () => { await pool.end(); });

test('verified late capture and refund survive inventory compensation overflow; worker can retry release once', async () => {
    const fixture_ = await fixture({ overflow: true });
    const evidence = await proof(fixture_);
    const result = await service.confirmProviderEvent(evidence);
    assert.equal(result.compensation_pending, true);
    assert.equal(result.compensation_error, 'STOCK_REVIEW_REQUIRED');
    const saved = await stored(fixture_, evidence);
    assert.equal(saved.attempt.status, 'captured_unapplied');
    assert.equal(saved.attempt.disposition, 'late_capture');
    assert.ok(saved.canonical, 'The independently verified capture must remain durable');
    assert.equal(saved.refunds.length, 1);
    assert.equal(saved.refunds[0].status, 'requested');
    assert.equal(saved.order.status, 'Chờ thanh toán');
    assert.equal(saved.order.payment_status, 'Chưa thanh toán');
    assert.equal(saved.order.stock_restored_at, null);
    assert.equal(saved.stock, 2147483647);
    await service.confirmProviderEvent(evidence);
    assert.equal((await stored(fixture_, evidence)).refunds.length, 1);
    await catalog.updateProduct(adminId, fixture_.productId, { stock_quantity: 20 });
    await service.expireBatch({ limit: 100 });
    const compensated = await stored(fixture_, evidence);
    assert.equal(compensated.order.status, 'Đã hủy');
    assert.equal(compensated.stock, 22);
    await service.expireBatch({ limit: 100 });
    assert.equal((await stored(fixture_, evidence)).stock, 22);
});

for (const status of ['failed', 'unknown']) {
    test(`verified ${status} event remains durable when expiry compensation cannot release inventory`, async () => {
        const fixture_ = await fixture({ overflow: true });
        const evidence = await proof(fixture_, status);
        const result = await service.confirmProviderEvent(evidence);
        assert.equal(result.compensation_pending, true);
        const saved = await stored(fixture_, evidence);
        assert.equal(saved.attempt.status, status);
        assert.ok(saved.events.some(event => event.event_type === status));
        assert.equal(saved.refunds.length, 0, 'An unknown or failed result is not proof of captured money');
        assert.equal(saved.order.stock_restored_at, null);
        assert.equal(saved.order.status, 'Chờ thanh toán');
        assert.equal(saved.order.payment_status, status === 'failed' ? 'Thất bại' : 'Chưa thanh toán');
        assert.equal(saved.stock, 2147483647);
        await catalog.updateProduct(adminId, fixture_.productId, { stock_quantity: 20 });
        await service.expireBatch({ limit: 100 });
        const compensated = await stored(fixture_, evidence);
        assert.equal(compensated.order.status, 'Đã hủy');
        assert.equal(compensated.stock, 22);
        assert.equal(compensated.refunds.length, 0);
        assert.equal(compensated.attempt.status, status);
    });
}

test('unknown result expires safely and a later verified on-time capture requests refund without resurrection', async () => {
    const fixture_ = await fixture();
    await service.confirmProviderEvent(await proof(fixture_, 'unknown'));
    const expired = await stored(fixture_);
    assert.equal(expired.order.status, 'Đã hủy');
    assert.equal(expired.attempt.status, 'unknown');
    assert.equal(expired.refunds.length, 0);
    assert.equal(expired.stock, 20);
    const [[time]] = await pool.execute("SELECT DATE_FORMAT(DATE_SUB(payment_expires_at,INTERVAL 1 SECOND),'%Y-%m-%dT%H:%i:%s.%fZ') paid_at FROM orders WHERE order_id=?", [fixture_.order.order_id]);
    const evidence = provider.issuePaymentEvent({ merchantReference: fixture_.attempt.merchant_reference,
        eventId: randomUUID(), providerTransactionId: randomUUID(), status: 'succeeded', amount: fixture_.attempt.amount,
        currency: 'VND', paidAtUtc: new Date(time.paid_at).toISOString() });
    await service.confirmProviderEvent(evidence);
    const late = await stored(fixture_, evidence);
    assert.equal(late.order.status, 'Đã hủy');
    assert.equal(late.stock, 20);
    assert.equal(late.attempt.status, 'captured_unapplied');
    assert.equal(late.refunds.length, 1);
    assert.equal(late.refunds[0].status, 'requested');
});

for (const fault of [{ failInsert: true }, { failCommit: true }]) {
    test(`${fault.failInsert ? 'receipt insert' : 'pre-commit'} failure still rolls back the whole settlement`, async () => {
        const fixture_ = await fixture({ expired: false });
        const evidence = await proof(fixture_);
        const faulty = createOnlineOrderService({ pool: faultPool(fault) });
        await assert.rejects(faulty.confirmProviderEvent(evidence));
        const failed = await stored(fixture_, evidence);
        assert.equal(failed.events.length, 0);
        assert.equal(failed.refunds.length, 0);
        assert.equal(failed.attempt.status, 'initiated');
        assert.equal(failed.order.payment_status, 'Chưa thanh toán');
        assert.equal(failed.order.status, 'Chờ thanh toán');
        assert.equal(failed.stock, 18);
        await service.confirmProviderEvent(evidence);
        const retried = await stored(fixture_, evidence);
        assert.equal(retried.order.status, 'Chờ xử lý');
        assert.equal(retried.order.payment_status, 'Đã thanh toán');
        assert.equal(retried.stock, 18);
    });
}

test('lost COMMIT response retains the accepted receipt and an identical retry cannot capture twice', async () => {
    const fixture_ = await fixture({ expired: false });
    const evidence = await proof(fixture_);
    const faulty = createOnlineOrderService({ pool: faultPool({ loseCommitResponse: true }) });
    await assert.rejects(faulty.confirmProviderEvent(evidence));
    const accepted = await stored(fixture_, evidence);
    assert.equal(accepted.order.payment_status, 'Đã thanh toán');
    assert.equal(accepted.stock, 18);
    assert.ok(accepted.canonical);
    const beforeEvents = accepted.events.length;
    assert.equal((await service.confirmProviderEvent(evidence)).replayed, true);
    const retried = await stored(fixture_, evidence);
    assert.equal(retried.events.length, beforeEvents);
    assert.equal(retried.refunds.length, 0);
    assert.equal(retried.stock, 18);
});
