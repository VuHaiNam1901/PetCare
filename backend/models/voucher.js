'use strict';

const math = require('../services/voucher-math');
const config = require('../config/vouchers');
const fields = ['code', 'discount_type', 'discount_value', 'max_discount_amount', 'minimum_order_amount',
    'starts_at_utc', 'ends_at_utc', 'total_limit', 'per_user_limit', 'status'];
const statuses = ['draft', 'active', 'disabled'];
const selectVoucher = `CAST(v.voucher_id AS CHAR) AS voucher_id,v.code,v.discount_type,v.discount_value,
    v.max_discount_amount,v.minimum_order_amount,v.starts_at_utc,v.ends_at_utc,v.total_limit,v.per_user_limit,v.status,v.created_at_utc,v.updated_at_utc`;
const database = () => require('../config/db');
function fail(status, message, code = 'INVALID_VOUCHER') { throw Object.assign(new Error(message), { status, code }); }
function normalizeCode(value) {
    if (typeof value !== 'string') fail(400, 'Voucher code must be text');
    const code = value.trim();
    // Validate before case folding: Unicode characters such as ß must not
    // expand into an existing ASCII voucher code.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(code)) fail(400, 'Voucher code must contain 1-64 ASCII letters, digits, underscores or hyphens');
    return code.toUpperCase();
}
function identity(value, name = 'voucher ID') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(400, `Invalid ${name}`);
    const text = String(value);
    if (!/^[1-9]\d*$/.test(text) || BigInt(text) > 18446744073709551615n) fail(400, `Invalid ${name}`);
    return text;
}
function utc(value, name) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail(400, `${name} must be an explicit UTC ISO timestamp`);
    const instant = Date.parse(value);
    if (!Number.isFinite(instant) || Number(value.slice(0, 4)) < 1000) fail(400, `Invalid ${name}`);
    const normalized = new Date(instant).toISOString();
    if (normalized.slice(0, 19) !== value.slice(0, 19)) fail(400, `Invalid ${name}`);
    return normalized;
}
const sqlUtc = value => value.slice(0, 23).replace('T', ' ');
function validate(value, partial = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) ||
        (partial && !Object.keys(value).length)) fail(400, 'Unsupported or empty voucher fields');
    const result = {};
    if (!partial) Object.assign(result, { max_discount_amount: null, minimum_order_amount: '0.00', total_limit: null, per_user_limit: null, status: 'draft' });
    for (const key of fields) if (Object.hasOwn(value, key)) {
        const item = value[key];
        if (key === 'code') result[key] = normalizeCode(item);
        else if (['discount_type', 'status'].includes(key)) {
            if (!(key === 'status' ? statuses : ['fixed', 'percent']).includes(item)) fail(400, `Invalid ${key}`);
            result[key] = item;
        } else if (['total_limit', 'per_user_limit'].includes(key)) {
            if (item !== null && (!Number.isSafeInteger(item) || item < 1 || item > 4294967295)) fail(400, `${key} must be a positive integer or null`);
            result[key] = item;
        } else if (['starts_at_utc', 'ends_at_utc'].includes(key)) result[key] = utc(item, key);
        else {
            if (item === null && key === 'max_discount_amount') { result[key] = null; continue; }
            const amount = math.cents(item, key);
            if (key !== 'minimum_order_amount' && amount <= 0n) fail(400, `${key} must be positive`);
            result[key] = item;
        }
    }
    if (!partial) {
        for (const key of ['code', 'discount_type', 'discount_value', 'starts_at_utc', 'ends_at_utc']) if (!Object.hasOwn(result, key)) fail(400, `${key} is required`);
        if (result.discount_type === 'percent' && math.cents(result.discount_value) > 10000n) fail(400, 'Percentage discount cannot exceed 100');
        if (Date.parse(result.ends_at_utc) <= Date.parse(result.starts_at_utc)) fail(400, 'Voucher end must be after its start');
    }
    return result;
}
const validateCreate = value => validate(value);
const validateUpdate = value => validate(value, true);
async function assertReady(db = database()) {
    try { await require('../migrations/008-voucher-foundation').verify(db); }
    catch { fail(503, 'Voucher migration 008 is incomplete or schema differs', 'VOUCHER_SCHEMA_NOT_READY'); }
}
async function transaction(action, { enabled = true, ready = true, readOnlySnapshot = false } = {}) {
    if (enabled) config.assertEnabled();
    const db = await database().getConnection();
    try {
        if (ready) await assertReady(db);
        if (readOnlySnapshot) {
            // Applies only to this transaction; do not leak isolation changes to
            // later checkout/administration work using the pooled connection.
            await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await db.query('START TRANSACTION READ ONLY');
        } else await db.beginTransaction();
        const result = await action(db);
        await db.commit();
        return result;
    } catch (error) {
        try { await db.rollback(); } catch { /* Keep the original/ambiguous COMMIT error. */ }
        if (error.code === 'ER_DUP_ENTRY') {
            error.status = 409; error.code = 'VOUCHER_CONFLICT'; error.message = 'Voucher code or order redemption already exists';
        }
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            error.status = 409; error.code = 'VOUCHER_RETRY'; error.retryable = true; error.message = 'Voucher is busy; retry the same request';
        }
        throw error;
    } finally { db.release(); }
}
async function requireAdmin(db, adminId) {
    const [[admin]] = await db.execute('SELECT role,status FROM `user` WHERE user_id=? FOR SHARE', [adminId]);
    if (!admin || admin.role !== 'admin' || admin.status !== 'active') fail(403, 'Active admin account required', 'VOUCHER_FORBIDDEN');
}
async function read(db, voucherId, lock = false) {
    const [[voucher]] = await db.execute(`SELECT ${selectVoucher} FROM vouchers v WHERE v.voucher_id=?${lock ? ' FOR UPDATE' : ''}`, [identity(voucherId)]);
    if (!voucher) fail(404, 'Voucher not found', 'VOUCHER_NOT_FOUND');
    return voucher;
}
async function activeRedemptions(db, voucherId) {
    // A consistent SELECT/SUM under REPEATABLE READ may be older than the row
    // lock we just waited for. A locking/current read is required for admission.
    const [rows] = await db.execute(`SELECT CAST(redemption_id AS CHAR) AS redemption_id,CAST(user_id AS CHAR) AS user_id,status
        FROM voucher_redemptions WHERE voucher_id=? AND status IN ('reserved','consumed') ORDER BY redemption_id FOR UPDATE`, [identity(voucherId)]);
    return rows;
}
function quota(voucher, rows, userId) {
    const usedByUser = rows.filter(row => String(row.user_id) === String(userId)).length;
    if (voucher.total_limit !== null && rows.length >= Number(voucher.total_limit)) fail(409, 'Voucher usage limit has been reached', 'VOUCHER_QUOTA_EXCEEDED');
    if (voucher.per_user_limit !== null && usedByUser >= Number(voucher.per_user_limit)) fail(409, 'Your voucher usage limit has been reached', 'VOUCHER_USER_LIMIT_EXCEEDED');
    return { remaining_total: voucher.total_limit === null ? null : Number(voucher.total_limit) - rows.length,
        remaining_user: voucher.per_user_limit === null ? null : Number(voucher.per_user_limit) - usedByUser };
}
async function window(db, voucher) {
    // A current read also protects callers whose transaction already owns a
    // REPEATABLE READ snapshot from before the voucher admission lock.
    const [[current]] = await db.execute('SELECT status,starts_at_utc<=UTC_TIMESTAMP(3) AS started,ends_at_utc>UTC_TIMESTAMP(3) AS not_expired FROM vouchers WHERE voucher_id=? FOR UPDATE', [voucher.voucher_id]);
    if (current?.status !== 'active') fail(409, 'Voucher is not active', 'VOUCHER_INACTIVE');
    if (!current?.started) fail(409, 'Voucher validity has not started', 'VOUCHER_NOT_STARTED');
    if (!current.not_expired) fail(409, 'Voucher has expired', 'VOUCHER_EXPIRED');
}
async function lockByCode(db, code) {
    config.assertEnabled();
    const normalized = normalizeCode(code);
    const [[voucher]] = await db.execute(`SELECT ${selectVoucher} FROM vouchers v WHERE v.code=? FOR UPDATE`, [normalized]);
    if (!voucher) fail(404, 'Voucher not found', 'VOUCHER_NOT_FOUND');
    return voucher;
}
async function quoteLocked(db, { code, userId, subtotal, voucher, paymentMethod }) {
    config.assertEnabled();
    voucher ||= await lockByCode(db, code);
    if (code !== undefined && normalizeCode(code) !== voucher.code) fail(409, 'Voucher lock does not match request', 'VOUCHER_CONFLICT');
    await window(db, voucher);
    if (math.cents(subtotal) < math.cents(voucher.minimum_order_amount)) fail(409, 'Order does not meet voucher minimum amount', 'VOUCHER_MINIMUM_NOT_MET');
    const quote = math.calculateDiscount(subtotal, voucher);
    const remaining = quota(voucher, await activeRedemptions(db, voucher.voucher_id), userId);
    if (paymentMethod === 'ONLINE' && quote.total_amount === '0.00') fail(409, 'Không thể áp dụng Voucher cho đơn Online có tổng thanh toán 0đ. Vui lòng chọn mã khác hoặc thanh toán COD.', 'VOUCHER_ONLINE_ZERO_TOTAL');
    return { voucher, ...quote, quota: remaining };
}
async function reserveLocked(db, { voucher, orderId, userId, discountAmount }) {
    const [[existing]] = await db.execute(`SELECT CAST(redemption_id AS CHAR) AS redemption_id,CAST(voucher_id AS CHAR) AS voucher_id,
        CAST(user_id AS CHAR) AS user_id,status,discount_amount FROM voucher_redemptions WHERE order_id=? FOR UPDATE`, [orderId]);
    if (existing) {
        if (String(existing.voucher_id) !== String(voucher.voucher_id) || String(existing.user_id) !== String(userId) ||
            existing.discount_amount !== discountAmount || existing.status === 'released') fail(409, 'Order already has another voucher redemption', 'VOUCHER_CONFLICT');
        return { ...existing, replayed: true };
    }
    await window(db, voucher);
    quota(voucher, await activeRedemptions(db, voucher.voucher_id), userId);
    const [[order]] = await db.execute('SELECT user_id,subtotal_amount,discount_amount,total_amount,voucher_code_snapshot FROM orders WHERE order_id=? FOR UPDATE', [orderId]);
    if (!order || String(order.user_id) !== String(userId) || order.voucher_code_snapshot !== voucher.code || order.discount_amount !== discountAmount) fail(409, 'Voucher order snapshot needs review', 'VOUCHER_CONFLICT');
    const expected = math.calculateDiscount(order.subtotal_amount, voucher);
    if (expected.discount_amount !== discountAmount || expected.total_amount !== order.total_amount) fail(409, 'Voucher order amount needs review', 'VOUCHER_CONFLICT');
    await db.execute(`INSERT INTO voucher_redemptions
        (voucher_id,order_id,user_id,status,discount_amount,reserved_at_utc) VALUES (?,?,?,'reserved',?,UTC_TIMESTAMP(3))`,
    [voucher.voucher_id, orderId, userId, discountAmount]);
    return { voucher_id: voucher.voucher_id, order_id: orderId, user_id: userId, status: 'reserved', discount_amount: discountAmount, replayed: false };
}
async function redemptionLocked(db, order) {
    if (!order.voucher_code_snapshot) return null;
    // Codes become immutable as soon as any redemption exists. Lock by the
    // snapshot so lifecycle reads cannot miss a newly committed redemption due
    // to an older transaction snapshot; always acquire voucher before redemption.
    const [[voucher]] = await db.execute('SELECT CAST(voucher_id AS CHAR) AS voucher_id FROM vouchers WHERE code=? FOR UPDATE', [order.voucher_code_snapshot]);
    if (!voucher) fail(409, 'Voucher snapshot is missing', 'VOUCHER_REVIEW_REQUIRED');
    const [[redemption]] = await db.execute(`SELECT CAST(redemption_id AS CHAR) AS redemption_id,CAST(voucher_id AS CHAR) AS voucher_id,
        CAST(user_id AS CHAR) AS user_id,status,discount_amount FROM voucher_redemptions WHERE order_id=? FOR UPDATE`, [order.order_id]);
    if (!redemption || redemption.voucher_id !== voucher.voucher_id || String(redemption.user_id) !== String(order.user_id) || redemption.discount_amount !== order.discount_amount ||
        order.subtotal_amount == null || order.total_amount == null ||
        math.cents(order.subtotal_amount) - math.cents(order.discount_amount) !== math.cents(order.total_amount)) fail(409, 'Voucher snapshot or redemption needs review', 'VOUCHER_REVIEW_REQUIRED');
    return redemption;
}
async function consumeLocked(db, order, payment) {
    const redemption = await redemptionLocked(db, order);
    if (!redemption) return { changed: false };
    if (redemption.status === 'consumed') return { changed: false };
    if (redemption.status !== 'reserved') fail(409, 'Released voucher cannot be consumed', 'VOUCHER_REVIEW_REQUIRED');
    if (!payment || !['COD', 'ONLINE'].includes(payment.payment_method) || payment.amount !== order.total_amount ||
        (payment.payment_method === 'ONLINE' && payment.payment_status !== 'Đã thanh toán')) fail(409, 'Voucher consumption requires the payment/order transition', 'VOUCHER_REVIEW_REQUIRED');
    const [updated] = await db.execute("UPDATE voucher_redemptions SET status='consumed',consumed_at_utc=UTC_TIMESTAMP(3) WHERE redemption_id=? AND status='reserved'", [redemption.redemption_id]);
    if (updated.affectedRows !== 1) fail(409, 'Voucher redemption changed concurrently', 'VOUCHER_RETRY');
    return { changed: true };
}
async function releaseLocked(db, order) {
    const redemption = await redemptionLocked(db, order);
    if (!redemption || redemption.status === 'released') return { changed: false };
    if (!['reserved', 'consumed'].includes(redemption.status)) fail(409, 'Unknown voucher redemption state', 'VOUCHER_REVIEW_REQUIRED');
    const [updated] = await db.execute("UPDATE voucher_redemptions SET status='released',released_at_utc=UTC_TIMESTAMP(3) WHERE redemption_id=? AND status IN ('reserved','consumed')", [redemption.redemption_id]);
    if (updated.affectedRows !== 1) fail(409, 'Voucher redemption changed concurrently', 'VOUCHER_RETRY');
    return { changed: true };
}
async function create(adminId, input) {
    const data = validateCreate(input);
    return transaction(async db => {
        await requireAdmin(db, adminId);
        const [created] = await db.execute(`INSERT INTO vouchers (${fields.join(',')},created_at_utc,updated_at_utc)
            VALUES (${fields.map(() => '?').join(',')},UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
        fields.map(field => field.endsWith('_utc') ? sqlUtc(data[field]) : data[field]));
        const [[{ id }]] = await db.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
        return read(db, id || created.insertId);
    });
}
async function list({ page = 1, limit = 20, q, status } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger((page - 1) * limit)) fail(400, 'Invalid voucher pagination');
    if (q !== undefined && (typeof q !== 'string' || q.trim().length > 64 || /[^\x20-\x7e]/.test(q))) fail(400, 'Invalid voucher search');
    if (status !== undefined && !statuses.includes(status)) fail(400, 'Invalid voucher status filter');
    return transaction(async db => {
        const conditions = [], values = [];
        if (q?.trim()) { conditions.push("v.code LIKE ? ESCAPE '='"); values.push('%' + q.trim().toUpperCase().replace(/[=%_]/g, value => '=' + value) + '%'); }
        if (status !== undefined) { conditions.push('v.status=?'); values.push(status); }
        const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
        const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM vouchers v${where}`, values);
        const [vouchers] = await db.query(`SELECT ${selectVoucher} FROM vouchers v${where} ORDER BY v.voucher_id DESC LIMIT ? OFFSET ?`, [...values, limit, (page - 1) * limit]);
        return { total, vouchers };
    });
}
const get = voucherId => transaction(db => read(db, voucherId));
async function listForCustomer(userId, { page = 1, limit = 20 } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 2147483647 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger((page - 1) * limit)) fail(400, 'Invalid voucher pagination');
    return transaction(async db => {
        const [[user]] = await db.execute('SELECT role,status FROM `user` WHERE user_id=?', [userId]);
        if (!user || user.role !== 'user' || user.status !== 'active') fail(403, 'Active customer account required', 'VOUCHER_FORBIDDEN');
        const [[clock]] = await db.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%d %H:%i:%s.%f') AS now_sql");
        // Discovery is a read-only snapshot, not an admission/reservation. The
        // existing quote and checkout lock/recheck current conditions as before.
        const where = `WHERE v.status='active' AND v.starts_at_utc<=? AND v.ends_at_utc>?
            AND (v.total_limit IS NULL OR v.total_limit > (SELECT COUNT(*) FROM voucher_redemptions r
                WHERE r.voucher_id=v.voucher_id AND r.status IN ('reserved','consumed')))
            AND (v.per_user_limit IS NULL OR v.per_user_limit > (SELECT COUNT(*) FROM voucher_redemptions r
                WHERE r.voucher_id=v.voucher_id AND r.user_id=? AND r.status IN ('reserved','consumed')))`;
        const values = [clock.now_sql, clock.now_sql, userId];
        const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM vouchers v ${where}`, values);
        const [vouchers] = await db.query(`SELECT v.code,v.discount_type,v.discount_value,v.max_discount_amount,
            v.minimum_order_amount,v.starts_at_utc,v.ends_at_utc FROM vouchers v ${where}
            ORDER BY v.ends_at_utc ASC,v.voucher_id ASC LIMIT ? OFFSET ?`, [...values, limit, (page - 1) * limit]);
        return { total, vouchers };
    }, { readOnlySnapshot: true });
}
async function update(adminId, voucherId, input) {
    const changes = validateUpdate(input);
    return transaction(async db => {
        await requireAdmin(db, adminId);
        const current = await read(db, voucherId, true);
        const data = validateCreate(Object.fromEntries(fields.map(field => [field, Object.hasOwn(changes, field) ? changes[field] : current[field]])));
        if (data.code !== current.code) {
            const [used] = await db.execute('SELECT redemption_id FROM voucher_redemptions WHERE voucher_id=? ORDER BY redemption_id LIMIT 1 FOR UPDATE', [current.voucher_id]);
            if (used.length) fail(409, 'Voucher code cannot change after a redemption exists', 'VOUCHER_CODE_IMMUTABLE');
        }
        const active = await activeRedemptions(db, current.voucher_id);
        if (data.total_limit !== null && active.length > data.total_limit) fail(409, 'Total limit cannot be below reserved and consumed usage', 'VOUCHER_LIMIT_BELOW_USAGE');
        if (data.per_user_limit !== null) {
            const users = new Map();
            for (const row of active) users.set(row.user_id, (users.get(row.user_id) || 0) + 1);
            if ([...users.values()].some(count => count > data.per_user_limit)) fail(409, 'Per-user limit cannot be below current usage', 'VOUCHER_LIMIT_BELOW_USAGE');
        }
        const changed = Object.keys(changes);
        await db.execute(`UPDATE vouchers SET ${changed.map(field => `${field}=?`).join(',')},updated_at_utc=UTC_TIMESTAMP(3) WHERE voucher_id=?`,
        [...changed.map(field => field.endsWith('_utc') ? sqlUtc(data[field]) : data[field]), current.voucher_id]);
        return read(db, current.voucher_id);
    });
}
const disable = (adminId, voucherId) => update(adminId, voucherId, { status: 'disabled' });
async function quoteForItems(userId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['code', 'items', 'payment_method'].includes(key)) ||
        !['COD', 'ONLINE'].includes(input.payment_method) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100 ||
        input.items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['product_id', 'quantity'].includes(key)) ||
            !Number.isSafeInteger(item.product_id) || item.product_id < 1 || item.product_id > 2147483647 || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 2147483647) ||
        new Set(input.items.map(item => item.product_id)).size !== input.items.length) fail(400, 'Invalid voucher quote items or payment method');
    const code = normalizeCode(input.code);
    return transaction(async db => {
        const [[user]] = await db.execute('SELECT role,status FROM `user` WHERE user_id=? FOR SHARE', [userId]);
        if (!user || user.role !== 'user' || user.status !== 'active') fail(403, 'Active customer account required', 'VOUCHER_FORBIDDEN');
        const voucher = await lockByCode(db, code);
        let total = 0n;
        for (const item of [...input.items].sort((a, b) => a.product_id - b.product_id)) {
            const [[product]] = await db.execute('SELECT price,status,stock_quantity FROM products WHERE product_id=? FOR SHARE', [item.product_id]);
            if (!product || product.status !== 'Đang bán' || !Number.isInteger(product.stock_quantity) || product.stock_quantity < item.quantity) fail(409, 'Product is unavailable for voucher quote', 'VOUCHER_PRODUCT_UNAVAILABLE');
            total += math.cents(product.price) * BigInt(item.quantity);
            if (total > 999999999999n) fail(409, 'Order total exceeds database capacity', 'ORDER_TOTAL_TOO_LARGE');
        }
        const quote = await quoteLocked(db, { code, userId, subtotal: math.decimal(total), voucher, paymentMethod: input.payment_method });
        const publicVoucher = Object.fromEntries(['voucher_id', 'code', 'discount_type', 'discount_value', 'max_discount_amount', 'minimum_order_amount', 'starts_at_utc', 'ends_at_utc'].map(key => [key, voucher[key]]));
        return { ...quote, voucher: publicVoucher, reserved: false };
    });
}

module.exports = { normalizeCode, validateCreate, validateUpdate, calculateDiscount: math.calculateDiscount,
    assertEnabled: config.assertEnabled, assertReady, lockByCode, quoteLocked, reserveLocked, consumeLocked, releaseLocked,
    create, list, get, update, disable, listForCustomer, quoteForItems, quote: quoteForItems };
