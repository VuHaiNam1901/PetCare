// Run with the application stopped. DDL commits implicitly in MySQL; back up
// first, use additive DDL, and make backfill safe to resume after interruption.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const mysql = require('mysql2');
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = name => '`' + name.replace(/`/g, '``') + '`';

function legacyNote(note) {
    let value;
    try { value = JSON.parse(note); } catch { return null; }
    if (!value || value.v !== 1 || !('key' in value) || !('fingerprint' in value)) return null;
    if (!/^[a-f0-9]{64}$/.test(value.key) || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
        !(value.note === null || typeof value.note === 'string')) throw new Error('Malformed legacy idempotency metadata; migration stopped');
    return value;
}

async function backup(db, tables, prefix = 'uc18', options = {}) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(prefix)) throw new Error('Invalid backup prefix');
    const [[session]] = await db.query('SELECT DATABASE() AS name, @@SESSION.time_zone AS time_zone, @@SESSION.sql_mode AS sql_mode');
    if (!session.name || typeof session.time_zone !== 'string' || typeof session.sql_mode !== 'string' ||
        session.sql_mode.split(',').includes('NO_BACKSLASH_ESCAPES')) throw new Error('Backup requires a selected database with standard SQL string escaping');
    const [[database]] = await db.query(`SHOW CREATE DATABASE ${identifier(session.name)}`);
    if (typeof database['Create Database'] !== 'string') throw new Error('Database definition is missing');
    const directory = path.join(path.resolve(options.root || process.env.PETCARE_BACKUP_ROOT || path.join(__dirname, '..', 'backups')),
        `${prefix}-${Date.now()}-${randomUUID()}`);
    const chunks = ['-- PetCare full table backup. Restore into an EMPTY database, not over live data.',
        'SET NAMES utf8mb4;', `SET SESSION time_zone=${mysql.escape(session.time_zone)};`,
        `SET SESSION sql_mode=${mysql.escape(session.sql_mode)};`, 'SET FOREIGN_KEY_CHECKS=0;'];
    const manifest = { database: session.name, created_at: new Date().toISOString(),
        database_schema: database['Create Database'], database_schema_sha256: digest(database['Create Database']),
        session: { time_zone: session.time_zone, sql_mode: session.sql_mode }, tables: {} };
    const supportedTypes = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric',
        'bit', 'date', 'datetime', 'timestamp', 'time', 'year', 'char', 'varchar', 'binary', 'varbinary',
        'tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'enum', 'set']);
    for (const table of tables) {
        const [[definition]] = await db.query(`SHOW CREATE TABLE ${identifier(table)}`);
        if (typeof definition['Create Table'] !== 'string') throw new Error(`Table definition is missing: ${table}`);
        const [columns] = await db.query(`SHOW FULL COLUMNS FROM ${identifier(table)}`);
        if (!columns.length || columns.some(column => /\b(?:VIRTUAL|STORED|INVISIBLE)\b/i.test(column.Extra || '') ||
            column.Generation_expression || !supportedTypes.has(column.Type.match(/^[a-z]+/i)?.[0].toLowerCase()))) {
            throw new Error(`Unsupported generated, invisible or column type in backup: ${table}`);
        }
        chunks.push(definition['Create Table'] + ';');
        const [selected] = await db.query({ sql: `SELECT * FROM ${identifier(table)}`,
            supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, typeCast(field, next) {
            if (['DATE', 'DATETIME', 'TIMESTAMP', 'NEWDATE', 'TIME', 'LONGLONG', 'DECIMAL', 'NEWDECIMAL'].includes(field.type)) return field.string();
            return next();
        } });
        const rows = selected.map(row => {
            if (Object.keys(row).length !== columns.length || columns.some(column => !Object.hasOwn(row, column.Field))) {
                throw new Error(`Backup row does not match table columns: ${table}`);
            }
            const ordered = Object.fromEntries(Object.keys(row).sort().map(name => [name, row[name]]));
            if (Object.values(ordered).some(value => value !== null && typeof value !== 'string' &&
                !(typeof value === 'number' && Number.isSafeInteger(value)) && !Buffer.isBuffer(value))) {
                throw new Error(`Unsupported or imprecise backup value: ${table}`);
            }
            return ordered;
        }).sort((left, right) => {
            const a = JSON.stringify(left), b = JSON.stringify(right);
            return a < b ? -1 : a > b ? 1 : 0;
        });
        for (const row of rows) chunks.push(`INSERT INTO ${identifier(table)} (${Object.keys(row).map(identifier).join(',')}) VALUES (${Object.values(row).map(value => mysql.escape(value)).join(',')});`);
        manifest.tables[table] = { rows: rows.length, sha256: digest(JSON.stringify(rows)),
            schema_sha256: digest(definition['Create Table']), columns: columns.map(column => column.Field) };
    }
    chunks.push('SET FOREIGN_KEY_CHECKS=1;');
    const sql = chunks.join('\n') + '\n';
    manifest.sql_sha256 = digest(sql);
    const manifestText = JSON.stringify(manifest, null, 2);
    // Finish all schema/data checks before creating the single backup set.
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'database.sql'), sql, { flag: 'wx' });
    await fs.writeFile(path.join(directory, 'manifest.json'), manifestText, { flag: 'wx' });
    if (digest(await fs.readFile(path.join(directory, 'database.sql'))) !== manifest.sql_sha256) throw new Error('Backup verification failed');
    if (await fs.readFile(path.join(directory, 'manifest.json'), 'utf8') !== manifestText) throw new Error('Backup manifest verification failed');
    return directory;
}

