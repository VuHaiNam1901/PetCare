'use strict';

const schema = require('./lib/stage1-schema');
const { column, ascii, unicode, idx, fk } = schema;

// Baseline is inspected, never recreated/backfilled by these migrations. Signed
// INT references match the database reviewed before Stage 1 implementation.
const baseline = [
    { table: 'orders', kind: 'baseline', columns: {
        order_id: column('int', { autoIncrement: true }), user_id: column('int'),
        order_date: column('datetime'), total_amount: column('decimal(12,2)'),
        approved_at: column('datetime', { nullable: true }), stock_reserved_at: column('datetime', { nullable: true }),
        stock_restored_at: column('datetime', { nullable: true }), stock_reservation_source: ascii('varchar(32)', true),
        rejection_reason: unicode('varchar(500)', true),
        recipient_name: unicode('varchar(100)', true), shipping_address: unicode('varchar(255)'), note: unicode('varchar(500)', true),
        phone: column('varchar(20)', { collation: 'utf8mb3_general_ci' }), status: column('varchar(30)', { collation: 'utf8mb3_general_ci' }),
        idempotency_key_hash: ascii('char(64)', true), request_fingerprint: ascii('char(64)', true)
    }, indexes: [idx('PRIMARY', ['order_id'], true), idx('uq_orders_user_idempotency', ['user_id', 'idempotency_key_hash'], true)],
    foreignKeys: [fk('fk_orders_User1', ['user_id'], 'user', ['user_id'])] },
    { table: 'payments', kind: 'baseline', columns: {
        payment_id: column('int', { autoIncrement: true }), order_id: column('int'),
        amount: column('decimal(12,2)'), transaction_date: column('datetime', { nullable: true }), created_at: column('datetime'),
        payment_method: column('varchar(20)', { collation: 'utf8mb3_general_ci' }), payment_status: column('varchar(30)', { collation: 'utf8mb3_general_ci' })
    }, indexes: [idx('PRIMARY', ['payment_id'], true), idx('order_id_UNIQUE', ['order_id'], true)], foreignKeys: [fk('fk_payments_orders1', ['order_id'], 'orders', ['order_id'])] },
    { table: 'order_details', kind: 'baseline', columns: {
        order_detail_id: column('int', { autoIncrement: true }), order_id: column('int'), product_id: column('int'),
        quantity: column('int'), unit_price: column('decimal(12,2)'), subtotal: column('decimal(12,2)')
    }, indexes: [idx('PRIMARY', ['order_detail_id'], true)],
    foreignKeys: [fk('fk_order_details_orders1', ['order_id'], 'orders', ['order_id']),
        fk('fk_order_details_products1', ['product_id'], 'products', ['product_id'])] },
    { table: 'products', kind: 'baseline', columns: {
        product_id: column('int', { autoIncrement: true }), stock_quantity: column('int')
    }, indexes: [idx('PRIMARY', ['product_id'], true)] },
    { table: 'user', kind: 'baseline', columns: { user_id: column('int', { autoIncrement: true }) }, indexes: [idx('PRIMARY', ['user_id'], true)] },
    { table: 'order_status_history', kind: 'baseline', columns: {
        history_id: column('bigint unsigned', { autoIncrement: true }), order_id: column('int'),
        from_status: unicode('varchar(30)', true), to_status: unicode('varchar(30)'),
        action: ascii('varchar(32)'), actor_id: column('int', { nullable: true }),
        actor_name: unicode('varchar(100)', true), reason: unicode('varchar(500)', true),
        created_at: column('datetime(3)', { defaultExpression: 'CURRENT_TIMESTAMP(3)' })
    }, indexes: [idx('PRIMARY', ['history_id'], true), idx('idx_order_history', ['order_id', 'history_id'])],
    foreignKeys: [fk('fk_order_history_order', ['order_id'], 'orders', ['order_id'], 'CASCADE')] }
];

const plan = {
    version: '006', name: 'order-payment-lifecycle', sourceFile: __filename, baseline,
    objects: [
        { table: 'orders', kind: 'extend', columns: {
            workflow_version: column('smallint unsigned', { nullable: true }),
            created_at_utc: column('datetime(3)', { nullable: true }),
            payment_expires_at: column('datetime(3)', { nullable: true }),
            cancelled_at: column('datetime(3)', { nullable: true }),
            cancellation_reason_code: ascii('varchar(32)', true)
        }, indexes: [idx('idx_orders_payment_expiry', ['workflow_version', 'status', 'payment_expires_at', 'order_id'])] },
        { table: 'order_status_history', kind: 'extend', columns: { event_key: ascii('varchar(128)', true) },
            indexes: [idx('uq_order_history_event', ['order_id', 'event_key'], true)] }
    ]
};

const migrate = (pool, options) => schema.migrate(pool, plan, options);
const verify = db => schema.verify(db, plan);
module.exports = { migrate, verify, plan };
if (require.main === module) schema.cli(plan);
