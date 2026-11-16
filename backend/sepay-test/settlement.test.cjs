const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const mysql = require('mysql2/promise');
const env = { ...process.env };
if (env.NODE_ENV !== 'test' || env.PETCARE_TEST_ISOLATED !== '1' ||
    !/^petcare_test_[a-f0-9]{32}$/.test(env.DB_NAME || '') || env.DB_NAME !== env.PETCARE_TEST_DATABASE ||
    env.DB_NAME === env.PETCARE_TEST_SOURCE_DATABASE || env.SEPAY_TEST_WRITE_DATABASE !== env.DB_NAME) {
    throw new Error('Use the dedicated runner with its newly generated isolated settlement schema');
}
const pool = require('../config/db');
const orders = require('../models/order');
const adminOrders = require('../models/admin-order');
const { createOnlineOrderService } = require('../services/online-orders');
const { createSePayTestService } = require('../services/sepay-test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'petcare-sepay-settlement-'));
const services = [];
const lifecycle = createOnlineOrderService({ pool, logger: { info() {}, error() {} } });
let nextEvent = 910000;
function service(name, overrides = {}) {
    const app = createSePayTestService({ pool, env, receiptDirectory: path.join(root, name), ...overrides });
    services.push(app);
    return app;
}
async function state(orderId) {
    const [[order]] = await pool.execute('SELECT * FROM orders WHERE order_id=?', [orderId]);
    const [[payment]] = await pool.execute('SELECT * FROM payments WHERE order_id=?', [orderId]);
    const [attempts] = await pool.execute('SELECT * FROM payment_attempts WHERE payment_id=? ORDER BY attempt_id', [payment.payment_id]);
    const [events] = await pool.execute('SELECT e.* FROM payment_events e JOIN payment_attempts a ON a.attempt_id=e.attempt_id WHERE a.payment_id=? ORDER BY e.event_id', [payment.payment_id]);
    const [refunds] = await pool.execute('SELECT r.* FROM refund_requests r JOIN payment_attempts a ON a.attempt_id=r.attempt_id WHERE a.payment_id=? ORDER BY r.refund_id', [payment.payment_id]);
    const [history] = await pool.execute('SELECT * FROM order_status_history WHERE order_id=? ORDER BY history_id', [orderId]);
    const [redemptions] = await pool.execute('SELECT * FROM voucher_redemptions WHERE order_id=? ORDER BY redemption_id', [orderId]);
    const [[product]] = await pool.query('SELECT stock_quantity FROM products WHERE product_id=1');
    return { order, payment, attempts, events, refunds, history, redemptions, stock: product.stock_quantity };
}
async function financialSnapshot() {
    const result = {};
    for (const table of ['orders', 'payments', 'payment_attempts', 'payment_events', 'refund_requests', 'refund_events', 'order_status_history', 'products', 'vouchers', 'voucher_redemptions']) {
        result[table] = (await pool.query(`SELECT * FROM \`${table}\` ORDER BY 1`))[0];
    }
    return result;
}
async function fixture(app, voucher = false) {
    const input = { source: 'buy-now', items: [{ product_id: 1, quantity: 1 }],
        recipient_name: 'Synthetic settlement customer', shipping_address: '123 Invented SePay Street',
        phone: '0900000000', payment_method: 'ONLINE', note: null, ...(voucher ? { voucher_code: 'SEPAYFIXED' } : {}) };
    const { order } = await orders.create(1, input, randomUUID());
    const qr = await app.qrForOrder(1, order.order_id);
    assert.ok(qr, 'An eligible synthetic order must expose its test QR');
    assert.equal(qr.reconciliationOnly, false);
    // SePay supplies bank transaction time at second resolution. Let its next
    // full second follow the attempt's actual millisecond initiation time.
    await new Promise(resolve => setTimeout(resolve, 1005 - Date.now() % 1000));
    return { orderId: order.order_id, amount: Number(qr.amount), qr };
}
function delivery(fixture_, change = {}, secret = env.SEPAY_TEST_WEBHOOK_SECRET) {
    const id = ++nextEvent;
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = { id, gateway: 'VietinBank', accountNumber: env.SEPAY_TEST_ACCOUNT_NUMBER, subAccount: '',
        transactionDate: new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
        code: `PCS${fixture_.orderId}`, content: `SEVQR PCS${fixture_.orderId}`, transferType: 'in',
        transferAmount: fixture_.amount, accumulated: 0, referenceCode: `SYNTHETIC-SETTLEMENT-${id}`, ...change };
    const raw = Buffer.from(JSON.stringify(payload));
    return { payload, args: [raw, { 'content-type': 'application/json', 'x-sepay-timestamp': String(timestamp),
        'x-sepay-signature': 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex') }] };
}
before(async () => {
    const [[actual]] = await pool.query('SELECT DATABASE() AS name');
    assert.equal(actual.name, env.PETCARE_TEST_DATABASE);
});
after(async () => {
    try { for (const app of services) await app.close(); }
    finally {
        await pool.end();
        const target = fs.realpathSync(root);
        assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(target).startsWith('petcare-sepay-settlement-'));
        fs.rmSync(target, { recursive: true, force: true });
    }
});

test('verified exact payment applies once before admin approval and preserves held stock and voucher rules', async () => {
    const app = service('correct');
    const fixture_ = await fixture(app, true);
    const before = await state(fixture_.orderId);
    const result = await app.reconcile(...delivery(fixture_).args);
    assert.equal(result.disposition, 'applied');
    const saved = await state(fixture_.orderId);
    assert.equal(saved.payment.payment_status, 'Đã thanh toán');
    assert.ok(saved.payment.transaction_date);
    assert.equal(saved.order.status, 'Chờ xử lý');
    assert.equal(saved.order.approved_at, null);
    assert.equal(saved.stock, before.stock, 'Settlement cannot deduct held inventory again');
    assert.equal(saved.order.total_amount, '140000.00', 'Final voucher-discounted amount comes from the stored order');
    assert.equal(saved.redemptions.length, 1);
    assert.equal(saved.redemptions[0].status, 'consumed');
    assert.equal(saved.redemptions[0].discount_amount, before.redemptions[0].discount_amount);
    assert.equal(saved.attempts.filter(attempt => attempt.provider === 'SEPAY' && attempt.disposition === 'applied').length, 1);
    assert.equal(saved.refunds.length, 0);
});

test('underpayment and overpayment remain unpaid with recorded captures and pending refund requests only', async () => {
    const app = service('mismatches');
    for (const adjustment of [-1, 1]) {
        const fixture_ = await fixture(app);
        const before = await state(fixture_.orderId);
        const result = await app.reconcile(...delivery(fixture_, { transferAmount: fixture_.amount + adjustment }).args);
        assert.equal(result.disposition, 'amount_mismatch');
        const saved = await state(fixture_.orderId);
        assert.equal(saved.payment.payment_status, 'Chưa thanh toán');
        assert.equal(saved.payment.transaction_date, null);
        assert.equal(saved.order.status, 'Chờ thanh toán');
        assert.equal(saved.stock, before.stock);
        assert.equal(saved.attempts[0].status, 'captured_unapplied');
        assert.equal(saved.refunds.length, 1);
        assert.equal(saved.refunds[0].status, 'requested');
        assert.equal(saved.refunds[0].confirmed_at_utc, null);
        assert.equal(saved.refunds[0].amount, `${fixture_.amount + adjustment}.00`);
    }
});

test('concurrent callbacks, QR reopening and service restart keep one applied capture and one payment transition', async () => {
    const app = service('concurrent');
    const fixture_ = await fixture(app);
    const secondQr = await app.qrForOrder(1, fixture_.orderId);
    assert.equal(secondQr.paymentCode, fixture_.qr.paymentCode);
    assert.equal((await state(fixture_.orderId)).attempts.length, 1);
    const request = delivery(fixture_);
    const results = await Promise.all(Array.from({ length: 3 }, () => app.reconcile(...request.args)));
    assert.ok(results.every(result => result.disposition === 'applied'));
    const saved = await state(fixture_.orderId);
    assert.equal(saved.attempts.length, 1);
    assert.equal(saved.events.length, 2, 'One canonical receipt plus one distinct callback');
    assert.equal(saved.history.filter(row => row.action === 'payment').length, 1);
    assert.equal(saved.refunds.length, 0);
    await app.close();
    const reopened = service('restarted');
    await reopened.reconcile(...request.args);
    assert.deepEqual(await state(fixture_.orderId), saved);
    const repeatedReference = delivery(fixture_, { referenceCode: request.payload.referenceCode, transactionDate: request.payload.transactionDate });
    await reopened.reconcile(...repeatedReference.args);
    const after = await state(fixture_.orderId);
    assert.equal(after.attempts.length, 1);
    assert.equal(after.history.filter(row => row.action === 'payment').length, 1);
    assert.equal(new Set(after.events.map(row => row.provider_transaction_id)).size, 1);
    assert.equal(after.refunds.length, 0);
    const sibling = await fixture(reopened);
    const beforeCrossAttempt = await financialSnapshot();
    for (const change of [
        { referenceCode: request.payload.referenceCode, transactionDate: request.payload.transactionDate },
        { id: request.payload.id, transactionDate: request.payload.transactionDate },
    ]) {
        await assert.rejects(reopened.reconcile(...delivery(sibling, change).args), error => error.status === 409);
        assert.deepEqual(await financialSnapshot(), beforeCrossAttempt, 'A bank reference or SePay ID cannot cross between order attempts');
    }
});

test('cancelled, rejected, expired and nonexistent orders cannot be revived by a callback', async () => {
    const app = service('terminal');
    for (const action of ['cancel', 'reject', 'expire', 'late']) {
        const fixture_ = await fixture(app);
        if (action === 'cancel') await orders.cancel(1, fixture_.orderId, { reason_code: 'changed_mind' });
        else if (action === 'reject') await adminOrders.reject(2, fixture_.orderId, 'Synthetic test rejection');
        else {
            await pool.execute(`UPDATE orders SET created_at_utc=UTC_TIMESTAMP(3)-INTERVAL 25 HOUR,
                payment_expires_at=UTC_TIMESTAMP(3)-INTERVAL 1 HOUR WHERE order_id=?`, [fixture_.orderId]);
            await pool.execute(`UPDATE payment_attempts SET initiated_at_utc=UTC_TIMESTAMP(3)-INTERVAL 25 HOUR
                WHERE payment_id=(SELECT payment_id FROM payments WHERE order_id=?)`, [fixture_.orderId]);
            if (action === 'expire') await lifecycle.expireBatch({ limit: 100 });
        }
        const before = await state(fixture_.orderId);
        assert.equal(before.order.status, action === 'late' ? 'Chờ thanh toán' : 'Đã hủy');
        const result = await app.reconcile(...delivery(fixture_).args);
        assert.ok(['cancelled_order', 'late_capture'].includes(result.disposition));
        const after = await state(fixture_.orderId);
        assert.equal(after.order.status, 'Đã hủy');
        assert.equal(after.payment.payment_status, 'Đã hủy');
        assert.equal(after.payment.transaction_date, null);
        assert.equal(after.stock, before.stock + (action === 'late' ? 1 : 0),
            'Only the existing expiry path may restore held inventory, once');
        assert.equal(after.refunds.length, 1);
        assert.equal(after.refunds[0].status, 'requested');
    }
    const before = await financialSnapshot();
    const result = await app.reconcile(...delivery({ orderId: 900001, amount: 1000 }).args);
    assert.equal(result.disposition, 'not_found');
    assert.deepEqual(await financialSnapshot(), before);
});

test('invalid authentication or account, disabled flag and wrong selected database cannot write business rows', async () => {
    const app = service('guards');
    const fixture_ = await fixture(app);
    const before = await financialSnapshot();
    await assert.rejects(app.reconcile(...delivery(fixture_, {}, 'wrong-secret').args), error => error.status === 401);
    const wrongAccount = await app.reconcile(...delivery(fixture_, { accountNumber: '999999999999' }).args);
    assert.equal(wrongAccount.disposition, 'wrong_account');
    await assert.rejects(lifecycle.confirmSePayEvent({ provider: 'SEPAY', providerEnvironment: 'test',
        merchantReference: `PCS${fixture_.orderId}`, orderId: fixture_.orderId, amount: `${fixture_.amount}.00`,
        currency: 'VND', status: 'succeeded', paidAtUtc: new Date().toISOString() }, env), error => error.status === 400);
    let accessed = 0;
    await assert.rejects(async () => {
        const disabled = createSePayTestService({ env: { ...env, SEPAY_INTEGRATION_ENABLED: '0' },
            pool: { getConnection() { accessed += 1; throw new Error('Disabled receiver accessed DB'); } } });
        await disabled.reconcile(...delivery(fixture_).args);
    }, error => error.status === 503);
    assert.equal(accessed, 0);
    const wrongPool = mysql.createPool({ host: env.DB_HOST, port: Number(env.DB_PORT) || 3306,
        user: env.DB_USER, password: env.DB_PASSWORD, database: 'information_schema', connectionLimit: 1 });
    try {
        const wrong = service('wrong-database', { pool: wrongPool });
        await assert.rejects(wrong.qrForOrder(1, fixture_.orderId), error => error.status === 503);
        await assert.rejects(wrong.reconcile(...delivery(fixture_).args), error => error.status === 503);
    } finally { await wrongPool.end(); }
    const original = await state(fixture_.orderId);
    const attempt = original.attempts[0];
    await pool.execute('UPDATE payment_attempts SET amount=? WHERE attempt_id=?', [`${fixture_.amount + 1}.00`, attempt.attempt_id]);
    try {
        const drifted = await state(fixture_.orderId);
        await assert.rejects(app.reconcile(...delivery(fixture_).args), error => error.status === 409);
        assert.deepEqual(await state(fixture_.orderId), drifted, 'Stored intent drift cannot create a receipt or mark a payment paid');
    } finally {
        await pool.execute('UPDATE payment_attempts SET amount=? WHERE attempt_id=?', [attempt.amount, attempt.attempt_id]);
    }
    assert.deepEqual(await financialSnapshot(), before);
});

test('failure during payment update rolls back receipts, attempts, history and voucher consumption; retry applies once', async () => {
    const app = service('rollback-normal');
    const fixture_ = await fixture(app, true);
    const before = await state(fixture_.orderId);
    const faultyPool = {
        async getConnection() {
            const db = await pool.getConnection();
            return { query: db.query.bind(db), beginTransaction: db.beginTransaction.bind(db),
                commit: db.commit.bind(db), rollback: db.rollback.bind(db), release: db.release.bind(db),
                async execute(sql, values) {
                    if (/^UPDATE payments SET payment_status='Đã thanh toán'/.test(sql.trim())) {
                        throw Object.assign(new Error('Synthetic payment write failure'), { code: 'SYNTHETIC_PAYMENT_FAILURE' });
                    }
                    return db.execute(sql, values);
                } };
        },
    };
    const faulty = service('rollback-fault', { pool: faultyPool });
    const request = delivery(fixture_);
    await assert.rejects(faulty.reconcile(...request.args));
    assert.deepEqual(await state(fixture_.orderId), before);
    const result = await app.reconcile(...request.args);
    assert.equal(result.disposition, 'applied');
    const saved = await state(fixture_.orderId);
    assert.equal(saved.payment.payment_status, 'Đã thanh toán');
    assert.equal(saved.history.filter(row => row.action === 'payment').length, 1);
    assert.equal(saved.redemptions[0].status, 'consumed');
    assert.equal(saved.stock, before.stock);
});
