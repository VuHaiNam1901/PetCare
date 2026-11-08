// Clone schema definitions only, seed invented data, and run every SQL-writing
// test against a disposable database. The configured application DB is read-only.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const backendRoot = path.join(__dirname, '..');
const sourceDatabase = process.env.DB_NAME;
const testDatabase = `petcare_test_${randomUUID().replace(/-/g, '')}`;
const identifier = value => '`' + value.replace(/`/g, '``') + '`';
const connectionOptions = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
};

function assertDisposable(name) {
    if (name !== testDatabase || name === sourceDatabase || !/^petcare_test_[a-f0-9]{32}$/.test(name)) {
        throw new Error('Refusing to create or drop an unverified test database');
    }
}

async function seed(db) {
    const [category] = await db.execute('INSERT INTO categories (name, description, created_at) VALUES (?, ?, NOW())', ['Danh mục kiểm thử', 'Synthetic fixtures only']);
    const fixtures = [
        ['Thức ăn cho chó kiểm thử', '125000.00', 1000, 'Đang bán'],
        ['Thức ăn cho mèo kiểm thử', '99000.50', 1000, 'Đang bán'],
        ['Bát ăn thử nghiệm', '10000.25', 1000, 'Đang bán'],
        ['Đồ chơi kiểm thử', '25000.00', 1000, 'Đang bán'],
        ['Sản phẩm ngừng bán kiểm thử', '15000.00', 1000, 'Ngừng bán'],
        ['Sản phẩm hết hàng kiểm thử', '5000.00', 0, 'Đang bán'],
    ];
    for (const [name, price, stock, status] of fixtures) {
        await db.execute('INSERT INTO products (category_id, name, description, price, stock_quantity, image_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
            [category.insertId, name, 'Dữ liệu tổng hợp dành riêng cho kiểm thử, không phải sản phẩm thật.', price, stock, '/images/products/test.webp', status]);
    }
}

async function verifyMigration(pool) {
    // A populated legacy fixture proves that migration does not truncate an old
    // note merely because the new API limits newly submitted notes to 200 chars.
    const legacyName = 'Legacy migration recipient';
    const legacyNote = 'Preserve existing legacy note. '.repeat(12);
    assert.ok(legacyNote.length > 200 && legacyNote.length <= 500);
    const [account] = await pool.execute(`INSERT INTO \`user\`
        (full_name,email,password,phone,address,role,status,created_at)
        VALUES (?,?,?,NULL,NULL,'user','active',NOW())`, [legacyName, `migration-${randomUUID()}@example.test`, 'synthetic-unused-password']);
    const [created] = await pool.execute(`INSERT INTO orders
        (user_id,order_date,total_amount,shipping_address,phone,status,note,idempotency_key_hash,request_fingerprint)
        VALUES (?,NOW(),?,?,?,?,?,?,?)`, [account.insertId, '123.45', 'Legacy address\nSecond line', '0123456789', 'Chờ xử lý', legacyNote, 'a'.repeat(64), 'b'.repeat(64)]);
    const [[before]] = await pool.execute('SELECT * FROM orders WHERE order_id = ?', [created.insertId]);
    const { migrate } = require('../migrations/004-checkout');
    const first = await migrate(pool);
    const [[after]] = await pool.execute('SELECT * FROM orders WHERE order_id = ?', [created.insertId]);
    for (const [field, value] of Object.entries(before)) {
        if (field === 'recipient_name' && value === null) continue;
        assert.deepEqual(after[field], value, `Migration changed legacy ${field}`);
    }
    assert.equal(after.recipient_name, legacyName);
    assert.equal(after.note, legacyNote);
    await pool.execute('UPDATE `user` SET full_name = ? WHERE user_id = ?', ['Renamed account after migration', account.insertId]);
    const second = await migrate(pool);
    const [[repeated]] = await pool.execute('SELECT * FROM orders WHERE order_id = ?', [created.insertId]);
    assert.deepEqual(repeated, after, 'Re-running migration changed the recipient snapshot or legacy order');
    assert.equal(second.schemaChanges, 0);
    assert.equal(second.backfilledRecipients, 0);
    console.log(`Migration verified on populated synthetic data: ${first.ordersPreserved} order(s) preserved; legacy ${legacyNote.length}-character note unchanged; recipient snapshot stable on rerun.`);
}

