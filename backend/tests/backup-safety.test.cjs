// Standalone, mocked backup tests. No application DB, migration or server is used.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { backup } = require('../migrations/001-admin-orders');

const hash = value => createHash('sha256').update(value).digest('hex');
const quoted = name => String.fromCharCode(96) + name + String.fromCharCode(96);
const databaseDDL = 'CREATE DATABASE ' + quoted('actual_petcare') + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
const tableDDL = 'CREATE TABLE ' + quoted('orders') + ' (\n' +
    '  ' + quoted('order_id') + ' int NOT NULL PRIMARY KEY\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
const columns = [
    ['order_id', 'int', ''],
    ['request_id', 'bigint unsigned', ''],
    ['amount', 'decimal(30,10)', ''],
    ['created_at', 'datetime(6)', 'DEFAULT_GENERATED'],
    ['note', 'text', ''],
    ['optional', 'varchar(20)', ''],
].map(([Field, Type, Extra]) => ({ Field, Type, Extra }));
const rows = [
    { order_id: 2, request_id: '18446744073709551615', amount: '12345678901234567890.1234567890',
        created_at: '2026-11-05 14:03:02.123456', note: "Tiếng Việt 🐾\nO'Brien\\path\0", optional: null },
    { optional: 'kept', note: 'First', created_at: '2026-11-05 00:00:00.000000',
        amount: '0.0100000000', request_id: '9007199254740993', order_id: 1 },
];
let root;

before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'petcare-backup-safety-'));
    const project = path.resolve(__dirname, '..', '..').toLowerCase() + path.sep;
    assert.equal(path.resolve(root).toLowerCase().startsWith(project), false);
});

after(async () => {
    const temporaryRoot = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
    const resolved = path.resolve(root);
    assert.ok(resolved.toLowerCase().startsWith(temporaryRoot));
    assert.match(path.basename(resolved), /^petcare-backup-safety-/);
    await fs.rm(resolved, { recursive: true });
});

function mockDatabase(overrides = {}) {
    const calls = [];
    return {
        calls,
        async query(query) {
            const sql = typeof query === 'string' ? query : query.sql;
            calls.push(query);
            assert.match(sql, /^(SELECT|SHOW) /, 'Backup may only read the mocked database');
            if (sql.startsWith('SELECT DATABASE()')) return [[{
                name: 'actual_petcare', time_zone: '+07:00', sql_mode: 'STRICT_TRANS_TABLES,NO_AUTO_VALUE_ON_ZERO',
                ...overrides.session,
            }]];
            if (sql === 'SHOW CREATE DATABASE ' + quoted('actual_petcare')) return [[{ 'Create Database': databaseDDL }]];
            if (sql === 'SHOW CREATE TABLE ' + quoted('orders')) return [[{ 'Create Table': tableDDL }]];
            if (sql === 'SHOW FULL COLUMNS FROM ' + quoted('orders')) return [overrides.columns || columns];
            if (sql === 'SELECT * FROM ' + quoted('orders')) return [overrides.rows || rows];
            throw new Error('Unexpected SQL in mocked backup: ' + sql);
        },
    };
}

test('writes one external backup set with exact values, real line breaks and source metadata', async () => {
    const db = mockDatabase();
    const directory = await backup(db, ['orders'], 'order-management', { root });
    assert.equal(path.dirname(directory), root);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['database.sql', 'manifest.json']);
    const sql = await fs.readFile(path.join(directory, 'database.sql'), 'utf8');
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(sql.split('\n')[1], 'SET NAMES utf8mb4;');
    assert.ok(sql.endsWith('SET FOREIGN_KEY_CHECKS=1;\n'));
    assert.ok(sql.includes("SET SESSION time_zone='+07:00';\n"));
    assert.ok(sql.includes("SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_AUTO_VALUE_ON_ZERO';\n"));
    assert.ok(sql.includes('SET FOREIGN_KEY_CHECKS=0;\n' + tableDDL + ';\nINSERT INTO '));
    assert.doesNotMatch(sql, /^(?:USE|CREATE DATABASE|DROP|TRUNCATE|DELETE|UPDATE)\b/m);
    assert.ok(sql.includes("'18446744073709551615'"));
    assert.ok(sql.includes("'12345678901234567890.1234567890'"));
    assert.ok(sql.includes("'2026-11-05 14:03:02.123456'"));
    assert.ok(sql.includes("Tiếng Việt 🐾\\nO\\'Brien\\\\path\\0"));
    assert.ok(sql.includes(',NULL,'));
    assert.equal(manifest.database, 'actual_petcare');
    assert.equal(manifest.database_schema, databaseDDL);
    assert.equal(manifest.database_schema_sha256, hash(databaseDDL));
    assert.deepEqual(manifest.session, { time_zone: '+07:00', sql_mode: 'STRICT_TRANS_TABLES,NO_AUTO_VALUE_ON_ZERO' });
    assert.equal(manifest.sql_sha256, hash(sql));
    assert.equal(manifest.tables.orders.schema_sha256, hash(tableDDL));
    assert.equal(manifest.tables.orders.rows, 2);
    assert.deepEqual(manifest.tables.orders.columns, columns.map(column => column.Field));
    const canonicalRows = rows.map(row => Object.fromEntries(Object.keys(row).sort().map(name => [name, row[name]])))
        .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
    assert.equal(manifest.tables.orders.sha256, hash(JSON.stringify(canonicalRows)));
    const select = db.calls.find(query => typeof query === 'object');
    assert.equal(select.supportBigNumbers, true);
    assert.equal(select.bigNumberStrings, true);
    assert.equal(select.dateStrings, true);
    for (const type of ['DATE', 'DATETIME', 'TIMESTAMP', 'NEWDATE', 'TIME', 'LONGLONG', 'DECIMAL', 'NEWDECIMAL']) {
        assert.equal(select.typeCast({ type, string: () => 'exact text' }, () => assert.fail('Lossy parser called')), 'exact text');
    }
    assert.equal(select.typeCast({ type: 'LONG' }, () => 42), 42);
    assert.equal(require.cache[require.resolve('../config/db')], undefined, 'Real DB config must never be loaded');
});

