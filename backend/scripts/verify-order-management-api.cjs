'use strict';

// Run only after migration 005 and after the backend has been started.
// This script issues SELECT queries and GET requests only. It never prints
// credentials, bearer tokens, personal fields, or business records.
const path = require('node:path');
const { createHash } = require('node:crypto');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const auth = require('../config/auth');
const { decorate, states } = require('../models/order-policy');

const addedOrderColumns = new Set(['rejection_reason', 'stock_reserved_at', 'stock_reservation_source']);
const identifier = value => '`' + value.replace(/`/g, '``') + '`';
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonValue = value => JSON.parse(JSON.stringify(value));
let checks = 0;
let stage = 'configuration';

function check(condition, label) {
    if (!condition) {
        const error = new Error('Verification assertion failed');
        error.verificationCheck = label;
        throw error;
    }
    checks++;
}

function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}

function same(actual, expected, label) {
    // Compare without assertion diffs that could disclose private records.
    check(canonical(jsonValue(actual)) === canonical(jsonValue(expected)), label);
}

function noPrivateFields(value) {
    if (!value || typeof value !== 'object') return true;
    return Object.entries(value).every(([key, entry]) =>
        !['password', 'idempotency_key_hash', 'request_fingerprint'].includes(key) && noPrivateFields(entry));
}

async function snapshot(db) {
    const [columns] = await db.query(`SELECT c.TABLE_NAME, c.COLUMN_NAME, c.ORDINAL_POSITION,
        c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA, c.COLLATION_NAME
        FROM information_schema.COLUMNS c
        JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`);
    const tables = new Map();
    for (const column of columns) {
        if (!tables.has(column.TABLE_NAME)) tables.set(column.TABLE_NAME, []);
        if (column.TABLE_NAME !== 'orders' || !addedOrderColumns.has(column.COLUMN_NAME)) {
            tables.get(column.TABLE_NAME).push(column.COLUMN_NAME);
        }
    }
    check(tables.has('order_status_history'), 'history table exists before API verification');
    check([...addedOrderColumns].every(name => columns.some(column => column.TABLE_NAME === 'orders' && column.COLUMN_NAME === name)),
        'all migration 005 columns exist before API verification');
    const fingerprints = {};
    for (const [table, names] of tables) {
        check(names.length > 0, 'snapshot contains table columns');
        const [rows] = await db.query({
            sql: `SELECT ${names.map(identifier).join(',')} FROM ${identifier(table)}`,
            rowsAsArray: true,
            typeCast(field, next) {
                if (['DATE', 'NEWDATE', 'DATETIME', 'TIMESTAMP', 'LONGLONG', 'DECIMAL', 'NEWDECIMAL'].includes(field.type)) return field.string();
                return next();
            }
        });
        const canonicalRows = rows.map(row => canonical(jsonValue(row))).sort();
        fingerprints[table] = { columns: names, rows: rows.length, sha256: digest(JSON.stringify(canonicalRows)) };
    }
    check(fingerprints.order_status_history.rows === 0, 'new history table remains empty');
    return { schema: digest(canonical(jsonValue(columns))), tables: fingerprints };
}

