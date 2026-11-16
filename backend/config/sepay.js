// Both switches are opt-in. Test traffic can only use an isolated synthetic DB;
// Live needs its own account, HMAC secret and explicit database write binding.
const enabled = (env = process.env) => env.SEPAY_INTEGRATION_ENABLED === '1';
const liveEnabled = (env = process.env) => env.SEPAY_LIVE_ENABLED === '1';
function testSettings(env = process.env) {
    const fail = () => { throw Object.assign(new Error('SePay Test requires explicit configuration and an isolated synthetic database'), { status: 503, code: 'SEPAY_TEST_FORBIDDEN' }); };
    const target = env.PETCARE_TEST_DATABASE;
    if (!enabled(env) || liveEnabled(env) || env.SEPAY_TEST_MODE !== '1' || env.SEPAY_ENVIRONMENT !== 'test' ||
        env.NODE_ENV !== 'test' || env.PETCARE_TEST_ISOLATED !== '1' ||
        !/^petcare_test_[a-f0-9]{32}$/.test(target || '') || target !== env.DB_NAME ||
        !env.PETCARE_TEST_SOURCE_DATABASE || target === env.PETCARE_TEST_SOURCE_DATABASE ||
        env.SEPAY_TEST_ACCOUNT_CONFIRMED !== '1' || !/^[0-9]{4,32}$/.test(env.SEPAY_TEST_ACCOUNT_NUMBER || '') ||
        !env.SEPAY_TEST_ACCOUNT_NAME?.trim() || env.SEPAY_TEST_ACCOUNT_NAME.length > 128 ||
        !/^[\x21-\x7e]{32,256}$/.test(env.SEPAY_TEST_WEBHOOK_SECRET || '')) fail();
    return { mode: 'test', providerEnvironment: 'test', database: target,
        accountNumber: env.SEPAY_TEST_ACCOUNT_NUMBER, accountName: env.SEPAY_TEST_ACCOUNT_NAME,
        secret: env.SEPAY_TEST_WEBHOOK_SECRET, bank: 'VietinBank' };
}
function settings(env = process.env) {
    if (env.SEPAY_ENVIRONMENT !== 'live') return testSettings(env);
    const fail = () => { throw Object.assign(new Error('SePay Live requires separate explicit configuration'), { status: 503, code: 'SEPAY_LIVE_FORBIDDEN' }); };
    const target = env.DB_NAME;
    if (!enabled(env) || !liveEnabled(env) || env.SEPAY_TEST_MODE !== '0' ||
        env.NODE_ENV === 'test' || env.PETCARE_TEST_ISOLATED === '1' || env.PETCARE_TEST_DATABASE || env.SEPAY_TEST_WRITE_DATABASE ||
        !/^[A-Za-z0-9_]{1,64}$/.test(target || '') || /^petcare_test_/i.test(target) || env.SEPAY_LIVE_WRITE_DATABASE !== target ||
        env.SEPAY_LIVE_ACCOUNT_CONFIRMED !== '1' || !/^[0-9]{4,32}$/.test(env.SEPAY_LIVE_ACCOUNT_NUMBER || '') ||
        !env.SEPAY_LIVE_ACCOUNT_NAME?.trim() || env.SEPAY_LIVE_ACCOUNT_NAME.length > 128 ||
        !/^[\x21-\x7e]{32,256}$/.test(env.SEPAY_LIVE_WEBHOOK_SECRET || '') ||
        env.SEPAY_LIVE_WEBHOOK_SECRET === env.SEPAY_TEST_WEBHOOK_SECRET || env.SEPAY_LIVE_ACCOUNT_NUMBER === env.SEPAY_TEST_ACCOUNT_NUMBER ||
        !['PETCARE_ORDER_WORKFLOW_ENABLED', 'PETCARE_ORDER_FRONTEND_READY', 'PETCARE_ORDER_EXPIRY_ENABLED'].every(key => env[key] === '1') ||
        env.PETCARE_PAYMENT_SIMULATION_ENABLED === '1') fail();
    // Existing schema uses 'production' for provider environments; no migration.
    return { mode: 'live', providerEnvironment: 'production', database: target,
        accountNumber: env.SEPAY_LIVE_ACCOUNT_NUMBER, accountName: env.SEPAY_LIVE_ACCOUNT_NAME,
        secret: env.SEPAY_LIVE_WEBHOOK_SECRET, bank: 'VietinBank' };
}
function writesEnabled(env = process.env) {
    const config = settings(env), target = config.database;
    if (config.mode === 'live') return true; // settings already verified the Live binding.
    if (env.SEPAY_TEST_WRITE_DATABASE && env.SEPAY_TEST_WRITE_DATABASE !== target) {
        throw Object.assign(new Error('SePay write target must match the isolated test database'), { status: 503, code: 'SEPAY_TEST_FORBIDDEN' });
    }
    return env.SEPAY_TEST_WRITE_DATABASE === target;
}
function checkoutSettings(env = process.env) {
    const config = settings(env);
    if (!writesEnabled(env) || !['PETCARE_ORDER_WORKFLOW_ENABLED', 'PETCARE_ORDER_FRONTEND_READY', 'PETCARE_ORDER_EXPIRY_ENABLED'].every(key => env[key] === '1')) {
        throw Object.assign(new Error('Online payment is unavailable'), { status: 503, code: 'ONLINE_PAYMENT_UNAVAILABLE' });
    }
    return config;
}
function supportsAmount(amount) {
    return typeof amount === 'string' && /^[1-9][0-9]{0,9}\.00$/.test(amount) &&
        BigInt(amount.slice(0, -3)) >= 1000n && BigInt(amount.slice(0, -3)) <= 499000000n;
}
async function assertDatabase(db, env = process.env) {
    const target = settings(env).database;
    const [[actual]] = await db.query('SELECT DATABASE() AS database_name');
    if (actual.database_name !== target) throw Object.assign(new Error('SePay database does not match the configured target'), { status: 503, code: 'SEPAY_DATABASE_FORBIDDEN' });
    return target;
}
async function assertWriteDatabase(db, env = process.env) {
    if (!writesEnabled(env)) throw Object.assign(new Error('SePay settlement requires an explicitly bound test database'), { status: 503, code: 'SEPAY_TEST_FORBIDDEN' });
    return assertDatabase(db, env);
}
module.exports = { enabled, liveEnabled, settings, testSettings, writesEnabled, checkoutSettings, supportsAmount, assertDatabase, assertWriteDatabase };
