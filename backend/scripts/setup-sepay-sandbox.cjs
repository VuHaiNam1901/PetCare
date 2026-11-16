// Provisions an isolated Sandbox schema (petcare_test_<32 hex>) for the
// PetCareShop SePay Test Mode website experience.
// - Reads ONLY table DDL from petcare_db inside a READ ONLY transaction.
// - Never copies real user or order rows from petcare_db.
// - Never modifies petcare_db or backend/.env.
// - Never drops existing petcare_test_* schemas.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');
const schema = require('../migrations/lib/stage1-schema');

const backendRoot = path.resolve(__dirname, '..');
const mainEnvPath = path.join(backendRoot, '.env');
const sandboxEnvPath = path.join(backendRoot, 'sepay-test', '.env');
const identifier = value => '`' + String(value).replace(/`/g, '``') + '`';

function assertTarget(actual, expected, source) {
    if (
        !/^petcare_test_[a-f0-9]{32}$/.test(actual || '') ||
        actual !== expected ||
        actual === source ||
        actual === 'petcare_db'
    ) {
        throw new Error(`Refusing to write outside the isolated Sandbox schema (got "${actual}", expected "${expected}")`);
    }
}

async function readSourceDefinitions(options, sourceName) {
    const source = await mysql.createConnection({ ...options, database: sourceName });
    try {
        await source.query('START TRANSACTION READ ONLY');
        const [tables] = await source.query('SHOW FULL TABLES');
        const definitions = [];
        for (const row of tables) {
            const tableName = Object.values(row)[0];
            const tableType = row.Table_type || Object.values(row)[1];
            if (tableType !== 'BASE TABLE') continue;
            const [[created]] = await source.query(`SHOW CREATE TABLE ${identifier(tableName)}`);
            const ddl = created['Create Table'];
            if (/\bREFERENCES\s+`[^`]+`\s*\./i.test(ddl)) {
                throw new Error(`Cross-schema foreign key detected in ${tableName}`);
            }
            definitions.push(
                ddl
                    .replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ')
                    .replace(/ AUTO_INCREMENT=\d+/g, '')
            );
        }
        await source.rollback();
        return definitions;
    } finally {
        await source.end();
    }
}

async function seedSandbox(pool, expected, sourceName) {
    const db = await pool.getConnection();
    try {
        const [[selected]] = await db.query('SELECT DATABASE() AS database_name');
        assertTarget(selected.database_name, expected, sourceName);

        // 1. Seed completed migration checksums (006, 007, 008)
        for (const name of ['006-order-payment-lifecycle', '007-payment-attempts-refunds', '008-voucher-foundation']) {
            const { plan } = require(path.join(backendRoot, 'migrations', name));
            await db.execute(
                `INSERT INTO schema_migrations (version, name, checksum, status, step, started_at_utc, updated_at_utc, completed_at_utc)
                 VALUES (?, ?, ?, 'completed', 'complete', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
                 ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), status = 'completed', step = 'complete', updated_at_utc = UTC_TIMESTAMP(3)`,
                [plan.version, plan.name, schema.checksum(plan)]
            );
        }

        // 2. Seed synthetic Sandbox accounts (Customer & Admin)
        const passwordHash = await bcrypt.hash('Sandbox@123', 10);
        await db.execute(
            `INSERT INTO \`user\` (user_id, full_name, email, password, phone, address, role, status, created_at)
             VALUES
               (1, 'Khách hàng Sandbox', 'sandbox.user@petcare.test', ?, '0901234567', '123 Đường Thử Nghiệm, Quận 1, TP. Hồ Chí Minh', 'user', 'active', NOW()),
               (2, 'Quản trị viên Sandbox', 'sandbox.admin@petcare.test', ?, '0909999999', 'Văn phòng PetCareShop Sandbox', 'admin', 'active', NOW())
             ON DUPLICATE KEY UPDATE
               full_name = VALUES(full_name),
               password = VALUES(password),
               phone = VALUES(phone),
               address = VALUES(address),
               role = VALUES(role),
               status = 'active'`,
            [passwordHash, passwordHash]
        );

        // 3. Seed 5 categories matching PetCareShop homepage tiles
        const categories = [
            [1, 'Thức ăn thú cưng', 'Thức ăn hạt và pate dinh dưỡng cho chó mèo'],
            [2, 'Đồ chơi thú cưng', 'Đồ chơi vận động và gặm sạch răng'],
            [3, 'Phụ kiện thú cưng', 'Vòng cổ, bát ăn và thùng đựng thức ăn'],
            [4, 'Vệ sinh & Chăm sóc', 'Khăn ướt, gel răng miệng và xẻng vệ sinh'],
            [5, 'Dinh dưỡng & Bổ sung', 'Dầu cá, bánh thưởng và vitamin'],
        ];
        for (const [id, name, description] of categories) {
            await db.execute(
                `INSERT INTO categories (category_id, name, description, created_at)
                 VALUES (?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
                [id, name, description]
            );
        }

        // 4. Seed pet_types
        const petTypes = [
            [1, 'dog', 'Chó'],
            [2, 'cat', 'Mèo'],
            [3, 'bird', 'Chim'],
            [4, 'fish', 'Cá'],
            [5, 'reptile', 'Bò sát'],
            [6, 'small-pet', 'Thú nhỏ'],
        ];
        for (const [id, slug, name] of petTypes) {
            await db.execute(
                `INSERT INTO pet_types (pet_type_id, slug, name)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE slug = VALUES(slug), name = VALUES(name)`,
                [id, slug, name]
            );
        }

        // 5. Seed synthetic Sandbox products with local public images
        const products = [
            [1, 1, 'Thức ăn hạt Me-O Tuna vị cá ngừ cho mèo 1.2kg', 'Hạt dinh dưỡng vị cá ngừ thơm ngon dành cho mèo trưởng thành (Dữ liệu Sandbox).', '115000.00', 50, '/images/products/1-me-o-tuna-thuc-an-hat-cho-meo-vi-ca-ngu-1-2kg.webp', 'Đang bán', [2]],
            [2, 1, 'Hạt Keos Digestive Care Cừu & Gạo cho chó 1.5kg', 'Công thức hỗ trợ tiêu hóa khỏe mạnh cho cún cưng (Dữ liệu Sandbox).', '165000.00', 50, '/images/products/11-keos-digestive-care-lamb-rice-cho-cho-1-5kg.webp', 'Đang bán', [1]],
            [3, 1, 'Pate Nekko Jelly cá ngừ cho mèo gói 70g', 'Pate thạch mềm giàu độ ẩm và taurine cho mèo (Dữ liệu Sandbox).', '25000.00', 100, '/images/products/3-nekko-jelly-pate-meo-70g.webp', 'Đang bán', [2]],
            [4, 5, 'Xúc xích thịt heo cà rốt Tellme cho chó 85g', 'Bánh thưởng giàu đạm và vitamin cho chó (Dữ liệu Sandbox).', '35000.00', 80, '/images/products/5-tellme-xuc-xich-thit-heo-ca-rot-cho-cho-85g.webp', 'Đang bán', [1]],
            [5, 2, 'Cần câu chuột lông thỏ đuôi dài CattyMan', 'Đồ chơi tương tác giúp mèo vận động mỗi ngày (Dữ liệu Sandbox).', '55000.00', 40, '/images/products/12-cattyman-toys-can-cau-chuot-long-tho-duoi-dai.webp', 'Đang bán', [2]],
            [6, 2, 'Đồ chơi gặm kẹo xoắn AFP Pups Candy Chew', 'Đồ chơi gặm sạch răng an toàn cho cún (Dữ liệu Sandbox).', '85000.00', 40, '/images/products/13-afp-pups-candy-chew-do-choi-can-gam-keo-xoan-cho-cho.webp', 'Đang bán', [1]],
            [7, 3, 'Thùng đựng thức ăn Royal Canin 2kg', 'Thùng bảo quản hạt kín hơi, chống ẩm mốc (Dữ liệu Sandbox).', '120000.00', 30, '/images/products/14-thung-dung-thuc-an-royal-canin-2kg-hinh-meo-m2.webp', 'Đang bán', [1, 2]],
            [8, 4, 'Khăn ướt vệ sinh Kit Cat 5in1 gói 80 miếng', 'Khăn ướt kháng khuẩn dịu nhẹ vệ sinh mắt tai và bàn chân (Dữ liệu Sandbox).', '75000.00', 60, '/images/products/16-kit-cat-5in1-cat-wipes-khan-uot-80-mieng.webp', 'Đang bán', [1, 2]],
        ];

        for (const [productId, categoryId, name, description, price, stock, imageUrl, status, petIds] of products) {
            await db.execute(
                `INSERT INTO products (product_id, category_id, name, description, price, stock_quantity, image_url, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                   category_id = VALUES(category_id),
                   name = VALUES(name),
                   description = VALUES(description),
                   price = VALUES(price),
                   image_url = VALUES(image_url),
                   status = VALUES(status)`,
                [productId, categoryId, name, description, price, stock, imageUrl, status]
            );
            for (const petTypeId of petIds) {
                await db.execute(
                    `INSERT IGNORE INTO product_pet_types (product_id, pet_type_id) VALUES (?, ?)`,
                    [productId, petTypeId]
                );
            }
        }

        // 6. Seed active Sandbox vouchers
        await db.execute(
            `INSERT INTO vouchers
               (code, discount_type, discount_value, max_discount_amount, minimum_order_amount,
                starts_at_utc, ends_at_utc, total_limit, per_user_limit, status, created_at_utc, updated_at_utc)
             VALUES
               ('SANDBOX20K', 'fixed', 20000.00, NULL, 100000.00, UTC_TIMESTAMP(3) - INTERVAL 1 DAY, UTC_TIMESTAMP(3) + INTERVAL 30 DAY, 100, 10, 'active', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
               ('SEPAY10', 'percent', 10.00, 50000.00, 50000.00, UTC_TIMESTAMP(3) - INTERVAL 1 DAY, UTC_TIMESTAMP(3) + INTERVAL 30 DAY, 100, 10, 'active', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
             ON DUPLICATE KEY UPDATE
               status = 'active',
               starts_at_utc = UTC_TIMESTAMP(3) - INTERVAL 1 DAY,
               ends_at_utc = UTC_TIMESTAMP(3) + INTERVAL 30 DAY,
               updated_at_utc = UTC_TIMESTAMP(3)`
        );
    } finally {
        db.release();
    }
}

function writeSandboxEnv(targetDatabase, sourceDatabase, existing = {}, mainEnv = {}) {
    const accountNumber = /^[0-9]{4,32}$/.test(existing.SEPAY_TEST_ACCOUNT_NUMBER || '')
        ? existing.SEPAY_TEST_ACCOUNT_NUMBER
        : '0000000001';
    const accountName = (existing.SEPAY_TEST_ACCOUNT_NAME || 'VU HAI NAM').trim();
    const webhookSecret = /^[\x21-\x7e]{32,256}$/.test(existing.SEPAY_TEST_WEBHOOK_SECRET || '')
        ? existing.SEPAY_TEST_WEBHOOK_SECRET
        : randomBytes(32).toString('hex');
    const backendPort = existing.SANDBOX_BACKEND_PORT || '3002';
    const receiverPort = existing.SEPAY_TEST_PORT || '3001';
    const dbHost = existing.DB_HOST || mainEnv.DB_HOST || 'localhost';
    const dbPort = existing.DB_PORT || mainEnv.DB_PORT || '3306';
    const dbUser = existing.DB_USER || mainEnv.DB_USER || 'root';
    const dbPassword = existing.DB_PASSWORD ?? mainEnv.DB_PASSWORD ?? '';

    const content = [
        '# PetCareShop - Isolated SePay Test Mode Sandbox Configuration',
        '# File nay chi dung cho moi truong Sandbox co lap; KHONG anh huong backend/.env that.',
        'NODE_ENV=test',
        'PETCARE_TEST_ISOLATED=1',
        `DB_HOST=${dbHost}`,
        `DB_PORT=${dbPort}`,
        `DB_USER=${dbUser}`,
        `DB_PASSWORD=${dbPassword}`,
        `DB_NAME=${targetDatabase}`,
        `PETCARE_TEST_DATABASE=${targetDatabase}`,
        `PETCARE_TEST_SOURCE_DATABASE=${sourceDatabase}`,
        `SEPAY_TEST_WRITE_DATABASE=${targetDatabase}`,
        '',
        '# SePay Test Mode & Receiver switches',
        'SEPAY_INTEGRATION_ENABLED=1',
        'SEPAY_TEST_ENABLED=1',
        'SEPAY_TEST_MODE=1',
        'SEPAY_ENVIRONMENT=test',
        'SEPAY_TEST_ACCOUNT_CONFIRMED=1',
        `SEPAY_TEST_ACCOUNT_NUMBER=${accountNumber}`,
        `SEPAY_TEST_ACCOUNT_NAME=${accountName}`,
        `SEPAY_TEST_WEBHOOK_SECRET=${webhookSecret}`,
        'SEPAY_TEST_HOST=127.0.0.1',
        `SEPAY_TEST_PORT=${receiverPort}`,
        'SEPAY_TEST_PATH=/webhooks/sepay/test',
        '',
        '# Sandbox Backend & Workflow switches',
        `SANDBOX_BACKEND_PORT=${backendPort}`,
        'PETCARE_ORDER_WORKFLOW_ENABLED=1',
        'PETCARE_ORDER_FRONTEND_READY=1',
        'PETCARE_ORDER_EXPIRY_ENABLED=1',
        'PETCARE_PAYMENT_SIMULATION_ENABLED=0',
        'PETCARE_VOUCHERS_ENABLED=1',
        '',
    ].join('\n');

    fs.writeFileSync(sandboxEnvPath, content, 'utf8');
}

async function run() {
    const mainEnv = fs.existsSync(mainEnvPath) ? dotenv.parse(fs.readFileSync(mainEnvPath, 'utf8')) : {};
    const existingSandboxEnv = fs.existsSync(sandboxEnvPath) ? dotenv.parse(fs.readFileSync(sandboxEnvPath, 'utf8')) : {};

    const sourceName = mainEnv.DB_NAME || 'petcare_db';
    if (sourceName !== 'petcare_db') {
        throw new Error(`Expected source DB_NAME in backend/.env to be petcare_db, found "${sourceName}"`);
    }

    const candidateTarget = existingSandboxEnv.PETCARE_TEST_DATABASE;
    const target = /^petcare_test_[a-f0-9]{32}$/.test(candidateTarget || '')
        ? candidateTarget
        : `petcare_test_${randomUUID().replace(/-/g, '')}`;
    assertTarget(target, target, sourceName);

    const options = {
        host: mainEnv.DB_HOST || 'localhost',
        port: Number(mainEnv.DB_PORT) || 3306,
        user: mainEnv.DB_USER || 'root',
        password: mainEnv.DB_PASSWORD || '',
        connectTimeout: 5000,
    };

    const definitions = await readSourceDefinitions(options, sourceName);
    let administrator, pool;
    try {
        administrator = await mysql.createConnection(options);
        await administrator.query(`CREATE DATABASE IF NOT EXISTS ${identifier(target)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        pool = mysql.createPool({ ...options, database: target, dateStrings: true, connectionLimit: 5 });

        const db = await pool.getConnection();
        try {
            const [[selected]] = await db.query('SELECT DATABASE() AS database_name');
            assertTarget(selected.database_name, target, sourceName);
            await db.query('SET FOREIGN_KEY_CHECKS=0');
            for (const ddl of definitions) {
                await db.query(ddl);
            }
            await db.query('SET FOREIGN_KEY_CHECKS=1');
        } finally {
            db.release();
        }

        await seedSandbox(pool, target, sourceName);
        writeSandboxEnv(target, sourceName, existingSandboxEnv, mainEnv);
        console.log(JSON.stringify({
            ok: true,
            sandboxDatabase: target,
            sourceDatabase: sourceName,
            sandboxEnvPath,
            backendPort: existingSandboxEnv.SANDBOX_BACKEND_PORT || '3002',
            receiverPort: existingSandboxEnv.SEPAY_TEST_PORT || '3001',
            accounts: {
                customer: 'sandbox.user@petcare.test / Sandbox@123',
                admin: 'sandbox.admin@petcare.test / Sandbox@123',
            },
        }, null, 2));
    } finally {
        await pool?.end();
        await administrator?.end();
    }
}

module.exports = { assertTarget, run };
if (require.main === module) {
    run().catch(error => {
        console.error('Sandbox setup failed:', error.message);
        process.exitCode = 1;
    });
}
