const { verifyHmac, parseJson, extractEvent } = require('../sepay-test/protocol.cjs');
const { createHash } = require('node:crypto');
const config = require('../config/sepay');
const verifiedPayments = new WeakSet();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// SePay evidence is separate from simulator evidence. Only this verifier can
// mint the capability accepted by the shared settlement service.
function verify(raw, headers, config, now) {
    verifyHmac(raw, headers, config.secret, now);
    const payload = parseJson(raw), event = extractEvent(payload);
    let disposition = null;
    if (event.transferType !== 'in') disposition = 'outgoing';
    else if (payload.gateway.toLowerCase() !== 'vietinbank' || payload.accountNumber !== config.accountNumber ||
        (payload.subAccount != null && payload.subAccount !== '')) disposition = 'wrong_account';
    else if (event.outcome !== 'recorded' || !/^[1-9][0-9]{0,9}$/.test(event.orderId || '') ||
        Number(event.orderId) > 2147483647) disposition = 'invalid_code';
    else if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(event.referenceCode)) disposition = 'invalid_reference';
    const date = payload.transactionDate;
    const paidAt = typeof date === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)
        ? Date.parse(date.replace(' ', 'T') + '+07:00') : NaN;
    const roundTrip = Number.isFinite(paidAt) ? new Date(paidAt + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : null;
    if (!disposition && roundTrip !== date) disposition = 'review_required';
    if (!disposition && event.transferAmount > 9999999999) disposition = 'review_required';
    return Object.freeze({ ...event, orderId: Number(event.orderId), paidAt, disposition, accountNumber: config.accountNumber });
}
function issuePaymentEvent(raw, headers, env = process.env, now = Date.now()) {
    const settings = config.settings(env);
    const event = verify(raw, headers, settings, now);
    if (event.disposition) throw Object.assign(new Error('SePay event is not eligible for ingestion'), { status: 400 });
    const evidence = Object.freeze({
        provider: 'SEPAY', providerEnvironment: settings.providerEnvironment, verificationSource: 'sepay_hmac_sha256',
        database: settings.database, accountBinding: digest(['VietinBank', settings.accountNumber]),
        orderId: event.orderId, merchantReference: `PCS${event.orderId}`,
        eventId: digest(['SEPAY', settings.providerEnvironment, settings.accountNumber, event.transactionId]),
        providerTransactionId: digest(['SEPAY', settings.providerEnvironment, 'VietinBank', settings.accountNumber, event.referenceCode]),
        amount: `${BigInt(event.transferAmount)}.00`, currency: 'VND', status: 'succeeded',
        paidAtUtc: new Date(event.paidAt).toISOString(),
    });
    verifiedPayments.add(evidence);
    return evidence;
}
function assertVerifiedPayment(evidence, env = process.env) {
    const settings = config.settings(env);
    if (!evidence || !verifiedPayments.has(evidence) || evidence.database !== settings.database ||
        evidence.providerEnvironment !== settings.providerEnvironment ||
        evidence.accountBinding !== digest(['VietinBank', settings.accountNumber])) {
        throw Object.assign(new Error('SePay payment requires verified HMAC evidence'), { status: 400, code: 'UNVERIFIED_PROVIDER_EVENT' });
    }
    return evidence;
}
module.exports = { verify, issuePaymentEvent, assertVerifiedPayment };
