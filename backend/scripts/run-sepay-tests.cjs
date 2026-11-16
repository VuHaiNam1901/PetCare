// Focused SePay preparation checks. Creates synthetic fixtures only in a new,
// verified test schema. No source rows, source DDL, migrations or DROP DATABASE.
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');

const backendRoot = path.resolve(__dirname, '..');
const identifier = value => '`' + value.replace(/`/g, '``') + '`';
function assertTarget(actual, expected, source) {
    if (!/^petcare_test_[a-f0-9]{32}$/.test(actual || '') || actual !== expected || actual === source || actual === 'petcare_db') {
        throw new Error('Refusing to write outside the newly generated isolated SePay fixture schema');
    }
}

async function seed(pool, expected, source) {
    const db = await pool.getConnection();
    try {
        const [[selected]] = await db.query('SELECT DATABASE() AS database_name');
        assertTarget(selected.database_name, expected, source);
        // Minimal copies of the existing query contract, not application schema
        // migrations or a second order workflow. All values below are invented.
        await db.query(`CREATE TABLE orders (
            order_id INT PRIMARY KEY, user_id INT NOT NULL, order_date DATETIME(3) NOT NULL,
            total_amount DECIMAL(12,2) NOT NULL, status VARCHAR(40) NOT NULL,
            approved_at DATETIME(3) NULL, stock_reserved_at DATETIME(3) NULL,
            stock_restored_at DATETIME(3) NULL, stock_reservation_source VARCHAR(64) NULL,
            workflow_version INT NULL, created_at_utc DATETIME(3) NULL,
            payment_expires_at DATETIME(3) NULL, cancelled_at DATETIME(3) NULL,
            cancellation_reason_code VARCHAR(32) NULL, cancellation_reason VARCHAR(500) NULL,
            rejection_reason VARCHAR(500) NULL
        ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await db.query(`CREATE TABLE payments (
            payment_id INT PRIMARY KEY, order_id INT NOT NULL UNIQUE,
            payment_method VARCHAR(16) NOT NULL, payment_status VARCHAR(40) NOT NULL,
            amount DECIMAL(12,2) NOT NULL, transaction_date DATETIME(3) NULL,
            created_at DATETIME(3) NOT NULL
        ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        for (let orderId = 1; orderId <= 6; orderId += 1) {
            await db.execute(`INSERT INTO orders
                (order_id,user_id,order_date,total_amount,status,stock_reserved_at,stock_reservation_source,
                 workflow_version,created_at_utc,payment_expires_at)
                VALUES (?,1,NOW(3),150000.00,'Chờ thanh toán',NOW(3)-INTERVAL 1 HOUR,
                    'checkout-v4-fingerprint',2,UTC_TIMESTAMP(3)-INTERVAL 1 HOUR,UTC_TIMESTAMP(3)+INTERVAL 23 HOUR)`, [orderId]);
            await db.execute(`INSERT INTO payments VALUES (?,?,'ONLINE','Chưa thanh toán',150000.00,NULL,NOW(3))`, [orderId, orderId]);
        }
        await db.query(`UPDATE orders SET created_at_utc=UTC_TIMESTAMP(3)-INTERVAL 25 HOUR,
            payment_expires_at=UTC_TIMESTAMP(3)-INTERVAL 1 HOUR WHERE order_id=2`);
        await db.query(`UPDATE orders SET status='Đã hủy',stock_restored_at=NOW(3),cancelled_at=UTC_TIMESTAMP(3),
            cancellation_reason_code='customer_cancelled',cancellation_reason='Synthetic customer cancellation' WHERE order_id=3`);
        await db.query(`UPDATE orders SET status='Đã hủy',stock_restored_at=NOW(3),cancelled_at=UTC_TIMESTAMP(3),
            cancellation_reason_code='admin_rejected',rejection_reason='Synthetic admin rejection' WHERE order_id=4`);
        await db.query("UPDATE payments SET payment_status='Đã hủy' WHERE order_id IN (3,4)");
        await db.query("UPDATE orders SET status='Chờ xử lý' WHERE order_id IN (5,6)");
        await db.query("UPDATE payments SET payment_status='Đã thanh toán',transaction_date=NOW(3) WHERE order_id=5");
        await db.query("UPDATE orders SET workflow_version=NULL,created_at_utc=NULL,payment_expires_at=NULL WHERE order_id=6");
        await db.query("UPDATE payments SET payment_method='COD' WHERE order_id=6");
    } finally { db.release(); }
}

async function run() {
    require('dotenv').config({ path: path.join(backendRoot, '.env'), quiet: true });
    const source = process.env.DB_NAME;
    if (!source) throw new Error('DB_NAME is required to establish source/target separation');
    const target = `petcare_test_${randomUUID().replace(/-/g, '')}`;
    assertTarget(target, target, source);
    const options = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectTimeout: 5000 };
    let administrator, pool, created = false;
    try {
        administrator = await mysql.createConnection(options);
        await administrator.query(`CREATE DATABASE ${identifier(target)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        created = true;
        pool = mysql.createPool({ ...options, database: target, dateStrings: true, connectionLimit: 5 });
        await seed(pool, target, source);
        await pool.end(); pool = undefined;
        console.log(`SePay isolated fixture schema: ${target}; synthetic orders/payments only, no migrations.`);
        process.exitCode = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'sepay-test/integration.test.cjs'], {
                cwd: backendRoot, windowsHide: true, stdio: 'inherit',
                env: { ...process.env, NODE_ENV: 'test', DB_NAME: target, PETCARE_TEST_DATABASE: target,
                    PETCARE_TEST_SOURCE_DATABASE: source, PETCARE_TEST_ISOLATED: '1', SEPAY_INTEGRATION_ENABLED: '1',
                    SEPAY_TEST_MODE: '1', SEPAY_ENVIRONMENT: 'test', SEPAY_TEST_ACCOUNT_CONFIRMED: '1',
                    SEPAY_TEST_ACCOUNT_NUMBER: '999999000001', SEPAY_TEST_ACCOUNT_NAME: 'TEST OWNER',
                    SEPAY_TEST_WEBHOOK_SECRET: randomBytes(32).toString('hex') },
            });
            child.once('error', reject);
            child.once('exit', code => resolve(code ?? 1));
        });
    } finally {
        await pool?.end();
        await administrator?.end();
        if (created) console.log(`Retained isolated fixture schema for review: ${target}. Source database was never selected or modified.`);
    }
}

module.exports = { assertTarget };
if (require.main === module) run().catch(error => {
    console.error('SePay safety checks stopped:', error.code || error.message);
    process.exitCode = 1;
});
