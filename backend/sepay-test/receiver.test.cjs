const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { createHmac, randomBytes } = require('node:crypto');

// Keep this guard active during imports AND HTTP requests. Any accidental
// dependency on the application's DB, services or routes fails these checks.
const backend = path.resolve(__dirname, '..') + path.sep;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    assert.ok(!/^mysql2(?:\/|$)/.test(request), 'Receiver must never load MySQL');
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved.startsWith(backend)) {
        assert.ok(resolved.startsWith(__dirname + path.sep) || resolved.startsWith(backend + 'node_modules' + path.sep),
            'Receiver must never load application modules: ' + resolved);
    }
    return originalLoad.apply(this, arguments);
};
after(() => { Module._load = originalLoad; });
const { createReceiver, extractEvent, start } = require('./receiver.cjs');

const ENDPOINT = '/webhooks/sepay/test';
const NOW = Date.UTC(2026, 10, 15, 3, 0, 0);
const SECRET = randomBytes(32).toString('hex');
const ENV = { SEPAY_TEST_MODE: '1', SEPAY_TEST_PORT: '3001', SEPAY_TEST_WEBHOOK_SECRET: SECRET, NODE_ENV: 'test' };
const payload = {
    id: 700001, gateway: 'VietinBank', transactionDate: '2026-11-15 10:00:00',
    accountNumber: 'SYNTHETIC-ACCOUNT', subAccount: '', code: null,
    content: 'SEVQR PCS4812', description: 'Dữ liệu hoàn toàn giả lập',
    transferType: 'in', transferAmount: 150000, accumulated: 0, referenceCode: 'SYNTHETIC-REFERENCE',
};
const body = change => JSON.stringify({ ...payload, ...change }, null, 2) + '\n';

function tempDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'petcare-sepay-test-'));
    t.after(() => {
        // Delete only this test's verified, dedicated temporary directory.
        const target = fs.realpathSync(directory);
        assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(target).startsWith('petcare-sepay-test-'));
        fs.rmSync(target, { recursive: true, force: true });
    });
    return directory;
}

async function serve(t, directory = tempDirectory(t)) {
    const messages = [];
    const { app } = createReceiver({ env: ENV, receiptDirectory: directory, now: () => NOW,
        logger: { info: (...args) => messages.push(args.join(' ')), error: (...args) => messages.push(args.join(' ')) } });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let closed = false;
    const close = async () => {
        if (!closed) { closed = true; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    };
    t.after(close);
    const send = (raw = body(), options = {}) => new Promise((resolve, reject) => {
        const timestamp = String(options.timestamp ?? NOW / 1000);
        const signature = 'sha256=' + createHmac('sha256', options.secret ?? SECRET).update(`${timestamp}.`).update(raw).digest('hex');
        const request = http.request({ host: '127.0.0.1', port: server.address().port,
            path: options.path ?? ENDPOINT, method: options.method ?? 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw),
                'X-SePay-Timestamp': timestamp, 'X-SePay-Signature': signature, ...options.headers } }, response => {
            let data = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { data += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: data ? JSON.parse(data) : null }));
        });
        request.on('error', reject);
        request.end(raw);
    });
    return { send, close, directory, messages };
}

test('requires explicit test mode, a dedicated secret and a separate port', t => {
    const directory = path.join(tempDirectory(t), 'not-created');
    for (const change of [{ SEPAY_TEST_MODE: '0' }, { NODE_ENV: 'production' }, { SEPAY_TEST_WEBHOOK_SECRET: '' },
        { SEPAY_TEST_PORT: '3000' }, { SEPAY_TEST_PORT: '0' }]) {
        assert.throws(() => createReceiver({ env: { ...ENV, ...change }, receiptDirectory: directory }), { code: 'SEPAY_TEST_CONFIG' });
    }
    assert.equal(fs.existsSync(directory), false);
});

