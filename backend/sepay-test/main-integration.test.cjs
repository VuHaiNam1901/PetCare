// Focused, database-free checks for the main website entry points. All accounts,
// keys and environment objects below are synthetic; process.env is never changed.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const { createHmac, randomBytes } = require('node:crypto');

const originalLoad = Module._load;
Module._load = function (request) {
    assert.ok(!/^mysql2(?:\/|$)/.test(request) && !/(?:^|\/)config\/db$/.test(request), 'These checks must never open MySQL');
    return originalLoad.apply(this, arguments);
};
after(() => { Module._load = originalLoad; });
const express = require('express');
const config = require('../config/sepay');
const provider = require('../providers/sepay-test');
const { createSePayService, createSePayTestService } = require('../services/sepay-test');
const { createSePayWebhookRouter } = require('../routes/sepay');

const NOW = Date.UTC(2026, 10, 16, 3);
const target = 'petcare_test_' + 'a'.repeat(32);
const testEnv = {
    SEPAY_INTEGRATION_ENABLED: '1', SEPAY_TEST_MODE: '1', SEPAY_ENVIRONMENT: 'test', NODE_ENV: 'test',
    PETCARE_TEST_ISOLATED: '1', DB_NAME: target, PETCARE_TEST_DATABASE: target, PETCARE_TEST_SOURCE_DATABASE: 'petcare_db',
    SEPAY_TEST_WRITE_DATABASE: target, SEPAY_TEST_ACCOUNT_CONFIRMED: '1',
    SEPAY_TEST_ACCOUNT_NUMBER: '999999000001', SEPAY_TEST_ACCOUNT_NAME: 'SYNTHETIC TEST',
    SEPAY_TEST_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
};
const liveEnv = {
    ...testEnv, SEPAY_LIVE_ENABLED: '1', SEPAY_ENVIRONMENT: 'live', SEPAY_TEST_MODE: '0', NODE_ENV: 'production',
    PETCARE_TEST_ISOLATED: '0', PETCARE_TEST_DATABASE: '', SEPAY_TEST_WRITE_DATABASE: '',
    DB_NAME: 'synthetic_live_configuration', SEPAY_LIVE_WRITE_DATABASE: 'synthetic_live_configuration',
    SEPAY_LIVE_ACCOUNT_CONFIRMED: '1', SEPAY_LIVE_ACCOUNT_NUMBER: '999999000002', SEPAY_LIVE_ACCOUNT_NAME: 'SYNTHETIC LIVE CONFIG',
    SEPAY_LIVE_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
    PETCARE_ORDER_WORKFLOW_ENABLED: '1', PETCARE_ORDER_FRONTEND_READY: '1', PETCARE_ORDER_EXPIRY_ENABLED: '1',
    PETCARE_PAYMENT_SIMULATION_ENABLED: '0',
};
const payload = {
    id: 123456, gateway: 'VietinBank', accountNumber: testEnv.SEPAY_TEST_ACCOUNT_NUMBER, subAccount: '',
    transactionDate: '2026-11-16 10:00:00', code: 'PCS1', content: 'SEVQR PCS1',
    transferType: 'in', transferAmount: 150000, referenceCode: 'SYNTHETIC-REFERENCE',
};
const forbiddenPool = { getConnection() { assert.fail('Rejected requests must not acquire a DB connection'); } };
function delivery(change = {}, { secret = testEnv.SEPAY_TEST_WEBHOOK_SECRET, timestamp = NOW / 1000, raw } = {}) {
    raw ??= Buffer.from(JSON.stringify({ ...payload, ...change }, null, 2) + '\n');
    return { raw, headers: { 'Content-Type': 'application/json', 'X-SePay-Timestamp': String(timestamp),
        'X-SePay-Signature': 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex') } };
}
const providerHeaders = headers => Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
async function serve(t, env = testEnv, pool = forbiddenPool) {
    const app = express();
    app.use(createSePayWebhookRouter({ env, pool, now: () => NOW, logger: { info() {} } }));
    app.use(express.json());
    app.post('/api/existing', (req, res) => res.json(req.body));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return (signed = delivery(), { path = '/webhooks/sepay/test', method = 'POST', headers = {} } = {}) => new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
            headers: { ...signed.headers, 'Content-Length': signed.raw.length, ...headers } }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
        });
        req.on('error', reject);
        req.end(signed.raw);
    });
}

test('default flags and invalid Test isolation reject before DB access', async t => {
    assert.equal(config.enabled({}), false);
    assert.equal(config.liveEnabled({}), false);
    for (const env of [{}, { ...testEnv, DB_NAME: 'petcare_db', PETCARE_TEST_DATABASE: 'petcare_db', SEPAY_TEST_WRITE_DATABASE: 'petcare_db' },
        { ...testEnv, SEPAY_LIVE_ENABLED: '1' }, { ...testEnv, SEPAY_TEST_WRITE_DATABASE: 'petcare_db' }]) {
        const send = await serve(t, env);
        assert.equal((await send()).status, 503);
        assert.equal((await send(delivery(), { path: '/webhooks/sepay' })).status, 503);
    }
});