test('canonical row hashes and INSERT ordering ignore source row/property order', async () => {
    const first = await backup(mockDatabase(), ['orders'], 'deterministic-a', { root });
    const second = await backup(mockDatabase({ rows: rows.slice().reverse() }), ['orders'], 'deterministic-b', { root });
    assert.equal(await fs.readFile(path.join(first, 'database.sql'), 'utf8'),
        await fs.readFile(path.join(second, 'database.sql'), 'utf8'));
    const a = JSON.parse(await fs.readFile(path.join(first, 'manifest.json'), 'utf8'));
    const b = JSON.parse(await fs.readFile(path.join(second, 'manifest.json'), 'utf8'));
    assert.equal(a.tables.orders.sha256, b.tables.orders.sha256);
});

test('explicit backup root takes precedence over environment; environment works without options', async () => {
    const previous = process.env.PETCARE_BACKUP_ROOT;
    const environmentRoot = path.join(root, 'environment-root');
    process.env.PETCARE_BACKUP_ROOT = environmentRoot;
    try {
        const environmentBackup = await backup(mockDatabase(), ['orders'], 'environment');
        assert.equal(path.dirname(environmentBackup), environmentRoot);
        const explicitBackup = await backup(mockDatabase(), ['orders'], 'explicit', { root });
        assert.equal(path.dirname(explicitBackup), root);
    } finally {
        if (previous === undefined) delete process.env.PETCARE_BACKUP_ROOT;
        else process.env.PETCARE_BACKUP_ROOT = previous;
    }
});

test('fails before writing files for generated, invisible, JSON or geometry columns', async () => {
    const before = await fs.readdir(root);
    for (const column of [
        { Field: 'value', Type: 'int', Extra: 'VIRTUAL GENERATED' },
        { Field: 'value', Type: 'int', Extra: 'STORED GENERATED' },
        { Field: 'value', Type: 'int', Extra: 'INVISIBLE' },
        { Field: 'value', Type: 'json', Extra: '' },
        { Field: 'value', Type: 'geometry', Extra: '' },
        { Field: 'value', Type: 'point', Extra: '' },
    ]) {
        await assert.rejects(backup(mockDatabase({ columns: [column] }), ['orders'], 'unsupported', { root }),
            /Unsupported generated, invisible or column type/);
    }
    assert.deepEqual(await fs.readdir(root), before);
});

test('fails before writing files for unsafe SQL escaping, missing DB, imprecise values or incomplete rows', async () => {
    const before = await fs.readdir(root);
    await assert.rejects(backup(mockDatabase({ session: { sql_mode: 'NO_BACKSLASH_ESCAPES' } }),
        ['orders'], 'escaping', { root }), /standard SQL string escaping/);
    await assert.rejects(backup(mockDatabase({ session: { name: null } }), ['orders'], 'missing-db', { root }),
        /selected database/);
    for (const value of [Number.MAX_SAFE_INTEGER + 1, new Date(), {}, undefined]) {
        await assert.rejects(backup(mockDatabase({ rows: [{ ...rows[0], request_id: value }] }),
            ['orders'], 'unsafe-value', { root }), /Unsupported or imprecise backup value/);
    }
    await assert.rejects(backup(mockDatabase({ rows: [{ order_id: 1 }] }), ['orders'], 'incomplete', { root }),
        /does not match table columns/);
    assert.deepEqual(await fs.readdir(root), before);
});

test('detects SQL or manifest readback corruption', async () => {
    const originalRead = fs.readFile;
    try {
        fs.readFile = async function (filename, ...args) {
            if (path.basename(filename) === 'database.sql') return Buffer.from('corrupt fixture readback');
            return originalRead.call(this, filename, ...args);
        };
        await assert.rejects(backup(mockDatabase(), ['orders'], 'corrupt-sql', { root }), /Backup verification failed/);
        fs.readFile = async function (filename, ...args) {
            if (path.basename(filename) === 'manifest.json') return 'corrupt fixture readback';
            return originalRead.call(this, filename, ...args);
        };
        await assert.rejects(backup(mockDatabase(), ['orders'], 'corrupt-manifest', { root }),
            /Backup manifest verification failed/);
    } finally { fs.readFile = originalRead; }
});
