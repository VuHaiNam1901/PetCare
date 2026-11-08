'use strict';

// No config/db import, socket, SQL server, historical migration or real row.
const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../migrations/lib/stage1-schema');
const lifecycle = require('../migrations/006-order-payment-lifecycle');
const financial = require('../migrations/007-payment-attempts-refunds');
const voucher = require('../migrations/008-voucher-foundation');

function representation(spec) {
    return {
        table_type: 'BASE TABLE', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', schema_name: 'application_read_only',
        columns: Object.entries(spec.columns).map(([name, definition]) => ({ name, type: definition.type,
            nullable: definition.nullable ? 'YES' : 'NO', default_value: definition.defaultExpression || definition.defaultValue,
            collation: definition.collation, extra: definition.autoIncrement ? 'auto_increment' : definition.defaultExpression ? 'DEFAULT_GENERATED' : '' })),
        indexes: (spec.indexes || []).flatMap(index => index.columns.map((Column_name, i) => ({ Key_name: index.name, Column_name,
            Seq_in_index: i + 1, Non_unique: index.unique ? 0 : 1, Sub_part: null, Index_type: 'BTREE', Visible: 'YES', Expression: null }))),
        foreignKeys: (spec.foreignKeys || []).flatMap(ref => ref.columns.map((column_name, i) => ({ name: ref.name, column_name,
            position: i + 1, referenced_schema: 'application_read_only', referenced_table: ref.table, referenced_column: ref.referencedColumns[i], delete_rule: ref.onDelete, update_rule: ref.onUpdate }))),
        checks: (spec.checks || []).map(check => ({ ...check, enforced: 'YES' }))
    };
}

