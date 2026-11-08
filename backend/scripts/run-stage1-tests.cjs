// This runner never calls migrations 001-005. The application database supplies
// schema metadata only; every migration and fixture write targets a new schema.
// The generated schema is deliberately retained for review, even after failure.
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');

const backendRoot = path.resolve(__dirname, '..');
const identifier = value => '`' + value.replace(/`/g, '``') + '`';
const legacyTests = [
    'tests/auth.test.js', 'tests/cart.test.js', 'tests/cart-merge.test.js',
    'tests/orders.test.js', 'tests/payments.test.js', 'tests/checkout.test.js',
    'tests/admin-order-management.test.js', 'tests/my-orders.test.js',
    'tests/order-detail.test.js', 'tests/catalog.test.js',
    'tests/admin-users.test.js', 'tests/reviews.test.js',
];

function assertTarget(database, expected, source) {
    if (!/^petcare_test_[a-f0-9]{32}$/.test(database || '') || database !== expected || database === source) {
        throw new Error('Stage 1 tests require their exact, newly generated isolated schema');
    }
}

async function seed(pool) {
    await pool.execute(`INSERT INTO \`user\`
        (user_id,full_name,email,password,phone,address,role,status,created_at)
        VALUES (1,'Synthetic legacy owner','legacy-owner@example.test','unused-synthetic-hash',NULL,NULL,'user','active',NOW()),
               (2,'Synthetic administrator','stage1-admin@example.test','unused-synthetic-hash',NULL,NULL,'admin','active',NOW())`);
    const [category] = await pool.execute('INSERT INTO categories (name,description,created_at) VALUES (?,?,NOW())',
        ['Stage 1 synthetic category', 'Invented fixtures only; no source rows are copied']);
    const fixtures = [
        ['Synthetic dog food', '125000.00', 1000, 'Đang bán'],
        ['Synthetic cat food', '99000.50', 1000, 'Đang bán'],
        ['Synthetic bowl', '10000.25', 1000, 'Đang bán'],
        ['Synthetic toy', '25000.00', 1000, 'Đang bán'],
        ['Synthetic discontinued item', '15000.00', 1000, 'Ngừng bán'],
        ['Synthetic unavailable item', '5000.00', 0, 'Đang bán'],
    ];
    const productIds = [];
    for (const [name, price, stock, status] of fixtures) {
        const [created] = await pool.execute(`INSERT INTO products
            (category_id,name,description,price,stock_quantity,image_url,status,created_at)
            VALUES (?,?,?,?,?,?,?,NOW())`, [category.insertId, name, 'Synthetic isolated fixture', price, stock, '/images/products/test.webp', status]);
        productIds.push(created.insertId);
    }
    // Deliberately reproduce legacy *shape* using invented values. These are not
    // copied orders 173/174 and contain no real customer/payment information.
    for (const [orderId, method, status, productId, amount] of [
        [173, 'ONLINE', 'Chờ thanh toán', productIds[0], '125000.00'],
        [174, 'COD', 'Chờ xử lý', productIds[1], '99000.50'],
    ]) {
        await pool.execute(`INSERT INTO orders
            (order_id,user_id,order_date,total_amount,recipient_name,shipping_address,phone,status,note,
             idempotency_key_hash,request_fingerprint,stock_reservation_source)
            VALUES (?,1,'2020-01-01 12:00:00',?,'Synthetic legacy recipient','Synthetic address 123','0900000000',?,NULL,?,?,'checkout-v4-fingerprint')`,
        [orderId, amount, status, createHash('sha256').update(`fixture-key-${orderId}`).digest('hex'), createHash('sha256').update(`fixture-payload-${orderId}`).digest('hex')]);
        await pool.execute('INSERT INTO order_details (order_id,product_id,quantity,unit_price,subtotal) VALUES (?,?,1,?,?)', [orderId, productId, amount, amount]);
        await pool.execute("INSERT INTO payments (order_id,payment_method,payment_status,amount,transaction_date,created_at) VALUES (?,?,'Chưa thanh toán',?,NULL,'2020-01-01 12:00:00')", [orderId, method, amount]);
        await pool.execute('UPDATE products SET stock_quantity=stock_quantity-1 WHERE product_id=?', [productId]);
    }
}

async function legacySnapshot(pool) {
    const snapshot = {};
    for (const table of ['orders', 'payments', 'order_details', 'order_status_history']) {
        const [rows] = await pool.query(`SELECT * FROM ${identifier(table)} WHERE order_id IN (173,174) ORDER BY 1`);
        snapshot[table] = rows;
    }
    return snapshot;
}

function compareLegacy(before, after) {
    for (const [table, rows] of Object.entries(before)) {
        if (rows.length !== after[table].length) throw new Error(`Migration changed synthetic legacy ${table} row count`);
        rows.forEach((row, index) => {
            for (const [column, value] of Object.entries(row)) {
                if (JSON.stringify(value) !== JSON.stringify(after[table][index][column])) throw new Error(`Migration changed legacy ${table}.${column}`);
            }
        });
    }
}

async function runProcess(files, environment) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
            cwd: backendRoot, env: environment, stdio: 'inherit', windowsHide: true,
        });
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
    });
}

