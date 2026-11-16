// Standalone receiver. Default mode has no application/DB dependencies.
// Explicit integration opt-in adds isolated reconciliation; exact write-target
// binding additionally permits the existing transactional Test settlement path.
// never import server.js, business routes, workers or settlement providers.
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { extractEvent, signatureHeaders, verifyHmac, parseJson } = require('./protocol.cjs');

const ENDPOINT = '/webhooks/sepay/test';
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RECEIPTS = 1000;
const RECEIPT_DIRECTORY = path.join(__dirname, '.receipts');
const OUTCOMES = ['recorded', 'ignored_outgoing', 'ignored_gateway', 'missing_sevqr', 'missing_code', 'ambiguous_code'];

function configuration(env) {
    const fail = message => { throw Object.assign(new Error(message), { code: 'SEPAY_TEST_CONFIG' }); };
    if (env.SEPAY_TEST_MODE !== '1' || String(env.NODE_ENV).trim().toLowerCase() === 'production') {
        fail('Requires SEPAY_TEST_MODE=1 and a non-production NODE_ENV.');
    }
    const secret = env.SEPAY_TEST_WEBHOOK_SECRET;
    if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(secret)) {
        fail('Set a dedicated SEPAY_TEST_WEBHOOK_SECRET (32-256 printable ASCII characters, no whitespace).');
    }
    const portText = env.SEPAY_TEST_PORT ?? '3001';
    const port = Number(portText);
    if (!/^[0-9]{4,5}$/.test(portText) || port < 1024 || port > 65535 || port === 3000) {
        fail('SEPAY_TEST_PORT must be 1024-65535, excluding the application port 3000.');
    }
    return { secret, port };
}

function createReceiptStore(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let count = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length;
    return (event, receivedAt) => {
        const digest = createHash('sha256').update(`sepay-test:${event.transactionId}`).digest('hex');
        const filename = path.join(directory, `${digest}.json`);
        const existing = () => {
            const receipt = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (receipt.transactionDigest !== digest || receipt.mode !== 'test' || !OUTCOMES.includes(receipt.outcome)) {
                throw new Error('Invalid technical receipt');
            }
            return { duplicate: true, receipt };
        };
        try { return existing(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        // No eviction: a full store must not silently forget a transaction ID.
        if (count >= MAX_RECEIPTS) throw new Error('Technical receipt limit reached');
        const receipt = {
            version: 1, mode: 'test', receivedAt: new Date(receivedAt).toISOString(), transactionDigest: digest,
            outcome: event.outcome, codeSource: event.codeSource,
            hasSevqrPrefix: event.hasSevqrPrefix, hasReference: Boolean(event.referenceCode),
        };
        try {
            // Exclusive creation prevents two deliveries from overwriting the
            // first receipt. Both new and duplicate deliveries receive 201.
            fs.writeFileSync(filename, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
            count += 1;
            return { duplicate: false, receipt };
        } catch (error) {
            if (error.code === 'EEXIST') return existing();
            throw error;
        }
    };
}

function createReceiver({ env = process.env, receiptDirectory = RECEIPT_DIRECTORY, integrationReceiptDirectory, logger = console, now = Date.now } = {}) {
    const config = configuration(env);
    const integration = env.SEPAY_INTEGRATION_ENABLED === '1'
        ? require('../services/sepay-test').createSePayTestService({ env, receiptDirectory: integrationReceiptDirectory }) : null;
    const record = createReceiptStore(receiptDirectory);
    const app = express();
    app.disable('x-powered-by');
    app.enable('case sensitive routing');
    app.enable('strict routing');
    app.set('trust proxy', false);
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (req.path !== ENDPOINT) return res.status(404).json({ success: false });
        if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ success: false });
        if (req.originalUrl.includes('?')) return res.status(400).json({ success: false });
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.get('content-type') || '')) {
            return res.status(415).json({ success: false });
        }
        if (!signatureHeaders(req.headers, now())) return res.status(401).json({ success: false });
        next();
    });
    // Never parse/re-serialize JSON before signature verification. Refuse body
    // compression so the signed bytes and the size limit remain unambiguous.
    app.post(ENDPOINT, express.raw({ type: 'application/json', limit: MAX_BODY_BYTES, inflate: false }), async (req, res) => {
        if (!Buffer.isBuffer(req.body)) return res.status(400).json({ success: false });
        let event;
        try {
            verifyHmac(req.body, req.headers, config.secret, now());
            event = extractEvent(parseJson(req.body));
        } catch (error) { return res.status(error.status === 401 ? 401 : 400).json({ success: false }); }
        if (integration) {
            try {
                const result = await integration.reconcile(req.body, req.headers, now());
                logger.info('[SEPAY TEST RESULT]', JSON.stringify({ disposition: result.disposition, duplicate: result.duplicate }));
                return res.status(201).json({ success: true });
            } catch {
                logger.error('[SEPAY TEST] Reconciliation unavailable');
                return res.status(503).json({ success: false });
            }
        }
        let result;
        try { result = record(event, now()); }
        catch {
            logger.error('[SEPAY TEST] Technical receipt unavailable');
            return res.status(503).json({ success: false });
        }
        // No raw ID, payment code, amount, reference, body or headers in logs.
        logger.info('[SEPAY TEST]', JSON.stringify({
            duplicate: result.duplicate, outcome: result.receipt.outcome,
            codeSource: result.receipt.codeSource, hasSevqrPrefix: result.receipt.hasSevqrPrefix,
        }));
        return res.status(201).json({ success: true });
    });
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status = error.type === 'entity.too.large' ? 413
            : error.status === 415 ? 415 : error.status >= 400 && error.status < 500 ? 400 : 500;
        res.status(status).json({ success: false });
    });
    return { app, port: config.port, close: () => integration?.close() };
}

async function start(options) {
    const { app, port, close } = createReceiver(options);
    const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000,
        keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 }, app);
    server.maxRequestsPerSocket = 100;
    server.once('close', () => { Promise.resolve(close()).catch(() => {
        (options?.logger ?? console).error('[SEPAY TEST] Receiver close failed');
    }); });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => { server.removeListener('error', reject); resolve(); });
    });
    (options?.logger ?? console).info(`[SEPAY TEST] Receiver: http://${HOST}:${port}${ENDPOINT} (SePay Test Mode)`);
    return server;
}

if (require.main === module) {
    // Load ONLY receiver-local configuration, irrespective of the working
    // directory. backend/.env (including MySQL credentials) is never loaded.
    require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
    start().then(server => {
        const shutdown = () => server.close();
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    }).catch(error => {
        console.error('[SEPAY TEST]', error.code === 'SEPAY_TEST_CONFIG' ? error.message : (error.code || 'STARTUP_FAILED'));
        process.exitCode = 1;
    });
}

module.exports = { createReceiver, extractEvent, start };