function harness(entries) {
    const tables = new Map(entries);
    const calls = [];
    const db = {
        async execute(sql, values) {
            calls.push(sql);
            const table = tables.get(values?.[0]);
            if (sql.includes('FROM information_schema.TABLES')) return [[...(table ? [{ table_type: table.table_type, engine: table.engine, collation: table.collation, schema_name: table.schema_name }] : [])]];
            if (sql.includes('FROM information_schema.COLUMNS')) return [table?.columns || []];
            if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) return [table?.foreignKeys || []];
            if (sql.includes('FROM information_schema.TABLE_CONSTRAINTS')) return [table?.checks || []];
            throw new Error(`Unexpected mock SQL: ${sql}`);
        },
        async query(sql) {
            calls.push(sql);
            if (sql.startsWith('SHOW INDEX FROM ')) return [tables.get(sql.slice(16).replace(/`/g, ''))?.indexes || []];
            if (sql.startsWith('SELECT DATABASE()')) return [[{ database_name: 'application_read_only', server_version: '8.0.46', sql_mode: 'STRICT_TRANS_TABLES' }]];
            if (sql.includes('SELECT TABLE_NAME AS name,TABLE_TYPE')) return [[...tables].map(([name, table]) => ({ name, type: table.table_type, engine: table.engine }))];
            if (sql.includes('triggers_count')) return [[{ triggers_count: 0, routines_count: 0, events_count: 0 }]];
            throw new Error(`Unexpected mock SQL: ${sql}`);
        },
        release() { calls.push('release'); }
    };
    return { tables, db, calls, pool: { async getConnection() { return db; } } };
}

test('new migration modules have no database side effects and stable checksums', () => {
    assert.deepEqual([lifecycle.plan.version, financial.plan.version, voucher.plan.version], ['006', '007', '008']);
    for (const migration of [lifecycle, financial, voucher]) {
        assert.match(schema.checksum(migration.plan), /^[a-f0-9]{64}$/);
        assert.equal(schema.checksum(migration.plan), schema.checksum(migration.plan));
    }
});

test('migration 006 default dry-run plans only nullable additions and does not write', async () => {
    const value = harness(lifecycle.plan.baseline.map(spec => [spec.table, representation(spec)]));
    const result = await lifecycle.migrate(value.pool);
    assert.equal(result.dryRun, true);
    assert.equal(result.pendingSteps.length, 8);
    assert.ok(result.pendingSteps.every(step => step.sql.startsWith('ALTER TABLE')));
    assert.equal(value.calls.some(sql => /^(?:INSERT|UPDATE|ALTER|CREATE|DELETE|DROP|TRUNCATE|LOCK)\b/.test(sql)), false);
    assert.equal(value.calls.at(-1), 'release');
});

test('apply to an unconfirmed application target stops before locks or writes', async () => {
    const value = harness(lifecycle.plan.baseline.map(spec => [spec.table, representation(spec)]));
    await assert.rejects(lifecycle.migrate(value.pool, { apply: true, expectedDatabase: 'different_schema' }), /expectedDatabase/);
    assert.equal(value.calls.some(sql => /GET_LOCK|^(?:INSERT|UPDATE|ALTER|CREATE|DELETE|DROP)\b/.test(sql)), false);
});

test('test target naming alone cannot bypass the isolated environment guard', () => {
    assert.throws(() => schema.assertApplyTarget('petcare_test_' + 'a'.repeat(32), {
        isolatedTest: true, expectedDatabase: 'petcare_test_' + 'a'.repeat(32)
    }), /guarded generated test schema/);
    assert.throws(() => schema.assertApplyTarget('petcare_db', { expectedDatabase: 'petcare_db', isolatedTest: true }), /guarded generated test schema/);
});

test('each finance and voucher table definition verifies without guessing missing parts', async () => {
    for (const spec of [...financial.plan.objects, ...voucher.plan.objects].filter(object => object.kind === 'create')) {
        const value = harness([[spec.table, representation(spec)]]);
        assert.deepEqual(await schema.inspectObject(value.db, spec), []);
        value.tables.get(spec.table).columns.pop();
        await assert.rejects(schema.inspectObject(value.db, spec), /Partial or incompatible table/);
    }
});

for (const mutation of [
    table => { table.columns[1].type = 'bigint'; },
    table => { table.columns[1].nullable = 'YES'; },
    table => { table.columns[1].default_value = '1'; },
    table => { table.columns[2].collation = 'utf8mb4_unicode_ci'; },
    table => { table.columns[0].extra = ''; },
    table => { table.indexes[0].Non_unique = 1; },
    table => { table.indexes[0].Sub_part = 8; },
    table => { table.foreignKeys[0].delete_rule = 'CASCADE'; },
    table => { table.checks[0].enforced = 'NO'; }
]) {
    test(`schema drift is rejected: ${mutation.toString()}`, async () => {
        const spec = financial.plan.objects[0];
        const saved = representation(spec);
        mutation(saved);
        const value = harness([[spec.table, saved]]);
        await assert.rejects(schema.inspectObject(value.db, spec), /Schema drift/);
    });
}

test('an interrupted nullable-column extension resumes only missing additive objects', async () => {
    const spec = lifecycle.plan.objects[0];
    const saved = representation({ ...spec, columns: { workflow_version: spec.columns.workflow_version }, indexes: [] });
    const value = harness([[spec.table, saved]]);
    const pending = await schema.inspectObject(value.db, spec);
    assert.equal(pending.length, 5);
    assert.equal(pending.some(step => step.key === 'column:orders.workflow_version'), false);
    assert.equal(pending.filter(step => step.kind === 'column').length, 4);
});

test('all historical order additions default to NULL, never a fabricated deadline or discount', () => {
    const extensions = [...lifecycle.plan.objects, ...voucher.plan.objects].filter(spec => spec.kind === 'extend');
    for (const object of extensions) for (const definition of Object.values(object.columns)) {
        assert.equal(definition.nullable, true);
        assert.equal(definition.defaultValue, null);
        assert.equal(definition.defaultExpression, null);
        assert.match(definition.sql, /NULL DEFAULT NULL$/);
    }
});

test('CHECK canonicalization accepts server formatting while preserving literal case and Boolean grouping', () => {
    assert.equal(schema.canonicalCheck("status IN ('late_capture','applied')"), schema.canonicalCheck("(`status` in (_ascii'late_capture',_ascii'applied'))"));
    assert.notEqual(schema.canonicalCheck("status IN ('late_capture')"), schema.canonicalCheck("status IN ('late')"));
    assert.notEqual(schema.canonicalCheck("status IN ('applied')"), schema.canonicalCheck("status IN ('APPLIED')"));
    assert.notEqual(schema.canonicalCheck('(a = 1 OR b = 2) AND c = 3'), schema.canonicalCheck('a = 1 OR (b = 2 AND c = 3)'));
    assert.equal(schema.canonicalCheck("REGEXP_LIKE(code, '^[A-Z0-9][A-Z0-9_-]{0,63}$', 'c')"),
        schema.canonicalCheck("regexp_like(`code`,_ascii'^[A-Z0-9][A-Z0-9_-]{0,63}$',_ascii'c')"));
});

test('CHECK canonicalization handles MySQL metadata-escaped literal delimiters locally', () => {
    const metadata = "(`status` in (_utf8mb4\\'initiated\\',_utf8mb4\\'captured_unapplied\\'))";
    assert.equal(schema.canonicalCheck(metadata), schema.canonicalCheck("status IN ('initiated','captured_unapplied')"));
    assert.notEqual(schema.canonicalCheck(metadata), schema.canonicalCheck("status IN ('initiated','captured')"));
    assert.notEqual(schema.canonicalCheck(metadata), schema.canonicalCheck("status IN ('INITIATED','captured_unapplied')"));
    assert.equal(schema.canonicalCheck("name = _utf8mb4\\'O\\'\\'Brien\\'"), schema.canonicalCheck("name = 'O''Brien'"));
    assert.equal(schema.canonicalCheck("name = 'a\\\\b'"), JSON.stringify(['=', ['identifier', 'name'], ['string', 'a\\b', null]]));
});
