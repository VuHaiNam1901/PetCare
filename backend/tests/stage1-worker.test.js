const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startOrderExpiryWorker } = require('../workers/order-expiry');

test('expiry worker is opt-in and cannot be configured with a different polling interval', async () => {
    const previous = process.env.PETCARE_ORDER_EXPIRY_ENABLED;
    process.env.PETCARE_ORDER_EXPIRY_ENABLED = '0';
    let calls = 0;
    const worker = startOrderExpiryWorker({ service: { async expireBatch() { calls++; } } });
    try {
        assert.deepEqual(await worker.runOnce(), { disabled: true });
        assert.equal(calls, 0);
        assert.throws(() => startOrderExpiryWorker({ intervalMs: 1000 }), /30 seconds/);
    } finally {
        await worker.stop();
        process.env.PETCARE_ORDER_EXPIRY_ENABLED = previous;
    }
});

test('startup catches up immediately and concurrent ticks share one running batch', async () => {
    const previous = process.env.PETCARE_ORDER_EXPIRY_ENABLED;
    process.env.PETCARE_ORDER_EXPIRY_ENABLED = '1';
    let calls = 0, release;
    const blocked = new Promise(resolve => { release = resolve; });
    const entries = [];
    const result = { scanned: 2, expired: 1, skipped: 1, errors: [] };
    const worker = startOrderExpiryWorker({
        service: { async expireBatch(options) { calls++; assert.equal(options.limit, 100); await blocked; return result; } },
        logger: { info(...arguments_) { entries.push(arguments_); }, error() { assert.fail('Unexpected expiry error'); } },
    });
    try {
        assert.equal(calls, 1, 'Startup must scan without waiting for the first 30-second interval');
        const first = worker.runOnce(), second = worker.runOnce();
        assert.equal(calls, 1, 'Overlapping ticks must not start more batches');
        release();
        assert.deepEqual(await first, result);
        assert.deepEqual(await second, result);
        assert.equal(entries.length, 1);
        await worker.runOnce();
        assert.equal(calls, 2);
    } finally {
        release();
        await worker.stop();
        process.env.PETCARE_ORDER_EXPIRY_ENABLED = previous;
    }
});

test('failed batches are logged without exception details and later scans can retry', async () => {
    const previous = process.env.PETCARE_ORDER_EXPIRY_ENABLED;
    process.env.PETCARE_ORDER_EXPIRY_ENABLED = '1';
    let calls = 0;
    const logs = [];
    const worker = startOrderExpiryWorker({
        service: { async expireBatch() { calls++; throw Object.assign(new Error('PRIVATE_CONNECTION_DETAILS'), { code: 'SYNTHETIC_FAILURE' }); } },
        logger: { info() {}, error(...arguments_) { logs.push(arguments_); } },
    });
    try {
        assert.deepEqual(await worker.runOnce(), { failed: true });
        await worker.runOnce();
        assert.equal(calls, 2);
        assert.ok(logs.length >= 2);
        assert.equal(JSON.stringify(logs).includes('PRIVATE_CONNECTION_DETAILS'), false);
        assert.equal(JSON.stringify(logs).includes('SYNTHETIC_FAILURE'), true);
    } finally {
        await worker.stop();
        process.env.PETCARE_ORDER_EXPIRY_ENABLED = previous;
    }
});

test('startup catch-up advances beyond a full batch containing skipped or damaged rows', async () => {
    const previous = process.env.PETCARE_ORDER_EXPIRY_ENABLED;
    process.env.PETCARE_ORDER_EXPIRY_ENABLED = '1';
    const cursors = [], logs = [];
    const worker = startOrderExpiryWorker({
        service: { async expireBatch({ afterOrderId }) {
            cursors.push(afterOrderId);
            return afterOrderId === 0
                ? { scanned: 100, expired: 98, skipped: 1, errors: [{ order_id: 10, code: 'STOCK_REVIEW_REQUIRED' }], nextCursor: 100 }
                : { scanned: 2, expired: 2, skipped: 0, errors: [], nextCursor: 102 };
        } },
        logger: { info(...arguments_) { logs.push(arguments_); }, error() {} },
    });
    try {
        const result = await worker.runOnce();
        assert.deepEqual(cursors, [0, 100]);
        assert.equal(result.scanned, 102);
        assert.equal(result.expired, 100);
        assert.equal(result.errors.length, 1);
        assert.equal(logs.length, 1);
    } finally {
        await worker.stop();
        process.env.PETCARE_ORDER_EXPIRY_ENABLED = previous;
    }
});
