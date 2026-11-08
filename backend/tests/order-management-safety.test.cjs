// Mock-only safety checks. This file never imports config/db or opens MySQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const backupPath = require.resolve('../migrations/001-admin-orders');
const migrationPath = require.resolve('../migrations/005-order-management');
const previousBackup = require.cache[backupPath];
const previousMigration = require.cache[migrationPath];
let activeHarness;
require.cache[backupPath] = {
    id: backupPath, filename: backupPath, loaded: true,
    exports: {
        backup: async (db, tables, prefix, options) => {
            activeHarness.log.push({ kind: 'backup', db, tables, prefix, options });
            return 'D:\\petcare-backups\\mock-only';
        }
    }
};
delete require.cache[migrationPath];
const { migrate } = require(migrationPath);
if (previousBackup) require.cache[backupPath] = previousBackup;
else delete require.cache[backupPath];
if (previousMigration) require.cache[migrationPath] = previousMigration;
else delete require.cache[migrationPath];

function fixture() {
    const order = {
        order_id: 1, user_id: 10, total_amount: '120.00', status: 'Chờ xử lý',
        approved_at: null, stock_restored_at: null,
        idempotency_key_hash: 'a'.repeat(64),
        recipient_name: 'Mock customer', shipping_address: 'Mock address',
        phone: '0900000000', note: null
    };
    const lines = [{ product_id: 2, quantity: 3 }];
    const payment = {
        payment_method: 'COD', payment_status: 'Chưa thanh toán',
        amount: '120.00', transaction_date: null
    };
    const canonical = {
        source: 'cart', items: lines, recipient_name: order.recipient_name,
        shipping_address: order.shipping_address, phone: order.phone,
        payment_method: payment.payment_method, note: order.note
    };
    order.request_fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    return { order, lines, payment };
}

function harness(options = {}) {
    const { routines = [], events = [], verifyFailure = false, writerFailure = false } = options;
    const acquired = Object.hasOwn(options, 'acquired') ? options.acquired : 1;
    const log = [];
    const data = fixture();
    let saved = { ...data.order };
    let writerChecks = 0;
    const db = {
        async query(sql, values) {
            log.push({ kind: 'sql', sql, values });
            if (sql.startsWith('SELECT DATABASE()')) return [[{ name: 'mock_petcare', mode: 'STRICT_TRANS_TABLES' }]];
            if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired }]];
            if (sql === 'SHOW FULL TABLES') return [[...['orders', 'payments', 'order_details'].map(name => ({ table_name: name, Table_type: 'BASE TABLE' }))]];
            if (sql.startsWith('SELECT ENGINE')) return [[{ ENGINE: 'InnoDB' }]];
            if (sql === 'SHOW TRIGGERS') return [[]];
            if (sql.startsWith('SELECT ROUTINE_NAME')) return [routines];
            if (sql === 'SHOW EVENTS') return [events];
            if (sql.startsWith('LOCK TABLES') || sql === 'UNLOCK TABLES') return [{}];
            if (sql === 'SHOW FULL COLUMNS FROM orders') return [[...Object.keys(data.order).map(Field => ({ Field }))]];
            if (sql === 'SELECT * FROM orders ORDER BY order_id') return [[{ ...saved }]];
            if (sql.startsWith('ALTER TABLE orders')) {
                saved = { ...saved, rejection_reason: null, stock_reserved_at: null, stock_reservation_source: null };
                return [{}];
            }
            if (sql.startsWith('CREATE TABLE IF NOT EXISTS order_status_history')) return [{}];
            if (sql === 'SHOW FULL COLUMNS FROM order_status_history') {
                return [[...['history_id', 'order_id', 'from_status', 'to_status', 'action', 'actor_id', 'actor_name', 'reason', 'created_at'].map(Field => ({ Field }))]];
            }
            if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: typeof acquired === 'string' ? '1' : 1 }]];
            throw new Error(`Unexpected mock query: ${sql}`);
        },
        async execute(sql, values) {
            log.push({ kind: 'sql', sql, values });
            if (sql.startsWith('SELECT * FROM payments')) return [[{ ...data.payment }]];
            if (sql.startsWith('SELECT product_id, quantity')) return [[...data.lines.map(line => ({ ...line }))]];
            if (sql.startsWith('UPDATE orders SET stock_reservation_source')) {
                assert.deepEqual(values, [data.order.order_id]);
                saved.stock_reservation_source = 'checkout-v4-fingerprint';
                return [{ affectedRows: 1 }];
            }
            throw new Error(`Unexpected mock execute: ${sql}`);
        },
        release() { log.push({ kind: 'release' }); }
    };
    const value = {
        log, db,
        pool: { async getConnection() { return db; } },
        options: {
            backupRoot: 'D:\\petcare-backups',
            async assertWritersStopped() {
                writerChecks++;
                log.push({ kind: 'writers-stopped', check: writerChecks });
                if (writerFailure) throw new Error('A writer is still connected');
            },
            async verifyBackup({ directory, db: source, tables }) {
                assert.equal(directory, 'D:\\petcare-backups\\mock-only');
                assert.equal(source, db);
                assert.deepEqual(tables, ['orders', 'payments', 'order_details']);
                log.push({ kind: 'verify-backup' });
                if (verifyFailure) throw new Error('Restore verification failed');
            }
        }
    };
    activeHarness = value;
    return value;
}

