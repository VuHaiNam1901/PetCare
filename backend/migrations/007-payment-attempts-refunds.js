'use strict';

const schema = require('./lib/stage1-schema');
const { column, ascii, idx, fk } = schema;
const lifecycle = require('./006-order-payment-lifecycle').plan;
const utc = nullable => column('datetime(3)', { nullable: Boolean(nullable) });
const amount = nullable => column('decimal(12,2)', { nullable: Boolean(nullable) });
const id = () => column('bigint unsigned', { autoIncrement: true });

const plan = {
    version: '007', name: 'payment-attempts-refunds', sourceFile: __filename,
    dependencies: [lifecycle], baseline: lifecycle.baseline,
    objects: [
        { table: 'payment_attempts', kind: 'create', columns: {
            attempt_id: id(), payment_id: column('int'), provider: ascii('varchar(24)'), provider_environment: ascii('varchar(16)'),
            merchant_reference: ascii('varchar(64)'), idempotency_key_hash: ascii('char(64)'), fingerprint: ascii('char(64)'),
            amount: amount(), currency: ascii('char(3)'), status: ascii('varchar(24)'), disposition: ascii('varchar(24)', true),
            provider_transaction_id: ascii('varchar(64)', true), captured_amount: amount(true), captured_currency: ascii('char(3)', true),
            initiated_at_utc: utc(), provider_paid_at_utc: utc(true), received_at_utc: utc(true), confirmed_at_utc: utc(true)
        }, indexes: [idx('PRIMARY', ['attempt_id'], true),
            idx('uq_payment_attempt_key', ['payment_id', 'idempotency_key_hash'], true),
            idx('uq_payment_merchant_ref', ['provider', 'provider_environment', 'merchant_reference'], true),
            idx('uq_payment_provider_txn', ['provider', 'provider_environment', 'provider_transaction_id'], true)],
        foreignKeys: [fk('fk_attempt_payment', ['payment_id'], 'payments', ['payment_id'])], checks: [
            { name: 'chk_attempt_amount', expression: 'amount > 0' },
            { name: 'chk_attempt_capture', expression: '(captured_amount IS NULL AND captured_currency IS NULL) OR (captured_amount > 0 AND captured_currency IS NOT NULL)' },
            { name: 'chk_attempt_status', expression: "status IN ('initiated','pending','succeeded','failed','unknown','captured_unapplied')" },
            { name: 'chk_attempt_environment', expression: "provider_environment IN ('test','sandbox','production')" },
            { name: 'chk_attempt_disposition', expression: "disposition IS NULL OR disposition IN ('applied','manual_review','unknown','failed','amount_mismatch','excess_capture','cancelled_order','late_capture')" }
        ] },
        { table: 'payment_events', kind: 'create', columns: {
            event_id: id(), attempt_id: column('bigint unsigned'), event_key: ascii('char(64)'), event_type: ascii('varchar(32)'),
            payload_hash: ascii('char(64)'), provider_transaction_id: ascii('varchar(64)', true), amount: amount(true), currency: ascii('char(3)', true),
            provider_paid_at_utc: utc(true), received_at_utc: utc(), verification_source: ascii('varchar(32)'), disposition: ascii('varchar(24)', true)
        }, indexes: [idx('PRIMARY', ['event_id'], true), idx('uq_payment_event_key', ['event_key'], true), idx('idx_payment_event_attempt', ['attempt_id', 'event_id'])],
        foreignKeys: [fk('fk_payment_event_attempt', ['attempt_id'], 'payment_attempts', ['attempt_id'])], checks: [
            { name: 'chk_payment_event_amount', expression: 'amount IS NULL OR amount > 0' },
            { name: 'chk_payment_event_type', expression: "event_type IN ('succeeded','failed','unknown')" },
            { name: 'chk_payment_event_disposition', expression: "disposition IS NULL OR disposition IN ('applied','manual_review','unknown','failed','amount_mismatch','excess_capture','cancelled_order','late_capture')" }
        ] },
        { table: 'refund_requests', kind: 'create', columns: {
            refund_id: id(), attempt_id: column('bigint unsigned'), payment_event_id: column('bigint unsigned', { nullable: true }), business_key: ascii('varchar(128)'), amount: amount(), currency: ascii('char(3)'),
            provider: ascii('varchar(24)'), provider_environment: ascii('varchar(16)'), reason_code: ascii('varchar(32)'), status: ascii('varchar(24)'), requested_at_utc: utc(), updated_at_utc: utc(),
            provider_refund_id: ascii('varchar(64)', true), confirmed_at_utc: utc(true)
        }, indexes: [idx('PRIMARY', ['refund_id'], true), idx('uq_refund_business_key', ['business_key'], true),
            idx('uq_refund_provider_reference', ['provider', 'provider_environment', 'provider_refund_id'], true), idx('idx_refund_attempt', ['attempt_id', 'refund_id']),
            idx('idx_refund_payment_event', ['payment_event_id']), idx('idx_refund_status', ['status', 'updated_at_utc'])],
        foreignKeys: [fk('fk_refund_attempt', ['attempt_id'], 'payment_attempts', ['attempt_id']), fk('fk_refund_payment_event', ['payment_event_id'], 'payment_events', ['event_id'])], checks: [
            { name: 'chk_refund_amount', expression: 'amount > 0' },
            { name: 'chk_refund_environment', expression: "provider_environment IN ('test','sandbox','production')" },
            { name: 'chk_refund_status', expression: "status IN ('requested','submitted','processing','succeeded','failed','unknown','manual_review')" },
            { name: 'chk_refund_confirmation', expression: "status <> 'succeeded' OR (confirmed_at_utc IS NOT NULL AND provider_refund_id IS NOT NULL)" }
        ] },
        { table: 'refund_events', kind: 'create', columns: {
            refund_event_id: id(), refund_id: column('bigint unsigned'), event_key: ascii('char(64)'), payload_hash: ascii('char(64)'), status: ascii('varchar(24)'),
            verification_source: ascii('varchar(32)', true), provider_refund_id: ascii('varchar(64)', true), created_at_utc: utc()
        }, indexes: [idx('PRIMARY', ['refund_event_id'], true), idx('uq_refund_event_key', ['event_key'], true), idx('idx_refund_event_request', ['refund_id', 'refund_event_id'])],
        foreignKeys: [fk('fk_refund_event_request', ['refund_id'], 'refund_requests', ['refund_id'])], checks: [
            { name: 'chk_refund_event_status', expression: "status IN ('requested','submitted','processing','succeeded','failed','unknown','manual_review')" },
            { name: 'chk_refund_event_confirmation', expression: "status <> 'succeeded' OR (verification_source IS NOT NULL AND provider_refund_id IS NOT NULL)" }
        ] }
    ]
};

const migrate = (pool, options) => schema.migrate(pool, plan, options);
const verify = db => schema.verify(db, plan);
module.exports = { migrate, verify, plan };
if (require.main === module) schema.cli(plan);