async function verifyInterruptedLifecycleMigration(pool, migration, options) {
    let interrupted = false;
    // Wrap a target connection without replacing pool/driver methods. The first
    // ALTER really commits in MySQL before the injected failure is reported.
    const instrumented = {
        async getConnection() {
            const db = await pool.getConnection();
            return {
                execute: db.execute.bind(db), release: db.release.bind(db),
                async query(sql, values) {
                    const result = await db.query(sql, values);
                    if (!interrupted && /^ALTER TABLE `orders` ADD COLUMN/.test(sql)) {
                        interrupted = true;
                        throw Object.assign(new Error('Synthetic interruption after committed DDL'), { code: 'SYNTHETIC_DDL_INTERRUPTION' });
                    }
                    return result;
                },
            };
        },
    };
    try {
        await migration.migrate(instrumented, options);
        throw new Error('The synthetic interruption did not execute');
    } catch (error) {
        if (error.code !== 'SYNTHETIC_DDL_INTERRUPTION') throw error;
    }
    if (!interrupted) throw new Error('The synthetic interruption did not follow an ALTER');
    const [[ledger]] = await pool.execute("SELECT status FROM schema_migrations WHERE version='006'");
    const [columns] = await pool.query("SHOW COLUMNS FROM orders WHERE Field='workflow_version'");
    if (ledger?.status !== 'failed' || columns.length !== 1) throw new Error('Interrupted migration did not retain its journal and committed additive column');
    console.log('Synthetic interruption after first committed ALTER recorded; migration 006 will inspect and resume the partial schema.');
}

