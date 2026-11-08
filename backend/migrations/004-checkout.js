// Stop application writers before running. MySQL DDL commits implicitly;
// a verified orders backup is taken before any schema/data change.
const { createHash } = require('node:crypto');
const mysql = require('mysql2');
const { backup } = require('./001-admin-orders');

const identifier = name => '`' + name.replace(/`/g, '``') + '`';

function unicodeDefinition(column) {
    if (!/^varchar\(\d+\)$/i.test(column.Type) || column.Extra) throw new Error(`Unexpected ${column.Field} definition; migration stopped`);
    return `${identifier(column.Field)} ${column.Type} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` +
        (column.Null === 'YES' ? ' NULL' : ' NOT NULL') +
        (column.Default === null ? column.Null === 'YES' ? ' DEFAULT NULL' : '' : ` DEFAULT ${mysql.escape(column.Default)}`) +
        (column.Comment ? ` COMMENT ${mysql.escape(column.Comment)}` : '');
}

async function migrate(pool) {
    const db = await pool.getConnection();
    let acquired = false;
    let tablesLocked = false;
    let lockName;
    try {
        const [[schema]] = await db.query('SELECT DATABASE() AS name, @@SESSION.sql_mode AS mode');
        if (!schema.name) throw new Error('Select an application database before migrating');
        if (schema.mode.includes('NO_BACKSLASH_ESCAPES')) throw new Error('Backup requires standard SQL string escaping');
        lockName = 'petcare_checkout_' + createHash('sha256').update(schema.name).digest('hex').slice(0, 32);
        const [[lock]] = await db.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
        if (lock.acquired !== 1 && lock.acquired !== '1') throw new Error('Another checkout migration is running');
        acquired = true;
        const [triggers] = await db.query("SHOW TRIGGERS WHERE `Table` = 'orders'");
        if (triggers.length) throw new Error('Order triggers require a separately reviewed migration');
        const [tables] = await db.query('SHOW FULL TABLES');
        const tableNames = tables.filter(table => table.Table_type === 'BASE TABLE').map(table => Object.values(table)[0]);
        if (!tableNames.includes('orders') || !tableNames.includes('user')) throw new Error('Required order/account tables are missing');
        // Keep the backup/backfill consistent with account names and prevent new
        // orders from arriving between the snapshot and verification. MySQL
        // expands FK locks through user/cart/order dependencies, so lock every
        // base table explicitly, as migration 001 does. Only orders is changed.
        await db.query('LOCK TABLES ' + tableNames.map(name => `${identifier(name)} WRITE`).join(', '));
        tablesLocked = true;
        const [columns] = await db.query('SHOW FULL COLUMNS FROM orders');
        const byName = new Map(columns.map(column => [column.Field, column]));
        const [before] = await db.query('SELECT * FROM orders ORDER BY order_id');
        const recipient = byName.get('recipient_name');
        if (recipient && (!/^varchar\((\d+)\)$/i.test(recipient.Type) || Number(recipient.Type.match(/\d+/)[0]) < 100)) throw new Error('Unexpected recipient_name capacity');
        for (const [name, minimum] of [['shipping_address', 255], ['note', 200]]) {
            const column = byName.get(name);
            if (!column || !/^varchar\((\d+)\)$/i.test(column.Type) || Number(column.Type.match(/\d+/)[0]) < minimum) throw new Error(`Unexpected ${name} capacity`);
        }
        const [[names]] = await db.query(`SELECT MAX(CHAR_LENGTH(\`user\`.full_name)) AS longest
            FROM orders JOIN \`user\` ON \`user\`.user_id = orders.user_id
            ${recipient ? 'WHERE orders.recipient_name IS NULL' : ''}`);
        const recipientCapacity = recipient ? Number(recipient.Type.match(/\d+/)[0]) : 100;
        if (names.longest > recipientCapacity) throw new Error('Legacy recipient names exceed column capacity; no truncation is permitted');
        const changes = [];
        if (!recipient) changes.push('ADD COLUMN recipient_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL');
        for (const name of ['recipient_name', 'shipping_address', 'note']) {
            const column = byName.get(name);
            if (column && !column.Collation?.startsWith('utf8mb4_')) changes.push('MODIFY COLUMN ' + unicodeDefinition(column));
        }
        // Backups preserve all legacy columns, including long notes and replay
        // metadata. Re-running an already applied migration is safe.
        const backupDirectory = await backup(db, ['orders'], 'checkout');
        if (changes.length) await db.query('ALTER TABLE orders ' + changes.join(', '));
        const [updated] = await db.query(`UPDATE orders JOIN \`user\` ON \`user\`.user_id = orders.user_id
            SET orders.recipient_name = \`user\`.full_name WHERE orders.recipient_name IS NULL`);
        const [after] = await db.query('SELECT * FROM orders ORDER BY order_id');
        if (after.length !== before.length) throw new Error('Order count changed unexpectedly during migration');
        const afterById = new Map(after.map(order => [order.order_id, order]));
        for (const original of before) {
            const saved = afterById.get(original.order_id);
            if (!saved) throw new Error('An existing order is missing after migration');
            for (const [name, value] of Object.entries(original)) {
                if (name === 'recipient_name' && value === null) continue;
                if (JSON.stringify(saved[name]) !== JSON.stringify(value)) throw new Error(`Existing order ${name} changed unexpectedly`);
            }
        }
        return { backupDirectory, ordersPreserved: before.length, backfilledRecipients: updated.affectedRows, schemaChanges: changes.length };
    } finally {
        try { if (tablesLocked) await db.query('UNLOCK TABLES'); }
        finally {
            try { if (acquired) await db.query('SELECT RELEASE_LOCK(?)', [lockName]); }
            finally { db.release(); }
        }
    }
}

module.exports = { migrate };
if (require.main === module) {
    const pool = require('../config/db');
    migrate(pool).then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error('Checkout migration stopped:', error.message); process.exitCode = 1; })
        .finally(() => pool.end());
}
