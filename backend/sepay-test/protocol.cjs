// Shared wire protocol; no database, routes or application dependencies.
const { createHmac, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const PAYMENT_CODE = /^PCS([0-9]{1,10})$/i;

function recognizePaymentCode(code, content) {
    const providerCode = typeof code === 'string' && PAYMENT_CODE.test(code) ? code.toUpperCase() : null;
    // Do not accept a truncated 11-digit suffix or a code embedded in another
    // alphanumeric token. SEVQR is the bank prefix, not our payment-code prefix.
    const contentCodes = new Set(Array.from(content.matchAll(/(?<![A-Z0-9])PCS[0-9]{1,10}(?![A-Z0-9])/gi), match => match[0].toUpperCase()));
    const candidates = new Set(contentCodes);
    if (providerCode) candidates.add(providerCode);
    if (candidates.size > 1) return { paymentCode: null, orderId: null, codeSource: 'ambiguous' };
    const paymentCode = candidates.values().next().value ?? null;
    const codeSource = !paymentCode ? 'none' : providerCode ? (contentCodes.size ? 'both' : 'code') : 'content';
    return { paymentCode, orderId: paymentCode?.slice(3) ?? null, codeSource };
}

function extractEvent(payload) {
    const fail = () => { throw Object.assign(new Error('Invalid SePay payload'), { status: 400 }); };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail();
    if (!Number.isSafeInteger(payload.id) || payload.id <= 0 ||
        !Number.isSafeInteger(payload.transferAmount) || payload.transferAmount <= 0 ||
        !['in', 'out'].includes(payload.transferType)) fail();
    for (const [field, maximum] of [['gateway', 64], ['content', 4096], ['referenceCode', 255]]) {
        if (typeof payload[field] !== 'string' || payload[field].length > maximum) fail();
    }
    if (!payload.gateway.length || (payload.code != null && (typeof payload.code !== 'string' || payload.code.length > 64))) fail();
    // Deliberately project only these fields. Account details, balances,
    // descriptions and any additional fields are never copied into a receipt.
    const event = {
        transactionId: String(payload.id), transferAmount: payload.transferAmount,
        transferType: payload.transferType, referenceCode: payload.referenceCode,
        ...recognizePaymentCode(payload.code, payload.content),
        // Allow only VietinBank's structured credit prefix before SEVQR.
        hasSevqrPrefix: /^(?:CT DEN:[A-Z0-9]+[ \t]+)?SEVQR(?:\s|$)/i.test(payload.content),
    };
    event.outcome = payload.gateway.toLowerCase() !== 'vietinbank' ? 'ignored_gateway'
        : event.transferType !== 'in' ? 'ignored_outgoing'
        : !event.hasSevqrPrefix ? 'missing_sevqr'
        : event.codeSource === 'ambiguous' ? 'ambiguous_code'
        : !event.paymentCode ? 'missing_code' : 'recorded';
    return Object.freeze(event);
}

function signatureHeaders(headers, now = Date.now()) {
    const timestamp = headers['x-sepay-timestamp'] || '';
    const signature = /^sha256=([a-f0-9]{64})$/i.exec(headers['x-sepay-signature'] || '');
    if (!/^[1-9][0-9]{0,11}$/.test(timestamp) || !signature || Math.abs(now / 1000 - Number(timestamp)) > 300) return null;
    return { timestamp, signature: Buffer.from(signature[1], 'hex') };
}
function verifyHmac(raw, headers, secret, now = Date.now()) {
    const auth = signatureHeaders(headers, now);
    if (!auth) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    if (!Buffer.isBuffer(raw) || raw.length > 16 * 1024) throw Object.assign(new Error('Invalid body'), { status: 400 });
    const expected = createHmac('sha256', secret).update(`${auth.timestamp}.`).update(raw).digest();
    if (!timingSafeEqual(expected, auth.signature)) throw Object.assign(new Error('Unauthorized'), { status: 401 });
}
function parseJson(raw) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
module.exports = { extractEvent, signatureHeaders, verifyHmac, parseJson };
