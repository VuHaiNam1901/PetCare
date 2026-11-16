import { commerceApi } from './commerce.js';

export async function getPaymentOptions({ signal } = {}) {
  const { payment_options: options } = await commerceApi('/api/orders/payment-options', { signal });
  if (!options || typeof options.online_available !== 'boolean' ||
    (options.online_available && !['test', 'live'].includes(options.online_mode))) {
    throw new Error('Chưa xác nhận được phương thức thanh toán từ máy chủ.');
  }
  return options;
}

export function supportsOnlineAmount(amount) {
  return typeof amount === 'string' && /^[1-9]\d{0,9}\.00$/.test(amount) &&
    Number(amount) >= 1000 && Number(amount) <= 499000000;
}

export function canOpenOnlinePayment(order) {
  return Boolean(order && order.payment_method === 'ONLINE' && order.workflow_version === 2 &&
    order.status === 'Chờ thanh toán' && ['Chưa thanh toán', 'Thất bại'].includes(order.payment_status) &&
    !order.approved_at && !order.transaction_date && !order.stock_restored_at && !order.cancelled_at &&
    !order.rejection_reason && order.review_required === false &&
    typeof order.payment_expires_at === 'string' && Date.parse(order.payment_expires_at) > Date.now() &&
    supportsOnlineAmount(order.total_amount));
}
