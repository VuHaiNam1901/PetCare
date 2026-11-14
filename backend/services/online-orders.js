const { createHash, randomUUID } = require('node:crypto');
const config = require('../config/order-workflow');
const provider = require('../providers/simulated-payments');
const { selectOrderClock, normalizeOrderClock } = require('../models/order-time');

const VERSION = 2;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function fail(message, status = 409, code = 'ONLINE_ORDER_CONFLICT') { throw Object.assign(new Error(message), { status, code }); }
const isNewOnline = (order, payment) => Number(order.workflow_version) === VERSION && payment?.payment_method === 'ONLINE';
const decimal = value => BigInt(String(value).replace('.', ''));
function utc(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).getUTCFullYear() < 2000) return null;
    const normalized = new Date(milliseconds).toISOString();
    // Date.parse normalizes impossible calendar dates; those are not evidence.
    if (normalized.slice(0, 19) !== value.slice(0, 19)) return null;
    return { milliseconds, sql: normalized.slice(0, 23).replace('T', ' ') };
}
async function clock(db) {
    const [[value]] = await db.query("SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000 AS now_ms, DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%d %H:%i:%s.%f') AS now_sql");
    return { milliseconds: Number(value.now_ms), sql: value.now_sql };
}
async function timing(db, orderId) {
    const [[value]] = await db.execute("SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', created_at_utc) DIV 1000 AS created_ms, TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', payment_expires_at) DIV 1000 AS expires_ms FROM orders WHERE order_id = ?", [orderId]);
    if (!value || value.created_ms == null || value.expires_ms == null || Number(value.expires_ms) - Number(value.created_ms) !== 86400000) fail('Online payment deadline needs review');
    return { created: Number(value.created_ms), expires: Number(value.expires_ms) };
}

