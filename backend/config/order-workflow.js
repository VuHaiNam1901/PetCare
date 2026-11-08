// Deployment switches are deliberately opt-in. Merely deploying this code does
// not create v2 orders, start a worker, or enable a simulated financial receipt.
const VERSION = 2;
const enabled = name => process.env[name] === '1';
function settings() {
    return {
        enabled: enabled('PETCARE_ORDER_WORKFLOW_ENABLED'),
        frontendReady: enabled('PETCARE_ORDER_FRONTEND_READY'),
        expiryEnabled: enabled('PETCARE_ORDER_EXPIRY_ENABLED'),
        simulationEnabled: enabled('PETCARE_PAYMENT_SIMULATION_ENABLED'),
        intervalMs: 30000,
    };
}
function unavailable(message) {
    throw Object.assign(new Error(message), { status: 503, code: 'ORDER_WORKFLOW_DISABLED' });
}
function isolatedTestDatabase() {
    const name = process.env.PETCARE_TEST_DATABASE;
    return process.env.NODE_ENV === 'test' && process.env.PETCARE_TEST_ISOLATED === '1' &&
        /^petcare_test_[a-f0-9]{32}$/.test(name || '') && name === process.env.DB_NAME &&
        Boolean(process.env.PETCARE_TEST_SOURCE_DATABASE) && name !== process.env.PETCARE_TEST_SOURCE_DATABASE;
}
function assertSimulationAllowed() {
    if (!settings().simulationEnabled || !isolatedTestDatabase()) {
        unavailable('Payment simulation requires explicit opt-in and an isolated synthetic test database');
    }
}
function assertWorkflowCreationAllowed() {
    const config = settings();
    if (!config.enabled || !config.frontendReady || !config.expiryEnabled) {
        unavailable('Online workflow requires explicit activation, compatible frontend and expiry worker readiness');
    }
}
module.exports = { VERSION, settings, isolatedTestDatabase, assertSimulationAllowed, assertWorkflowCreationAllowed };