async function migrate(pool) {
    const db = await pool.getConnection();
    let locked = false;
    let migrationLock = false;
    try {
        const [[lock]] = await db.query("SELECT GET_LOCK('petcare_uc18_migration', 0) AS acquired");
        if (lock.acquired !== 1 && lock.acquired !== '1') throw new Error('Another migration is running');
        migrationLock = true;
        const [tables] = await db.query('SHOW FULL TABLES');
        if (tables.some(table => table.Table_type !== 'BASE TABLE')) throw new Error('Views need a separately reviewed backup plan');
        const names = tables.map(table => Object.values(table)[0]);
        const [engines] = await db.query('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
        if (engines.some(row => row.ENGINE !== 'InnoDB')) throw new Error('Non-InnoDB table requires a separate backup plan');
        const [triggers] = await db.query('SHOW TRIGGERS');
        const [routines] = await db.query('SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()');
        const [events] = await db.query('SHOW EVENTS');
        if (triggers.length || routines.length || events.length) throw new Error('Stored database objects require a separately reviewed full backup');
        const [[mode]] = await db.query('SELECT @@SESSION.sql_mode AS mode');
        if (mode.mode.includes('NO_BACKSLASH_ESCAPES')) throw new Error('Backup requires standard SQL string escaping');
        // Block writes during backup, impact checks, DDL and backfill.
        await db.query('LOCK TABLES ' + names.map(name => `${identifier(name)} WRITE`).join(', '));
        locked = true;
        const backupDirectory = await backup(db, names);
        console.log('Verified pre-migration backup:', backupDirectory);
        const [orders] = await db.query('SELECT * FROM orders');
        const seen = new Set();
        const pending = [];
        for (const order of orders) {
            const metadata = legacyNote(order.note);
            const key = order.idempotency_key_hash || metadata?.key;
            if (key) {
                const identity = `${order.user_id}:${key}`;
                if (seen.has(identity)) throw new Error('Duplicate user/idempotency key found; no automatic merging is permitted');
                seen.add(identity);
            }
            if (metadata) {
                if ((order.idempotency_key_hash && order.idempotency_key_hash !== metadata.key) ||
                    (order.request_fingerprint && order.request_fingerprint !== metadata.fingerprint)) throw new Error('Conflicting legacy idempotency metadata');
                pending.push({ id: order.order_id, ...metadata });
            }
            if (order.status === 'Đã hủy' && !order.stock_restored_at) throw new Error('Legacy cancellation requires a stock restoration audit before migration');
            if (!['Chờ xử lý', 'Chờ thanh toán'].includes(order.status) && !order.approved_at && order.status !== 'Đã hủy') throw new Error('Legacy progressed orders require an approval audit before migration');
        }
        const [columns] = await db.query('SHOW COLUMNS FROM orders');
        const existingColumns = new Set(columns.map(column => column.Field));
        const additions = Object.entries({
            approved_at: 'DATETIME NULL', stock_restored_at: 'DATETIME NULL',
            idempotency_key_hash: 'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL',
            request_fingerprint: 'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL'
        }).filter(([name]) => !existingColumns.has(name)).map(([name, definition]) => `ADD COLUMN ${identifier(name)} ${definition}`);
        const [indexes] = await db.query('SHOW INDEX FROM orders');
        const unique = indexes.filter(index => !index.Non_unique && index.Key_name === 'uq_orders_user_idempotency').sort((a, b) => a.Seq_in_index - b.Seq_in_index);
        if (unique.length && unique.map(index => index.Column_name).join(',') !== 'user_id,idempotency_key_hash') throw new Error('Unexpected existing idempotency index');
        if (!unique.length) additions.push('ADD UNIQUE KEY uq_orders_user_idempotency (user_id, idempotency_key_hash)');
        if (additions.length) await db.query('ALTER TABLE orders ' + additions.join(', '));
        for (const row of pending) await db.execute('UPDATE orders SET idempotency_key_hash = ?, request_fingerprint = ?, note = ? WHERE order_id = ?', [row.key, row.fingerprint, row.note, row.id]);
        const [after] = await db.query('SELECT * FROM orders');
        if (after.length !== orders.length) throw new Error('Order count changed unexpectedly');
        const afterById = new Map(after.map(order => [order.order_id, order]));
        for (const order of orders) {
            const saved = afterById.get(order.order_id);
            const metadata = legacyNote(order.note);
            for (const [key, value] of Object.entries(order)) {
                if (['note', 'idempotency_key_hash', 'request_fingerprint'].includes(key)) continue;
                if (JSON.stringify(saved[key]) !== JSON.stringify(value)) throw new Error('Existing order data verification failed');
            }
            if (saved.note !== (metadata ? metadata.note : order.note)) throw new Error('Note backfill verification failed');
            if (metadata && (saved.idempotency_key_hash !== metadata.key || saved.request_fingerprint !== metadata.fingerprint)) throw new Error('Key backfill verification failed');
        }
        console.log(`Migration verified: ${orders.length} orders preserved; ${pending.length} legacy notes migrated.`);
        return { backupDirectory, orders: orders.length, migratedNotes: pending.length };
    } finally {
        if (locked) await db.query('UNLOCK TABLES');
        if (migrationLock) await db.query("SELECT RELEASE_LOCK('petcare_uc18_migration')");
        db.release();
    }
}

module.exports = { migrate, legacyNote, backup };
if (require.main === module) {
    const pool = require('../config/db');
    migrate(pool).catch(error => { console.error('Migration stopped:', error.message); process.exitCode = 1; }).finally(() => pool.end());
}
