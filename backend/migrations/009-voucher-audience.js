'use strict';

// Distribution is additive: existing Voucher tables and financial history stay intact.
const schema = require('./lib/stage1-schema');
const { column, ascii, idx, fk } = schema;
const foundation = require('./008-voucher-foundation').plan;
const plan = {
    version: '009', name: 'voucher-audience', sourceFile: __filename,
    dependencies: [foundation], baseline: foundation.baseline,
    objects: [
        { table: 'voucher_audiences', kind: 'create', columns: {
            voucher_id: column('bigint unsigned'), audience: ascii('varchar(16)'),
            created_at_utc: column('datetime(3)'), updated_at_utc: column('datetime(3)')
        }, indexes: [idx('PRIMARY', ['voucher_id'], true)],
        foreignKeys: [fk('fk_voucher_audience_voucher', ['voucher_id'], 'vouchers', ['voucher_id'])],
        checks: [{ name: 'chk_voucher_audience', expression: "audience IN ('all','selected')" }] },
        { table: 'voucher_assignments', kind: 'create', columns: {
            voucher_id: column('bigint unsigned'), user_id: column('int'), granted_by: column('int'),
            granted_at_utc: column('datetime(3)')
        }, indexes: [idx('PRIMARY', ['voucher_id', 'user_id'], true),
            idx('idx_voucher_assignment_user', ['user_id', 'voucher_id']), idx('idx_voucher_assignment_admin', ['granted_by'])],
        foreignKeys: [fk('fk_voucher_assignment_voucher', ['voucher_id'], 'vouchers', ['voucher_id']),
            fk('fk_voucher_assignment_customer', ['user_id'], 'user', ['user_id']),
            fk('fk_voucher_assignment_admin', ['granted_by'], 'user', ['user_id'])], checks: [] }
    ]
};

const migrate = (pool, options) => schema.migrate(pool, plan, options);
const verify = db => schema.verify(db, plan);
module.exports = { migrate, verify, plan };
if (require.main === module) schema.cli(plan);
