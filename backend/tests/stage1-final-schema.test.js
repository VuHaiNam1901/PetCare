'use strict';

// Final-review regressions use metadata mocks only. No MySQL connection or
// application configuration is loaded by this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../migrations/lib/stage1-schema');
const lifecycle = require('../migrations/006-order-payment-lifecycle');
const financial = require('../migrations/007-payment-attempts-refunds');

const targetSchema = 'isolated_review_target';

function representation(spec) {
    return {
        table_type: 'BASE TABLE', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', schema_name: targetSchema,
        columns: Object.entries(spec.columns).map(([name, definition]) => ({ name, type: definition.type,
            nullable: definition.nullable ? 'YES' : 'NO', default_value: definition.defaultExpression || definition.defaultValue,
            collation: definition.collation, extra: definition.autoIncrement ? 'auto_increment' : definition.defaultExpression ? 'DEFAULT_GENERATED' : '' })),
        indexes: (spec.indexes || []).flatMap(index => index.columns.map((Column_name, i) => ({ Key_name: index.name, Column_name,
            Seq_in_index: i + 1, Non_unique: index.unique ? 0 : 1, Sub_part: null, Index_type: 'BTREE', Visible: 'YES', Expression: null }))),
        foreignKeys: (spec.foreignKeys || []).flatMap(ref => ref.columns.map((column_name, i) => ({ name: ref.name, column_name,
            position: i + 1, referenced_schema: targetSchema, referenced_table: ref.table, referenced_column: ref.referencedColumns[i],
            delete_rule: ref.onDelete, update_rule: ref.onUpdate }))),
        checks: (spec.checks || []).map(check => ({ ...check, enforced: 'YES' }))
    };
}

function metadataDb(table) {
    return {
        async execute(sql) {
            if (sql.includes('FROM information_schema.TABLES')) return [[{
                table_type: table.table_type, engine: table.engine, collation: table.collation, schema_name: table.schema_name
            }]];
            if (sql.includes('FROM information_schema.COLUMNS')) return [table.columns];
            if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) return [table.foreignKeys];
            if (sql.includes('FROM information_schema.TABLE_CONSTRAINTS')) return [table.checks];
            throw new Error(`Unexpected metadata query: ${sql}`);
        },
        async query(sql) {
            if (sql.startsWith('SHOW INDEX FROM ')) return [table.indexes];
            throw new Error(`Unexpected metadata query: ${sql}`);
        }
    };
}

test('same-schema finance foreign keys verify, but same-named tables in another schema do not', async () => {
    const spec = financial.plan.objects.find(object => object.table === 'payment_attempts');
    const table = representation(spec);
    assert.deepEqual(await schema.inspectObject(metadataDb(table), spec), []);
    table.foreignKeys[0].referenced_schema = 'different_database';
    await assert.rejects(schema.inspectObject(metadataDb(table), spec), /foreign key|schema drift/i);
});

test('missing referenced schema metadata cannot silently authorize a finance foreign key', async () => {
    const spec = financial.plan.objects.find(object => object.table === 'payment_attempts');
    const table = representation(spec);
    delete table.foreignKeys[0].referenced_schema;
    await assert.rejects(schema.inspectObject(metadataDb(table), spec), /foreign key|schema drift/i);
});

test('baseline verification requires the durable checkout idempotency unique index', async () => {
    const spec = lifecycle.plan.baseline.find(object => object.table === 'orders');
    const table = representation(spec);
    table.indexes = table.indexes.filter(index => index.Key_name !== 'uq_orders_user_idempotency');
    await assert.rejects(schema.inspectObject(metadataDb(table), spec, { required: true }), /index|schema drift/i);
});

for (const [tableName, constraintName] of [
    ['orders', 'fk_orders_User1'],
    ['order_details', 'fk_order_details_orders1'],
    ['order_details', 'fk_order_details_products1'],
]) {
    test(`baseline verification requires ${tableName}.${constraintName}`, async () => {
        const spec = lifecycle.plan.baseline.find(object => object.table === tableName);
        const table = representation(spec);
        table.foreignKeys = table.foreignKeys.filter(foreignKey => foreignKey.name !== constraintName);
        await assert.rejects(schema.inspectObject(metadataDb(table), spec, { required: true }), /foreign key|schema drift/i);
    });
}

test('all expected baseline key definitions accept matching same-schema metadata', async () => {
    for (const spec of lifecycle.plan.baseline) {
        assert.deepEqual(await schema.inspectObject(metadataDb(representation(spec)), spec, { required: true }), []);
    }
});
