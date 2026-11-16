'use strict';

function fail(status, message, code = 'INVALID_VOUCHER') { throw Object.assign(new Error(message), { status, code }); }
function unavailable() {
    fail(503, 'Voucher distribution is not ready; the reviewed distribution schema is required', 'VOUCHER_DISTRIBUTION_NOT_READY');
}
async function assertDistributionReady(db) {
    try { await require('../migrations/009-voucher-audience').verify(db); }
    catch { unavailable(); }
}
async function distributionReady(db) {
    // Absence preserves legacy 008 behavior. A partial/changed installation must
    // never turn a restricted code into a public code by falling back to "all".
    const [tables] = await db.execute(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('voucher_audiences','voucher_assignments')`);
    const [[entry]] = await db.execute('SELECT version FROM schema_migrations WHERE version=?', ['009']);
    if (!tables.length && !entry) return false;
    await assertDistributionReady(db);
    return true;
}
function normalizeUserIds(value, { allowEmpty = false } = {}) {
    if (!Array.isArray(value) || value.length > 100 || (!allowEmpty && !value.length)) fail(400, 'Select 1-100 active customers');
    const ids = value.map(item => {
        if ((typeof item !== 'string' && typeof item !== 'number') ||
            (typeof item === 'number' && !Number.isSafeInteger(item)) || !/^[1-9]\d*$/.test(String(item)) ||
            BigInt(item) > 2147483647n) fail(400, 'Invalid customer ID');
        return String(item);
    });
    return [...new Set(ids)].sort((a, b) => Number(a) - Number(b));
}
async function policy(db, voucherId, { lock = false, ready } = {}) {
    if (!(ready ?? await distributionReady(db))) return { audience: 'all', distribution_managed: false };
    const [[saved]] = await db.execute(`SELECT audience FROM voucher_audiences WHERE voucher_id=?${lock ? ' FOR SHARE' : ''}`, [voucherId]);
    return { audience: saved?.audience || 'all', distribution_managed: Boolean(saved) };
}
async function enforceLocked(db, voucherId, userId) {
    const current = await policy(db, voucherId, { lock: true });
    if (current.audience !== 'selected') return;
    const [[assignment]] = await db.execute('SELECT user_id FROM voucher_assignments WHERE voucher_id=? AND user_id=? FOR SHARE', [voucherId, userId]);
    if (!assignment) fail(403, 'This voucher is assigned to other customers', 'VOUCHER_NOT_ASSIGNED');
}
async function savePolicyLocked(db, voucherId, audience) {
    await db.execute(`INSERT INTO voucher_audiences (voucher_id,audience,created_at_utc,updated_at_utc)
        VALUES (?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE audience=?,updated_at_utc=UTC_TIMESTAMP(3)`,
    [voucherId, audience, audience]);
}
async function grantLocked(db, adminId, voucherId, input) {
    const ids = normalizeUserIds(input);
    // Voucher row ownership serializes all grant and checkout admissions. User
    // locks also prevent an account from being disabled during this grant.
    const [customers] = await db.execute(`SELECT user_id,role,status FROM \`user\`
        WHERE user_id IN (${ids.map(() => '?').join(',')}) ORDER BY user_id FOR SHARE`, ids);
    if (customers.length !== ids.length || customers.some(user => user.role !== 'user' || user.status !== 'active')) {
        fail(400, 'Voucher recipients must all be active customer accounts', 'VOUCHER_INVALID_RECIPIENT');
    }
    const [existing] = await db.execute(`SELECT CAST(user_id AS CHAR) AS user_id FROM voucher_assignments
        WHERE voucher_id=? AND user_id IN (${ids.map(() => '?').join(',')}) ORDER BY user_id FOR UPDATE`, [voucherId, ...ids]);
    const assigned = new Set(existing.map(user => String(user.user_id)));
    const additions = ids.filter(id => !assigned.has(id));
    for (const userId of additions) {
        await db.execute(`INSERT INTO voucher_assignments (voucher_id,user_id,granted_by,granted_at_utc)
            VALUES (?,?,?,UTC_TIMESTAMP(3))`, [voucherId, userId, adminId]);
    }
    // The earlier schema checks may have established an older RR snapshot.
    // Count the current rows owned by our voucher lock, including prior grants.
    const [all] = await db.execute('SELECT user_id FROM voucher_assignments WHERE voucher_id=? ORDER BY user_id FOR SHARE', [voucherId]);
    return { added: additions.length, total: all.length, user_ids: ids };
}

module.exports = { assertDistributionReady, distributionReady, normalizeUserIds, policy, enforceLocked, savePolicyLocked, grantLocked };