async function verifyOrderManagementMigration(pool) {
    const { migrate } = require('../migrations/005-order-management');
    const [[owner]] = await pool.query('SELECT user_id FROM `user` ORDER BY user_id LIMIT 1');
    const [[product]] = await pool.query('SELECT product_id, price FROM products ORDER BY product_id LIMIT 1');
    const input = { source: 'buy-now', items: [{ product_id: product.product_id, quantity: 1 }],
        recipient_name: 'Nguyễn Kiểm Thử', shipping_address: 'Địa chỉ kiểm thử\nTầng 2', phone: '0912345678', payment_method: 'COD', note: 'Giữ nguyên ghi chú\nUnicode 🐾' };
    const fingerprint = require('node:crypto').createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const [created] = await pool.execute(`INSERT INTO orders
        (user_id,order_date,total_amount,recipient_name,shipping_address,phone,status,note,idempotency_key_hash,request_fingerprint)
        VALUES (?,NOW(),?,?,?,?,?,?,?,?)`, [owner.user_id, product.price, input.recipient_name, input.shipping_address, input.phone, 'Chờ xử lý', input.note, 'c'.repeat(64), fingerprint]);
    await pool.execute('INSERT INTO order_details (order_id,product_id,quantity,unit_price,subtotal) VALUES (?,?,1,?,?)', [created.insertId, product.product_id, product.price, product.price]);
    await pool.execute("INSERT INTO payments (order_id,payment_method,payment_status,amount,created_at) VALUES (?,'COD','Chưa thanh toán',?,NOW())", [created.insertId, product.price]);
    // Reproduce the v4 writer's atomic reservation, not an application DB row.
    await pool.execute('UPDATE products SET stock_quantity = stock_quantity - 1 WHERE product_id = ?', [product.product_id]);
    const [[before]] = await pool.execute('SELECT * FROM orders WHERE order_id = ?', [created.insertId]);
    const [beforeProducts] = await pool.query('SELECT * FROM products ORDER BY product_id');
    const first = await migrate(pool);
    const [[after]] = await pool.execute('SELECT * FROM orders WHERE order_id = ?', [created.insertId]);
    for (const [field, value] of Object.entries(before)) {
        if (field === 'stock_reservation_source' && value === null) continue;
        assert.deepEqual(after[field], value, `Order management migration changed legacy ${field}`);
    }
    assert.equal(after.stock_reservation_source, 'checkout-v4-fingerprint');
    assert.equal(after.stock_reserved_at, null, 'Migration must not invent the reservation time');
    assert.equal(after.rejection_reason, null);
    const [[unknown]] = await pool.query('SELECT stock_reservation_source,stock_reserved_at FROM orders WHERE order_id <> ' + Number(created.insertId) + ' ORDER BY order_id LIMIT 1');
    assert.equal(unknown.stock_reservation_source, null, 'Unproven legacy reservation must remain unknown');
    assert.equal(unknown.stock_reserved_at, null);
    const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM order_status_history');
    assert.equal(count, 0, 'Migration must not manufacture old history');
    const second = await migrate(pool);
    const [[repeated]] = await pool.execute('SELECT * FROM orders WHERE order_id = ?', [created.insertId]);
    assert.deepEqual(repeated, after);
    assert.equal(second.schemaChanges, 0);
    assert.equal(second.verifiedLegacyReservations, 0);
    assert.deepEqual((await pool.query('SELECT * FROM products ORDER BY product_id'))[0], beforeProducts, 'Migration changed inventory or catalog');
    console.log(`Order management migration verified: ${first.verifiedLegacyReservations} proven legacy reservation(s), unknown legacy preserved, no invented history, rerun stable.`);
}

async function run() {
    if (!sourceDatabase) throw new Error('DB_NAME is required to read schema definitions');
    const requested = process.argv.slice(2);
    const testsRoot = path.join(backendRoot, 'tests') + path.sep;
    for (const argument of requested) {
        if (!path.resolve(backendRoot, argument).startsWith(testsRoot) || !/\.test\.js$/.test(argument)) throw new Error('Only backend tests/*.test.js paths are accepted');
    }
    let source, administrator, targetPool, created = false;
    try {
        source = await mysql.createConnection({ ...connectionOptions, database: sourceDatabase });
        // No application rows, credentials, or customer information are copied.
        await source.query('START TRANSACTION READ ONLY');
        const [tables] = await source.query('SHOW FULL TABLES');
        if (tables.some(table => table.Table_type !== 'BASE TABLE')) throw new Error('Schema cloning does not support views');
        const [triggers] = await source.query('SHOW TRIGGERS');
        if (triggers.length) throw new Error('Schema cloning requires a source without triggers');
        const definitions = [];
        for (const table of tables) {
            const name = Object.values(table)[0];
            const [[row]] = await source.query(`SHOW CREATE TABLE ${identifier(name)}`);
            const ddl = row['Create Table'];
            if (/\bREFERENCES\s+`[^`]+`\s*\./i.test(ddl)) throw new Error('Cross-database foreign keys are not supported');
            definitions.push(ddl.replace(/ AUTO_INCREMENT=\d+/g, ''));
        }
        await source.rollback();
        await source.end(); source = undefined;

        administrator = await mysql.createConnection(connectionOptions);
        assertDisposable(testDatabase);
        await administrator.query(`CREATE DATABASE ${identifier(testDatabase)} CHARACTER SET utf8mb4`);
        created = true;
        targetPool = mysql.createPool({ ...connectionOptions, database: testDatabase, connectionLimit: 5 });
        const db = await targetPool.getConnection();
        try {
            await db.query('SET FOREIGN_KEY_CHECKS=0');
            for (const ddl of definitions) await db.query(ddl);
            await db.query('SET FOREIGN_KEY_CHECKS=1');
            await seed(db);
        } finally { db.release(); }

        // Migration modules see only the disposable database, even if they
        // require config/db.js while being loaded.
        process.env.PETCARE_TEST_SOURCE_DATABASE = sourceDatabase;
        process.env.PETCARE_TEST_DATABASE = testDatabase;
        process.env.PETCARE_TEST_ISOLATED = '1';
        process.env.DB_NAME = testDatabase;
        process.env.NODE_ENV = 'test';
        await verifyMigration(targetPool);
        await verifyOrderManagementMigration(targetPool);
        console.log(`Isolated test database ready: ${testDatabase} (synthetic data only)`);
        const exitCode = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...(requested.length ? requested : ['tests/*.test.js'])], {
                cwd: backendRoot, env: { ...process.env }, stdio: 'inherit', windowsHide: true,
            });
            child.once('error', reject);
            child.once('exit', code => resolve(code ?? 1));
        });
        process.exitCode = exitCode;
    } finally {
        await source?.end();
        await targetPool?.end();
        if (administrator) {
            if (created) {
                assertDisposable(testDatabase);
                await administrator.query(`DROP DATABASE ${identifier(testDatabase)}`);
                console.log('Disposable test database removed; application data was never modified.');
            }
            await administrator.end();
        }
    }
}

run().catch(error => { console.error('Isolated tests stopped:', error.message); process.exitCode = 1; });
