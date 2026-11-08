const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Bangkok' });
const dateTimeFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

export function recordedDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getFullYear() <= 1000 ? null : date;
}

export function formatOrderDate(value, includeTime = false) {
  const date = recordedDate(value);
  return date ? (includeTime ? dateTimeFormat : dateFormat).format(date) : null;
}

export function orderStatusLabel(order) {
  if (!order) return 'Chưa có trạng thái';
  if (order.approval_state === 'rejected' || (order.status === 'Đã hủy' && order.rejection_reason)) return 'Đã từ chối';
  if (order.approval_state === 'pending' || (!order.approval_state && !order.approved_at &&
    ((order.payment_method === 'COD' && order.status === 'Chờ xử lý') ||
      (order.payment_method === 'ONLINE' && order.status === 'Chờ thanh toán')))) return 'Chờ duyệt';
  return order.status || 'Chưa có trạng thái';
}
