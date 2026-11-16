// Pure protocol checks: no application, server, database or .env dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractEvent } = require('./protocol.cjs');

const payload = {
    id: 1, gateway: 'VietinBank', transferType: 'in', transferAmount: 150000,
    referenceCode: 'SYNTHETIC-REFERENCE', code: null,
};

test('accepts SEVQR at the start or after a structured VietinBank credit prefix', () => {
    for (const content of ['SEVQR PCS123', 'CT DEN:123456789 SEVQR PCS123',
        'CT DEN:REF123ABC SEVQR PCS123', 'ct den:ref123\tsevqr pcs123']) {
        const event = extractEvent({ ...payload, content });
        assert.equal(event.hasSevqrPrefix, true, content);
        assert.equal(event.outcome, 'recorded', content);
        assert.equal(event.paymentCode, 'PCS123', content);
        assert.equal(event.orderId, '123', content);
    }
});

test('rejects arbitrary leading text, malformed bank prefixes and embedded SEVQR', () => {
    for (const content of ['text SEVQR PCS123', 'text CT DEN:REF123 SEVQR PCS123',
        ' CT DEN:REF123 SEVQR PCS123', 'CTDEN:REF123 SEVQR PCS123',
        'CT DEN REF123 SEVQR PCS123', 'CT DEN: SEVQR PCS123',
        'CT DEN:REF 123 SEVQR PCS123', 'CT DEN:REF!123 SEVQR PCS123',
        'CT DEN:REF123SEVQR PCS123', 'CT DEN:REF123 extra SEVQR PCS123',
        'CT DEN:REF123\nSEVQR PCS123', 'CT DEN:REF123 SEVQRX PCS123', 'XSEVQR PCS123']) {
        const event = extractEvent({ ...payload, code: 'PCS123', content });
        assert.equal(event.hasSevqrPrefix, false, content);
        assert.equal(event.outcome, 'missing_sevqr', content);
    }
});

test('the bank prefix still requires an unambiguous payment code', () => {
    for (const [change, outcome] of [
        [{ content: 'CT DEN:REF123 SEVQR chuyen khoan' }, 'missing_code'],
        [{ content: 'CT DEN:REF123 SEVQR PCS12345678901' }, 'missing_code'],
        [{ content: 'CT DEN:REF123 SEVQR PCS123 PCS456' }, 'ambiguous_code'],
        [{ content: 'CT DEN:REF123 SEVQR PCS123', code: 'PCS456' }, 'ambiguous_code'],
    ]) {
        const event = extractEvent({ ...payload, ...change });
        assert.equal(event.hasSevqrPrefix, true);
        assert.equal(event.outcome, outcome);
        assert.equal(event.paymentCode, null);
    }
});
