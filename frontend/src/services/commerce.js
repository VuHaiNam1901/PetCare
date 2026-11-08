import { API_ORIGIN } from './api.js';
import { voucherMessages } from '../utils/vouchers.js';

const messages = {
  'Invalid email or password': 'Email hoặc mật khẩu không đúng.',
  'Email already registered': 'Email này đã được đăng ký.',
  'Account is inactive': 'Tài khoản đã bị vô hiệu hóa.',
  'Quantity exceeds available stock': 'Số lượng vượt quá tồn kho hiện tại.',
  'Product is not available for sale': 'Sản phẩm hiện đã ngừng bán.',
  'Product not found': 'Không tìm thấy sản phẩm.',
  'Cart item not found': 'Sản phẩm không còn trong giỏ. Vui lòng tải lại giỏ hàng.',
  'Invalid or expired token': 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  'Insufficient permissions': 'Tài khoản này không được sử dụng giỏ hàng của khách hàng.',
  'Cannot connect to MySQL': 'Chưa kết nối được cơ sở dữ liệu. Vui lòng thử lại.',
  'Insufficient stock or invalid quantity': 'Sản phẩm không còn đủ số lượng. Vui lòng kiểm tra lại giỏ hàng.',
  'Selected cart items are no longer available': 'Sản phẩm hoặc số lượng trong giỏ đã thay đổi. Vui lòng kiểm tra lại.',
  'Order is busy; retry with the same Idempotency-Key': 'Đơn hàng đang được xử lý. Vui lòng thử lại để nhận kết quả.',
};

const orderMessages = {
  CART_CHANGED: 'Sản phẩm hoặc số lượng trong giỏ đã thay đổi. Vui lòng kiểm tra lại giỏ hàng.',
  OUT_OF_STOCK: 'Sản phẩm không còn đủ số lượng. Vui lòng kiểm tra lại tồn kho.',
  ORDER_TOTAL_TOO_LARGE: 'Tổng tiền vượt giới hạn cho phép. Vui lòng giảm số lượng đặt.',
  IDEMPOTENCY_CONFLICT: 'Yêu cầu đặt hàng đã thay đổi. Vui lòng giữ nguyên lần đặt hàng đang chờ kết quả.',
  ORDER_RETRY: 'Đơn hàng đang được xử lý. Vui lòng thử lại để nhận kết quả.',
};

export async function commerceApi(path, { method = 'GET', body, token, headers = {}, signal } = {}) {
  let response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Chưa nhận được xác nhận từ máy chủ. Vui lòng kiểm tra kết nối và thử lại.');
  }
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Máy chủ trả về dữ liệu không hợp lệ. Vui lòng thử lại.');
  }
  if (!response.ok || data.success !== true) {
    throw Object.assign(new Error(messages[data.message] || orderMessages[data.code] || voucherMessages[data.code] || data.message || 'Không thể thực hiện thao tác. Vui lòng thử lại.'), { status: response.status, code: data.code, conflicts: data.conflicts || [] });
  }
  return data;
}
