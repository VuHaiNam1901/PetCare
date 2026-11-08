const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../config/db');
const migrations = [
    require('../migrations/006-order-payment-lifecycle'),
    require('../migrations/007-payment-attempts-refunds'),
    require('../migrations/008-voucher-foundation'),
];
const options = { apply: true, expectedDatabase: process.env.PETCARE_TEST_DATABASE, isolatedTest: true };

after(async () => { await pool.end(); });

async function legacySnapshot() {
    const snapshot = {};
    for (const table of ['orders', 'order_details', 'payments', 'order_status_history']) {
        snapshot[table] = (await pool.query(`SELECT * FROM \`${table}\` WHERE order_id IN (173,174) ORDER BY 1`))[0];
    }
    return snapshot;
}

test('006-008 verify and rerun without changing synthetic legacy data or manufacturing history', async () => {
    const before = await legacySnapshot();
    for (const migration of migrations) {
        await migration.verify(pool);
        await migration.migrate(pool, options);
    }
    assert.deepEqual(await legacySnapshot(), before);
    const [[legacy]] = await pool.execute('SELECT workflow_version,created_at_utc,payment_expires_at,cancelled_at,cancellation_reason_code,subtotal_amount,discount_amount,voucher_code_snapshot FROM orders WHERE order_id=173');
    assert.ok(Object.values(legacy).every(value => value === null));
    const [ledger] = await pool.query('SELECT version,status FROM schema_migrations ORDER BY version');
    assert.deepEqual(ledger.map(row => [row.version, row.status]), [['006', 'completed'], ['007', 'completed'], ['008', 'completed']]);
});

test('default migration invocation is read-only even on a completed schema', async () => {
    const [before] = await pool.query('SELECT * FROM schema_migrations ORDER BY version');
    for (const migration of migrations) await migration.migrate(pool);
    const [after_] = await pool.query('SELECT * FROM schema_migrations ORDER BY version');
    assert.deepEqual(after_, before);
});

test('interrupted migration ledger is inspected and can safely resume', async () => {
    await pool.execute("UPDATE schema_migrations SET status='running',step='synthetic-interruption' WHERE version='006'");
    await migrations[0].migrate(pool, options);
    const [[row]] = await pool.execute("SELECT status FROM schema_migrations WHERE version='006'");
    assert.equal(row.status, 'completed');
});

test('existing wrong column type is rejected rather than silently repaired', async () => {
    const before = await legacySnapshot();
    await pool.query('ALTER TABLE orders MODIFY COLUMN workflow_version TINYINT UNSIGNED NULL DEFAULT NULL');
    try {
        await assert.rejects(migrations[0].migrate(pool, options));
        const [[column]] = await pool.query("SHOW COLUMNS FROM orders WHERE Field='workflow_version'");
        assert.equal(column.Type.toLowerCase(), 'tinyint unsigned');
    } finally {
        await pool.query('ALTER TABLE orders MODIFY COLUMN workflow_version SMALLINT UNSIGNED NULL DEFAULT NULL');
    }
    await migrations[0].migrate(pool, options);
    assert.deepEqual(await legacySnapshot(), before);
});

test('wrong expected database stops before schema changes', async () => {
    await assert.rejects(migrations[0].migrate(pool, { ...options, expectedDatabase: 'petcare_db' }));
    await migrations[0].verify(pool);
});

test('changed CHECK string literal is detected without altering schema or journal', async () => {
    const [before] = await pool.query('SELECT * FROM schema_migrations ORDER BY version');
    let changed = false;
    const inspected = {
        query: pool.query.bind(pool),
        async execute(sql, values) {
            const result = await pool.execute(sql, values);
            if (sql.includes('information_schema.CHECK_CONSTRAINTS') && values?.includes('vouchers')) {
                result[0] = result[0].map(row => {
                    if (row.name !== 'chk_voucher_status') return row;
                    // MySQL may escape the surrounding quote delimiters in
                    // CHECK_CLAUSE. Change the literal content in either form.
                    const expression = row.expression.replace(/\bdraft\b/g, 'DRAFT');
                    changed = expression !== row.expression;
                    return { ...row, expression };
                });
            }
            return result;
        },
    };
    await assert.rejects(migrations[2].verify(inspected), /check constraint|schema drift/i);
    assert.equal(changed, true, 'The metadata fixture must change a string literal, not just expression formatting');
    const [after_] = await pool.query('SELECT * FROM schema_migrations ORDER BY version');
    assert.deepEqual(after_, before);
    await migrations[2].verify(pool);
});

test('Voucher constraints and uniqueness protect the inactive foundation', async () => {
    const insert = (code, type, value) => pool.execute(`INSERT INTO vouchers
        (code,discount_type,discount_value,minimum_order_amount,starts_at_utc,ends_at_utc,status,created_at_utc,updated_at_utc)
        VALUES (?,?,?,0,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY),'draft',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [code, type, value]);
    await assert.rejects(insert('BAD_PERCENT', 'percent', '101.00'));
    await assert.rejects(insert('lower_case_code', 'fixed', '100.00'));
    await insert('SYNTHETIC_DRAFT', 'percent', '10.00');
    await assert.rejects(insert('SYNTHETIC_DRAFT', 'percent', '10.00'), error => error.code === 'ER_DUP_ENTRY');
});