test('main Express route validates signed raw bytes and refuses malformed or unauthenticated requests', async t => {
    const send = await serve(t);
    assert.equal((await send(delivery({}, { secret: 'wrong-key' }))).status, 401);
    assert.equal((await send(delivery({}, { timestamp: NOW / 1000 - 301 }))).status, 401);
    assert.equal((await send(delivery(), { headers: { 'X-SePay-Signature': '' } })).status, 401);
    const signed = delivery();
    assert.equal((await send({ ...signed, raw: Buffer.from(signed.raw.toString().replace('150000', '150001')) })).status, 401);
    assert.equal((await send(delivery({}, { raw: Buffer.from('{') }))).status, 400);
    assert.equal((await send(delivery({ id: '123456' }))).status, 400);
    assert.equal((await send(delivery({}, { raw: Buffer.from('{"unused":"' + 'x'.repeat(16384) + '"}') }))).status, 413);
    assert.equal((await send(signed, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await send(signed, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
    assert.equal((await send(signed, { path: '/webhooks/sepay/test?status=paid' })).status, 400);
    assert.equal((await send(signed, { method: 'GET' })).status, 405);
    const unchanged = await send(delivery({ status: 'untrusted' }), { path: '/api/existing' });
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.body.status, 'untrusted', 'Other APIs still receive parsed JSON');
});

test('wrong account, outgoing transfer and conflicting content never reach settlement', async t => {
    const send = await serve(t);
    for (const change of [{ accountNumber: '999999999999' }, { subAccount: 'unconfigured-va' }, { transferType: 'out' },
        { gateway: 'OtherBank' }, { code: 'PCS2' }, { content: 'PCS1' }, { referenceCode: '' }]) {
        const response = await send(delivery({ ...change, status: 'paid', orderId: 999 }));
        assert.deepEqual(response, { status: 201, body: { success: true } });
    }
});

test('a valid DEMO webhook and QR request cannot write to a misdirected petcare_db connection', async t => {
    const sql = [];
    const db = { async query(statement) { sql.push(statement); return [[{ database_name: 'petcare_db' }]]; },
        async rollback() {}, release() {},
        async beginTransaction() { assert.fail('Must reject before starting a write transaction'); },
        async execute() { assert.fail('Must reject before any business SQL'); } };
    const pool = { async getConnection() { return db; } };
    const send = await serve(t, testEnv, pool);
    assert.deepEqual(await send(), { status: 503, body: { success: false } });
    await assert.rejects(createSePayService({ env: testEnv, pool }).qrForOrder(1, 1), error => error.status === 503);
    assert.deepEqual(sql, ['SELECT DATABASE() AS database_name', 'SELECT DATABASE() AS database_name']);
});

test('Live configuration is opt-in, uses the existing production schema value and refuses shared Test settings', async t => {
    assert.equal(config.settings(liveEnv).providerEnvironment, 'production');
    for (const change of [{ SEPAY_LIVE_ENABLED: undefined }, { SEPAY_LIVE_WRITE_DATABASE: '' }, { SEPAY_TEST_MODE: '1' },
        { PETCARE_TEST_DATABASE: target }, { SEPAY_LIVE_ACCOUNT_NUMBER: testEnv.SEPAY_TEST_ACCOUNT_NUMBER },
        { SEPAY_LIVE_WEBHOOK_SECRET: testEnv.SEPAY_TEST_WEBHOOK_SECRET }, { PETCARE_ORDER_EXPIRY_ENABLED: '0' }]) {
        assert.throws(() => config.settings({ ...liveEnv, ...change }), error => error.status === 503);
    }
    assert.throws(() => createSePayTestService({ env: liveEnv, pool: forbiddenPool }), error => error.status === 503);
    const signed = delivery({ accountNumber: liveEnv.SEPAY_LIVE_ACCOUNT_NUMBER }, { secret: liveEnv.SEPAY_LIVE_WEBHOOK_SECRET });
    const evidence = provider.issuePaymentEvent(signed.raw, providerHeaders(signed.headers), liveEnv, NOW);
    assert.equal(evidence.providerEnvironment, 'production');
    assert.equal(provider.assertVerifiedPayment(evidence, liveEnv), evidence);
    assert.throws(() => provider.assertVerifiedPayment({ ...evidence }, liveEnv), error => error.status === 400);
    assert.throws(() => provider.assertVerifiedPayment(evidence, testEnv), error => error.status === 400);
    const send = await serve(t, liveEnv);
    assert.equal((await send(signed)).status, 503, 'Live evidence cannot enter the Test endpoint');
    assert.equal((await send(delivery(), { path: '/webhooks/sepay' })).status, 401, 'A Test key cannot authenticate Live');
    const outgoing = delivery({ accountNumber: liveEnv.SEPAY_LIVE_ACCOUNT_NUMBER, transferType: 'out' }, { secret: liveEnv.SEPAY_LIVE_WEBHOOK_SECRET });
    assert.deepEqual(await send(outgoing, { path: '/webhooks/sepay' }), { status: 201, body: { success: true } });
});
