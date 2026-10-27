const pool = require('../config/db');
const { readDetail } = require('./order');

const states = ['Chờ xử lý', 'Chờ thanh toán', 'Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng', 'Đã hủy'];
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };

function consistent(order, payment) {
    if (!payment || !['COD', 'ONLINE'].includes(payment.payment_method) || payment.amount !== order.total_amount || !states.includes(order.status)) fail('Order/payment data needs review');
    if (order.status === 'Đã hủy') {
        if (!order.stock_restored_at || payment.payment_status !== 'Đã hủy') fail('Cancelled order stock/payment data needs review');
        return;
    }
    const allowedPayments = payment.payment_method === 'ONLINE' ? ['Chưa thanh toán', 'Thất bại', 'Đã thanh toán'] : ['Chưa thanh toán', 'Đã thanh toán'];
    if (order.stock_restored_at || !allowedPayments.includes(payment.payment_status)) fail('Order/payment state is inconsistent');
    if ((payment.payment_status === 'Đã thanh toán') !== Boolean(payment.transaction_date)) fail('Payment confirmation date is inconsistent');
    if (payment.payment_method === 'COD') {
        if (order.status === 'Chờ thanh toán') fail('Invalid COD order state');
        if ((order.status !== 'Chờ xử lý') !== Boolean(order.approved_at)) fail('COD approval state is inconsistent');
        if ((order.status === 'Đã giao hàng') !== (payment.payment_status === 'Đã thanh toán')) fail('COD delivery/payment state is inconsistent');
    } else {
        if (order.status === 'Chờ xử lý') fail('Invalid ONLINE order state');
        if (['Đã thanh toán', 'Thất bại'].includes(payment.payment_status) && !order.approved_at) fail('ONLINE payment requires prior approval');
        if (order.status !== 'Chờ thanh toán' && (!order.approved_at || payment.payment_status !== 'Đã thanh toán')) fail('ONLINE shipping requires approval and payment');
    }
}

async function mutate(adminId, orderId, action, target, cashReceived) {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const [[admin]] = await db.execute('SELECT role, status FROM `user` WHERE user_id = ? FOR SHARE', [adminId]);
        if (!admin || admin.role !== 'admin' || admin.status !== 'active') throw Object.assign(new Error('Active admin account required'), { status: 403 });
        const [[order]] = await db.execute('SELECT * FROM orders WHERE order_id = ? FOR UPDATE', [orderId]);
        if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
        const [[payment]] = await db.execute('SELECT * FROM payments WHERE order_id = ? FOR UPDATE', [orderId]);
        consistent(order, payment);
        if (action === 'approve') {
            if (['Đã hủy', 'Đã giao hàng'].includes(order.status)) fail('A terminal order cannot be approved');
            if (!order.approved_at) {
                const expected = payment.payment_method === 'COD' ? 'Chờ xử lý' : 'Chờ thanh toán';
                if (order.status !== expected || payment.payment_status !== 'Chưa thanh toán') fail('Order cannot be approved in its current state');
                await db.execute('UPDATE orders SET approved_at = NOW(), status = ? WHERE order_id = ?', [payment.payment_method === 'COD' ? 'Chờ giao hàng' : 'Chờ thanh toán', orderId]);
            }
        } else if (target === 'Đã hủy') {
            if (cashReceived !== undefined) fail('Cash receipt is only valid for COD delivery');
            if (order.status !== 'Đã hủy') {
                if (!['Chờ xử lý', 'Chờ thanh toán', 'Chờ giao hàng'].includes(order.status)) fail('Shipping or delivered orders cannot be cancelled');
                const unpaid = payment.payment_status === 'Chưa thanh toán' || (payment.payment_method === 'ONLINE' && payment.payment_status === 'Thất bại');
                if (!unpaid) fail('Paid orders require a refund workflow before cancellation');
                const [lines] = await db.execute('SELECT product_id, quantity FROM order_details WHERE order_id = ? ORDER BY product_id FOR UPDATE', [orderId]);
                if (!lines.length) fail('Order has no detail rows; stock restoration requires review');
                const quantities = new Map();
                for (const line of lines) {
                    if (!Number.isInteger(line.quantity) || line.quantity <= 0) fail('Invalid order quantity');
                    quantities.set(line.product_id, (quantities.get(line.product_id) || 0) + line.quantity);
                }
                for (const [productId, quantity] of quantities) {
                    if (!Number.isSafeInteger(quantity) || quantity > 2147483647) fail('Stock restoration exceeds capacity');
                    const [updated] = await db.execute('UPDATE products SET stock_quantity = stock_quantity + ? WHERE product_id = ? AND stock_quantity >= 0 AND stock_quantity <= ?', [quantity, productId, 2147483647 - quantity]);
                    if (updated.affectedRows !== 1) fail('Stock restoration requires review');
                }
                await db.execute('UPDATE orders SET status = ?, stock_restored_at = NOW() WHERE order_id = ?', ['Đã hủy', orderId]);
                await db.execute('UPDATE payments SET payment_status = ? WHERE order_id = ?', ['Đã hủy', orderId]);
            }
        } else {
            if (cashReceived !== undefined && (target !== 'Đã giao hàng' || payment.payment_method !== 'COD')) fail('Cash receipt is only valid for COD delivery');
            if (target !== order.status) {
                if (!order.approved_at) fail('Order must be approved first');
                const next = { 'Chờ thanh toán': 'Chờ giao hàng', 'Chờ giao hàng': 'Đang giao hàng', 'Đang giao hàng': 'Đã giao hàng' };
                if (next[order.status] !== target) fail('Invalid order status transition');
                if (payment.payment_method === 'ONLINE' && payment.payment_status !== 'Đã thanh toán') fail('ONLINE payment must be completed before shipping');
                if (target === 'Đã giao hàng' && payment.payment_method === 'COD') {
                    if (cashReceived !== true) fail('Explicit COD cash collection confirmation is required');
                    await db.execute('UPDATE payments SET payment_status = ?, transaction_date = NOW() WHERE order_id = ?', ['Đã thanh toán', orderId]);
                }
                await db.execute('UPDATE orders SET status = ? WHERE order_id = ?', [target, orderId]);
            }
        }
        const result = await readDetail(db, null, orderId);
        await db.commit();
        return result;
    } catch (error) {
        await db.rollback();
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            error.status = 409;
            error.message = 'Order is busy; retry the request';
        }
        throw error;
    } finally { db.release(); }
}

exports.states = states;
exports.approve = (adminId, orderId) => mutate(adminId, orderId, 'approve');
exports.update = (adminId, orderId, target, cashReceived) => mutate(adminId, orderId, 'status', target, cashReceived);
exports.get = orderId => readDetail(pool, null, orderId);
exports.list = async (page, limit, status) => {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const where = status ? 'WHERE status = ?' : '';
        const params = status ? [status] : [];
        const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM orders ${where}`, params);
        const [rows] = await db.query(`SELECT order_id FROM orders ${where} ORDER BY order_date DESC, order_id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
        const orders = [];
        for (const row of rows) orders.push(await readDetail(db, null, row.order_id));
        await db.commit();
        return { total, orders };
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
};