function createOnlineOrderService({ pool, logger = console } = {}) {
    const database = () => pool || require('../config/db');
    async function assertReady(db = database()) {
        try {
            // Verification is read-only and validates types, indexes, constraints,
            // dependencies and completed checksummed ledger entries, not names alone.
            // 007 verifies its complete 006 dependency as well.
            await require('../migrations/007-payment-attempts-refunds').verify(db);
        } catch {
            fail('Online workflow migrations 006 and 007 are incomplete or schema differs', 503, 'ONLINE_SCHEMA_NOT_READY');
        }
        return true;
    }
    async function assertSimulatorDatabase(db) {
        config.assertSimulationAllowed();
        const [[row]] = await db.query('SELECT DATABASE() AS database_name');
        if (row.database_name !== process.env.PETCARE_TEST_DATABASE || row.database_name !== process.env.DB_NAME || !/^petcare_test_[a-f0-9]{32}$/.test(row.database_name || '')) fail('Simulator requires the selected isolated test database', 403, 'SIMULATOR_FORBIDDEN');
    }
    async function transaction(action, { simulator = false } = {}) {
        const db = await database().getConnection();
        try {
            if (simulator) await assertSimulatorDatabase(db);
            await assertReady(db);
            await db.beginTransaction();
            const result = await action(db);
            await db.commit();
            return result;
        } catch (error) {
            try { await db.rollback(); } catch { /* Preserve ambiguous commit errors. */ }
            if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_DUP_ENTRY'].includes(error.code)) {
                error.status = 409; error.code = 'ONLINE_RETRY'; error.retryable = true;
                error.message = 'Online order is busy; retry using the original reference';
            }
            throw error;
        } finally { db.release(); }
    }
    function checkOrder(order, payment) {
        if (!isNewOnline(order, payment)) fail('Only version 2 ONLINE orders use this service');
        if (!order.stock_reserved_at || !order.stock_reservation_source || payment.amount !== order.total_amount) fail('Online order reservation/payment needs review');
        require('../models/order-policy').consistent(order, payment);
    }
    async function assertAppliedPayment(db, order, payment) {
        checkOrder(order, payment);
        if (payment.payment_status !== 'Đã thanh toán' || !payment.transaction_date) fail('Online delivery requires a verified applied payment');
        const [captures] = await db.execute(`SELECT *,
            TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',initiated_at_utc) DIV 1000 AS initiated_ms,
            TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',provider_paid_at_utc) DIV 1000 AS provider_paid_ms
            FROM payment_attempts WHERE payment_id=? AND status='succeeded' AND disposition='applied'
            ORDER BY attempt_id FOR UPDATE`, [payment.payment_id]);
        if (captures.length !== 1) fail('Online payment has no unique verified applied capture');
        const attempt = captures[0];
        const receiptKey = hash(`receipt:${attempt.provider}:${attempt.provider_environment}:${attempt.provider_transaction_id}`);
        const [[receipt]] = await db.execute(`SELECT *,
            TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',provider_paid_at_utc) DIV 1000 AS provider_paid_ms
            FROM payment_events WHERE attempt_id=? AND event_key=? FOR UPDATE`, [attempt.attempt_id, receiptKey]);
        const times = await timing(db, order.order_id), now = await clock(db);
        const paidAt = receipt?.provider_paid_ms == null ? NaN : Number(receipt.provider_paid_ms);
        if (!receipt || receipt.event_type !== 'succeeded' || receipt.disposition !== 'applied' || !receipt.verification_source ||
            !attempt.provider_transaction_id || receipt.provider_transaction_id !== attempt.provider_transaction_id ||
            receipt.amount !== payment.amount || attempt.amount !== payment.amount || attempt.captured_amount !== payment.amount ||
            receipt.currency !== 'VND' || attempt.currency !== receipt.currency || attempt.captured_currency !== receipt.currency ||
            !attempt.confirmed_at_utc || !attempt.received_at_utc || !receipt.received_at_utc ||
            !Number.isFinite(paidAt) || attempt.provider_paid_ms == null || paidAt !== Number(attempt.provider_paid_ms) ||
            attempt.initiated_ms == null || paidAt < Number(attempt.initiated_ms) || paidAt < times.created ||
            paidAt >= times.expires || paidAt > now.milliseconds) fail('Online payment capture evidence needs review');
        return { attempt_id: attempt.attempt_id, event_id: receipt.event_id };
    }
    async function append(db, order, toStatus, action, eventKey, { reason = null, actorId = null, actorName = null } = {}) {
        await db.execute(`INSERT INTO order_status_history
            (order_id,from_status,to_status,action,actor_id,actor_name,reason,created_at,event_key)
            VALUES (?,?,?,?,?,?,?,NOW(3),?)`, [order.order_id, order.status, toStatus, action, actorId, actorName, reason, eventKey]);
    }
    // The caller owns the order/payment locks and has checked order consistency.
    // This also serves legacy orders whose reservation was verified by migration
    // 005 from their checkout fingerprint rather than a reservation timestamp.
    async function releaseStockLocked(db, order) {
        if (order.stock_restored_at) return false;
        const reserved = order.stock_reservation_valid !== undefined
            ? Boolean(order.stock_reserved_at) && Number(order.stock_reservation_valid) === 1
            : order.stock_reserved_at && new Date(order.stock_reserved_at).getFullYear() > 1000 && new Date(order.stock_reserved_at).getTime() <= Date.now();
        if (!reserved && order.stock_reservation_source !== 'checkout-v4-fingerprint') fail('Missing stock reservation proof');
        const [lines] = await db.execute('SELECT product_id,quantity FROM order_details WHERE order_id = ? ORDER BY product_id FOR UPDATE', [order.order_id]);
        if (!lines.length) fail('Order has no inventory lines');
        const quantities = new Map();
        for (const line of lines) {
            if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) fail('Invalid reserved inventory quantity');
            quantities.set(line.product_id, (quantities.get(line.product_id) || 0) + line.quantity);
        }
        // Validate every row first; do not expose partial release even on failure.
        for (const [productId, quantity] of [...quantities].sort((a, b) => a[0] - b[0])) {
            const [[product]] = await db.execute('SELECT stock_quantity FROM products WHERE product_id = ? FOR UPDATE', [productId]);
            if (!Number.isSafeInteger(quantity) || quantity > 2147483647 || !product || !Number.isInteger(product.stock_quantity) || product.stock_quantity < 0 || product.stock_quantity > 2147483647 - quantity) fail('Reserved inventory requires manual review', 409, 'STOCK_REVIEW_REQUIRED');
        }
        const [marked] = await db.execute('UPDATE orders SET stock_restored_at = NOW() WHERE order_id = ? AND stock_restored_at IS NULL', [order.order_id]);
        if (marked.affectedRows !== 1) return false;
        for (const [productId, quantity] of [...quantities].sort((a, b) => a[0] - b[0])) {
            const [result] = await db.execute('UPDATE products SET stock_quantity = stock_quantity + ? WHERE product_id = ? AND stock_quantity >= 0 AND stock_quantity <= ?', [quantity, productId, 2147483647 - quantity]);
            if (result.affectedRows !== 1) fail('Stock release failed', 409, 'STOCK_REVIEW_REQUIRED');
        }
        order.stock_restored_at = true;
        return true;
    }
    async function requestRefund(db, attempt, reason, now, receipt = null) {
        if (!receipt) {
            const receiptKey = hash(`receipt:${attempt.provider}:${attempt.provider_environment}:${attempt.provider_transaction_id}`);
            [[receipt]] = await db.execute("SELECT event_id,provider_transaction_id,amount,currency FROM payment_events WHERE attempt_id=? AND event_key=? AND event_type='succeeded' FOR UPDATE", [attempt.attempt_id, receiptKey]);
        }
        const amount = receipt?.amount;
        if (!amount || decimal(amount) <= 0n || receipt.currency !== 'VND' || !receipt.provider_transaction_id || !receipt.event_id) fail('Refund requires verified capture evidence');
        // The transaction, rather than attempt, identifies money: a provider can
        // exceptionally report two captures against the same merchant reference.
        const businessKey = `capture:${hash(`${attempt.provider}:${attempt.provider_environment}:${receipt.provider_transaction_id}`)}`;
        const [[existing]] = await db.execute('SELECT * FROM refund_requests WHERE business_key = ? FOR UPDATE', [businessKey]);
        if (existing) return existing;
        const [[{ total }]] = await db.execute("SELECT COALESCE(SUM(amount),0) AS total FROM refund_requests WHERE payment_event_id = ? AND status IN ('requested','submitted','processing','succeeded','unknown','manual_review')", [receipt.event_id]);
        if (decimal(total) + decimal(amount) > decimal(receipt.amount)) fail('Refund exceeds the verified capture');
        const [created] = await db.execute(`INSERT INTO refund_requests
            (attempt_id,payment_event_id,provider,provider_environment,business_key,amount,currency,reason_code,status,requested_at_utc,updated_at_utc)
            VALUES (?,?,?,?,?,?,?,?,'requested',?,?)`, [attempt.attempt_id, receipt.event_id, attempt.provider, attempt.provider_environment, businessKey, amount, receipt.currency, reason, now.sql, now.sql]);
        const eventKey = hash(`refund-request:${businessKey}`);
        await db.execute(`INSERT INTO refund_events
            (refund_id,event_key,payload_hash,status,verification_source,created_at_utc)
            VALUES (?,?,?,'requested',NULL,?)`, [created.insertId, eventKey, hash({ businessKey, amount, reason }), now.sql]);
        return { refund_id: created.insertId, attempt_id: attempt.attempt_id, amount, currency: receipt.currency, status: 'requested' };
    }
    async function expireLocked(db, order, payment) {
        if (!isNewOnline(order, payment)) return { expired: false };
        checkOrder(order, payment);
        if (order.status !== 'Chờ thanh toán' || order.approved_at || order.stock_restored_at || !['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status) || payment.transaction_date) return { expired: false };
        const times = await timing(db, order.order_id), now = await clock(db);
        if (now.milliseconds < times.expires) return { expired: false };
        if (order.voucher_code_snapshot) await require('../models/voucher').releaseLocked(db, order);
        await releaseStockLocked(db, order);
        await db.execute("UPDATE orders SET status = 'Đã hủy', cancelled_at = ?, cancellation_reason_code = 'payment_expired' WHERE order_id = ?", [now.sql, order.order_id]);
        await db.execute("UPDATE payments SET payment_status = 'Đã hủy' WHERE payment_id = ?", [payment.payment_id]);
        await append(db, order, 'Đã hủy', 'payment_expired', `expiry:${order.order_id}`, { reason: 'Đơn Online hết hạn thanh toán 24 giờ.' });
        order.status = 'Đã hủy'; order.cancellation_reason_code = 'payment_expired'; payment.payment_status = 'Đã hủy';
        return { expired: true, order_id: order.order_id };
    }
    async function expireAfterProviderEvent(db, order, payment) {
        // Monetary ingestion must survive a recoverable inventory problem. Only
        // the expiry compensation is rolled back; receipt/event/refund writes
        // remain in the outer transaction and still require a successful COMMIT.
        const savedOrder = { ...order }, savedPayment = { ...payment };
        await db.query('SAVEPOINT provider_expiry_compensation');
        try {
            const result = await expireLocked(db, order, payment);
            await db.query('RELEASE SAVEPOINT provider_expiry_compensation');
            return result;
        } catch (error) {
            try {
                await db.query('ROLLBACK TO SAVEPOINT provider_expiry_compensation');
                await db.query('RELEASE SAVEPOINT provider_expiry_compensation');
            } catch {
                // A deadlock or lost connection may have destroyed the entire
                // transaction. Never claim durable ingestion in that situation.
                throw error;
            }
            Object.assign(order, savedOrder);
            Object.assign(payment, savedPayment);
            const code = /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'EXPIRY_COMPENSATION_FAILED';
            try { logger.error('[ONLINE_COMPENSATION_PENDING]', { order_id: order.order_id, code }); }
            catch { /* Logging failure must not roll back verified monetary evidence. */ }
            return { expired: false, compensation_pending: true, compensation_error: code };
        }
    }
    async function cancelOnlineLocked(db, order, payment, { reason, actorId, actorName, customer = false }) {
        checkOrder(order, payment);
        if (order.status === 'Đã hủy') {
            if (customer || order.cancellation_reason_code !== 'admin_rejected' || order.rejection_reason !== reason) fail('Order was already cancelled for another reason');
            return { changed: false };
        }
        if (order.approved_at || !['Chờ thanh toán', 'Chờ xử lý'].includes(order.status)) fail('Only orders awaiting approval or payment can be rejected');
        if (typeof reason !== 'string' || !reason.trim() || [...reason.trim()].length > 500) fail('A rejection reason is required', 400);
        const reasonCode = customer ? 'customer_cancelled' : 'admin_rejected';
        const now = await clock(db);
        if (payment.payment_status === 'Đã thanh toán') {
            // A summary is not enough to authorize a financial request either.
            // Rejection must verify the same original receipt as fulfillment.
            await assertAppliedPayment(db, order, payment);
            const [captures] = await db.execute("SELECT * FROM payment_attempts WHERE payment_id = ? AND status = 'succeeded' AND disposition = 'applied' ORDER BY attempt_id FOR UPDATE", [payment.payment_id]);
            if (captures.length !== 1 || !payment.transaction_date) fail('Paid order has no unique verified applied capture');
            await requestRefund(db, captures[0], reasonCode, now);
        } else if (!['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status) || payment.transaction_date) fail('Payment state requires review');
        if (order.voucher_code_snapshot) await require('../models/voucher').releaseLocked(db, order);
        await releaseStockLocked(db, order);
        await db.execute("UPDATE orders SET status = 'Đã hủy', rejection_reason = ?, cancelled_at = ?, cancellation_reason_code = ? WHERE order_id = ?", [customer ? null : reason.trim(), now.sql, reasonCode, order.order_id]);
        if (payment.payment_status !== 'Đã thanh toán') await db.execute("UPDATE payments SET payment_status = 'Đã hủy' WHERE payment_id = ?", [payment.payment_id]);
        await append(db, order, 'Đã hủy', customer ? 'cancel' : 'reject', `${customer ? 'customer-cancel' : 'reject'}:${order.order_id}`, { reason: reason.trim(), actorId, actorName });
        return { changed: true };
    }
    const rejectLocked = (db, order, payment, options) => cancelOnlineLocked(db, order, payment, { ...options, customer: false });
    const cancelLocked = (db, order, payment, options) => cancelOnlineLocked(db, order, payment, { ...options, customer: true });
    async function createAttempt(userId, orderId, key) {
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) fail('Invalid payment idempotency key', 400);
        const result = await transaction(async db => {
            const [[user]] = await db.execute('SELECT role,status FROM `user` WHERE user_id = ? FOR SHARE', [userId]);
            if (!user || user.role !== 'user' || user.status !== 'active') fail('Active user account required', 403);
            const [[order]] = await db.execute(`SELECT *${selectOrderClock()} FROM orders WHERE order_id = ? AND user_id = ? FOR UPDATE`, [orderId, userId]);
            if (!order) fail('Order not found', 404);
            normalizeOrderClock(order);
            const [[payment]] = await db.execute('SELECT * FROM payments WHERE order_id = ? FOR UPDATE', [orderId]);
            checkOrder(order, payment);
            const fingerprint = hash({ paymentId: payment.payment_id, amount: payment.amount, currency: 'VND', provider: 'SIMULATOR', environment: 'test' });
            const [[previous]] = await db.execute('SELECT * FROM payment_attempts WHERE payment_id = ? AND idempotency_key_hash = ? FOR UPDATE', [payment.payment_id, hash(key)]);
            if (previous) {
                if (previous.fingerprint !== fingerprint) fail('Payment key was already used for another request');
                return { ...previous, replayed: true };
            }
            if (order.status !== 'Chờ thanh toán' || order.approved_at || order.stock_restored_at || !['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status) || payment.transaction_date) fail('Order is not awaiting payment');
            if ((await expireLocked(db, order, payment)).expired) return { expired: true };
            const reference = randomUUID(), now = await clock(db);
            if (now.milliseconds >= (await timing(db, order.order_id)).expires) {
                await expireLocked(db, order, payment);
                return { expired: true };
            }
            const [created] = await db.execute(`INSERT INTO payment_attempts
                (payment_id,provider,provider_environment,merchant_reference,idempotency_key_hash,fingerprint,amount,currency,status,initiated_at_utc)
                SELECT ?,'SIMULATOR','test',?,?,?,?,'VND','initiated',UTC_TIMESTAMP(3)
                FROM orders WHERE order_id=? AND payment_expires_at > UTC_TIMESTAMP(3)`, [payment.payment_id, reference, hash(key), fingerprint, payment.amount, order.order_id]);
            if (created.affectedRows !== 1) {
                await expireLocked(db, order, payment);
                return { expired: true };
            }
            return { attempt_id: created.insertId, payment_id: payment.payment_id, merchant_reference: reference, amount: payment.amount, currency: 'VND', status: 'initiated', replayed: false };
        }, { simulator: true });
        if (result.expired) fail('Order payment deadline has expired', 409, 'PAYMENT_EXPIRED');
        return result;
    }
    async function confirmProviderEvent(input) {
        const evidence = provider.assertVerifiedPayment(input);
        return transaction(async db => {
            const [[target]] = await db.execute(`SELECT a.attempt_id,p.order_id FROM payment_attempts a JOIN payments p ON p.payment_id=a.payment_id
                WHERE a.provider=? AND a.provider_environment=? AND a.merchant_reference=?`, [evidence.provider, evidence.providerEnvironment, evidence.merchantReference]);
            if (!target) fail('Payment attempt not found', 404);
            const [[order]] = await db.execute(`SELECT *${selectOrderClock()} FROM orders WHERE order_id = ? FOR UPDATE`, [target.order_id]);
            normalizeOrderClock(order);
            const [[payment]] = await db.execute('SELECT * FROM payments WHERE order_id = ? FOR UPDATE', [target.order_id]);
            checkOrder(order, payment);
            const [[attempt]] = await db.execute('SELECT * FROM payment_attempts WHERE attempt_id = ? FOR UPDATE', [target.attempt_id]);
            const eventKey = hash(`callback:${evidence.provider}:${evidence.providerEnvironment}:${evidence.eventId}`), payloadHash = hash(evidence);
            const [[priorEvent]] = await db.execute('SELECT * FROM payment_events WHERE event_key = ? FOR UPDATE', [eventKey]);
            if (priorEvent) {
                if (priorEvent.payload_hash !== payloadHash || String(priorEvent.attempt_id) !== String(attempt.attempt_id)) fail('Provider event ID was replayed with different data');
                return { replayed: true, disposition: priorEvent.disposition, attempt_id: attempt.attempt_id };
            }
            const now = await clock(db), paid = utc(evidence.paidAtUtc);
            let disposition, refundReason = null, receipt = null, compensation = {};
            // The canonical receipt key provides a unique monetary identity even
            // when two captures use the same attempt, or callbacks use new IDs.
            // Callback audit keys occupy a separate namespace. Financial totals
            // must use canonical receipt identities, never sum callback rows.
            if (evidence.status === 'succeeded') {
                const receiptKey = hash(`receipt:${evidence.provider}:${evidence.providerEnvironment}:${evidence.providerTransactionId}`);
                const receiptHash = hash({ provider: evidence.provider, environment: evidence.providerEnvironment,
                    merchantReference: evidence.merchantReference, transactionId: evidence.providerTransactionId,
                    amount: evidence.amount, currency: evidence.currency, paidAtUtc: paid?.sql ?? evidence.paidAtUtc });
                const [[existingReceipt]] = await db.execute('SELECT * FROM payment_events WHERE event_key=? FOR UPDATE', [receiptKey]);
                if (existingReceipt) {
                    if (String(existingReceipt.attempt_id) !== String(attempt.attempt_id)) fail('Provider transaction belongs to another attempt');
                    disposition = existingReceipt.payload_hash === receiptHash ? existingReceipt.disposition : 'manual_review';
                    await db.execute(`INSERT INTO payment_events
                        (attempt_id,event_key,event_type,payload_hash,provider_transaction_id,amount,currency,provider_paid_at_utc,received_at_utc,verification_source,disposition)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [attempt.attempt_id, eventKey, evidence.status, payloadHash, evidence.providerTransactionId, evidence.amount, evidence.currency, paid?.sql || null, now.sql, evidence.verificationSource, disposition]);
                    return { replayed: true, disposition, attempt_id: attempt.attempt_id };
                }
                const [[collision]] = await db.execute('SELECT attempt_id FROM payment_attempts WHERE provider=? AND provider_environment=? AND provider_transaction_id=? FOR UPDATE', [evidence.provider, evidence.providerEnvironment, evidence.providerTransactionId]);
                if (collision && String(collision.attempt_id) !== String(attempt.attempt_id)) fail('Provider transaction belongs to another attempt');
                const [reserved] = await db.execute(`INSERT INTO payment_events
                    (attempt_id,event_key,event_type,payload_hash,provider_transaction_id,amount,currency,provider_paid_at_utc,received_at_utc,verification_source,disposition)
                    VALUES (?,?,'succeeded',?,?,?,?,?,?,?,NULL)`, [attempt.attempt_id, receiptKey, receiptHash, evidence.providerTransactionId, evidence.amount, evidence.currency, paid?.sql || null, now.sql, evidence.verificationSource]);
                receipt = { event_id: reserved.insertId, provider_transaction_id: evidence.providerTransactionId, amount: evidence.amount, currency: evidence.currency };
            }
            // A callback replay must never turn yesterday's accepted receipt into
            // a late payment, and a failure must never overwrite a captured state.
            const captured = ['succeeded', 'captured_unapplied'].includes(attempt.status);
            // A captured attempt without its canonical receipt is inconsistent;
            // do not manufacture an applied receipt from a later callback.
            if (captured && attempt.provider_transaction_id === evidence.providerTransactionId) disposition = 'manual_review';
            else if (captured) {
                disposition = evidence.status === 'succeeded' ? 'excess_capture' : 'manual_review';
                if (evidence.status === 'succeeded') refundReason = disposition;
            }
            else if (evidence.status === 'unknown') {
                disposition = 'unknown';
                await db.execute("UPDATE payment_attempts SET status='unknown',received_at_utc=? WHERE attempt_id=?", [now.sql, attempt.attempt_id]);
                compensation = await expireAfterProviderEvent(db, order, payment);
            }
            else if (evidence.status === 'failed') {
                disposition = 'failed';
                await db.execute("UPDATE payment_attempts SET status='failed',received_at_utc=? WHERE attempt_id=?", [now.sql, attempt.attempt_id]);
                if (order.status === 'Chờ thanh toán' && ['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status)) {
                    await db.execute("UPDATE payments SET payment_status='Thất bại' WHERE payment_id=?", [payment.payment_id]);
                    payment.payment_status = 'Thất bại';
                }
                compensation = await expireAfterProviderEvent(db, order, payment);
            } else {
                const times = await timing(db, order.order_id);
                const [[initiation]] = await db.execute("SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', initiated_at_utc) DIV 1000 AS initiated_ms FROM payment_attempts WHERE attempt_id=?", [attempt.attempt_id]);
                const validProviderTime = paid && paid.milliseconds >= times.created && paid.milliseconds >= Number(initiation.initiated_ms) && paid.milliseconds <= now.milliseconds;
                // A trusted provider can assert a capture while supplying an
                // unusable time. Retain that money claim for manual review; a
                // requested refund is never permission to submit or mark it paid.
                const matchingAmount = evidence.amount === attempt.amount && evidence.currency === attempt.currency;
                const onTime = validProviderTime && paid.milliseconds < times.expires;
                const active = order.status === 'Chờ thanh toán' && !order.approved_at && !order.stock_restored_at && ['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status) && !payment.transaction_date;
                disposition = active && onTime && matchingAmount ? 'applied' : !validProviderTime ? 'manual_review' : !matchingAmount ? 'amount_mismatch' : payment.payment_status === 'Đã thanh toán' ? 'excess_capture' : order.status === 'Đã hủy' ? 'cancelled_order' : 'late_capture';
                await db.execute(`UPDATE payment_attempts SET status=?,disposition=?,provider_transaction_id=?,captured_amount=?,captured_currency=?,provider_paid_at_utc=?,received_at_utc=?,confirmed_at_utc=? WHERE attempt_id=?`,
                    [disposition === 'applied' ? 'succeeded' : 'captured_unapplied', disposition, evidence.providerTransactionId, evidence.amount, evidence.currency, paid?.sql || null, now.sql, now.sql, attempt.attempt_id]);
                Object.assign(attempt, { provider_transaction_id: evidence.providerTransactionId, captured_amount: evidence.amount, captured_currency: evidence.currency });
                if (disposition === 'applied') {
                    // transaction_date retains the legacy local-time convention;
                    // the actual verified provider time is stored separately UTC.
                    await db.execute("UPDATE payments SET payment_status='Đã thanh toán',transaction_date=NOW() WHERE payment_id=?", [payment.payment_id]);
                    if (order.voucher_code_snapshot) await require('../models/voucher').consumeLocked(db, order, { ...payment, payment_status: 'Đã thanh toán' });
                    await db.execute("UPDATE orders SET status='Chờ xử lý' WHERE order_id=?", [order.order_id]);
                    await append(db, order, 'Chờ xử lý', 'payment', `capture:${attempt.attempt_id}`);
                } else {
                    refundReason = disposition;
                }
            }
            if (receipt) await db.execute('UPDATE payment_events SET disposition=? WHERE event_id=?', [disposition, receipt.event_id]);
            await db.execute(`INSERT INTO payment_events
                (attempt_id,event_key,event_type,payload_hash,provider_transaction_id,amount,currency,provider_paid_at_utc,received_at_utc,verification_source,disposition)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [attempt.attempt_id, eventKey, evidence.status, payloadHash, evidence.providerTransactionId, evidence.amount, evidence.currency, paid?.sql || null, now.sql, evidence.verificationSource, disposition]);
            if (refundReason) {
                await requestRefund(db, attempt, refundReason, now, receipt);
                compensation = await expireAfterProviderEvent(db, order, payment);
            }
            return { replayed: captured && attempt.provider_transaction_id === evidence.providerTransactionId, disposition, attempt_id: attempt.attempt_id,
                ...(compensation.compensation_pending ? { compensation_pending: true, compensation_error: compensation.compensation_error } : {}) };
        }, { simulator: true });
    }
    async function simulate(userId, orderId, testCase) {
        if (!['ONLINE_SUCCESS', 'ONLINE_FAILURE'].includes(testCase)) fail('Invalid simulation test case', 400);
        const attempt = await createAttempt(userId, orderId, `sim_${randomUUID()}`);
        const now = await clock(database());
        const result = await confirmProviderEvent(provider.issuePaymentEvent({ merchantReference: attempt.merchant_reference, amount: attempt.amount,
            status: testCase === 'ONLINE_SUCCESS' ? 'succeeded' : 'failed', paidAtUtc: new Date(now.milliseconds).toISOString() }));
        return { simulated: true, outcome: testCase === 'ONLINE_SUCCESS' ? 'success' : 'failure', ...result };
    }
    async function confirmRefundEvent(input) {
        const evidence = provider.assertVerifiedRefund(input);
        return transaction(async db => {
            const [[target]] = await db.execute(`SELECT p.order_id,p.payment_id,r.attempt_id FROM refund_requests r JOIN payment_attempts a ON a.attempt_id=r.attempt_id JOIN payments p ON p.payment_id=a.payment_id WHERE r.refund_id=?`, [evidence.refundId]);
            if (!target) fail('Refund request not found', 404);
            const [[order]] = await db.execute(`SELECT *${selectOrderClock()} FROM orders WHERE order_id=? FOR UPDATE`, [target.order_id]);
            normalizeOrderClock(order);
            const [[payment]] = await db.execute('SELECT * FROM payments WHERE payment_id=? FOR UPDATE', [target.payment_id]);
            checkOrder(order, payment);
            const [[attempt]] = await db.execute('SELECT * FROM payment_attempts WHERE attempt_id=? FOR UPDATE', [target.attempt_id]);
            const [[refund]] = await db.execute('SELECT * FROM refund_requests WHERE refund_id=? FOR UPDATE', [evidence.refundId]);
            const eventKey = hash(`refund:${evidence.provider}:${evidence.providerEnvironment}:${evidence.eventId}`), payloadHash = hash(evidence);
            const [[previous]] = await db.execute('SELECT * FROM refund_events WHERE event_key=? FOR UPDATE', [eventKey]);
            if (previous) {
                if (previous.payload_hash !== payloadHash || String(previous.refund_id) !== String(refund.refund_id)) fail('Refund event ID was replayed with different data');
                return { replayed: true, status: refund.status, refund_id: refund.refund_id };
            }
            if (attempt.provider !== evidence.provider || attempt.provider_environment !== evidence.providerEnvironment || evidence.amount !== refund.amount || evidence.currency !== refund.currency) fail('Refund evidence does not match request');
            if (refund.status === 'succeeded' && evidence.status === 'succeeded' && evidence.providerRefundId !== refund.provider_refund_id) fail('Completed refund has a different provider refund reference');
            const [[receipt]] = await db.execute("SELECT * FROM payment_events WHERE event_id=? AND attempt_id=? AND event_type='succeeded'", [refund.payment_event_id, attempt.attempt_id]);
            const receiptKey = receipt && hash(`receipt:${attempt.provider}:${attempt.provider_environment}:${receipt.provider_transaction_id}`);
            if (!receipt || receipt.event_key !== receiptKey || receipt.currency !== refund.currency || decimal(refund.amount) > decimal(receipt.amount)) fail('Refund exceeds verified capture');
            const now = await clock(db);
            let status = refund.status;
            if (refund.status !== 'succeeded') {
                const rank = { requested: 0, submitted: 1, processing: 2, failed: 2, unknown: 2, manual_review: 2, succeeded: 3 };
                if (evidence.status === 'succeeded' || rank[evidence.status] >= rank[refund.status]) status = evidence.status;
                await db.execute('UPDATE refund_requests SET status=?,updated_at_utc=?,provider_refund_id=COALESCE(?,provider_refund_id),confirmed_at_utc=? WHERE refund_id=?', [status, now.sql, evidence.providerRefundId, status === 'succeeded' ? now.sql : null, refund.refund_id]);
            }
            await db.execute(`INSERT INTO refund_events (refund_id,event_key,payload_hash,status,verification_source,provider_refund_id,created_at_utc) VALUES (?,?,?,?,?,?,?)`, [refund.refund_id, eventKey, payloadHash, evidence.status, evidence.verificationSource, evidence.providerRefundId, now.sql]);
            return { replayed: refund.status === 'succeeded', status, refund_id: refund.refund_id };
        }, { simulator: true });
    }
    async function readRefunds(db, orderId) {
        const [rows] = await db.execute(`SELECT r.refund_id,r.amount,r.currency,r.reason_code,r.status,r.requested_at_utc,r.updated_at_utc,r.confirmed_at_utc
            FROM refund_requests r JOIN payment_attempts a ON a.attempt_id=r.attempt_id JOIN payments p ON p.payment_id=a.payment_id WHERE p.order_id=? ORDER BY r.refund_id`, [orderId]);
        return rows;
    }
    async function expireBatch({ limit = 100, afterOrderId = 0 } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('Invalid expiration batch size', 400);
        if (!Number.isSafeInteger(afterOrderId) || afterOrderId < 0 || afterOrderId > 2147483647) fail('Invalid expiration cursor', 400);
        await assertReady();
        const [candidates] = await database().execute(`SELECT order_id FROM orders WHERE workflow_version=2 AND status='Chờ thanh toán' AND payment_expires_at <= UTC_TIMESTAMP(3) AND stock_restored_at IS NULL AND order_id > ? ORDER BY order_id LIMIT ${limit}`, [afterOrderId]);
        let expired = 0, skipped = 0;
        const errors = [];
        for (const candidate of candidates) {
            try {
                const result = await transaction(async db => {
                    const [[order]] = await db.execute(`SELECT *${selectOrderClock()} FROM orders WHERE order_id=? FOR UPDATE SKIP LOCKED`, [candidate.order_id]);
                    if (!order) return { expired: false };
                    normalizeOrderClock(order);
                    const [[payment]] = await db.execute('SELECT * FROM payments WHERE order_id=? FOR UPDATE', [order.order_id]);
                    return expireLocked(db, order, payment);
                });
                if (result.expired) expired++; else skipped++;
            } catch (error) { errors.push({ order_id: candidate.order_id, code: error.code || 'EXPIRY_FAILED' }); }
        }
        return { scanned: candidates.length, expired, skipped, errors, nextCursor: candidates.at(-1)?.order_id ?? afterOrderId };
    }
    return { assertReady, assertAppliedPayment, createAttempt, simulate, confirmProviderEvent, confirmRefundEvent, rejectLocked, cancelLocked, releaseStockLocked, expireLocked, expireBatch, readRefunds };
}

let singleton;
const defaultService = () => singleton ||= createOnlineOrderService();
module.exports = { createOnlineOrderService, isNewOnline };
for (const name of ['assertReady', 'assertAppliedPayment', 'createAttempt', 'simulate', 'confirmProviderEvent', 'confirmRefundEvent', 'rejectLocked', 'cancelLocked', 'releaseStockLocked', 'expireLocked', 'expireBatch', 'readRefunds']) module.exports[name] = (...args) => defaultService()[name](...args);
