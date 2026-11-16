// Shared adapter for the main website and Sandbox. Test mode retains its
// isolation guards and optional read-only diagnosis; Live is separately opt-in.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const config = require('../config/sepay');
const provider = require('../providers/sepay-test');
const policy = require('../models/order-policy');
const clock = require('../models/order-time');
const queues = new Map();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = () => { throw Object.assign(new Error('SePay test reconciliation unavailable'), { status: 503, code: 'SEPAY_TEST_FORBIDDEN' }); };
const iso = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function serialize(directory, work) {
    const previous = queues.get(directory) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    queues.set(directory, current);
    return current.finally(() => { if (queues.get(directory) === current) queues.delete(directory); });
}
function createSePayService({ pool, env = process.env,
    receiptDirectory = path.join(__dirname, '../sepay-test/.integration-receipts') } = {}) {
    config.settings(env); // Fail before any connection or filesystem mutation.
    config.writesEnabled(env); // An explicitly mismatched write binding fails closed.
    const directory = path.resolve(receiptDirectory);
    let ownedPool;
    const database = () => pool || (ownedPool ??= require('mysql2/promise').createPool({
        host: env.DB_HOST, port: Number(env.DB_PORT) || 3306, user: env.DB_USER, password: env.DB_PASSWORD,
        database: config.settings(env).database, dateStrings: true, connectionLimit: 3, connectTimeout: 5000,
    }));
    const settlement = () => require('./online-orders').createOnlineOrderService({ pool: database() });
    async function snapshot(orderId, userId) {
        const settings = config.settings(env);
        const db = await database().getConnection();
        let active = false;
        try {
            const [[actual]] = await db.query('SELECT DATABASE() AS database_name');
            if (actual.database_name !== settings.database) unavailable();
            await db.query('START TRANSACTION READ ONLY'); active = true;
            // One statement observes order, payment and DB time consistently.
            // No locks, attempt creation, expiry compensation or business writes.
            const [[order]] = await db.execute(`SELECT o.*${clock.selectOrderClock('o')},
                DATE_FORMAT(o.created_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') AS created_at_utc,
                DATE_FORMAT(o.payment_expires_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS payment_expires_at,
                TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',UTC_TIMESTAMP(3)) DIV 1000 AS now_ms,
                p.payment_id,p.payment_method,p.payment_status,p.amount AS payment_amount,p.transaction_date
                FROM orders o LEFT JOIN payments p ON p.order_id=o.order_id
                WHERE o.order_id=?${userId == null ? '' : ' AND o.user_id=?'}`,
            userId == null ? [orderId] : [orderId, userId]);
            await db.commit(); active = false;
            if (order) {
                clock.normalizeOrderClock(order);
                order.created_at_utc = iso(order.created_at_utc);
                order.payment_expires_at = iso(order.payment_expires_at);
            }
            return order;
        } finally {
            try { if (active) await db.rollback(); }
            finally { db.release(); }
        }
    }
    function state(order) {
        if (!order) return 'not_found';
        if (order.workflow_version !== 2 || order.payment_method !== 'ONLINE') return 'unsupported_order';
        if (order.rejection_reason || order.cancellation_reason_code === 'admin_rejected') return 'rejected';
        if (order.status === 'Đã hủy' || order.stock_restored_at || order.cancelled_at) return 'cancelled';
        if (order.payment_status === 'Đã thanh toán' || order.transaction_date) return 'already_paid';
        const created = Date.parse(order.created_at_utc), deadline = Date.parse(order.payment_expires_at);
        if (!Number.isFinite(created) || !Number.isFinite(deadline) || deadline - created !== 86400000 ||
            !Number.isFinite(Number(order.now_ms)) || Number(order.now_ms) < created) return 'review_required';
        if (Number(order.now_ms) >= deadline) return 'expired';
        if (!order.payment_id || order.status !== 'Chờ thanh toán' || order.approved_at ||
            !['Chưa thanh toán', 'Thất bại'].includes(order.payment_status)) return 'review_required';
        try { policy.consistent(order, { payment_method: order.payment_method, payment_status: order.payment_status,
            amount: order.payment_amount, transaction_date: order.transaction_date }); }
        catch { return 'review_required'; }
        if (!/^[1-9][0-9]{0,9}\.00$/.test(order.total_amount)) return 'review_required';
        return null;
    }
    async function qrForOrder(userId, orderId) {
        const settings = config.settings(env);
        const writable = config.writesEnabled(env);
        if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(orderId) || orderId <= 0 || orderId > 2147483647) return null;
        const order = await snapshot(orderId, userId);
        if (state(order)) return null;
        const amount = order.total_amount.slice(0, -3);
        if (!config.supportsAmount(order.total_amount)) return null;
        if (writable) {
            try { await settlement().createSePayAttempt(userId, orderId, env); }
            catch (error) { if (error.status === 409) return null; throw error; }
        }
        const paymentCode = `PCS${order.order_id}`, transferContent = `SEVQR ${paymentCode}`;
        const url = new URL('https://vietqr.app/img');
        url.search = new URLSearchParams({ acc: settings.accountNumber, bank: settings.bank, amount, des: transferContent }).toString();
        return { provider: 'SEPAY', mode: settings.mode, reconciliationOnly: !writable, orderId: order.order_id,
            amount: order.total_amount, paymentCode, transferContent, expiresAt: order.payment_expires_at,
            qrUrl: url.toString(), bank: settings.bank, accountNumber: settings.accountNumber, accountName: settings.accountName };
    }
    async function reconcile(raw, headers, now = Date.now()) {
        const settings = config.settings(env);
        const event = provider.verify(raw, headers, settings, now);
        if (event.disposition) return { disposition: event.disposition, eligible: false, duplicate: false };
        if (config.writesEnabled(env)) {
            // File receipts/eligible results from Turn 1 are never consulted.
            // Canonical DB receipts and state updates commit in one transaction.
            const evidence = provider.issuePaymentEvent(raw, headers, env, now);
            try {
                const result = await settlement().confirmSePayEvent(evidence, env);
                return { ...result, duplicate: Boolean(result.replayed), eligible: false };
            } catch (error) {
                if (error.status === 404) return { disposition: 'not_found', duplicate: false, eligible: false };
                throw error;
            }
        }
        return serialize(directory, async () => {
            config.settings(env);
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            const lock = path.join(directory, '.lock');
            try { fs.mkdirSync(lock); } catch { unavailable(); }
            try {
                const ledger = path.join(directory, 'ledger.json');
                let receipts = [];
                try { receipts = JSON.parse(fs.readFileSync(ledger, 'utf8')); }
                catch (error) { if (error.code !== 'ENOENT') unavailable(); }
                if (!Array.isArray(receipts) || receipts.length > 1000 || receipts.some(row =>
                    !row || !['id', 'reference', 'fingerprint'].every(key => /^[a-f0-9]{64}$/.test(row[key])))) unavailable();
                const id = hash(['sepay', 'test', event.accountNumber, event.transactionId]);
                const reference = hash(['sepay', 'test', event.accountNumber, event.referenceCode]);
                const fingerprint = hash([event.accountNumber, event.orderId, event.transferAmount, event.referenceCode, event.paidAt]);
                const matches = receipts.filter(row => row.id === id || row.reference === reference);
                if (matches.some(row => row.fingerprint !== fingerprint)) return { disposition: 'event_conflict', eligible: false, duplicate: true };
                const duplicate = matches.length > 0;
                if (receipts.some(row => row.id === id)) return { disposition: 'duplicate', eligible: false, duplicate: true };
                if (receipts.length >= 1000) unavailable();
                let disposition = 'duplicate';
                if (!duplicate) {
                    const order = await snapshot(event.orderId);
                    disposition = state(order);
                    if (!disposition) {
                        if (event.paidAt >= Date.parse(order.payment_expires_at)) disposition = 'expired';
                        else if (event.paidAt < Date.parse(order.created_at_utc) || event.paidAt > Number(order.now_ms)) disposition = 'review_required';
                        else {
                            const expected = BigInt(order.total_amount.replace('.', ''));
                            const received = BigInt(event.transferAmount) * 100n;
                            disposition = received < expected ? 'underpaid' : received > expected ? 'overpaid' : 'eligible';
                        }
                    }
                }
                // Hashes + technical outcome only. No bank/account/order data,
                // amount, reference or secret is persisted in this local ledger.
                receipts.push({ id, reference, fingerprint, disposition, receivedAt: new Date(now).toISOString() });
                const temporary = path.join(directory, 'ledger.tmp');
                fs.writeFileSync(temporary, JSON.stringify(receipts), { mode: 0o600 });
                fs.renameSync(temporary, ledger);
                return { disposition, duplicate, eligible: !duplicate && disposition === 'eligible' };
            } finally { fs.rmdirSync(lock); }
        });
    }
    async function getStatus(userId, orderId) {
        const settings = config.settings(env), writable = config.writesEnabled(env);
        const order = await snapshot(orderId, userId);
        if (!order || order.workflow_version !== 2 || order.payment_method !== 'ONLINE') return null;
        let disposition = state(order) || 'pending';
        if (writable) {
            const db = await database().getConnection();
            try {
                const [[actual]] = await db.query('SELECT DATABASE() AS database_name');
                if (actual.database_name !== settings.database) unavailable();
                const [[event]] = await db.execute(`SELECT e.disposition FROM payment_events e
                    JOIN payment_attempts a ON a.attempt_id=e.attempt_id JOIN payments p ON p.payment_id=a.payment_id
                    JOIN orders o ON o.order_id=p.order_id WHERE o.order_id=? AND o.user_id=?
                    AND a.provider='SEPAY' AND a.provider_environment=?
                    ORDER BY e.event_id DESC LIMIT 1`, [orderId, userId, settings.providerEnvironment]);
                if (event?.disposition) disposition = event.disposition;
            } finally { db.release(); }
        }
        return { provider: 'SEPAY', mode: settings.mode, disposition,
            reviewRequired: ['manual_review', 'review_required', 'amount_mismatch', 'excess_capture', 'cancelled_order', 'late_capture'].includes(disposition) };
    }
    return { qrForOrder, reconcile, getStatus, async close() { await ownedPool?.end(); } };
}
// Existing receiver/fixtures cannot select Live even if given Live settings.
function createSePayTestService(options = {}) {
    config.testSettings(options.env);
    return createSePayService(options);
}
module.exports = { createSePayService, createSePayTestService };
