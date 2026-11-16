// Utility to send a signed SePay Test Mode HMAC webhook to the local receiver
// (127.0.0.1:3001/webhooks/sepay/test) for an ONLINE order in the Sandbox DB.
// Usage: node scripts/send-sepay-test-webhook.cjs <orderId> [amount]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHmac } = require('node:crypto');
const dotenv = require('dotenv');

const backendRoot = path.resolve(__dirname, '..');
const sandboxEnvPath = path.join(backendRoot, 'sepay-test', '.env');
const mainEnvPath = path.join(backendRoot, '.env');

dotenv.config({ path: sandboxEnvPath, quiet: true });
dotenv.config({ path: mainEnvPath, quiet: true });

const pool = require('../config/db');

async function main() {
    const orderId = Number(process.argv[2]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
        console.error('Usage: npm run sandbox:webhook -- <orderId> [transferAmount]');
        process.exit(1);
    }

    let transferAmount = process.argv[3] ? Number(process.argv[3]) : null;
    if (!transferAmount) {
        const [[order]] = await pool.execute('SELECT total_amount FROM orders WHERE order_id = ?', [orderId]);
        if (!order) {
            throw new Error(`Order #${orderId} not found in ${process.env.DB_NAME}`);
        }
        transferAmount = Math.round(Number(order.total_amount));
    }

    const id = Math.floor(Date.now() / 1000);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const vnTime = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const payload = {
        id,
        gateway: 'VietinBank',
        transactionDate: vnTime,
        accountNumber: process.env.SEPAY_TEST_ACCOUNT_NUMBER,
        subAccount: '',
        code: `PCS${orderId}`,
        content: `SEVQR PCS${orderId}`,
        transferType: 'in',
        transferAmount,
        accumulated: 0,
        referenceCode: `FT-SANDBOX-${orderId}-${id}`,
    };

    const raw = Buffer.from(JSON.stringify(payload));
    const signature = 'sha256=' + createHmac('sha256', process.env.SEPAY_TEST_WEBHOOK_SECRET)
        .update(`${timestamp}.`)
        .update(raw)
        .digest('hex');

    const port = Number(process.env.SEPAY_TEST_PORT || 3001);
    const host = process.env.SEPAY_TEST_HOST || '127.0.0.1';
    const endpoint = process.env.SEPAY_TEST_PATH || '/webhooks/sepay/test';

    const response = await new Promise((resolve, reject) => {
        const req = http.request(
            {
                host,
                port,
                path: endpoint,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': raw.length,
                    'X-SePay-Timestamp': timestamp,
                    'X-SePay-Signature': signature,
                },
            },
            res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
            }
        );
        req.on('error', reject);
        req.end(raw);
    });

    console.log(JSON.stringify({
        sentTo: `http://${host}:${port}${endpoint}`,
        orderId,
        transferAmount,
        transferContent: payload.content,
        statusCode: response.statusCode,
        response: JSON.parse(response.body || '{}'),
    }, null, 2));
    await pool.end();
}

main().catch(async error => {
    console.error('Webhook send failed:', error.message);
    try { await pool.end(); } catch {}
    process.exit(1);
});