test('startup binds only loopback and reports an occupied port without loading application modules', async t => {
    const directory = tempDirectory(t);
    const occupied = http.createServer();
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    let occupiedClosed = false;
    t.after(async () => { if (!occupiedClosed) await new Promise(resolve => occupied.close(resolve)); });
    const port = occupied.address().port;
    const options = { env: { ...ENV, SEPAY_TEST_PORT: String(port) }, receiptDirectory: directory, logger: { info() {}, error() {} } };
    await assert.rejects(start(options), { code: 'EADDRINUSE' });
    await new Promise(resolve => occupied.close(resolve));
    occupiedClosed = true;
    const server = await start(options);
    t.after(() => new Promise(resolve => server.close(resolve)));
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(server.address().port, port);
});

test('extracts only technical fields and distinguishes provider code from content fallback', () => {
    const event = extractEvent(payload);
    assert.equal(event.paymentCode, 'PCS4812');
    assert.equal(event.orderId, '4812');
    assert.equal(event.transferAmount, 150000);
    assert.equal(event.transferType, 'in');
    assert.equal(event.referenceCode, 'SYNTHETIC-REFERENCE');
    assert.equal(event.codeSource, 'content');
    for (const field of ['accountNumber', 'description', 'content', 'accumulated']) assert.equal(field in event, false);
    assert.equal(extractEvent({ ...payload, code: 'PCS4812' }).codeSource, 'both');
    assert.equal(extractEvent({ ...payload, code: 'PCS7', content: 'SEVQR payment' }).codeSource, 'code');
    assert.equal(extractEvent({ ...payload, code: 'SEVQR' }).codeSource, 'content');
    for (const suffix of ['1', '1234567890']) assert.equal(extractEvent({ ...payload, content: `SEVQR PCS${suffix}` }).orderId, suffix);
    for (const token of ['PCS12345678901', 'XPCS4812', 'PCS4812X']) {
        assert.equal(extractEvent({ ...payload, content: `SEVQR ${token}` }).paymentCode, null);
    }
    for (const change of [{ code: 'PCS99' }, { content: 'SEVQR PCS4812 PCS99' }]) {
        const ambiguous = extractEvent({ ...payload, ...change });
        assert.equal(ambiguous.paymentCode, null);
        assert.equal(ambiguous.outcome, 'ambiguous_code');
    }
});

test('verifies the original JSON bytes, returns SePay acknowledgement and stores no raw financial data', async t => {
    const receiver = await serve(t);
    const response = await receiver.send(body({ orderId: 4812, status: 'paid' }));
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { success: true });
    assert.equal(response.headers['x-powered-by'], undefined);
    const [filename] = fs.readdirSync(receiver.directory);
    assert.match(filename, /^[a-f0-9]{64}\.json$/);
    const receipt = JSON.parse(fs.readFileSync(path.join(receiver.directory, filename), 'utf8'));
    assert.deepEqual(Object.keys(receipt).sort(), ['version', 'mode', 'receivedAt', 'transactionDigest', 'outcome', 'codeSource', 'hasSevqrPrefix', 'hasReference'].sort());
    assert.equal(receipt.outcome, 'recorded');
    assert.equal(receipt.codeSource, 'content');
    const recorded = JSON.stringify(receipt) + receiver.messages.join('\n');
    for (const privateValue of [SECRET, payload.accountNumber, payload.referenceCode, payload.description, 'PCS4812', '150000', '700001']) {
        assert.ok(!recorded.includes(privateValue));
    }
});

test('rejects absent/wrong signatures, tampering and expired/future timestamps before recording', async t => {
    const receiver = await serve(t);
    const signedBody = body();
    const signature = 'sha256=' + createHmac('sha256', SECRET).update(`${NOW / 1000}.`).update(signedBody).digest('hex');
    for (const options of [{ headers: { 'X-SePay-Signature': '' } }, { secret: randomBytes(32).toString('hex') },
        { headers: { 'X-SePay-Signature': 'sha256=wrong' } }, { timestamp: NOW / 1000 - 301 },
        { timestamp: NOW / 1000 + 301 }, { timestamp: 'invalid' },
        { headers: { 'X-SePay-Signature': '', Authorization: 'Apikey ' + SECRET } }]) {
        assert.equal((await receiver.send(signedBody, options)).status, 401);
    }
    assert.equal((await receiver.send(body({ transferAmount: 150001 }), { headers: { 'X-SePay-Signature': signature } })).status, 401);
    assert.deepEqual(fs.readdirSync(receiver.directory), []);
});

