// One-shot maintenance runner. Never retries migration or restores over source data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mysql = require('mysql2/promise');
const { migrate, reservationProof } = require('../migrations/005-order-management');

const root = 'D:\\petcare-backups';
const target = 'petcare_db';
const addedColumns = ['rejection_reason', 'stock_reserved_at', 'stock_reservation_source'];
const expectedCounts = { cart_items: 2, cart_merge_requests: 4, carts: 1, categories: 5,
    chat_histories: 0, order_details: 2, orders: 2, payments: 2, products: 21, reviews: 0, user: 1 };
const qi = value => '`' + value.replace(/`/g, '``') + '`';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonicalRows = rows => rows.map(row => JSON.stringify(
    Object.fromEntries(Object.keys(row).sort().map(name => [name, row[name]])))).sort();
const dataHash = rows => sha('[' + canonicalRows(rows).join(',') + ']');
const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    supportBigNumbers: true, bigNumberStrings: true };

async function snapshot(db, names, oldColumns) {
    const result = {};
    for (const name of [...names].sort()) {
        const [[definition]] = await db.query('SHOW CREATE TABLE ' + qi(name));
        const [columns] = await db.query('SHOW FULL COLUMNS FROM ' + qi(name));
        const fields = oldColumns?.[name] || columns.map(column => column.Field);
        const [rows] = await db.query({ sql: 'SELECT ' + fields.map(qi).join(',') + ' FROM ' + qi(name),
            supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
        result[name] = { rows: rows.length, sha256: dataHash(rows),
            schema_sha256: sha(definition['Create Table']), columns: fields, definition: definition['Create Table'] };
    }
    return result;
}

async function assertForeignKeys(db, schema) {
    const [rows] = await db.execute(`SELECT CONSTRAINT_NAME,TABLE_NAME,COLUMN_NAME,
        REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME,ORDINAL_POSITION
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`, [schema]);
    const groups = new Map();
    for (const row of rows) {
        assert.equal(row.REFERENCED_TABLE_SCHEMA, schema, 'Cross-schema FK requires a separate plan');
        const key = row.TABLE_NAME + ':' + row.CONSTRAINT_NAME;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    for (const group of groups.values()) {
        const first = group[0];
        const join = group.map(row => `c.${qi(row.COLUMN_NAME)}=p.${qi(row.REFERENCED_COLUMN_NAME)}`).join(' AND ');
        const present = group.map(row => `c.${qi(row.COLUMN_NAME)} IS NOT NULL`).join(' AND ');
        const [[count]] = await db.query(`SELECT COUNT(*) n FROM ${qi(first.TABLE_NAME)} c
            LEFT JOIN ${qi(first.REFERENCED_TABLE_NAME)} p ON ${join}
            WHERE ${present} AND p.${qi(first.REFERENCED_COLUMN_NAME)} IS NULL`);
        assert.equal(Number(count.n), 0, 'Orphan rows in ' + first.CONSTRAINT_NAME);
    }
    return groups.size;
}

function assertApplicationStopped() {
    const command = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(node|php|python|java|pm2|nodemon)\\.exe$' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
    const values = raw.trim() ? JSON.parse(raw) : [];
    for (const processInfo of Array.isArray(values) ? values : [values]) {
        if (processInfo.ProcessId === process.pid) continue;
        if (processInfo.Name === 'node.exe' && /@oai[\\/]artifact-tool[\\/]dist[\\/]artifact-session[\\/]host-daemon\.mjs/.test(processInfo.CommandLine || '')) continue;
        throw Error('Potential application writer still running: PID ' + processInfo.ProcessId + ' ' + processInfo.Name);
    }
}

async function main() {
    assert.equal(process.argv[2], '--execute', 'Use --execute after reviewing this one-shot runner');
    assert.equal(connection.database, target, 'Unexpected database');
    assert.equal(path.relative(path.resolve(__dirname, '..', '..'), path.resolve(root)).startsWith('..'), true, 'Backup must be outside project');
    assertApplicationStopped();
    const observer = await mysql.createConnection(connection);
    const pool = mysql.createPool({ ...connection, connectionLimit: 1 });
    const allowedIds = new Set([observer.threadId]);
    pool.on('connection', db => allowedIds.add(db.threadId));
    const ledgerPath = path.join(root, 'petcare-005-operation.json');
    const state = { database: target, started_at: new Date().toISOString(), phase: 'preflight', migrationInvocations: 0 };
    let ledgerCreated = false;
    const saveState = async () => { if (ledgerCreated) await fs.writeFile(ledgerPath, JSON.stringify(state, null, 2) + '\n'); };
    try {
        // Explicitly authorized continuation of the GET_LOCK type failure only.
        // Any new failure or any backup/DDL evidence blocks another invocation.
        assert.equal(process.argv[3], '--resume-get-lock-type-fix');
        const previous = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
        assert.equal(previous.database, target);
        assert.equal(previous.phase, 'stopped-no-retry');
        assert.equal(previous.failedAt, 'migration-started');
        assert.equal(previous.error, 'Another order management migration is running');
        assert.equal(previous.migrationInvocations, 1);
        assert.equal(previous.backupDirectory, undefined);
        assert.equal(previous.previousAttempts, undefined, 'This authorized continuation has already been used');
        const existingFiles = await fs.readdir(root, { withFileTypes: true });
        assert(!existingFiles.some(entry => entry.isDirectory() && entry.name.startsWith('order-management-')),
            'An existing migration backup requires review; do not create a duplicate');
        const [[server]] = await observer.query('SELECT DATABASE() name,VERSION() version,@@SESSION.sql_mode mode,@@GLOBAL.read_only read_only');
        assert.equal(server.name, target);
        assert.equal(server.mode.includes('NO_BACKSLASH_ESCAPES'), false);
        assert.equal(Number(server.read_only), 0);
        const [tables] = await observer.query('SHOW FULL TABLES');
        assert(tables.every(table => table.Table_type === 'BASE TABLE'));
        const names = tables.map(table => Object.values(table)[0]).sort();
        assert.deepEqual(names, Object.keys(expectedCounts).sort(), 'Unexpected table set; stop for review');
        const [engines] = await observer.query('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
        assert(engines.every(row => row.ENGINE === 'InnoDB'));
        const [triggers] = await observer.query('SHOW TRIGGERS');
        const [routines] = await observer.query('SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()');
        const [events] = await observer.query('SELECT EVENT_NAME FROM information_schema.EVENTS');
        const [replicas] = await observer.query('SHOW REPLICA STATUS');
        const [prepared] = await observer.query('XA RECOVER');
        assert.equal(triggers.length + routines.length + events.length + replicas.length + prepared.length, 0, 'Stored objects, replication or prepared transactions require review');
        const [columnsBefore] = await observer.query('SHOW FULL COLUMNS FROM orders');
        assert(addedColumns.every(name => !columnsBefore.some(column => column.Field === name)), 'Migration may already be applied; never retry automatically');
        const primary = columnsBefore.find(column => column.Field === 'order_id');
        assert.equal(primary.Type, 'int'); assert.equal(primary.Key, 'PRI');
        assert.equal(primary.Null, 'NO'); assert.equal(primary.Extra, 'auto_increment');
        const [indexesBefore] = await observer.query('SHOW INDEX FROM orders');
        const before = await snapshot(observer, names);
        assert.deepEqual(before, previous.before, 'Source data/schema changed since the stopped attempt');
        for (const table of Object.values(before)) {
            assert(!/\bREFERENCES\s+(?:`[^`]+`|[a-z0-9_$]+)\s*\./i.test(table.definition),
                'Schema-qualified REFERENCES require a separately reviewed restore plan');
        }
        assert.deepEqual(Object.fromEntries(names.map(name => [name, before[name].rows])), expectedCounts, 'Counts changed since reviewed preflight');
        const foreignKeysBefore = await assertForeignKeys(observer, target);
        const [orders] = await observer.query('SELECT * FROM orders ORDER BY order_id');
        const provenIds = [];
        for (const order of orders) {
            const [[payment]] = await observer.execute('SELECT * FROM payments WHERE order_id=?', [order.order_id]);
            const [lines] = await observer.execute('SELECT product_id,quantity FROM order_details WHERE order_id=? ORDER BY product_id', [order.order_id]);
            if (reservationProof(order, payment, lines)) provenIds.push(order.order_id);
        }
        assert.equal(provenIds.length, 2, 'Reservation proof changed since review');
        const [transactions] = await observer.query('SELECT trx_id FROM information_schema.INNODB_TRX');
        assert.equal(transactions.length, 0, 'Active transaction; leave clients untouched and stop');
        const [clients] = await observer.query("SELECT ID,USER,HOST,DB,COMMAND FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND USER<>'event_scheduler'");
        // These idle Workbench sessions were mapped to PID 12080 and client
        // attributes during this authorized continuation. No other client is stopped.
        assert(clients.every(client => [18, 19].includes(Number(client.ID)) && client.USER === 'root' &&
            client.DB === target && client.COMMAND === 'Sleep' && /^localhost:6246[12]$/.test(client.HOST)),
            'Unexpected database client is connected; stop for review');
        for (const client of clients) {
            const [attributes] = await observer.execute(`SELECT ATTR_NAME,ATTR_VALUE FROM performance_schema.session_connect_attrs
                WHERE PROCESSLIST_ID=? AND ATTR_NAME IN ('program_name','_pid')`, [client.ID]);
            const attributesByName = Object.fromEntries(attributes.map(attribute => [attribute.ATTR_NAME, attribute.ATTR_VALUE]));
            assert.equal(attributesByName.program_name, 'MySQLWorkbench');
            assert.equal(attributesByName._pid, '12080');
        }
        state.previousAttempts = [{ started_at: previous.started_at, phase: previous.phase,
            failedAt: previous.failedAt, error: previous.error, migrationInvocations: previous.migrationInvocations,
            disconnectedIdleClients: previous.disconnectedIdleClients }];
        state.resumeReason = 'User authorized one new attempt after correcting GET_LOCK numeric/string handling';
        await fs.writeFile(ledgerPath, JSON.stringify(state, null, 2) + '\n');
        ledgerCreated = true;
        for (const client of clients) await observer.query('KILL CONNECTION ' + Number(client.ID));
        state.disconnectedIdleClients = clients.map(client => Number(client.ID));
        const assertWritersStopped = async () => {
            assertApplicationStopped();
            const [sessions] = await observer.query("SELECT ID,USER,DB,COMMAND FROM information_schema.PROCESSLIST WHERE USER<>'event_scheduler'");
            assert(sessions.every(session => allowedIds.has(Number(session.ID))), 'Another database client connected; stop without retry');
            const [active] = await observer.query('SELECT trx_mysql_thread_id FROM information_schema.INNODB_TRX');
            assert(active.every(transaction => allowedIds.has(Number(transaction.trx_mysql_thread_id))), 'External transaction detected');
        };
        await assertWritersStopped();
        state.phase = 'migration-started'; state.migrationInvocations = 1;
        state.before = before; state.serverVersion = server.version;
        state.provenReservationOrders = provenIds.length;
        await saveState();
        const result = await migrate(pool, {
            backupRoot: root, assertWritersStopped,
            async verifyBackup({ directory, db, tables: lockedNames }) {
                state.backupDirectory = directory; state.phase = 'backup-verifying'; await saveState();
                assert.equal(path.dirname(directory), root);
                const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
                const sql = await fs.readFile(path.join(directory, 'database.sql'), 'utf8');
                assert.equal(manifest.database, target);
                assert.equal(sha(sql), manifest.sql_sha256);
                assert.equal(sha(manifest.database_schema), manifest.database_schema_sha256);
                const [[sourceDatabase]] = await db.query('SHOW CREATE DATABASE ' + qi(target));
                assert.equal(manifest.database_schema, sourceDatabase['Create Database']);
                assert.deepEqual(Object.keys(manifest.tables).sort(), names);
                const locked = await snapshot(db, lockedNames);
                assert.deepEqual(locked, before, 'Source changed between preflight and locked backup');
                for (const name of names) {
                    assert.equal(manifest.tables[name].rows, before[name].rows);
                    assert.equal(manifest.tables[name].sha256, before[name].sha256);
                    assert.equal(manifest.tables[name].schema_sha256, before[name].schema_sha256);
                }
                const fresh = 'petcare_verify_005_' + randomUUID().replace(/-/g, '');
                assert(/^petcare_verify_005_[a-f0-9]{32}$/.test(fresh));
                const [exists] = await observer.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [fresh]);
                assert.equal(exists.length, 0);
                assert(manifest.database_schema.startsWith('CREATE DATABASE ' + qi(target) + ' '));
                await observer.query(manifest.database_schema.replace('CREATE DATABASE ' + qi(target), 'CREATE DATABASE ' + qi(fresh)));
                state.restoreVerificationDatabase = fresh; await saveState();
                const restore = await mysql.createConnection({ ...connection, database: fresh, multipleStatements: true });
                allowedIds.add(restore.threadId);
                let restored;
                try {
                    await restore.query('SET SESSION lock_wait_timeout=10');
                    await restore.query(sql);
                    restored = await snapshot(restore, names);
                    assert.deepEqual(restored, before, 'Restored schema/data differ from source');
                    assert.equal(await assertForeignKeys(restore, fresh), foreignKeysBefore);
                    for (const name of names) {
                        const [check] = await restore.query('CHECK TABLE ' + qi(name));
                        assert(check.some(row => row.Msg_type === 'status' && row.Msg_text === 'OK'), 'Restore CHECK TABLE failed: ' + name);
                    }
                } finally { allowedIds.delete(restore.threadId); await restore.end(); }
                const verification = { verified_at: new Date().toISOString(), sql_sha256: manifest.sql_sha256,
                    restored_database: fresh, allTables: names.length, allRows: Object.values(restored).reduce((sum, table) => sum + table.rows, 0),
                    schemaAndDataMatched: true, foreignKeysChecked: foreignKeysBefore, checkTable: 'OK', sourceUnchangedBeforeDDL: true };
                await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(verification, null, 2) + '\n', { flag: 'wx' });
                state.backupVerification = verification; state.phase = 'backup-verified-before-DDL'; await saveState();
                console.log(JSON.stringify({ phase: state.phase, directory, ...verification }));
            }
        });
        state.phase = 'migration-returned'; state.migrationResult = result; await saveState();
        await assertWritersStopped();
        const after = await snapshot(observer, names, Object.fromEntries(names.map(name => [name, before[name].columns])));
        for (const name of names) {
            assert.equal(after[name].rows, before[name].rows);
            assert.equal(after[name].sha256, before[name].sha256, 'Old data changed: ' + name);
            if (name !== 'orders') assert.equal(after[name].schema_sha256, before[name].schema_sha256, 'Unexpected schema change: ' + name);
        }
        const [columnsAfter] = await observer.query('SHOW FULL COLUMNS FROM orders');
        assert.deepEqual(columnsAfter.filter(column => !addedColumns.includes(column.Field)), columnsBefore);
        assert.equal(columnsAfter.length, columnsBefore.length + 3);
        const newColumns = new Map(columnsAfter.filter(column => addedColumns.includes(column.Field)).map(column => [column.Field, column]));
        assert.equal(newColumns.get('rejection_reason').Type, 'varchar(500)');
        assert.equal(newColumns.get('rejection_reason').Collation, 'utf8mb4_unicode_ci');
        assert.equal(newColumns.get('stock_reserved_at').Type, 'datetime');
        assert.equal(newColumns.get('stock_reservation_source').Type, 'varchar(32)');
        assert.equal(newColumns.get('stock_reservation_source').Collation, 'ascii_bin');
        for (const column of newColumns.values()) { assert.equal(column.Null, 'YES'); assert.equal(column.Default, null); }
        const [indexesAfter] = await observer.query('SHOW INDEX FROM orders');
        const stableIndexes = rows => rows.map(({ Cardinality, ...rest }) => rest);
        assert.deepEqual(stableIndexes(indexesAfter), stableIndexes(indexesBefore));
        const [sources] = await observer.query('SELECT order_id,rejection_reason,stock_reserved_at,stock_reservation_source FROM orders ORDER BY order_id');
        for (const order of sources) {
            assert.equal(order.rejection_reason, null); assert.equal(order.stock_reserved_at, null);
            assert.equal(order.stock_reservation_source, provenIds.includes(order.order_id) ? 'checkout-v4-fingerprint' : null);
        }
        const [historyColumns] = await observer.query('SHOW FULL COLUMNS FROM order_status_history');
        assert.deepEqual(historyColumns.map(column => column.Field), ['history_id', 'order_id', 'from_status', 'to_status', 'action', 'actor_id', 'actor_name', 'reason', 'created_at']);
        assert.equal(historyColumns[0].Type, 'bigint unsigned'); assert.equal(historyColumns[0].Key, 'PRI'); assert.equal(historyColumns[0].Extra, 'auto_increment');
        assert.equal(historyColumns[1].Type, 'int'); assert.equal(historyColumns[1].Null, 'NO');
        const [historyIndexes] = await observer.query('SHOW INDEX FROM order_status_history');
        assert.deepEqual(historyIndexes.filter(index => index.Key_name === 'PRIMARY').map(index => index.Column_name), ['history_id']);
        assert.deepEqual(historyIndexes.filter(index => index.Key_name === 'idx_order_history').sort((a,b) => a.Seq_in_index-b.Seq_in_index).map(index => index.Column_name), ['order_id', 'history_id']);
        const [fk] = await observer.query(`SELECT k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.DELETE_RULE,r.UPDATE_RULE
            FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='order_status_history' AND k.CONSTRAINT_NAME='fk_order_history_order'`);
        assert.equal(fk.length, 1);
        assert.equal(fk[0].COLUMN_NAME, 'order_id');
        assert.equal(fk[0].REFERENCED_TABLE_NAME, 'orders');
        assert.equal(fk[0].REFERENCED_COLUMN_NAME, 'order_id');
        assert.equal(fk[0].DELETE_RULE, 'CASCADE');
        assert(['RESTRICT', 'NO ACTION'].includes(fk[0].UPDATE_RULE));
        const [[historyCount]] = await observer.query('SELECT COUNT(*) n FROM order_status_history');
        assert.equal(Number(historyCount.n), 0);
        const [tablesAfter] = await observer.query('SHOW FULL TABLES');
        assert.deepEqual(tablesAfter.map(table => Object.values(table)[0]).sort(), [...names, 'order_status_history'].sort());
        assert.equal(await assertForeignKeys(observer, target), foreignKeysBefore + 1);
        state.phase = 'migration-and-integrity-verified'; state.completed_at = new Date().toISOString();
        state.afterCounts = Object.fromEntries(names.map(name => [name, after[name].rows]));
        state.allOldDataUnchanged = true; state.historyRows = 0; await saveState();
        console.log(JSON.stringify({ phase: state.phase, migrationInvocations: state.migrationInvocations,
            result, backupDirectory: state.backupDirectory, restoreVerificationDatabase: state.restoreVerificationDatabase,
            beforeCounts: expectedCounts, afterCounts: state.afterCounts, allOldDataUnchanged: true,
            historyPrimaryForeignKeyAndIndexVerified: true, historyRows: 0 }));
    } catch (error) {
        state.failedAt = state.phase; state.phase = 'stopped-no-retry'; state.error = error.message;
        await saveState();
        console.error(JSON.stringify({ phase: state.phase, failedAt: state.failedAt, error: error.message,
            migrationInvocations: state.migrationInvocations, backupDirectory: state.backupDirectory,
            restoreVerificationDatabase: state.restoreVerificationDatabase, ledger: ledgerCreated ? ledgerPath : undefined }));
        process.exitCode = 1;
    } finally { await pool.end(); await observer.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
