// This is a test provider, not a payment gateway. Only evidence minted inside
// this module can reach the settlement service; an HTTP body cannot assert trust.
const { randomUUID } = require('node:crypto');
const { assertSimulationAllowed } = require('../config/order-workflow');
const paymentEvidence = new WeakSet();
const refundEvidence = new WeakSet();
const failure = message => { throw Object.assign(new Error(message), { status: 400, code: 'UNVERIFIED_PROVIDER_EVENT' }); };
function text(value, maximum, name) {
    if (typeof value !== 'string' || !value.length || value.length > maximum || /[^\x21-\x7e]/.test(value)) failure(`Invalid ${name}`);
    return value;
}
function amount(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value) || BigInt(value.replace('.', '')) <= 0n) failure('Invalid provider amount');
    return value;
}
function issuePaymentEvent(input) {
    assertSimulationAllowed();
    if (!input || !['succeeded', 'failed', 'unknown'].includes(input.status)) failure('An explicit provider outcome is required');
    if (input.paidAtUtc != null && (typeof input.paidAtUtc !== 'string' || input.paidAtUtc.length > 64)) failure('Invalid provider timestamp representation');
    const evidence = Object.freeze({
        provider: 'SIMULATOR', providerEnvironment: 'test', verificationSource: 'controlled_simulator',
        eventId: text(input.eventId || randomUUID(), 128, 'provider event ID'),
        merchantReference: text(input.merchantReference, 64, 'merchant reference'),
        providerTransactionId: text(input.providerTransactionId || randomUUID(), 64, 'provider transaction ID'),
        amount: amount(input.amount), currency: input.currency || 'VND',
        status: input.status, paidAtUtc: input.paidAtUtc ?? null
    });
    if (evidence.currency !== 'VND') failure('Unsupported simulator currency');
    paymentEvidence.add(evidence);
    return evidence;
}
function issueRefundEvent(input) {
    assertSimulationAllowed();
    if (!input || !['submitted', 'processing', 'succeeded', 'failed', 'unknown'].includes(input.status)) failure('Invalid refund outcome');
    const evidence = Object.freeze({
        provider: 'SIMULATOR', providerEnvironment: 'test', verificationSource: 'controlled_simulator',
        eventId: text(input.eventId || randomUUID(), 128, 'provider event ID'),
        refundId: String(input.refundId), status: input.status,
        providerRefundId: input.providerRefundId == null ? null : text(input.providerRefundId, 64, 'provider refund ID'),
        amount: amount(input.amount), currency: input.currency || 'VND'
    });
    if (!/^[1-9]\d*$/.test(evidence.refundId) || evidence.currency !== 'VND' || (evidence.status === 'succeeded' && !evidence.providerRefundId)) failure('Incomplete refund evidence');
    refundEvidence.add(evidence);
    return evidence;
}
function assertVerifiedPayment(evidence) {
    assertSimulationAllowed();
    if (!evidence || !paymentEvidence.has(evidence)) failure('Payment event has no trusted provider verification');
    return evidence;
}
function assertVerifiedRefund(evidence) {
    assertSimulationAllowed();
    if (!evidence || !refundEvidence.has(evidence)) failure('Refund event has no trusted provider verification');
    return evidence;
}
module.exports = { issuePaymentEvent, issueRefundEvent, assertVerifiedPayment, assertVerifiedRefund };
