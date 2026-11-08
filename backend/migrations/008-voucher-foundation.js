'use strict';

// Foundation only: no seed vouchers, API, cart calculation or redemption writer.
const schema = require('./lib/stage1-schema');
const { column, ascii, idx, fk } = schema;
const financial = require('./007-payment-attempts-refunds').plan;
const utc = nullable => column('datetime(3)', { nullable: Boolean(nullable) });
const amount = nullable => column('decimal(12,2)', { nullable: Boolean(nullable) });
const plan = {
    version: '008', name: 'voucher-foundation', sourceFile: __filename,
    dependencies: [financial], baseline: financial.baseline,
    objects: [
        { table: 'vouchers', kind: 'create', columns: {
            voucher_id: column('bigint unsigned', { autoIncrement: true }), code: ascii('varchar(64)'), discount_type: ascii('varchar(16)'),
            discount_value: amount(), max_discount_amount: amount(true), minimum_order_amount: amount(),
            starts_at_utc: utc(), ends_at_utc: utc(), total_limit: column('int unsigned', { nullable: true }),
            per_user_limit: column('int unsigned', { nullable: true }), status: ascii('varchar(16)'), created_at_utc: utc(), updated_at_utc: utc()
        }, indexes: [idx('PRIMARY', ['voucher_id'], true), idx('uq_voucher_code', ['code'], true)], foreignKeys: [], checks: [
            { name: 'chk_voucher_code', expression: "REGEXP_LIKE(code, '^[A-Z0-9][A-Z0-9_-]{0,63}$', 'c')" },
            { name: 'chk_voucher_discount', expression: "(discount_type = 'fixed' AND discount_value > 0) OR (discount_type = 'percent' AND discount_value > 0 AND discount_value <= 100)" },
            { name: 'chk_voucher_maximum', expression: 'max_discount_amount IS NULL OR max_discount_amount > 0' },
            { name: 'chk_voucher_minimum', expression: 'minimum_order_amount >= 0' },
            { name: 'chk_voucher_dates', expression: 'ends_at_utc > starts_at_utc' },
            { name: 'chk_voucher_limits', expression: '(total_limit IS NULL OR total_limit > 0) AND (per_user_limit IS NULL OR per_user_limit > 0)' },
            { name: 'chk_voucher_status', expression: "status IN ('draft','active','disabled')" }
        ] },
        { table: 'voucher_redemptions', kind: 'create', columns: {
            redemption_id: column('bigint unsigned', { autoIncrement: true }), voucher_id: column('bigint unsigned'), order_id: column('int'), user_id: column('int'),
            status: ascii('varchar(16)'), discount_amount: amount(), reserved_at_utc: utc(), consumed_at_utc: utc(true), released_at_utc: utc(true)
        }, indexes: [idx('PRIMARY', ['redemption_id'], true), idx('uq_redemption_order', ['order_id'], true),
            idx('idx_redemption_quota', ['voucher_id', 'status']), idx('idx_redemption_customer', ['voucher_id', 'user_id', 'status']), idx('idx_redemption_user', ['user_id'])],
        foreignKeys: [fk('fk_redemption_voucher', ['voucher_id'], 'vouchers', ['voucher_id']), fk('fk_redemption_order', ['order_id'], 'orders', ['order_id']), fk('fk_redemption_user', ['user_id'], 'user', ['user_id'])], checks: [
            { name: 'chk_redemption_amount', expression: 'discount_amount >= 0' },
            { name: 'chk_redemption_status', expression: "status IN ('reserved','consumed','released')" },
            { name: 'chk_redemption_timestamps', expression: "(status = 'reserved' AND consumed_at_utc IS NULL AND released_at_utc IS NULL) OR (status = 'consumed' AND consumed_at_utc IS NOT NULL AND released_at_utc IS NULL) OR (status = 'released' AND released_at_utc IS NOT NULL)" }
        ] },
        { table: 'orders', kind: 'extend', columns: {
            subtotal_amount: amount(true), discount_amount: amount(true), voucher_code_snapshot: ascii('varchar(64)', true)
        }, indexes: [] }
    ]
};

const migrate = (pool, options) => schema.migrate(pool, plan, options);
const verify = db => schema.verify(db, plan);
module.exports = { migrate, verify, plan };
if (require.main === module) schema.cli(plan);