function mutations(log) {
    return log.filter(entry => entry.kind === 'sql' && /^(?:ALTER|UPDATE|CREATE)\b/.test(entry.sql));
}

function assertReleased(log, tablesLocked) {
    assert.equal(log.filter(entry => entry.kind === 'release').length, 1);
    assert.equal(log.filter(entry => entry.kind === 'sql' && entry.sql.startsWith('SELECT RELEASE_LOCK')).length, 1);
    assert.equal(log.filter(entry => entry.kind === 'sql' && entry.sql === 'UNLOCK TABLES').length, tablesLocked ? 1 : 0);
}

for (const objectType of ['routines', 'events']) {
    test(`stored ${objectType} stop before backup, locks or DDL`, { concurrency: false }, async () => {
        const value = harness({ [objectType]: [{ name: 'unsupported_object' }] });
        await assert.rejects(migrate(value.pool, value.options), /Stored database objects/);
        assert.equal(value.log.some(entry => entry.kind === 'backup'), false);
        assert.equal(value.log.some(entry => entry.kind === 'sql' && entry.sql.startsWith('LOCK TABLES')), false);
        assert.deepEqual(mutations(value.log), []);
        assertReleased(value.log, false);
    });
}

test('failed restore verification stops before source DDL or data changes', { concurrency: false }, async () => {
    const value = harness({ verifyFailure: true });
    await assert.rejects(migrate(value.pool, value.options), /Restore verification failed/);
    assert.equal(value.log.filter(entry => entry.kind === 'backup').length, 1);
    assert.equal(value.log.filter(entry => entry.kind === 'verify-backup').length, 1);
    assert.deepEqual(mutations(value.log), []);
    assertReleased(value.log, true);
});

test('connected writer stops before backup or source mutations', { concurrency: false }, async () => {
    const value = harness({ writerFailure: true });
    await assert.rejects(migrate(value.pool, value.options), /writer is still connected/);
    assert.equal(value.log.some(entry => entry.kind === 'backup'), false);
    assert.deepEqual(mutations(value.log), []);
    assertReleased(value.log, false);
});

for (const acquired of [0, '0', null, undefined, true, '01', '1x']) {
    test(`GET_LOCK ${String(acquired)} (${typeof acquired}) stops before backup or DDL`, { concurrency: false }, async () => {
        const value = harness({ acquired });
        await assert.rejects(migrate(value.pool, value.options), /Another order management migration is running/);
        assert.equal(value.log.some(entry => entry.kind === 'backup'), false);
        assert.equal(value.log.some(entry => entry.kind === 'sql' && entry.sql.startsWith('LOCK TABLES')), false);
        assert.deepEqual(mutations(value.log), []);
        assert.equal(value.log.filter(entry => entry.kind === 'sql' && entry.sql.startsWith('SELECT RELEASE_LOCK')).length, 0);
        assert.equal(value.log.filter(entry => entry.kind === 'release').length, 1);
    });
}

for (const acquired of [1, '1']) {
test(`GET_LOCK ${typeof acquired} 1 permits one verified backup and relocking after ALTER before update`, { concurrency: false }, async () => {
    const value = harness({ acquired });
    const result = await migrate(value.pool, value.options);
    const { log } = value;
    assert.equal(log.filter(entry => entry.kind === 'backup').length, 1);
    const backup = log.find(entry => entry.kind === 'backup');
    assert.equal(backup.options.root, value.options.backupRoot);
    assert.equal(backup.prefix, 'order-management');
    assert.equal(backup.db, value.db);
    const verified = log.findIndex(entry => entry.kind === 'verify-backup');
    const alter = log.findIndex(entry => entry.kind === 'sql' && entry.sql.startsWith('ALTER TABLE'));
    const update = log.findIndex(entry => entry.kind === 'sql' && entry.sql.startsWith('UPDATE orders'));
    const create = log.findIndex(entry => entry.kind === 'sql' && entry.sql.startsWith('CREATE TABLE'));
    assert(verified > 0 && verified < alter);
    assert.equal(log[alter - 1].kind, 'writers-stopped');
    assert.equal(log[alter + 1].kind, 'sql');
    assert.match(log[alter + 1].sql, /^LOCK TABLES /);
    assert.equal(update, alter + 2);
    assert.equal(log[create - 1].kind, 'writers-stopped');
    assert.equal(log.filter(entry => entry.kind === 'writers-stopped').length, 3);
    assert.equal(log.filter(entry => entry.kind === 'sql' && entry.sql.startsWith('LOCK TABLES')).length, 2);
    assert.equal(result.ordersPreserved, 1);
    assert.equal(result.verifiedLegacyReservations, 1);
    assert.equal(result.schemaChanges, 4);
    assert.equal(result.businessFieldsUnchanged, true);
    assertReleased(log, true);
});
}
