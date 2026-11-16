const pool = require('../config/db');
const { approvalState, consistent, customerCanCancel } = require('./order-policy');
const history = require('./order-history');
const workflow = require('../config/order-workflow');
const clock = require('./order-time');
const sepay = require('../config/sepay');

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function rejection(order, payment) {
    if (payment.payment_method !== 'ONLINE') return 'Only ONLINE orders support simulated payment';
    if (order.workflow_version !== workflow.VERSION) return 'Historical Online orders require reconciliation';
    try { consistent(order, payment); } catch (error) { return error.message; }
    if (!order.payment_window_open) return 'Payment deadline has expired';
    if (order.status !== 'Chờ thanh toán' || order.stock_restored_at) return 'Order is not awaiting payment';
    if (!['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status)) return 'Payment is already completed or unavailable';
    if (payment.transaction_date || payment.amount !== order.total_amount) return 'Order/payment data needs review';
    return null;
}

async function assertOnlineCheckoutAllowed(db) {
    try {
        const settings = sepay.checkoutSettings();
        await sepay.assertWriteDatabase(db);
        await require('../services/online-orders').assertReady(db);
        return settings;
    } catch {
        throw Object.assign(new Error('Thanh toán trực tuyến hiện chưa khả dụng. Vui lòng chọn COD.'), { status: 503, code: 'ONLINE_PAYMENT_UNAVAILABLE' });
    }
}
exports.assertOnlineCheckoutAllowed = assertOnlineCheckoutAllowed;
exports.options = async () => {
    try {
        sepay.checkoutSettings(); // Disabled configurations never acquire a connection.
        const db = await pool.getConnection();
        try {
            const settings = await assertOnlineCheckoutAllowed(db);
            return { online_available: true, online_mode: settings.mode };
        } finally { db.release(); }
    } catch { return { online_available: false, online_mode: null }; }
};

function view(order, payment) {
    let simulationAllowed = true;
    try { workflow.assertSimulationAllowed(); } catch { simulationAllowed = false; }
    return {
        payment_id: payment.payment_id, order_id: order.order_id,
        payment_method: payment.payment_method, payment_status: payment.payment_status,
        amount: payment.amount, transaction_date: payment.transaction_date,
        created_at: payment.created_at, order_status: order.status,
        approved_at: order.approved_at, can_simulate: simulationAllowed && rejection(order, payment) === null,
        approval_state: approvalState({ ...order, payment_method: payment.payment_method }),
        rejection_reason: order.rejection_reason,
        can_cancel: customerCanCancel(order, payment),
        cancellation_reason_code: order.cancellation_reason_code ?? null,
        cancellation_reason: order.cancellation_reason ?? null,
        cancelled_at: order.cancelled_at ?? null,
        simulation_only: true, can_pay: false,
        payment_unavailable_reason: payment.payment_method === 'ONLINE'
            ? order.workflow_version === workflow.VERSION ? 'Thanh toán trực tuyến hiện chưa khả dụng.' : 'Đơn Online cũ cần cửa hàng đối soát; không thể mở thanh toán trên đơn này.'
            : null
    };
}

async function information(db, userId, orderId) {
    // One statement gives a consistent order/payment snapshot without locking GETs.
    const [[stored]] = await db.execute(`SELECT o.*${clock.selectOrderClock('o')}${clock.selectPaymentClock('p')},
        p.payment_id, p.payment_method, p.payment_status, p.amount, p.transaction_date, p.created_at
        FROM orders o LEFT JOIN payments p ON p.order_id = o.order_id
        WHERE o.order_id = ? AND o.user_id = ?`, [orderId, userId]);
    if (!stored) fail(404, 'Order not found');
    clock.normalizeOrderClock(stored);
    const row = stored.status === 'Đã hủy' ? history.withCancellation(stored, await history.read(db, orderId)) : stored;
    if (!row.payment_id) fail(409, 'Payment record is missing; order needs review');
    if (row.workflow_version === workflow.VERSION) {
        const [[window]] = await db.execute('SELECT payment_expires_at > UTC_TIMESTAMP(3) AS payment_window_open FROM orders WHERE order_id = ?', [orderId]);
        row.payment_window_open = Boolean(window.payment_window_open);
        const result = { ...view(row, row), workflow_version: row.workflow_version, payment_expires_at: row.payment_expires_at,
            refunds: await require('../services/online-orders').readRefunds(db, orderId) };
        let settings;
        try { settings = sepay.checkoutSettings(); } catch { /* Keep reading existing orders when payments are off. */ }
        if (row.payment_method === 'ONLINE' && settings) {
            const service = require('../services/sepay-test').createSePayService({ pool: db });
            const qr = await service.qrForOrder(userId, orderId);
            if (qr) result.sepay = qr;
            result.sepayStatus = await service.getStatus(userId, orderId);
            result.can_pay = Boolean(qr);
            result.payment_unavailable_reason = qr ? null : 'Đơn hàng hiện không đủ điều kiện thanh toán. Vui lòng cập nhật trạng thái hoặc liên hệ cửa hàng.';
            result.can_simulate = false;
            result.simulation_only = settings.mode === 'test';
            if (settings.mode === 'test') {
                if (qr) result.sepayTest = qr;
                result.sepayTestStatus = result.sepayStatus;
            }
        }
        return result;
    }
    return view(row, row);
}

exports.get = (userId, orderId) => information(pool, userId, orderId);

exports.simulate = async (userId, orderId, testCase) => {
    // Fixed synthetic cases only; no card, OTP, amount or status is accepted.
    const cases = { ONLINE_SUCCESS: 'success', ONLINE_FAILURE: 'failure' };
    if (!Object.hasOwn(cases, testCase)) fail(400, 'Invalid simulation test case');
    // Financial simulation is never allowed against application data, including
    // legacy orders. This endpoint remains available only in isolated tests.
    workflow.assertSimulationAllowed();
    const current = await information(pool, userId, orderId);
    if (current.workflow_version !== workflow.VERSION) fail(409, 'Đơn Online cũ cần cửa hàng đối soát; không thể thanh toán trên đơn này.');
    const result = await require('../services/online-orders').simulate(userId, orderId, testCase);
    return { simulated: true, outcome: cases[testCase], ...result, payment: await information(pool, userId, orderId) };
};
