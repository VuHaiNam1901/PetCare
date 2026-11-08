const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVoucherReadiness } = require('../services/voucher-readiness');

test('disabled readiness never loads or verifies database schema', async () => {
    const readiness = createVoucherReadiness({ enabled: () => false, verify: () => assert.fail('No database access when disabled') });
    assert.deepEqual(await readiness(), { ready: false, online_ready: false });
});
test('ready schema permits COD while incomplete Online flags remain unavailable', async () => {
    const readiness = createVoucherReadiness({ enabled: () => true, verify: async () => {},
        workflowSettings: () => ({ enabled: true, frontendReady: false, expiryEnabled: true }) });
    assert.deepEqual(await readiness(), { ready: true, online_ready: false });
});
test('Online readiness requires all current workflow conditions', async () => {
    const readiness = createVoucherReadiness({ enabled: () => true, verify: async () => {},
        workflowSettings: () => ({ enabled: true, frontendReady: true, expiryEnabled: true }) });
    assert.deepEqual(await readiness(), { ready: true, online_ready: true });
});
test('schema verification failure is explicit unavailable and discloses no internal error', async () => {
    const readiness = createVoucherReadiness({ enabled: () => true, verify: async () => { throw new Error('private schema/connection data'); } });
    assert.deepEqual(await readiness(), { ready: false, online_ready: false });
});
