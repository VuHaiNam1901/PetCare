'use strict';

const maximum = 999999999999n;
function invalid(message) { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_VOUCHER' }); }
function cents(value, name = 'amount') {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value)) invalid(`${name} must be a canonical decimal string with two fractional digits`);
    const amount = BigInt(value.replace('.', ''));
    if (amount > maximum) invalid(`${name} exceeds database capacity`);
    return amount;
}
function decimal(value) {
    if (typeof value !== 'bigint' || value < 0n || value > maximum) invalid('Invalid monetary amount');
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
function calculateDiscount(subtotal, voucher) {
    const original = cents(subtotal, 'subtotal_amount');
    const value = cents(voucher.discount_value, 'discount_value');
    if (value <= 0n || !['fixed', 'percent'].includes(voucher.discount_type) ||
        (voucher.discount_type === 'percent' && value > 10000n)) invalid('Invalid voucher discount');
    // Percentage is stored to two decimals: 12.34% = 1234 / 10000.
    // Integer division intentionally rounds the discount down to one money cent.
    let discount = voucher.discount_type === 'fixed' ? value : original * value / 10000n;
    if (voucher.max_discount_amount != null) {
        const cap = cents(voucher.max_discount_amount, 'max_discount_amount');
        if (cap <= 0n) invalid('max_discount_amount must be positive');
        if (discount > cap) discount = cap;
    }
    if (discount > original) discount = original;
    return { subtotal_amount: decimal(original), discount_amount: decimal(discount), total_amount: decimal(original - discount) };
}
module.exports = { cents, decimal, calculateDiscount };
