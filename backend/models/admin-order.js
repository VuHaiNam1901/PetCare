const pool = require('../config/db');
const { readDetail } = require('./order');
const { states, consistent, isV2 } = require('./order-policy');
const { append: appendHistory } = require('./order-history');
const orderTime = require('./order-time');
const fail = (message, conflicts) => { throw Object.assign(new Error(message), { status: 409, ...(conflicts ? { code: 'STOCK_REVIEW_REQUIRED', conflicts } : {}) }); };

async function reservedProducts(db, order) {
    // Checkout already removes these quantities from available stock. A zero
    // available balance is valid: this order owns its recorded reservation.
    const [lines] = await db.execute('SELECT product_id, quantity FROM order_details WHERE order_id = ? ORDER BY product_id FOR UPDATE', [order.order_id]);
    if (!lines.length) fail('Đơn hàng không có sản phẩm; cần kiểm tra tồn kho.');
    const quantities = new Map();
    for (const line of lines) {
        if (!Number.isInteger(line.quantity) || line.quantity <= 0) fail(`Số lượng đã giữ của sản phẩm #${line.product_id} không hợp lệ.`);
        quantities.set(line.product_id, (quantities.get(line.product_id) || 0) + line.quantity);
    }
    const products = [];
    for (const [productId, quantity] of quantities) {
        if (!Number.isSafeInteger(quantity) || quantity > 2147483647) fail(`Số lượng sản phẩm #${productId} vượt giới hạn tồn kho.`);
        const [[product]] = await db.execute('SELECT product_id, name, stock_quantity FROM products WHERE product_id = ? FOR UPDATE', [productId]);
        if (!product || !Number.isInteger(product.stock_quantity) || product.stock_quantity < 0) fail(`Không xác nhận được lượng hàng đã giữ cho ${product?.name || `sản phẩm #${productId}`}; cần đối soát tồn kho.`, [{ product_id: productId, name: product?.name || null, stock_quantity: product?.stock_quantity ?? null, reserved_quantity: quantity }]);
        products.push({ ...product, quantity });
    }
    return products;
}

async function mutate(adminId, orderId, action, target, cashReceived, reason) {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const [[admin]] = await db.execute('SELECT role, status, full_name FROM `user` WHERE user_id = ? FOR SHARE', [adminId]);
        if (!admin || admin.role !== 'admin' || admin.status !== 'active') throw Object.assign(new Error('Active admin account required'), { status: 403 });
        const [[storedOrder]] = await db.execute(`SELECT *${orderTime.selectOrderClock()} FROM orders WHERE order_id = ? FOR UPDATE`, [orderId]);
        if (!storedOrder) throw Object.assign(new Error('Order not found'), { status: 404 });
        const order = orderTime.normalizeOrderClock(storedOrder);
        const [[payment]] = await db.execute(`SELECT *${orderTime.selectPaymentClock()} FROM payments WHERE order_id = ? FOR UPDATE`, [orderId]);
        if (payment) orderTime.normalizeOrderClock(payment);
        consistent(order, payment);
        if (isV2(order) && (action === 'approve' || (action === 'status' && ['Đang giao hàng', 'Đã giao hàng'].includes(target)))) {
            // A projection saying "paid" is insufficient authority to fulfill.
            // Verify the unique applied provider receipt under the same locks,
            // including retries of already approved/shipped states.
            await require('../services/online-orders').assertAppliedPayment(db, order, payment);
        }
        let nextStatus = order.status, changed = false, historyRecorded = false;
        if (action === 'approve') {
            if (['Đã hủy', 'Đã giao hàng'].includes(order.status)) fail('Không thể duyệt đơn hàng đã kết thúc.');
            if (!order.approved_at) {
                const expected = payment.payment_method === 'COD' || isV2(order) ? 'Chờ xử lý' : 'Chờ thanh toán';
                const expectedPayment = isV2(order) ? 'Đã thanh toán' : 'Chưa thanh toán';
                if (order.status !== expected || payment.payment_status !== expectedPayment) fail('Đơn hàng không còn chờ duyệt.');
                if (payment.payment_method === 'COD' && order.voucher_code_snapshot) await require('./voucher').consumeLocked(db, order, payment);
                await reservedProducts(db, order);
                nextStatus = payment.payment_method === 'COD' || isV2(order) ? 'Chờ giao hàng' : 'Chờ thanh toán';
                await db.execute('UPDATE orders SET approved_at = NOW(), status = ? WHERE order_id = ?', [nextStatus, orderId]);
                changed = true;
            }
        } else if (action === 'reject') {
            if (isV2(order)) {
                const result = await require('../services/online-orders').rejectLocked(db, order, payment, { reason, actorId: adminId, actorName: admin.full_name });
                changed = result.changed;
                nextStatus = 'Đã hủy';
                historyRecorded = true;
            } else if (order.status === 'Đã hủy') {
                if (order.rejection_reason !== reason) fail('Đơn hàng đã bị từ chối với lý do khác.');
            } else {
                const expected = payment.payment_method === 'COD' ? 'Chờ xử lý' : 'Chờ thanh toán';
                if (order.approved_at || order.status !== expected || payment.payment_status !== 'Chưa thanh toán') fail('Chỉ được từ chối đơn hàng đang chờ duyệt.');
                if (order.voucher_code_snapshot) await require('./voucher').releaseLocked(db, order);
                const products = await reservedProducts(db, order);
                for (const product of products) {
                    const [updated] = await db.execute('UPDATE products SET stock_quantity = stock_quantity + ? WHERE product_id = ? AND stock_quantity >= 0 AND stock_quantity <= ?', [product.quantity, product.product_id, 2147483647 - product.quantity]);
                    if (updated.affectedRows !== 1) fail(`Không thể hoàn tồn kho cho ${product.name}; toàn bộ thao tác đã hủy.`);
                }
                nextStatus = 'Đã hủy';
                await db.execute('UPDATE orders SET status = ?, stock_restored_at = NOW(), rejection_reason = ? WHERE order_id = ?', [nextStatus, reason, orderId]);
                await db.execute('UPDATE payments SET payment_status = ? WHERE order_id = ?', ['Đã hủy', orderId]);
                changed = true;
            }
        } else {
            if (target === 'Đã hủy') fail('Từ chối đơn qua thao tác Từ chối và cung cấp lý do; chỉ áp dụng trước khi duyệt.');
            if (cashReceived !== undefined && (target !== 'Đã giao hàng' || payment.payment_method !== 'COD')) fail('Xác nhận thu tiền chỉ áp dụng khi giao xong đơn COD.');
            if (target === 'Đã giao hàng' && payment.payment_method === 'COD' && cashReceived !== true) fail('Cần xác nhận đã giao hàng và đã thu tiền COD.');
            if (target !== order.status) {
                if (!order.approved_at) fail('Đơn hàng phải được duyệt trước.');
                // Only payment confirmation may advance ONLINE out of payment.
                const next = { 'Chờ giao hàng': 'Đang giao hàng', 'Đang giao hàng': 'Đã giao hàng' };
                if (next[order.status] !== target) fail('Không được chuyển ngược hoặc bỏ bước trạng thái đơn hàng.');
                if (payment.payment_method === 'ONLINE' && payment.payment_status !== 'Đã thanh toán') fail('Đơn Online phải được thanh toán thành công trước khi giao.');
                if (target === 'Đã giao hàng' && payment.payment_method === 'COD') await db.execute('UPDATE payments SET payment_status = ?, transaction_date = NOW() WHERE order_id = ?', ['Đã thanh toán', orderId]);
                nextStatus = target;
                await db.execute('UPDATE orders SET status = ? WHERE order_id = ?', [target, orderId]);
                changed = true;
            }
        }
        if (changed && !historyRecorded) await appendHistory(db, { orderId, fromStatus: order.status, toStatus: nextStatus, action, actorId: adminId, actorName: admin.full_name, reason: action === 'reject' ? reason : null,
            eventKey: isV2(order) ? `admin:${action}:${orderId}:${states.indexOf(nextStatus)}` : null });
        const result = await readDetail(db, null, orderId);
        await db.commit();
        return result;
    } catch (error) {
        try { await db.rollback(); } catch { /* Keep the business/commit error. */ }
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) { error.status = 409; error.message = 'Đơn hàng đang được xử lý. Vui lòng tải lại và thử lại.'; }
        throw error;
    } finally { db.release(); }
}

