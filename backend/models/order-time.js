// Legacy DATETIME values are wall-clock values in the MySQL session timezone.
// Let MySQL interpret those values instead of assuming the Node host has the
// same timezone. UTC lifecycle/financial columns are handled separately by db.js.
const orderFields = ['order_date', 'approved_at', 'stock_reserved_at', 'stock_restored_at'];
function prefix(alias) {
    if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid clock table alias');
    return alias ? alias + '.' : '';
}
function selectOrderClock(alias = '') {
    const table = prefix(alias);
    return ', ' + orderFields.map(field => `UNIX_TIMESTAMP(${table}${field}) AS __clock_${field}`).join(', ') +
        `, (${table}stock_reserved_at IS NOT NULL AND ${table}stock_reserved_at > '1000-01-01' AND ${table}stock_reserved_at <= NOW()) AS stock_reservation_valid` +
        `, (${table}approved_at IS NOT NULL AND ${table}approved_at > '1000-01-01' AND ${table}approved_at <= NOW()) AS approval_valid`;
}
function selectPaymentClock(alias = '') {
    const table = prefix(alias);
    return `, UNIX_TIMESTAMP(${table}created_at) AS __clock_created_at, UNIX_TIMESTAMP(${table}transaction_date) AS __clock_transaction_date`;
}
function normalizeLegacyClock(row, fields) {
    if (!row) return row;
    for (const field of fields) {
        const key = '__clock_' + field;
        const seconds = row[key];
        if (Object.hasOwn(row, field) && seconds !== undefined && seconds !== null) {
            const [whole, fraction = ''] = String(seconds).split('.');
            const milliseconds = Number(BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3)));
            if (Number.isFinite(milliseconds)) row[field] = new Date(milliseconds);
        }
        delete row[key];
    }
    return row;
}
const normalizeOrderClock = row => normalizeLegacyClock(row, [...orderFields, 'created_at', 'transaction_date']);
function stripClockProof(row) {
    delete row.stock_reservation_valid;
    delete row.approval_valid;
    return row;
}
module.exports = { selectOrderClock, selectPaymentClock, normalizeLegacyClock, normalizeOrderClock, stripClockProof };
