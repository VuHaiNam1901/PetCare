// Voucher verification never replays migrations 001-005 or copies source rows.
// Only a fresh, random schema receives DDL/fixtures and it is retained for review.
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');

const root = path.resolve(__dirname, '..');
const identifier = value => '`' + String(value).replace(/`/g, '``') + '`';
function assertTarget(selected, generated, source) {
    if (!/^petcare_test_[a-f0-9]{32}$/.test(selected || '') || selected !== generated || selected === source) {
        throw new Error('Voucher tests require their exact newly generated isolated schema');
    }
}
async function snapshotLegacy(pool) {
    const result = {};
    for (const table of ['orders', 'payments', 'order_details', 'order_status_history']) {
        result[table] = (await pool.query(`SELECT * FROM ${identifier(table)} WHERE order_id IN (173,174) ORDER BY 1`))[0];
    }
    return result;
}
function verifyLegacy(before, after) {
    for (const [table, rows] of Object.entries(before)) {
        if (rows.length !== after[table].length) throw new Error(`Synthetic legacy ${table} row count changed`);
        for (const [index, row] of rows.entries()) for (const [field, value] of Object.entries(row)) {
            if (JSON.stringify(value) !== JSON.stringify(after[table][index][field])) throw new Error(`Synthetic legacy ${table}.${field} changed`);
        }
    }
}
async function seed(pool) {
    await pool.query(`INSERT INTO \`user\`
        (user_id,full_name,email,password,role,status,created_at) VALUES
        (1,'Voucher synthetic owner','voucher-owner@example.test','unused-synthetic-password','user','active',NOW()),
        (2,'Voucher synthetic administrator','voucher-admin@example.test','unused-synthetic-password','admin','active',NOW()),
        (3,'Voucher synthetic second owner','voucher-other@example.test','unused-synthetic-password','user','active',NOW())`);
    const [category] = await pool.execute('INSERT INTO categories(name,description,created_at) VALUES(?,?,NOW())',
        ['Voucher synthetic category', 'Invented fixtures, no source data copied']);
    for (const [id, name, price, status] of [[1, 'Voucher synthetic product', '100000.00', 'Đang bán'],
        [2, 'Voucher fractional synthetic product', '10000.25', 'Đang bán'], [3, 'Voucher stopped synthetic product', '5000.00', 'Ngừng bán']]) {
        await pool.execute(`INSERT INTO products
            (product_id,category_id,name,description,price,stock_quantity,image_url,status,created_at)
            VALUES(?,?,?,'Invented fixture',?,1000,'/images/products/test.webp',?,NOW())`, [id, category.insertId, name, price, status]);
    }
    for (const [id, method, status, productId, amount] of [[173, 'ONLINE', 'Chờ thanh toán', 1, '100000.00'], [174, 'COD', 'Chờ xử lý', 2, '10000.25']]) {
        await pool.execute(`INSERT INTO orders
            (order_id,user_id,order_date,total_amount,recipient_name,shipping_address,phone,status,note,
             idempotency_key_hash,request_fingerprint,stock_reservation_source)
            VALUES(?,1,'2020-01-01 12:00:00',?,'Synthetic legacy recipient','123 Invented address','0900000000',?,NULL,?,?,'checkout-v4-fingerprint')`,
        [id, amount, status, createHash('sha256').update(`voucher-legacy-key-${id}`).digest('hex'), createHash('sha256').update(`voucher-legacy-payload-${id}`).digest('hex')]);
        await pool.execute('INSERT INTO order_details(order_id,product_id,quantity,unit_price,subtotal) VALUES(?,?,1,?,?)', [id, productId, amount, amount]);
        await pool.execute("INSERT INTO payments(order_id,payment_method,payment_status,amount,created_at) VALUES(?,?,'Chưa thanh toán',?,'2020-01-01 12:00:00')", [id, method, amount]);
        await pool.execute('UPDATE products SET stock_quantity=stock_quantity-1 WHERE product_id=?', [productId]);
    }
}
async function run() {
    require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
    const requested = process.argv.slice(2);
    if (requested.some(file => !/^tests[\\/]voucher-[a-z0-9-]+\.test\.js$/.test(file))) throw new Error('Only tests/voucher-*.test.js paths are allowed');
    const sourceName = process.env.DB_NAME;
    if (!sourceName) throw new Error('DB_NAME is needed only to inspect baseline schema metadata');
    const generated = `petcare_test_${randomUUID().replace(/-/g, '')}`;
    const options = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectTimeout: 5000 };
    let source, administrator, target;
    let created = false;
    try {
        source = await mysql.createConnection({ ...options, database: sourceName });
        await source.query('START TRANSACTION READ ONLY');
        const [tables] = await source.query('SHOW FULL TABLES');
        if (tables.some(table => table.Table_type !== 'BASE TABLE')) throw new Error('Baseline source must not contain views');
        const [[stored]] = await source.query(`SELECT
            (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()) triggers_count,
            (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()) routines_count,
            (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()) events_count`);
        if (Number(stored.triggers_count) || Number(stored.routines_count) || Number(stored.events_count)) throw new Error('Stored objects need an independently reviewed test baseline');
        const names = tables.map(table => Object.values(table)[0]);
        const [columns] = await source.query('SHOW COLUMNS FROM orders');
        if (columns.some(column => column.Field === 'workflow_version') || names.includes('schema_migrations')) throw new Error('Voucher runner needs baseline 005, never a schema reset of a migrated source');
        if (['orders', 'payments', 'order_details', 'products', 'order_status_history', 'user'].some(name => !names.includes(name))) throw new Error('Incomplete baseline 005 source schema');
        const definitions = [];
        for (const name of names) {
            const [[row]] = await source.query(`SHOW CREATE TABLE ${identifier(name)}`);
            const ddl = row['Create Table'];
            if (/\bREFERENCES\s+`[^`]+`\s*\./i.test(ddl)) throw new Error('Cross-schema foreign keys cannot be copied into test fixtures');
            definitions.push(ddl.replace(/ AUTO_INCREMENT=\d+/g, ''));
        }
        await source.rollback();
        await source.end(); source = undefined;
        assertTarget(generated, generated, sourceName);
        administrator = await mysql.createConnection(options);
        await administrator.query(`CREATE DATABASE ${identifier(generated)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        created = true;
        console.log(`Voucher isolated test schema: ${generated}; retained, never automatically removed.`);
        target = mysql.createPool({ ...options, database: generated, dateStrings: true, connectionLimit: 10 });
        const db = await target.getConnection();
        try {
            const [[selected]] = await db.query('SELECT DATABASE() database_name');
            assertTarget(selected.database_name, generated, sourceName);
            await db.query('SET FOREIGN_KEY_CHECKS=0');
            for (const ddl of definitions) await db.query(ddl);
            await db.query('SET FOREIGN_KEY_CHECKS=1');
        } finally { db.release(); }
        await seed(target);
        const before = await snapshotLegacy(target);
        const environment = { ...process.env, NODE_ENV: 'test', DB_NAME: generated,
            PETCARE_TEST_SOURCE_DATABASE: sourceName, PETCARE_TEST_DATABASE: generated, PETCARE_TEST_ISOLATED: '1',
            PETCARE_ORDER_WORKFLOW_ENABLED: '1', PETCARE_ORDER_FRONTEND_READY: '1', PETCARE_ORDER_EXPIRY_ENABLED: '1',
            PETCARE_PAYMENT_SIMULATION_ENABLED: '1', PETCARE_VOUCHERS_ENABLED: '1' };
        // Migration modules see only the generated test identity. No historical
        // migration module is imported by this runner.
        Object.assign(process.env, environment);
        for (const file of ['006-order-payment-lifecycle', '007-payment-attempts-refunds', '008-voucher-foundation']) {
            await require(path.join(root, 'migrations', file)).migrate(target, { apply: true, expectedDatabase: generated, isolatedTest: true });
        }
        verifyLegacy(before, await snapshotLegacy(target));
        const files = requested.length ? requested : (await fs.readdir(path.join(root, 'tests')))
            .filter(file => /^voucher-[a-z0-9-]+\.test\.js$/.test(file)).sort().map(file => `tests/${file}`);
        if (!files.length) throw new Error('No focused voucher test files found');
        process.exitCode = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
                cwd: root, env: environment, stdio: 'inherit', windowsHide: true,
            });
            child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
        });
        verifyLegacy(before, await snapshotLegacy(target));
        console.log('Synthetic legacy 173/174 and history unchanged after focused Voucher tests.');
    } finally {
        await source?.end(); await target?.end(); await administrator?.end();
        if (created) console.log(`Retained Voucher schema: ${generated}. Source rows were never copied or modified; no migration 001-005 or schema cleanup ran.`);
    }
}
module.exports = { assertTarget, verifyLegacy };
if (require.main === module) run().catch(error => { console.error('Voucher tests stopped:', error.code || error.message); process.exitCode = 1; });