test('bounds the request and rejects invalid JSON, types and unsupported encoding', async t => {
    const receiver = await serve(t);
    for (const raw of ['{', '[]', 'null', body({ id: '700001' }), body({ id: Number.MAX_SAFE_INTEGER + 1 }),
        body({ transferAmount: '150000' }), body({ transferAmount: 0 }), body({ transferAmount: 1.5 }),
        body({ transferType: 'paid' }), body({ referenceCode: {} }), body({ content: 'x'.repeat(4097) })]) {
        assert.equal((await receiver.send(raw)).status, 400);
    }
    assert.equal((await receiver.send(body(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await receiver.send(body(), { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
    assert.equal((await receiver.send(body({ description: 'x'.repeat(16 * 1024) }))).status, 413);
    assert.deepEqual(fs.readdirSync(receiver.directory), []);
});

test('deduplicates concurrent deliveries by SePay id and retains the receipt across restart', async t => {
    const directory = tempDirectory(t);
    const first = await serve(t, directory);
    const responses = await Promise.all(Array.from({ length: 3 }, () => first.send()));
    assert.ok(responses.every(response => response.status === 201 && response.body.success === true));
    assert.equal(fs.readdirSync(directory).length, 1);
    assert.equal(first.messages.filter(message => message.includes('"duplicate":true')).length, 2);
    const original = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
    await first.close();
    const second = await serve(t, directory);
    // id, not the bank reference code, is the idempotency key.
    assert.equal((await second.send(body({ referenceCode: 'ANOTHER-SYNTHETIC-REFERENCE' }))).status, 201);
    assert.ok(second.messages[0].includes('"duplicate":true'));
    assert.equal(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'), original);
});

test('acknowledges but marks irrelevant events, missing SEVQR and ambiguous payment codes', async t => {
    const receiver = await serve(t);
    const cases = [
        [{ transferType: 'out' }, 'ignored_outgoing'], [{ gateway: 'OtherBank' }, 'ignored_gateway'],
        [{ content: 'PCS4812' }, 'missing_sevqr'], [{ content: 'SEVQR payment' }, 'missing_code'],
        [{ code: 'PCS99' }, 'ambiguous_code'],
    ];
    for (const [index, [change, outcome]] of cases.entries()) {
        assert.equal((await receiver.send(body({ ...change, id: payload.id + index }))).status, 201);
        assert.ok(receiver.messages.at(-1).includes(`"outcome":"${outcome}"`));
    }
});

test('exposes no business, health, environment or receipt route, and accepts only POST on the exact endpoint', async t => {
    const receiver = await serve(t);
    for (const route of ['/', '/api/orders', '/api/admin/users', '/api/health/db', '/.env', '/.receipts', ENDPOINT + '/']) {
        assert.equal((await receiver.send('', { method: 'GET', path: route })).status, 404);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT']) {
        const response = await receiver.send('', { method });
        assert.equal(response.status, 405);
        assert.equal(response.headers.allow, 'POST');
    }
    assert.equal((await receiver.send(body(), { path: ENDPOINT + '?secret=unused' })).status, 400);
    assert.deepEqual(fs.readdirSync(receiver.directory), []);
});

test('does not acknowledge a corrupt receipt as a successfully recorded duplicate', async t => {
    const receiver = await serve(t);
    assert.equal((await receiver.send()).status, 201);
    const filename = path.join(receiver.directory, fs.readdirSync(receiver.directory)[0]);
    fs.writeFileSync(filename, '{');
    const response = await receiver.send();
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { success: false });
    assert.ok(!JSON.stringify(response).includes(receiver.directory));
});
