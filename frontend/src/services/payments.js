import { commerceApi } from './commerce.js';

const TEST_CASES = ['ONLINE_SUCCESS', 'ONLINE_FAILURE'];
const messages = {
  'Invalid order ID or query parameters': 'Mã đơn hàng không hợp lệ. Vui lòng mở lại đơn từ danh sách.',
  'Only test_case ONLINE_SUCCESS or ONLINE_FAILURE is accepted': 'Vui lòng chọn mô phỏng thành công hoặc thất bại.',
  'Invalid simulation test case': 'Kịch bản mô phỏng thanh toán không hợp lệ.',
  'Only ONLINE orders support simulated payment': 'Chỉ đơn hàng thanh toán Online mới được mô phỏng thanh toán.',
  'Admin approval is required before payment': 'Đơn hàng cần được Admin duyệt trước khi mô phỏng thanh toán.',
  'Order is not awaiting payment': 'Đơn hàng hiện không ở trạng thái chờ thanh toán. Vui lòng tải lại thông tin.',
  'Payment is already completed or unavailable': 'Thanh toán đã hoàn tất hoặc hiện không thể thực hiện. Vui lòng tải lại trạng thái.',
  'Order/payment data needs review': 'Thông tin đơn hàng và thanh toán cần được kiểm tra. Vui lòng liên hệ cửa hàng.',
  'Payment record is missing; order needs review': 'Đơn hàng chưa có bản ghi thanh toán hợp lệ. Vui lòng liên hệ cửa hàng.',
  'Payment is busy; reload payment information before retrying': 'Thanh toán đang được xử lý. Vui lòng tải lại trạng thái trước khi thử lại.',
};

const validId = value => (typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value))) &&
  Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647;
const validApproval = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).getFullYear() > 1000 && Date.parse(value) <= Date.now();

export function canSimulateOrderPayment(order, payment) {
  return Boolean(order && payment && validId(order.order_id) && validId(payment.order_id) &&
    Number(order.order_id) === Number(payment.order_id) &&
    order.payment_method === 'ONLINE' && payment.payment_method === 'ONLINE' &&
    payment.can_simulate === true && payment.simulation_only === true &&
    order.approval_state === 'approved' && payment.approval_state === 'approved' &&
    validApproval(order.approved_at) && validApproval(payment.approved_at) &&
    Date.parse(order.approved_at) === Date.parse(payment.approved_at) &&
    order.status === 'Chờ thanh toán' && payment.order_status === 'Chờ thanh toán' &&
    ['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status) &&
    order.payment_status === payment.payment_status &&
    !order.transaction_date && !payment.transaction_date && !order.stock_restored_at &&
    !order.rejection_reason && !payment.rejection_reason && order.review_required === false &&
    typeof order.total_amount === 'string' && /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(order.total_amount) &&
    payment.amount === order.total_amount && order.payment_amount === payment.amount);
}

export async function simulateOrderPayment(token, orderId, testCase) {
  if (typeof token !== 'string' || !token.trim()) {
    throw Object.assign(new Error('Vui lòng đăng nhập bằng tài khoản khách hàng để mô phỏng thanh toán.'), { status: 401 });
  }
  if (!validId(orderId)) throw Object.assign(new Error('Mã đơn hàng không hợp lệ. Vui lòng mở lại đơn từ danh sách.'), { status: 400 });
  if (!TEST_CASES.includes(testCase)) throw Object.assign(new Error('Vui lòng chọn mô phỏng thành công hoặc thất bại.'), { status: 400 });
  try {
    return await commerceApi(`/api/orders/${Number(orderId)}/payment/simulate`, {
      method: 'POST', token, body: { test_case: testCase },
    });
  } catch (error) {
    let message;
    let code;
    if (error.status === 401) message = 'Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.';
    else if (error.status === 403) message = 'Vui lòng dùng tài khoản khách hàng đang hoạt động để mô phỏng thanh toán.';
    else if (error.status === 404) message = 'Không tìm thấy đơn hàng hoặc bạn không có quyền truy cập.';
    else if (error.message === 'Payment is busy; reload payment information before retrying') {
      message = messages[error.message];
      code = 'PAYMENT_BUSY';
    } else if (messages[error.message]) message = messages[error.message];
    else if (error.status === 400) message = 'Yêu cầu mô phỏng thanh toán chưa hợp lệ. Vui lòng kiểm tra lại.';
    else if (error.status === 409) message = 'Đơn hàng chưa đủ điều kiện hoặc dữ liệu thanh toán đã thay đổi. Vui lòng tải lại trạng thái.';
    else message = 'Chưa nhận được xác nhận thanh toán. Vui lòng tải lại trạng thái trước khi thử lại.';
    throw Object.assign(new Error(message), { status: error.status, ...(code ? { code } : {}) });
  }
}