exports.states = states;
exports.approve = (adminId, orderId) => mutate(adminId, orderId, 'approve');
exports.reject = (adminId, orderId, reason) => mutate(adminId, orderId, 'reject', undefined, undefined, reason);
exports.update = (adminId, orderId, target, cashReceived) => mutate(adminId, orderId, 'status', target, cashReceived);
exports.get = async orderId => {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const order = await readDetail(db, null, orderId);
        await db.commit(); return order;
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
};
exports.list = async (page, limit, status, q, approval) => {
    const db = await pool.getConnection();
    try {
        await db.beginTransaction();
        const conditions = [], params = [];
        if (status) { conditions.push('o.status = ?'); params.push(status); }
        if (q) {
            const orderId = /^#?[1-9]\d*$/.test(q) && Number(q.replace('#', '')) <= 2147483647 ? Number(q.replace('#', '')) : 0;
            conditions.push("(o.order_id = ? OR o.phone LIKE ? ESCAPE '=')");
            params.push(orderId, '%' + q.replace(/[=%_]/g, value => '=' + value) + '%');
        }
        if (approval === 'pending') {
            // Probe metadata rather than referencing a not-yet-deployed column.
            // Default-off deployment must still read the unchanged 005 schema.
            const [columns] = await db.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='workflow_version'");
            conditions.push(columns.length
                ? "o.approved_at IS NULL AND o.stock_restored_at IS NULL AND ((p.payment_method = 'COD' AND o.status = 'Chờ xử lý') OR (p.payment_method = 'ONLINE' AND ((o.workflow_version IS NULL AND o.status = 'Chờ thanh toán') OR (o.workflow_version = 2 AND o.status = 'Chờ xử lý' AND p.payment_status = 'Đã thanh toán'))))"
                : "o.approved_at IS NULL AND o.stock_restored_at IS NULL AND ((p.payment_method = 'COD' AND o.status = 'Chờ xử lý') OR (p.payment_method = 'ONLINE' AND o.status = 'Chờ thanh toán'))");
        }
        if (approval === 'approved') conditions.push("o.approved_at IS NOT NULL AND o.status <> 'Đã hủy'");
        if (approval === 'rejected') conditions.push("o.status = 'Đã hủy' AND o.rejection_reason IS NOT NULL");
        const where = conditions.length ? 'WHERE ' + conditions.map(value => '(' + value + ')').join(' AND ') : '';
        const from = 'FROM orders o LEFT JOIN payments p ON p.order_id = o.order_id';
        const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total ${from} ${where}`, params);
        const [rows] = await db.query(`SELECT o.order_id ${from} ${where} ORDER BY o.order_date DESC, o.order_id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
        const orders = [];
        for (const row of rows) orders.push(await readDetail(db, null, row.order_id));
        await db.commit();
        return { total, orders };
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
};
