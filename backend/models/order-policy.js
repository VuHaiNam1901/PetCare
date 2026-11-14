const states = ['Chờ xử lý', 'Chờ thanh toán', 'Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng', 'Đã hủy'];
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
const validTime = (value, databaseProof) => databaseProof !== undefined
    ? Boolean(value) && Number(databaseProof) === 1
    : value && new Date(value).getFullYear() > 1000 && new Date(value).getTime() <= Date.now();
const isV2 = order => order.workflow_version === 2;

function consistentV2(order, payment) {
    const created = Date.parse(order.created_at_utc), deadline = Date.parse(order.payment_expires_at);
    if (payment.payment_method !== 'ONLINE' || !Number.isFinite(created) || !Number.isFinite(deadline) ||
        deadline - created !== 24 * 60 * 60 * 1000) fail('Thời hạn thanh toán Online cần được kiểm tra.');
    const paid = payment.payment_status === 'Đã thanh toán';
    if (paid !== Boolean(payment.transaction_date)) fail('Thời điểm xác nhận thanh toán không nhất quán.');
    if (order.status === 'Đã hủy') {
        if (!order.stock_restored_at || !order.cancelled_at || !['admin_rejected', 'payment_expired', 'customer_cancelled'].includes(order.cancellation_reason_code) ||
            !['Đã hủy', 'Đã thanh toán'].includes(payment.payment_status) ||
            (order.cancellation_reason_code === 'admin_rejected' && !order.rejection_reason)) fail('Dữ liệu hủy đơn/hoàn tồn cần được kiểm tra.');
        return;
    }
    if (order.stock_restored_at || order.cancelled_at || order.cancellation_reason_code || order.rejection_reason) fail('Trạng thái hủy đơn không nhất quán.');
    if (order.status === 'Chờ thanh toán') {
        if (order.approved_at || !['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status)) fail('Đơn Online chưa đủ điều kiện thanh toán.');
    } else if (order.status === 'Chờ xử lý') {
        if (!paid || order.approved_at) fail('Đơn Online chưa đủ điều kiện chờ duyệt.');
    } else if (!paid || !order.approved_at) fail('Đơn Online chỉ được giao sau khi đã thanh toán và duyệt.');
}

function consistent(order, payment) {
    if (!payment || !['COD', 'ONLINE'].includes(payment.payment_method) || payment.amount !== order.total_amount || !states.includes(order.status)) fail('Dữ liệu đơn hàng/thanh toán cần được kiểm tra.');
    const reserved = validTime(order.stock_reserved_at, order.stock_reservation_valid) || order.stock_reservation_source === 'checkout-v4-fingerprint';
    if (!reserved) fail('Đơn hàng cũ chưa có bằng chứng giữ tồn kho. Cần đối soát trước khi xử lý; không tự động trừ hoặc hoàn hàng.');
    if (order.approved_at && !validTime(order.approved_at, order.approval_valid)) fail('Thời điểm duyệt đơn không hợp lệ; cần kiểm tra dữ liệu.');
    if (isV2(order)) return consistentV2(order, payment);
    if (order.workflow_version != null) fail('Phiên bản nghiệp vụ đơn hàng chưa được hỗ trợ.');
    if (order.status === 'Đã hủy') {
        const customerCancelled = order.cancellation_reason_code === 'customer_cancelled' && order.cancellation_reason && order.cancelled_at;
        if (!order.stock_restored_at || payment.payment_status !== 'Đã hủy' || (!order.rejection_reason && !customerCancelled)) fail('Dữ liệu đơn bị hủy/tồn kho cần được kiểm tra.');
        return;
    }
    const allowedPayments = payment.payment_method === 'ONLINE' ? ['Chưa thanh toán', 'Thất bại', 'Đã thanh toán'] : ['Chưa thanh toán', 'Đã thanh toán'];
    if (order.stock_restored_at || order.rejection_reason || !allowedPayments.includes(payment.payment_status)) fail('Trạng thái đơn hàng/thanh toán không nhất quán.');
    if ((payment.payment_status === 'Đã thanh toán') !== Boolean(payment.transaction_date)) fail('Thời điểm xác nhận thanh toán không nhất quán.');
    if (payment.payment_method === 'COD') {
        if (order.status === 'Chờ thanh toán') fail('Trạng thái đơn COD không hợp lệ.');
        if ((order.status !== 'Chờ xử lý') !== Boolean(order.approved_at)) fail('Trạng thái duyệt COD không nhất quán.');
        if ((order.status === 'Đã giao hàng') !== (payment.payment_status === 'Đã thanh toán')) fail('Trạng thái giao hàng/thu tiền COD không nhất quán.');
    } else {
        if (order.status === 'Chờ xử lý') fail('Trạng thái đơn Online không hợp lệ.');
        if (order.status === 'Chờ thanh toán' && payment.payment_status === 'Đã thanh toán') fail('Thanh toán Online đã ghi nhận nhưng trạng thái đơn chưa đồng bộ; cần kiểm tra hệ thống thanh toán.');
        if (['Đã thanh toán', 'Thất bại'].includes(payment.payment_status) && !order.approved_at) fail('Thanh toán Online cần được Admin duyệt trước.');
        if (order.status !== 'Chờ thanh toán' && (!order.approved_at || payment.payment_status !== 'Đã thanh toán')) fail('Đơn Online chỉ được giao sau khi đã duyệt và thanh toán thành công.');
    }
}

function approvalState(order) {
    if (order.status === 'Đã hủy' && order.rejection_reason) return 'rejected';
    if (order.status === 'Đã hủy' && order.cancellation_reason_code === 'customer_cancelled') return 'cancelled';
    if (isV2(order)) {
        if (order.status === 'Đã hủy') return 'cancelled';
        if (order.approved_at) return 'approved';
        return order.status === 'Chờ thanh toán' ? 'awaiting_payment' : order.status === 'Chờ xử lý' ? 'pending' : 'legacy';
    }
    if (order.approved_at) return 'approved';
    if (!order.stock_restored_at && order.status === (order.payment_method === 'COD' ? 'Chờ xử lý' : 'Chờ thanh toán')) return 'pending';
    return 'legacy';
}

function customerCanCancel(order, payment) {
    if (order.approved_at || order.stock_restored_at || !['Chờ xử lý', 'Chờ thanh toán'].includes(order.status)) return false;
    try { consistent(order, payment); } catch { return false; }
    return true;
}

function decorate(order) {
    const approval_state = approvalState(order);
    let review_message = '';
    try { consistent(order, { payment_method: order.payment_method, payment_status: order.payment_status, amount: order.payment_amount, transaction_date: order.transaction_date }); }
    catch (error) { review_message = error.message; }
    const allowed_actions = [];
    if (!review_message) {
        if (isV2(order) && approval_state === 'awaiting_payment') allowed_actions.push('reject');
        else if (approval_state === 'pending' && (order.payment_status === 'Chưa thanh toán' || (isV2(order) && order.payment_status === 'Đã thanh toán'))) allowed_actions.push('approve', 'reject');
        else if (order.status === 'Chờ giao hàng') allowed_actions.push('ship');
        else if (order.status === 'Đang giao hàng') allowed_actions.push('deliver');
    }
    return { ...order, approval_state, allowed_actions,
        can_cancel: customerCanCancel(order, { payment_method: order.payment_method, payment_status: order.payment_status, amount: order.payment_amount, transaction_date: order.transaction_date }),
        review_required: Boolean(review_message), review_reason: review_message };
}

module.exports = { states, consistent, approvalState, decorate, isV2, customerCanCancel };