async function main() {
    const port = Number(process.env.PORT || 3000);
    check(Number.isInteger(port) && port > 0 && port <= 65535, 'valid backend port');
    check(process.env.DB_NAME === 'petcare_db', 'verification targets petcare_db');
    const base = `http://127.0.0.1:${port}`;
    let db;
    try {
        stage = 'database connection';
        db = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT) || 3306,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        });
        const [[selectedDatabase]] = await db.query('SELECT DATABASE() AS database_name');
        check(selectedDatabase.database_name === 'petcare_db', 'connected database is petcare_db');

        stage = 'pre-request snapshot';
        const before = await snapshot(db);
        const [[customer]] = await db.query(`SELECT u.user_id, COUNT(*) AS order_count
            FROM \`user\` u JOIN orders o ON o.user_id = u.user_id
            WHERE u.role = 'user' AND u.status = 'active'
            GROUP BY u.user_id ORDER BY COUNT(*) DESC, u.user_id DESC LIMIT 1`);
        if (customer) customer.order_count = Number(customer.order_count);
        check(Boolean(customer) && customer.order_count > 0, 'existing active customer has orders');
        check(Number.isSafeInteger(customer.order_count), 'customer order count is a safe integer');
        const [[expectedUser]] = await db.execute(`SELECT user_id, full_name, email, phone, address,
            role, status, created_at FROM \`user\` WHERE user_id = ?`, [customer.user_id]);
        const [[count]] = await db.execute('SELECT COUNT(*) AS total FROM orders WHERE user_id = ?', [customer.user_id]);
        count.total = Number(count.total);
        check(Number.isSafeInteger(count.total), 'SQL order count is a safe integer');
        const [ids] = await db.query(`SELECT order_id FROM orders WHERE user_id = ?
            ORDER BY order_date DESC, order_id DESC LIMIT 10 OFFSET 0`, [customer.user_id]);
        check(ids.length > 0, 'API request exercises order history reads');

        const expectedOrders = [];
        for (const { order_id: orderId } of ids) {
            const [[order]] = await db.execute(`SELECT o.*, COALESCE(o.recipient_name, u.full_name) AS recipient_name,
                p.payment_method, p.payment_status, p.amount AS payment_amount, p.transaction_date
                FROM orders o JOIN \`user\` u ON u.user_id = o.user_id
                LEFT JOIN payments p ON p.order_id = o.order_id
                WHERE o.order_id = ? AND o.user_id = ?`, [orderId, customer.user_id]);
            const [items] = await db.execute(`SELECT d.order_detail_id, d.product_id, p.name, p.image_url,
                d.quantity, d.unit_price, d.subtotal FROM order_details d
                JOIN products p ON p.product_id = d.product_id
                WHERE d.order_id = ? ORDER BY d.order_detail_id`, [orderId]);
            const [history] = await db.execute(`SELECT history_id, from_status, to_status, action,
                actor_id, actor_name, created_at, reason FROM order_status_history
                WHERE order_id = ? ORDER BY history_id`, [orderId]);
            check(Boolean(order) && order.user_id === customer.user_id, 'SQL order ownership');
            check(history.length === 0, 'legacy orders have no invented history');
            delete order.idempotency_key_hash;
            delete order.request_fingerprint;
            expectedOrders.push({ ...decorate(order), items, history });
        }

        // Same subject and algorithm as the login route, using an existing real
        // account. This is an internal test token, not a password/login test.
        const token = jwt.sign({}, auth.secret, {
            algorithm: 'HS256', subject: String(customer.user_id), expiresIn: '5m'
        });
        async function get(route) {
            const response = await fetch(base + route, {
                method: 'GET', redirect: 'error',
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(15000)
            });
            check(response.status === 200, 'GET ' + route + ' HTTP 200');
            const body = await response.json();
            check(noPrivateFields(body), 'GET ' + route + ' exposes no private metadata');
            return { status: response.status, body };
        }

        stage = 'authenticated customer request';
        const me = await get('/api/auth/me');
        same(me.body, { success: true, user: expectedUser }, 'authenticated account matches SQL');
        stage = 'orders request';
        const response = await get('/api/orders?page=1&limit=10');
        const data = response.body;
        check(data.success === true && data.page === 1 && data.limit === 10, 'pagination metadata');
        same(data.statuses, states, 'available statuses');
        check(data.total === count.total && count.total === customer.order_count, 'customer total matches SQL');
        check(Array.isArray(data.orders) && data.orders.length === Math.min(count.total, 10) && data.orders.length > 0,
            'nonempty page length matches SQL');
        same(data.orders.map(order => order.order_id), ids.map(order => order.order_id), 'order IDs and date ordering');
        check(data.orders.every(order => order.user_id === customer.user_id), 'all response orders belong to customer');
        for (let index = 0; index < data.orders.length; index++) {
            same(data.orders[index], expectedOrders[index], 'all order item payment history and policy fields match SQL');
            check(Array.isArray(data.orders[index].history) && data.orders[index].history.length === 0,
                'response legacy history remains empty');
        }

        stage = 'post-request snapshot';
        const after = await snapshot(db);
        same(after, before, 'all source table row counts hashes and schema unchanged after GET requests');
        console.log(JSON.stringify({
            success: true,
            authentication: 'internal-test-token',
            customerId: customer.user_id,
            customerOrders: count.total,
            returnedOrders: data.orders.length,
            totalOrdersBefore: before.tables.orders.rows,
            totalOrdersAfter: after.tables.orders.rows,
            http: { authMe: me.status, orders: response.status },
            sourceTablesUnchanged: true,
            sourceTablesVerified: Object.keys(before.tables).length - 1,
            historyRows: after.tables.order_status_history.rows,
            assertionsPassed: checks
        }));
    } finally {
        if (db) await db.end();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(JSON.stringify({
            success: false,
            stage,
            ...(error.verificationCheck ? { failedCheck: error.verificationCheck } : {}),
            ...(typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? { code: error.code } : {}),
            assertionsPassed: checks
        }));
        process.exitCode = 1;
    });
}
