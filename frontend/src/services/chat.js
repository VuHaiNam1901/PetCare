import { API_ORIGIN } from './api.js';

// Gemini has a 45-second SDK deadline; leave time for the session lock and SQL.
export const CHAT_TIMEOUT_MS = 65000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const positiveId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const invalidResponse = () => chatError('Máy chủ trả về dữ liệu trò chuyện không hợp lệ. Vui lòng thử lại.', { code: 'INVALID_RESPONSE', retryable: true });

function chatError(message, fields = {}) {
  return Object.assign(new Error(message), { status: 0, code: 'CHAT_UNAVAILABLE', retryAfterMs: 0, retryable: false, ...fields });
}

export function createChatRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw chatError('Trình duyệt chưa hỗ trợ gửi tin nhắn an toàn. Vui lòng cập nhật trình duyệt.', { code: 'CLIENT_UNSUPPORTED' });
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function retryAfter(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const trimmed = value.trim();
  const milliseconds = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

function validProduct(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return false;
  const price = product.price;
  return positiveId(product.product_id) && nonblank(product.name) &&
    ((typeof price === 'number' && Number.isFinite(price) && price >= 0) ||
      (typeof price === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(price) && Number.isFinite(Number(price)))) &&
    Number.isSafeInteger(product.stock_quantity) && product.stock_quantity >= 0 &&
    typeof product.available === 'boolean' &&
    (product.image_url == null || typeof product.image_url === 'string') &&
    (product.category_id == null || positiveId(product.category_id)) &&
    (product.category_name == null || typeof product.category_name === 'string') &&
    (product.status === undefined || typeof product.status === 'string') &&
    (product.source === undefined || typeof product.source === 'string');
}

function validateSuccess(data, request) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.success !== true ||
      typeof data.session_id !== 'string' || !SESSION.test(data.session_id) || typeof data.request_id !== 'string' || !UUID.test(data.request_id) ||
      data.request_id.toLowerCase() !== request.request_id ||
      (request.session_id && data.session_id !== request.session_id) || !nonblank(data.message) ||
      !Array.isArray(data.products) || data.products.length > 3 || !data.products.every(validProduct) ||
      new Set(data.products.map(product => product.product_id)).size !== data.products.length ||
      (data.follow_up != null && typeof data.follow_up !== 'string') ||
      (data.warnings !== undefined && (!Array.isArray(data.warnings) || data.warnings.length > 2 || !data.warnings.every(nonblank))) ||
      typeof data.code !== 'string' || !CODE.test(data.code) || typeof data.replayed !== 'boolean') throw invalidResponse();
  return { success: true, session_id: data.session_id, request_id: request.request_id, message: data.message,
    products: data.products.map(({ product_id, category_id, category_name, name, price, stock_quantity, image_url, status, available, source }) =>
      ({ product_id, category_id, category_name, name, price, stock_quantity, image_url, status, available, source })),
    follow_up: data.follow_up ?? null, warnings: data.warnings ?? [], code: data.code, replayed: data.replayed };
}

