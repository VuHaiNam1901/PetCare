const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHmac } = require('node:crypto');
const mysql = require('mysql2/promise');
const { createSePayTestService } = require('../services/sepay-test');

const env = { ...process.env };
if (env.NODE_ENV !== 'test' || env.PETCARE_TEST_ISOLATED !== '1' ||
    !/^petcare_test_[a-f0-9]{32}$/.test(env.DB_NAME || '') || env.DB_NAME !== env.PETCARE_TEST_DATABASE ||
    !env.PETCARE_TEST_SOURCE_DATABASE || env.DB_NAME === env.PETCARE_TEST_SOURCE_DATABASE) {
    throw new Error('Use the dedicated SePay test runner; an application database is never a test target');
}
const options = { host: env.DB_HOST, port: Number(env.DB_PORT) || 3306, user: env.DB_USER,
    password: env.DB_PASSWORD, database: env.DB_NAME, dateStrings: true, connectionLimit: 5, connectTimeout: 5000 };
const pool = mysql.createPool(options);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'petcare-sepay-integration-'));
let beforeSnapshot, sequence = 800000, reads = 0;

function readOnlyPool(actual = pool) {
    return {
        async getConnection() {
            const db = await actual.getConnection();
            const read = method => async (sql, values) => {
                assert.match(sql.trim(), /^(SELECT\b|START TRANSACTION READ ONLY\b|SET TRANSACTION READ ONLY\b)/i,
                    'SePay preparation must not write a business row or execute DDL');
                reads += 1;
                return db[method](sql, values);
            };
            return { query: read('query'), execute: read('execute'),
                commit: db.commit.bind(db), rollback: db.rollback.bind(db), release: db.release.bind(db) };
        },
    };
}
async function snapshot() {
    return { orders: (await pool.query('SELECT * FROM orders ORDER BY order_id'))[0],
        payments: (await pool.query('SELECT * FROM payments ORDER BY payment_id'))[0] };
}
before(async () => {
    const [[actual]] = await pool.query('SELECT DATABASE() AS database_name');
    assert.equal(actual.database_name, env.PETCARE_TEST_DATABASE);
    beforeSnapshot = await snapshot();
});
after(async () => {
    try { assert.deepEqual(await snapshot(), beforeSnapshot, 'No order/payment may change while preparing or reconciling SePay test QR'); }
    finally {
        await pool.end();
        const target = fs.realpathSync(root);
        assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(target).startsWith('petcare-sepay-integration-'));
        fs.rmSync(target, { recursive: true, force: true });
    }
});
function service(t, name, override = {}) {
    const result = createSePayTestService({ pool: readOnlyPool(), env, receiptDirectory: path.join(root, name), ...override });
    t.after(() => result.close());
    return result;
}
function delivery(change = {}, { timestamp = Math.floor(Date.now() / 1000), secret = env.SEPAY_TEST_WEBHOOK_SECRET } = {}) {
    const id = ++sequence;
    const raw = Buffer.from(JSON.stringify({ id, gateway: 'VietinBank',
        transactionDate: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
        accountNumber: env.SEPAY_TEST_ACCOUNT_NUMBER, subAccount: '', code: 'PCS1', content: 'SEVQR PCS1',
        transferType: 'in', transferAmount: 150000, accumulated: 0, referenceCode: `SYNTHETIC-${id}`, ...change }, null, 2));
    const headers = { 'content-type': 'application/json', 'x-sepay-timestamp': String(timestamp),
        'x-sepay-signature': 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex') };
    return [raw, headers];
}

test('default-off and invalid isolation reject before accessing any database', async () => {
    let accesses = 0;
    const forbidden = { getConnection() { accesses += 1; throw new Error('Database should not be accessed'); } };
    for (const override of [{ SEPAY_INTEGRATION_ENABLED: undefined }, { SEPAY_INTEGRATION_ENABLED: '0' },
        { DB_NAME: 'petcare_db', PETCARE_TEST_DATABASE: 'petcare_db' }, { NODE_ENV: 'production' },
        { SEPAY_ENVIRONMENT: 'live' }, { PETCARE_TEST_ISOLATED: '0' }]) {
        await assert.rejects(async () => {
            const app = createSePayTestService({ pool: forbidden, env: { ...env, ...override }, receiptDirectory: path.join(root, 'forbidden') });
            try { await app.qrForOrder(1, 1); }
            finally { await app.close(); }
        }, error => error.status === 503);
    }
    assert.equal(accesses, 0);
});

test('reopening QR uses trusted stored amount, order and deadline without creating an order', async t => {
    const app = service(t, 'qr');
    const first = await app.qrForOrder(1, 1), second = await app.qrForOrder(1, 1);
    assert.deepEqual(second, first);
    assert.equal(first.mode, 'test');
    assert.equal(first.reconciliationOnly, true);
    assert.equal(first.orderId, 1);
    assert.equal(first.amount, '150000.00');
    assert.equal(first.paymentCode, 'PCS1');
    assert.equal(first.transferContent, 'SEVQR PCS1');
    assert.ok(Date.parse(first.expiresAt) > Date.now());
    const url = new URL(first.qrUrl);
    assert.equal(url.origin, 'https://vietqr.app');
    assert.equal(url.searchParams.get('amount'), '150000');
    assert.equal(url.searchParams.get('des'), 'SEVQR PCS1');
    assert.ok(!JSON.stringify(first).includes(env.SEPAY_TEST_WEBHOOK_SECRET));
    for (const id of [2, 3, 4, 5, 6]) assert.equal(await app.qrForOrder(1, id), null);
    try { assert.equal(await app.qrForOrder(999, 1), null); }
    catch (error) { assert.equal(error.status, 404); }
});

test('exact amount is eligible only; underpayment and overpayment are not accepted as payment', async t => {
    const app = service(t, 'amounts');
    const exact = await app.reconcile(...delivery());
    assert.equal(exact.disposition, 'eligible');
    assert.equal(exact.eligible, true);
    for (const [amount, disposition] of [[149999, 'underpaid'], [150001, 'overpaid']]) {
        const result = await app.reconcile(...delivery({ transferAmount: amount }));
        assert.equal(result.disposition, disposition);
        assert.equal(result.eligible, false);
    }
});

test('expired, cancelled, rejected, already paid, COD and unknown orders never become eligible', async t => {
    const app = service(t, 'order-states');
    for (const [id, disposition] of [[2, 'expired'], [3, 'cancelled'], [4, 'rejected'], [5, 'already_paid'], [6, 'unsupported_order'], [900001, 'not_found']]) {
        const result = await app.reconcile(...delivery({ code: `PCS${id}`, content: `SEVQR PCS${id}` }));
        assert.equal(result.disposition, disposition);
        assert.equal(result.eligible, false);
    }
});

test('signature, timestamp, recipient account, reference, payment code and direction are checked', async t => {
    const app = service(t, 'authentication');
    const initialReads = reads;
    for (const bad of [delivery({}, { secret: 'wrong-secret' }), delivery({}, { timestamp: Math.floor(Date.now() / 1000) - 301 })]) {
        await assert.rejects(app.reconcile(...bad), error => error.status === 401);
    }
    assert.equal(reads, initialReads, 'Unverified requests cannot read orders');
    for (const [change, disposition] of [[{ accountNumber: 'OTHER-ACCOUNT' }, 'wrong_account'],
        [{ referenceCode: '' }, 'invalid_reference'], [{ code: 'PCS99' }, 'invalid_code'],
        [{ transferType: 'out' }, 'outgoing']]) {
        const result = await app.reconcile(...delivery(change));
        assert.equal(result.disposition, disposition);
        assert.equal(result.eligible, false);
    }
});

test('duplicate concurrent events and repeated bank reference are persisted without repeating reconciliation', async t => {
    const directory = path.join(root, 'duplicates');
    const app = service(t, 'duplicates');
    const request = delivery();
    const responses = await Promise.all(Array.from({ length: 3 }, () => app.reconcile(...request)));
    assert.equal(responses.filter(response => response.duplicate === false).length, 1);
    assert.equal(responses.filter(response => response.duplicate === true).length, 2);
    const original = JSON.parse(request[0].toString());
    const changed = await app.reconcile(...delivery({ id: original.id, referenceCode: original.referenceCode,
        transactionDate: original.transactionDate, transferAmount: 150001 }));
    assert.equal(changed.disposition, 'event_conflict');
    await app.close();
    const reopened = service(t, 'duplicates-reopened', { receiptDirectory: directory });
    assert.equal((await reopened.reconcile(...request)).duplicate, true);
    const sameReference = await reopened.reconcile(...delivery({ referenceCode: original.referenceCode, transactionDate: original.transactionDate }));
    assert.equal(sameReference.duplicate, true);
});

test('actual selected database must match the isolated target before opening its transaction', async t => {
    const wrong = mysql.createPool({ ...options, database: 'information_schema' });
    t.after(() => wrong.end());
    const app = service(t, 'actual-guard', { pool: readOnlyPool(wrong) });
    await assert.rejects(app.qrForOrder(1, 1), error => error.status === 503);
    await assert.rejects(app.reconcile(...delivery()), error => error.status === 503);
});

test('enabled receiver returns only SePay acknowledgement and rejects an invalid HTTP signature', async t => {
    const { createReceiver } = require('./receiver.cjs');
    const receiver = createReceiver({ env, receiptDirectory: path.join(root, 'http-technical'),
        integrationReceiptDirectory: path.join(root, 'http-integration'), logger: { info() {}, error() {} } });
    const server = http.createServer(receiver.app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await receiver.close();
    });
    const send = ([raw, headers]) => new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: server.address().port,
            method: 'POST', path: '/webhooks/sepay/test', headers: { ...headers, 'content-length': raw.length } }, response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
        });
        request.on('error', reject);
        request.end(raw);
    });
    assert.deepEqual(await send(delivery()), { status: 201, body: { success: true } });
    assert.deepEqual(await send(delivery({}, { secret: 'wrong-secret' })), { status: 401, body: { success: false } });
});
