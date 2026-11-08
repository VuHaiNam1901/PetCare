// Public capability discovery only. This never applies migrations or enables flags.
function createVoucherReadiness({
    enabled = () => require('../config/vouchers').enabled(),
    verify = () => require('../models/voucher').assertReady(),
    workflowSettings = () => require('../config/order-workflow').settings(),
} = {}) {
    return async function readiness() {
        if (!enabled()) return { ready: false, online_ready: false };
        try {
            await verify();
            const workflow = workflowSettings();
            return { ready: true, online_ready: Boolean(workflow.enabled && workflow.frontendReady && workflow.expiryEnabled) };
        } catch {
            // Do not expose schema names, connection details or migration errors.
            return { ready: false, online_ready: false };
        }
    };
}
module.exports = { createVoucherReadiness };