function responseError(response, data, request) {
  const status = response.status;
  const code = typeof data?.code === 'string' && CODE.test(data.code) ? data.code : 'CHAT_UNAVAILABLE';
  const messages = {
    400: 'Tin nhắn chưa hợp lệ. Vui lòng bắt đầu cuộc trò chuyện mới và kiểm tra nội dung.',
    401: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục trò chuyện.',
    403: code === 'SESSION_FORBIDDEN' ? 'Phiên trò chuyện không còn hợp lệ. Vui lòng bắt đầu cuộc trò chuyện mới.' : 'Tài khoản hiện không có quyền trò chuyện. Vui lòng kiểm tra phiên đăng nhập.',
    409: code === 'REQUEST_CONFLICT' ? 'Tin nhắn này xung đột với yêu cầu đã gửi. Vui lòng bắt đầu cuộc trò chuyện mới.' : 'Cuộc trò chuyện đang bận. Vui lòng thử lại sau ít giây.',
    429: 'Bạn đã gửi quá nhiều tin nhắn. Vui lòng chờ rồi thử lại.',
    503: code === 'GEMINI_QUOTA' ? 'Trợ lý đang đạt giới hạn lượt tư vấn. Vui lòng thử lại sau.' : 'Trợ lý đang tạm thời gián đoạn. Vui lòng thử lại sau.',
    504: 'Trợ lý chưa phản hồi kịp thời. Vui lòng thử lại.',
  };
  // The backend does not include these fields in every error (notably 429).
  // Accept a newly issued capability only when it belongs to this request.
  const matchingRequest = typeof data?.request_id === 'string' && UUID.test(data.request_id) && data.request_id.toLowerCase() === request.request_id;
  const session = matchingRequest && typeof data?.session_id === 'string' && SESSION.test(data.session_id) &&
    (!request.session_id || data.session_id === request.session_id) ? data.session_id : undefined;
  return chatError(messages[status] || 'Chưa nhận được xác nhận từ máy chủ. Vui lòng thử lại.', {
    status, code, retryAfterMs: retryAfter(response.headers.get('Retry-After')),
    retryable: [408, 425, 429].includes(status) || status >= 500 || (status === 409 && code === 'SESSION_BUSY'),
    ...(matchingRequest ? { request_id: request.request_id } : {}), ...(session ? { session_id: session } : {}),
  });
}

export async function sendChatMessage(input, { token, signal } = {}) {
  if (!input || typeof input.message !== 'string' || !input.message.trim() || [...input.message].length > 2000 ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input.message) ||
      typeof input.request_id !== 'string' || !UUID.test(input.request_id) ||
      (input.session_id !== undefined && (typeof input.session_id !== 'string' || !SESSION.test(input.session_id)))) {
    throw chatError('Tin nhắn chưa hợp lệ. Vui lòng kiểm tra nội dung trước khi gửi.', { status: 400, code: 'INVALID_REQUEST' });
  }
  const request = { message: input.message, request_id: input.request_id.toLowerCase(),
    ...(input.session_id === undefined ? {} : { session_id: input.session_id }) };
  const controller = new AbortController();
  let timedOut = false;
  let issuedSession;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, CHAT_TIMEOUT_MS);
  try {
    if (controller.signal.aborted) throw chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' });
    let response;
    try {
      response = await fetch(`${API_ORIGIN}/api/chat`, { method: 'POST', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(request) });
    } catch {
      if (controller.signal.aborted) throw chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' });
      throw chatError('Chưa kết nối được với máy chủ. Vui lòng kiểm tra mạng và thử lại.', { code: 'NETWORK_ERROR', retryable: true });
    }
    let data;
    try { data = await response.json(); }
    catch { if (!response.ok) throw responseError(response, null, request); throw invalidResponse(); }
    if (typeof data?.request_id === 'string' && UUID.test(data.request_id) && data.request_id.toLowerCase() === request.request_id &&
        typeof data?.session_id === 'string' && SESSION.test(data.session_id) && (!request.session_id || data.session_id === request.session_id)) issuedSession = data.session_id;
    if (controller.signal.aborted) throw chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' });
    if (!response.ok || data?.success !== true) {
      if (response.ok) throw invalidResponse();
      throw responseError(response, data, request);
    }
    return validateSuccess(data, request);
  } catch (error) {
    if (timedOut) throw chatError('Chưa nhận được phản hồi từ máy chủ trong thời gian chờ. Vui lòng thử lại.', { code: 'CLIENT_TIMEOUT', retryable: true,
      ...(issuedSession ? { session_id: issuedSession, request_id: request.request_id } : {}) });
    if (signal?.aborted) throw chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' });
    if (issuedSession && error.retryable) Object.assign(error, { session_id: issuedSession, request_id: request.request_id });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
