import { formatPrice } from './catalog.js';

const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Bangkok' });
const dateTimeFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
const fractionalMoneyFormat = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function recordedDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getFullYear() <= 1000 ? null : date;
}

export function formatOrderDate(value, includeTime = false) {
  const date = recordedDate(value);
  return date ? (includeTime ? dateTimeFormat : dateFormat).format(date) : null;
}

export function formatOrderMoney(value, allowFraction = false) {
  if (!allowFraction) return formatPrice(value);
  if (value == null || String(value).trim() === '') return 'Liên hệ';
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? fractionalMoneyFormat.format(number) : 'Liên hệ';
}

export function orderStatusLabel(order) {
  if (!order) return 'Chưa có trạng thái';
  if (order.approval_state === 'rejected' || (order.status === 'Đã hủy' && order.rejection_reason)) return 'Đã từ chối';
  if (order.approval_state === 'pending') return 'Chờ duyệt';
  if (!order.approval_state && !order.approved_at) {
    if (order.workflow_version === 2) {
      if (order.status === 'Chờ xử lý') return 'Chờ duyệt';
    } else if ((order.payment_method === 'COD' && order.status === 'Chờ xử lý') ||
      (order.payment_method === 'ONLINE' && order.status === 'Chờ thanh toán')) {
      return 'Chờ duyệt';
    }
  }
  return order.status || 'Chưa có trạng thái';
}
