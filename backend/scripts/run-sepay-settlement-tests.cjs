// A fresh, retained fixture schema only. Source access is SHOW CREATE and
// information_schema metadata in a READ ONLY transaction, never source rows.
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const schema = require('../migrations/lib/stage1-schema');
const migrations = ['006-order-payment-lifecycle', '007-payment-attempts-refunds', '008-voucher-foundation']
    .map(file => require('../migrations/' + file));
const backend = path.resolve(__dirname, '..');
const quote = name => '`' + name.replace(/`/g, '``') + '`';
function assertTarget(actual, expected, source) {
    if (!/^petcare_test_[a-f0-9]{32}$/.test(actual || '') || actual !== expected || actual === source || actual === 'petcare_db') {
        throw new Error('Refusing to write outside this newly generated settlement fixture schema');
    }
}

async function definitions(source, database) {
    const names = new Set(['schema_migrations']);
    for (const { plan } of migrations) for (const object of [...plan.baseline, ...plan.objects]) names.add(object.table);
    const result = [];
    // FK dependencies include only tables needed by these existing tables;
    // unrelated source tables and all source application rows are untouched.
    for (const table of names) {
        const [[metadata]] = await source.execute('SELECT TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [database, table]);
        if (metadata?.type !== 'BASE TABLE') throw new Error(`Required existing table ${table} is unavailable; no migrations will run`);
        const [triggers] = await source.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? AND EVENT_OBJECT_TABLE=?', [database, table]);
        if (triggers.length) throw new Error(`Fixture cloning requires separate review for source triggers on ${table}`);
        const [references] = await source.execute(`SELECT DISTINCT REFERENCED_TABLE_SCHEMA AS schema_name,REFERENCED_TABLE_NAME AS table_name
            FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL`, [database, table]);
        for (const reference of references) {
            if (reference.schema_name !== database) throw new Error('Cross-schema foreign keys require separate review');
            names.add(reference.table_name);
        }
        const [[row]] = await source.query(`SHOW CREATE TABLE ${quote(table)}`);
        const ddl = row['Create Table'];
        if (/\bREFERENCES\s+`[^`]+`\s*\./i.test(ddl)) throw new Error('Qualified source foreign keys cannot be cloned safely');
        result.push(ddl.replace(/ AUTO_INCREMENT=\d+/g, ''));
    }
    return result;
}

async function seed(pool, target, source) {
    const db = await pool.getConnection();
    try {
        const [[actual]] = await db.query('SELECT DATABASE() AS name');
        assertTarget(actual.name, target, source);
        // The isolated journal describes these cloned definitions; no source
        // migration rows are read/copied and no migrate()/ALTER is executed.
        for (const { plan } of migrations) await db.execute(`INSERT INTO schema_migrations
            (version,name,checksum,status,step,started_at_utc,updated_at_utc,completed_at_utc)
            VALUES (?,?,?,'completed',NULL,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
        [plan.version, plan.name, schema.checksum(plan)]);
        await db.execute(`INSERT INTO \`user\`
            (user_id,full_name,email,password,phone,address,role,status,created_at)
            VALUES (1,'Synthetic SePay owner','sepay-owner@example.test','unused-test-hash',NULL,NULL,'user','active',NOW()),
                   (2,'Synthetic SePay admin','sepay-admin@example.test','unused-test-hash',NULL,NULL,'admin','active',NOW())`);
        const [category] = await db.execute('INSERT INTO categories (name,description,created_at) VALUES (?,?,NOW())',
            ['Synthetic SePay category', 'No source catalog rows are copied']);
        await db.execute(`INSERT INTO products
            (product_id,category_id,name,description,price,stock_quantity,image_url,status,created_at)
            VALUES (1,?,'Synthetic SePay product','Invented settlement fixture',150000.00,1000,'/images/products/test.webp','Đang bán',NOW())`, [category.insertId]);
        await db.execute(`INSERT INTO vouchers
            (voucher_id,code,discount_type,discount_value,max_discount_amount,minimum_order_amount,starts_at_utc,ends_at_utc,
             total_limit,per_user_limit,status,created_at_utc,updated_at_utc)
            VALUES (1,'SEPAYFIXED','fixed',10000.00,NULL,0.00,UTC_TIMESTAMP(3)-INTERVAL 1 DAY,UTC_TIMESTAMP(3)+INTERVAL 1 DAY,
                100,100,'active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`);
    } finally { db.release(); }
}

async function run() {
    require('dotenv').config({ path: path.join(backend, '.env'), quiet: true });
    const sourceName = process.env.DB_NAME;
    if (sourceName !== 'petcare_db') throw new Error('Source must be petcare_db metadata; existing retained test schemas are never selected');
    const target = `petcare_test_${randomUUID().replace(/-/g, '')}`;
    assertTarget(target, target, sourceName);
    const options = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectTimeout: 5000 };
    let source, administrator, pool, created = false;
    try {
        source = await mysql.createConnection({ ...options, database: sourceName });
        await source.query('START TRANSACTION READ ONLY');
        const ddl = await definitions(source, sourceName);
        await source.rollback(); await source.end(); source = undefined;
        administrator = await mysql.createConnection(options);
        // No IF NOT EXISTS: a collision fails rather than reusing a database.
        await administrator.query(`CREATE DATABASE ${quote(target)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        created = true;
        pool = mysql.createPool({ ...options, database: target, dateStrings: true, connectionLimit: 8 });
        const db = await pool.getConnection();
        try {
            const [[actual]] = await db.query('SELECT DATABASE() AS name');
            assertTarget(actual.name, target, sourceName);
            await db.query('SET FOREIGN_KEY_CHECKS=0');
            try { for (const statement of ddl) await db.query(statement); }
            finally { await db.query('SET FOREIGN_KEY_CHECKS=1'); }
        } finally { db.release(); }
        await seed(pool, target, sourceName);
        for (const migration of migrations) await migration.verify(pool);
        await pool.end(); pool = undefined;
        console.log(`SePay settlement fixture: ${target}; cloned definitions only, synthetic data, no migration execution.`);
        process.exitCode = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'sepay-test/settlement.test.cjs'], {
                cwd: backend, windowsHide: true, stdio: 'inherit', env: { ...process.env,
                    NODE_ENV: 'test', DB_NAME: target, PETCARE_TEST_DATABASE: target, PETCARE_TEST_SOURCE_DATABASE: sourceName,
                    PETCARE_TEST_ISOLATED: '1', PETCARE_ORDER_WORKFLOW_ENABLED: '1', PETCARE_ORDER_FRONTEND_READY: '1',
                    PETCARE_ORDER_EXPIRY_ENABLED: '1', PETCARE_PAYMENT_SIMULATION_ENABLED: '0', PETCARE_VOUCHERS_ENABLED: '1',
                    SEPAY_INTEGRATION_ENABLED: '1', SEPAY_TEST_MODE: '1', SEPAY_ENVIRONMENT: 'test',
                    SEPAY_TEST_WRITE_DATABASE: target, SEPAY_TEST_ACCOUNT_CONFIRMED: '1',
                    SEPAY_TEST_ACCOUNT_NUMBER: '999999000002', SEPAY_TEST_ACCOUNT_NAME: 'SYNTHETIC SEPAY OWNER',
                    SEPAY_TEST_WEBHOOK_SECRET: randomBytes(32).toString('hex') },
            });
            child.once('error', reject);
            child.once('exit', code => resolve(code ?? 1));
        });
    } finally {
        await source?.end(); await pool?.end(); await administrator?.end();
        if (created) console.log(`Retained new settlement fixture schema: ${target}. No existing test schema was opened, modified or dropped.`);
    }
}

module.exports = { assertTarget };
if (require.main === module) run().catch(error => {
    console.error('SePay settlement checks stopped:', error.code || error.message);
    process.exitCode = 1;
});
