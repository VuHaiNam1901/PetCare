// Deploying the backend does not activate Voucher checkout or administration.
const enabled = () => process.env.PETCARE_VOUCHERS_ENABLED === '1';
function assertEnabled() {
    if (!enabled()) throw Object.assign(new Error('Voucher functionality is not enabled'), { status: 503, code: 'VOUCHERS_DISABLED' });
}
module.exports = { enabled, assertEnabled };