async function run() {
    require('dotenv').config({ path: path.join(backendRoot, '.env'), quiet: true });
    const arguments_ = process.argv.slice(2);
    if (arguments_.some(argument => argument !== '--legacy' && !/^tests[\\/]stage1-[a-z0-9-]+\.test\.js$/.test(argument))) {
        throw new Error('Only --legacy and explicit tests/stage1-*.test.js paths are accepted');
    }
    const sourceDatabase = process.env.DB_NAME;
    if (!sourceDatabase) throw new Error('DB_NAME is required for read-only schema inspection');
    const testDatabase = `petcare_test_${randomUUID().replace(/-/g, '')}`;
    const options = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectTimeout: 5000 };
    let source, administrator, targetPool;
    let created = false;
    try {
        source = await mysql.createConnection({ ...options, database: sourceDatabase });
        await source.query('START TRANSACTION READ ONLY');
        const [tables] = await source.query('SHOW FULL TABLES');
        if (tables.some(table => table.Table_type !== 'BASE TABLE')) throw new Error('Only a baseline schema without views is supported');
        const [triggers] = await source.query('SHOW TRIGGERS');
        if (triggers.length) throw new Error('Source triggers require a separately reviewed fixture schema');
        const names = tables.map(table => Object.values(table)[0]);
        const required = ['orders', 'order_details', 'payments', 'order_status_history', 'products', 'user'];
        if (required.some(name => !names.includes(name))) throw new Error('Source baseline 005 schema is incomplete');
        const [columns] = await source.query('SHOW COLUMNS FROM orders');
        if (columns.some(column => column.Field === 'workflow_version') || names.includes('schema_migrations')) {
            throw new Error('Source is beyond baseline 005; supply a separately reviewed baseline schema instead of silently reusing migrated definitions');
        }
        const definitions = [];
        for (const name of names) {
            const [[row]] = await source.query(`SHOW CREATE TABLE ${identifier(name)}`);
            const ddl = row['Create Table'];
            if (/\bREFERENCES\s+`[^`]+`\s*\./i.test(ddl)) throw new Error('Cross-schema foreign keys cannot be cloned');
            definitions.push(ddl.replace(/ AUTO_INCREMENT=\d+/g, ''));
        }
        await source.rollback();
        await source.end(); source = undefined;

        assertTarget(testDatabase, testDatabase, sourceDatabase);
        administrator = await mysql.createConnection(options);
        await administrator.query(`CREATE DATABASE ${identifier(testDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        created = true;
        console.log(`Stage 1 isolated schema created: ${testDatabase}; retained for review, never automatically removed.`);
        targetPool = mysql.createPool({ ...options, database: testDatabase, dateStrings: true, connectionLimit: 10 });
        const connection = await targetPool.getConnection();
        try {
            const [[actual]] = await connection.query('SELECT DATABASE() name');
            assertTarget(actual.name, testDatabase, sourceDatabase);
            await connection.query('SET FOREIGN_KEY_CHECKS=0');
            for (const ddl of definitions) await connection.query(ddl);
            await connection.query('SET FOREIGN_KEY_CHECKS=1');
        } finally { connection.release(); }
        await seed(targetPool);
        const before = await legacySnapshot(targetPool);
        Object.assign(process.env, {
            NODE_ENV: 'test', DB_NAME: testDatabase,
            PETCARE_TEST_SOURCE_DATABASE: sourceDatabase, PETCARE_TEST_DATABASE: testDatabase,
            PETCARE_TEST_ISOLATED: '1', PETCARE_PAYMENT_SIMULATION_ENABLED: '1',
            PETCARE_ORDER_WORKFLOW_ENABLED: '0', PETCARE_ORDER_FRONTEND_READY: '0', PETCARE_ORDER_EXPIRY_ENABLED: '0',
        });
        for (const file of ['006-order-payment-lifecycle', '007-payment-attempts-refunds', '008-voucher-foundation']) {
            const migration = require(path.join(backendRoot, 'migrations', file));
            const migrationOptions = { apply: true, expectedDatabase: testDatabase, isolatedTest: true };
            if (file.startsWith('006-')) await verifyInterruptedLifecycleMigration(targetPool, migration, migrationOptions);
            await migration.migrate(targetPool, migrationOptions);
            await migration.migrate(targetPool, migrationOptions);
        }
        compareLegacy(before, await legacySnapshot(targetPool));
        console.log('Migrations 006-008 applied and rerun only on isolated fixtures; all old synthetic order fields and history preserved.');
        if (arguments_.includes('--legacy')) {
            const legacyCode = await runProcess(legacyTests, { ...process.env });
            if (legacyCode) { process.exitCode = legacyCode; return; }
        }
        const fs = require('node:fs/promises');
        const specified = arguments_.filter(argument => argument !== '--legacy');
        const files = specified.length ? specified : (await fs.readdir(path.join(backendRoot, 'tests')))
            .filter(file => /^stage1-[a-z0-9-]+\.test\.js$/.test(file)).sort().map(file => `tests/${file}`);
        if (!files.length) throw new Error('No Stage 1 test files were found');
        process.exitCode = await runProcess(files, { ...process.env,
            PETCARE_ORDER_WORKFLOW_ENABLED: '1', PETCARE_ORDER_FRONTEND_READY: '1', PETCARE_ORDER_EXPIRY_ENABLED: '1' });
    } finally {
        await source?.end();
        await targetPool?.end();
        await administrator?.end();
        if (created) console.log(`Retained isolated test schema: ${testDatabase}. No source rows were copied or modified; no migrations 001-005 ran.`);
    }
}

module.exports = { assertTarget, compareLegacy, legacyTests };
if (require.main === module) run().catch(error => {
    console.error('Stage 1 tests stopped:', error.code || error.message);
    process.exitCode = 1;
});
