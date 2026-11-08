// Additive migration only. Stop application writers before running because
// MySQL DDL commits implicitly. No status, inventory or old history is guessed.
const { createHash } = require('node:crypto');
const { backup } = require('./001-admin-orders');
const identifier = value => '`' + value.replace(/`/g, '``') + '`';

function reservationProof(order, payment, lines) {
    if (order.approved_at || order.stock_restored_at || !['Chờ xử lý', 'Chờ thanh toán'].includes(order.status) ||
        !/^[a-f0-9]{64}$/.test(order.idempotency_key_hash || '') || !/^[a-f0-9]{64}$/.test(order.request_fingerprint || '') ||
        !payment || payment.payment_status !== 'Chưa thanh toán' || payment.transaction_date || payment.amount !== order.total_amount ||
        !['COD', 'ONLINE'].includes(payment.payment_method) || order.status !== (payment.payment_method === 'COD' ? 'Chờ xử lý' : 'Chờ thanh toán') ||
        typeof order.recipient_name !== 'string' || typeof order.shipping_address !== 'string' || typeof order.phone !== 'string' ||
        !lines.length || lines.some(line => !Number.isSafeInteger(line.product_id) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) ||
        new Set(lines.map(line => line.product_id)).size !== lines.length) return false;
    const items = lines.map(({ product_id, quantity }) => ({ product_id, quantity })).sort((a, b) => a.product_id - b.product_id);
    for (const source of items.length === 1 ? ['cart', 'buy-now'] : ['cart']) {
        // Exact canonical input/property order from the v4 Checkout writer. A
        // matching digest proves use of its atomic reserve-on-create protocol.
        const input = { source, items, recipient_name: order.recipient_name,
            shipping_address: order.shipping_address, phone: order.phone,
            payment_method: payment.payment_method, note: order.note };
        if (createHash('sha256').update(JSON.stringify(input)).digest('hex') === order.request_fingerprint) return true;
    }
    return false;
}

async function migrate(pool, options = {}) {
    const db = await pool.getConnection();
    let lockName, acquired = false, tablesLocked = false;
    try {
        const [[schema]] = await db.query('SELECT DATABASE() AS name, @@SESSION.sql_mode AS mode');
        if (!schema.name || schema.mode.includes('NO_BACKSLASH_ESCAPES')) throw new Error('Select a database with standard SQL string escaping');
        lockName = 'petcare_orders_' + createHash('sha256').update(schema.name).digest('hex').slice(0, 32);
        const [[lock]] = await db.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
        if (lock.acquired !== 1 && lock.acquired !== '1') throw new Error('Another order management migration is running');
        acquired = true;
        const [tables] = await db.query('SHOW FULL TABLES');
        if (tables.some(table => table.Table_type !== 'BASE TABLE')) throw new Error('Views require a separately reviewed migration');
        const names = tables.map(table => Object.values(table)[0]);
        if (!names.includes('orders')) throw new Error('Orders table is missing');
        const [engines] = await db.query('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
        if (engines.some(table => table.ENGINE !== 'InnoDB')) throw new Error('Order management requires InnoDB tables');
        const [triggers] = await db.query('SHOW TRIGGERS');
        if (triggers.length) throw new Error('Triggers require a separately reviewed migration');
        const [routines] = await db.query('SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()');
        const [events] = await db.query('SHOW EVENTS');
        if (routines.length || events.length) throw new Error('Stored database objects require a separately reviewed full backup');
        const lockTables = 'LOCK TABLES ' + names.map(name => `${identifier(name)} WRITE`).join(', ');
        if (options.assertWritersStopped) await options.assertWritersStopped();
        await db.query(lockTables);
        tablesLocked = true;
        const [columns] = await db.query('SHOW FULL COLUMNS FROM orders');
        const existing = new Map(columns.map(column => [column.Field, column]));
        const [before] = await db.query('SELECT * FROM orders ORDER BY order_id');
        if (existing.has('rejection_reason') && (!/^varchar\(500\)$/i.test(existing.get('rejection_reason').Type) || !existing.get('rejection_reason').Collation?.startsWith('utf8mb4_'))) throw new Error('Unexpected rejection_reason definition');
        if (existing.has('stock_reserved_at') && !/^datetime(?:\(\d+\))?$/i.test(existing.get('stock_reserved_at').Type)) throw new Error('Unexpected stock_reserved_at definition');
        if (existing.has('stock_reservation_source') && !/^varchar\(32\)$/i.test(existing.get('stock_reservation_source').Type)) throw new Error('Unexpected stock_reservation_source definition');
        const proven = [];
        for (const order of before) {
            if (order.stock_reserved_at || order.stock_reservation_source) continue;
            const [[payment]] = await db.execute('SELECT * FROM payments WHERE order_id = ?', [order.order_id]);
            const [lines] = await db.execute('SELECT product_id, quantity FROM order_details WHERE order_id = ? ORDER BY product_id', [order.order_id]);
            if (reservationProof(order, payment, lines)) proven.push(order.order_id);
        }
        const backupDirectory = await backup(db, names, 'order-management', { root: options.backupRoot });
        // An operational runner can restore this single backup into a fresh,
        // isolated schema and verify it before any DDL touches the source.
        if (options.verifyBackup) await options.verifyBackup({ directory: backupDirectory, db, tables: names });
        if (options.assertWritersStopped) await options.assertWritersStopped();
        const additions = [];
        if (!existing.has('rejection_reason')) additions.push('ADD COLUMN rejection_reason VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL');
        if (!existing.has('stock_reserved_at')) additions.push('ADD COLUMN stock_reserved_at DATETIME NULL DEFAULT NULL');
        if (!existing.has('stock_reservation_source')) additions.push('ADD COLUMN stock_reservation_source VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL');
        if (additions.length) {
            await db.query('ALTER TABLE orders ' + additions.join(', '));
            // ALTER can release explicit table locks. Reacquire all of them
            // before the proven-reservation updates; writers remain stopped.
            await db.query(lockTables);
        }
        for (const orderId of proven) await db.execute("UPDATE orders SET stock_reservation_source = 'checkout-v4-fingerprint' WHERE order_id = ? AND stock_reserved_at IS NULL AND stock_reservation_source IS NULL", [orderId]);
        // CREATE TABLE releases/changes metadata locks on some MySQL versions.
        // Writers are stopped operationally; release explicit table locks first.
        await db.query('UNLOCK TABLES'); tablesLocked = false;
        if (options.assertWritersStopped) await options.assertWritersStopped();
        await db.query(`CREATE TABLE IF NOT EXISTS order_status_history (
            history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            order_id INT NOT NULL,
            from_status VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
            to_status VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
            action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            actor_id INT NULL,
            actor_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
            reason VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (history_id),
            KEY idx_order_history (order_id, history_id),
            CONSTRAINT fk_order_history_order FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const [historyColumns] = await db.query('SHOW FULL COLUMNS FROM order_status_history');
        const expected = ['history_id', 'order_id', 'from_status', 'to_status', 'action', 'actor_id', 'actor_name', 'reason', 'created_at'];
        if (expected.some(name => !historyColumns.some(column => column.Field === name))) throw new Error('Unexpected existing history table; review schema before starting app');
        const [after] = await db.query('SELECT * FROM orders ORDER BY order_id');
        if (before.length !== after.length) throw new Error('Order count changed during migration');
        for (let index = 0; index < before.length; index++) {
            for (const [field, value] of Object.entries(before[index])) {
                if (field === 'stock_reservation_source' && value === null && proven.includes(before[index].order_id)) continue;
                if (JSON.stringify(after[index][field]) !== JSON.stringify(value)) throw new Error(`Existing order ${field} changed during migration`);
            }
        }
        return { backupDirectory, ordersPreserved: before.length, schemaChanges: additions.length + (names.includes('order_status_history') ? 0 : 1),
            verifiedLegacyReservations: proven.length,
            legacyOrdersRequiringReview: after.filter(order => !order.stock_reserved_at && !order.stock_reservation_source && !['Đã hủy', 'Đã giao hàng'].includes(order.status)).length,
            businessFieldsUnchanged: true };
    } finally {
        try { if (tablesLocked) await db.query('UNLOCK TABLES'); }
        finally {
            try { if (acquired) await db.query('SELECT RELEASE_LOCK(?)', [lockName]); }
            finally { db.release(); }
        }
    }
}

module.exports = { migrate, reservationProof };
if (require.main === module) {
    const pool = require('../config/db');
    migrate(pool).then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error('Order management migration stopped:', error.message); process.exitCode = 1; })
        .finally(() => pool.end());
}
