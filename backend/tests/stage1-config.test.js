const test = require('node:test');
const assert = require('node:assert/strict');
const workflow = require('../config/order-workflow');

const keys = ['NODE_ENV', 'DB_NAME', 'PETCARE_TEST_DATABASE', 'PETCARE_TEST_SOURCE_DATABASE', 'PETCARE_TEST_ISOLATED',
    'PETCARE_ORDER_WORKFLOW_ENABLED', 'PETCARE_ORDER_FRONTEND_READY', 'PETCARE_ORDER_EXPIRY_ENABLED', 'PETCARE_PAYMENT_SIMULATION_ENABLED'];
function withEnvironment(values, action) {
    const saved = new Map(keys.map(key => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        Object.assign(process.env, values);
        action();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}

test('deployment switches default off; enabling workflow requires frontend and worker readiness', () => {
    withEnvironment({}, () => {
        assert.deepEqual(workflow.settings(), { enabled: false, frontendReady: false, expiryEnabled: false, simulationEnabled: false, intervalMs: 30000 });
        assert.throws(workflow.assertWorkflowCreationAllowed, { status: 503 });
        process.env.PETCARE_ORDER_WORKFLOW_ENABLED = '1';
        assert.throws(workflow.assertWorkflowCreationAllowed, { status: 503 });
        process.env.PETCARE_ORDER_FRONTEND_READY = '1';
        assert.throws(workflow.assertWorkflowCreationAllowed, { status: 503 });
        process.env.PETCARE_ORDER_EXPIRY_ENABLED = '1';
        assert.doesNotThrow(workflow.assertWorkflowCreationAllowed);
    });
});

test('simulated receipts require opt-in and the exact isolated test identity', () => {
    const testName = 'petcare_test_' + 'a'.repeat(32);
    const valid = { NODE_ENV: 'test', DB_NAME: testName, PETCARE_TEST_DATABASE: testName,
        PETCARE_TEST_SOURCE_DATABASE: 'source_metadata_only', PETCARE_TEST_ISOLATED: '1', PETCARE_PAYMENT_SIMULATION_ENABLED: '1' };
    withEnvironment(valid, () => {
        assert.doesNotThrow(workflow.assertSimulationAllowed);
        for (const [key, bad] of [['NODE_ENV', 'production'], ['DB_NAME', 'petcare_db'], ['PETCARE_TEST_DATABASE', 'petcare_db'],
            ['PETCARE_TEST_SOURCE_DATABASE', testName], ['PETCARE_TEST_ISOLATED', '0'], ['PETCARE_PAYMENT_SIMULATION_ENABLED', '0']]) {
            const previous = process.env[key];
            process.env[key] = bad;
            assert.throws(workflow.assertSimulationAllowed, { status: 503 });
            process.env[key] = previous;
        }
    });
});
