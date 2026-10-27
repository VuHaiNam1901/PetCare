const pool = require('../config/db');

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function rejection(order, payment) {
    if (payment.payment_method !== 'ONLINE') return 'Only ONLINE orders support simulated payment';
    if (!order.approval_valid) return 'Admin approval is required before payment';
    if (order.status !== 'Chờ thanh toán' || order.stock_restored_at) return 'Order is not awaiting payment';
    if (!['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status)) return 'Payment is already completed or unavailable';
    if (payment.transaction_date || payment.amount !== order.total_amount) return 'Order/payment data needs review';
    return null;
}

function view(order, payment) {
    return {
        payment_id: payment.payment_id, order_id: order.order_id,
        payment_method: payment.payment_method, payment_status: payment.payment_status,
        amount: payment.amount, transaction_date: payment.transaction_date,
        created_at: payment.created_at, order_status: order.status,
        approved_at: order.approved_at, can_simulate: rejection(order, payment) === null,
        simulation_only: true
    };
}

async function information(db, userId, orderId) {
    // One statement gives a consistent order/payment snapshot without locking GETs.
    const [[row]] = await db.execute(`SELECT o.order_id, o.total_amount, o.status,
        o.approved_at, o.stock_restored_at,
        (o.approved_at IS NOT NULL AND o.approved_at > '1000-01-01' AND o.approved_at <= NOW()) AS approval_valid,
        p.payment_id, p.payment_method, p.payment_status, p.amount, p.transaction_date, p.created_at
        FROM orders o LEFT JOIN payments p ON p.order_id = o.order_id
        WHERE o.order_id = ? AND o.user_id = ?`, [orderId, userId]);
    if (!row) fail(404, 'Order not found');
    if (!row.payment_id) fail(409, 'Payment record is missing; order needs review');
    return view(row, row);
}

exports.get = (userId, orderId) => information(pool, userId, orderId);

exports.simulate = async (userId, orderId, testCase) => {
    // Fixed synthetic cases only; no card, OTP, amount or status is accepted.
    const cases = { ONLINE_SUCCESS: 'success', ONLINE_FAILURE: 'failure' };
    if (!Object.hasOwn(cases, testCase)) fail(400, 'Invalid simulation test case');
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const [[user]] = await db.execute('SELECT role, status FROM `user` WHERE user_id = ? FOR SHARE', [userId]);
        if (!user || user.role !== 'user' || user.status !== 'active') fail(403, 'Active user account required');
        // Same order -> payment lock order as UC18, so cancellation and payment
        // cannot both succeed, and concurrent success is recorded only once.
        const [[order]] = await db.execute(`SELECT *,
            (approved_at IS NOT NULL AND approved_at > '1000-01-01' AND approved_at <= NOW()) AS approval_valid
            FROM orders WHERE order_id = ? AND user_id = ? FOR UPDATE`, [orderId, userId]);
        if (!order) fail(404, 'Order not found');
        const [[payment]] = await db.execute('SELECT * FROM payments WHERE order_id = ? FOR UPDATE', [orderId]);
        if (!payment) fail(409, 'Payment record is missing; order needs review');
        const reason = rejection(order, payment);
        if (reason) fail(409, reason);
        const outcome = cases[testCase];
        const succeeded = outcome === 'success';
        await db.execute(`UPDATE payments SET payment_status = ?, transaction_date = ${succeeded ? 'NOW()' : 'NULL'} WHERE order_id = ?`, [succeeded ? 'Đã thanh toán' : 'Thất bại', orderId]);
        await db.execute('UPDATE orders SET status = ? WHERE order_id = ?', [succeeded ? 'Chờ giao hàng' : 'Chờ thanh toán', orderId]);
        const result = await information(db, userId, orderId);
        await db.commit();
        return { simulated: true, outcome, payment: result };
    } catch (error) {
        await db.rollback();
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            error.status = 409;
            error.message = 'Payment is busy; reload payment information before retrying';
        }
        throw error;
    } finally { db.release(); }
};
