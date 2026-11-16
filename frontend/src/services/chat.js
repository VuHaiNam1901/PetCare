import { API_ORIGIN } from './api.js';
import { customerChatRoute, sanitizeChatPageState } from '../utils/chat-page-context.js';

// Gemini has a 45-second SDK deadline; leave time for the session lock and SQL.
export const CHAT_TIMEOUT_MS = 65000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const positiveId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const invalidResponse = () => chatError('Máy chủ trả về dữ liệu trò chuyện không hợp lệ. Vui lòng thử lại.', { code: 'INVALID_RESPONSE', retryable: true });

function chatError(message, fields = {}) {
  return Object.assign(new Error(message), { status: 0, code: 'CHAT_UNAVAILABLE', retryAfterMs: 0, retryable: false, autoRetryable: false, kind: 'system', ...fields });
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
  const quota = code === 'GEMINI_QUOTA' || status === 429;
  const timeout = code === 'GEMINI_TIMEOUT' || status === 504 || status === 408;
  const configuredMessage = {
    GEMINI_QUOTA: 'Dịch vụ AI đang hết hạn mức tư vấn. Nội dung vẫn được giữ; vui lòng chờ rồi nhấn Thử lại.',
    GEMINI_UNAVAILABLE: 'Dịch vụ AI đang tạm gián đoạn. Bạn có thể thử lại; hội thoại vẫn được giữ.',
    GEMINI_AUTH: 'Dịch vụ AI chưa xác thực được kết nối. Vui lòng thử lại sau.',
    GEMINI_BAD_REQUEST: 'Dịch vụ AI chưa xử lý được yêu cầu. Vui lòng thử lại sau.',
    GEMINI_MODEL_UNAVAILABLE: 'Dịch vụ AI hiện chưa sẵn sàng. Vui lòng thử lại sau.',
    HISTORY_SAVE_FAILED: 'Chưa xác nhận lưu được lượt trò chuyện này. Nội dung vẫn ở trình duyệt; nhấn Thử lại để kiểm tra và tiếp tục.',
    MEMORY_UNAVAILABLE: 'Chưa thể khôi phục lịch sử từ máy chủ. Vui lòng thử lại; nội dung trong trình duyệt vẫn được giữ.',
  };
  const bodyDelay = Number.isSafeInteger(data?.retry_after_ms) && data.retry_after_ms >= 0 ? data.retry_after_ms : 0;
  const retryAfterMs = Math.min(86400000, Math.max(retryAfter(response.headers.get('Retry-After')), bodyDelay) || (quota ? 60000 : 0));
  // The backend does not include these fields in every error (notably 429).
  // Accept a newly issued capability only when it belongs to this request.
  const matchingRequest = typeof data?.request_id === 'string' && UUID.test(data.request_id) && data.request_id.toLowerCase() === request.request_id;
  const session = matchingRequest && typeof data?.session_id === 'string' && SESSION.test(data.session_id) &&
    (!request.session_id || data.session_id === request.session_id) ? data.session_id : undefined;
  return chatError(configuredMessage[code] || messages[status] || 'Hệ thống trò chuyện gặp lỗi. Bạn có thể thử lại; hội thoại vẫn được giữ.', {
    status, code, retryAfterMs, kind: quota ? 'quota' : timeout ? 'timeout' : 'system',
    autoRetryable: !quota && ['GEMINI_UNAVAILABLE', 'CHAT_BUSY', 'SESSION_BUSY'].includes(code),
    retryable: [408, 425, 429].includes(status) || status >= 500 || (status === 409 && code === 'SESSION_BUSY'),
    ...(matchingRequest ? { request_id: request.request_id } : {}), ...(session ? { session_id: session } : {}),
  });
}

function normalizeRequest(input) {
  if (!input || typeof input.message !== 'string' || !input.message.trim() || [...input.message].length > 2000 ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input.message) ||
      typeof input.request_id !== 'string' || !UUID.test(input.request_id) ||
      (input.session_id !== undefined && (typeof input.session_id !== 'string' || !SESSION.test(input.session_id)))) {
    throw chatError('Tin nhắn chưa hợp lệ. Vui lòng kiểm tra nội dung trước khi gửi.', { status: 400, code: 'INVALID_REQUEST' });
  }
  const context = input.page_context;
  let pageContext;
  if (context?.version === 1 && customerChatRoute(context.route)) {
    const cart = {};
    for (const key of ['item_count', 'selected_count', 'selectable_count', 'editable_quantity_count']) if (Number.isSafeInteger(context.cart?.[key]) && context.cart[key] >= 0 && context.cart[key] <= 100) cart[key] = context.cart[key];
    for (const key of ['loading', 'error', 'busy', 'merging', 'merge_can_edit']) if (typeof context.cart?.[key] === 'boolean') cart[key] = context.cart[key];
    pageContext = { version: 1, route: customerChatRoute(context.route), cart, state: sanitizeChatPageState(context.state) };
  }
  return { message: input.message, request_id: input.request_id.toLowerCase(),
    ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
    ...(pageContext ? { page_context: pageContext } : {}) };
}

async function postChat(path, request, { token, signal, timeoutMs = CHAT_TIMEOUT_MS, validate = validateSuccess } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let issuedSession;
  let rejectAbort;
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort();
    rejectAbort(chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' }));
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  const receive = async () => {
    if (controller.signal.aborted) throw chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' });
    let response;
    try {
      response = await fetch(`${API_ORIGIN}${path}`, { method: 'POST', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(request) });
    } catch {
      if (controller.signal.aborted) throw chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' });
      throw chatError('Mất kết nối với máy chủ trò chuyện. Vui lòng kiểm tra mạng rồi nhấn Thử lại.', { code: 'NETWORK_ERROR', kind: 'network', retryable: true, autoRetryable: true });
    }
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (!response.ok) throw responseError(response, null, request);
      if (error?.name === 'TypeError') throw chatError('Kết nối bị gián đoạn khi nhận phản hồi. Vui lòng nhấn Thử lại.', { code: 'NETWORK_ERROR', kind: 'network', retryable: true, autoRetryable: true });
      throw invalidResponse();
    }
    if (typeof data?.request_id === 'string' && UUID.test(data.request_id) && data.request_id.toLowerCase() === request.request_id &&
        typeof data?.session_id === 'string' && SESSION.test(data.session_id) && (!request.session_id || data.session_id === request.session_id)) issuedSession = data.session_id;
    if (controller.signal.aborted) throw chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' });
    if (!response.ok || data?.success !== true) {
      if (response.ok) throw invalidResponse();
      throw responseError(response, data, request);
    }
    return validate(data, request);
  };
  try {
    // Some transports do not settle after abort. Bound fetch AND body parsing
    // explicitly so the widget always reaches its finally/loading cleanup.
    return await Promise.race([receive(), interrupted]);
  } catch (error) {
    if (timedOut) throw chatError('Máy chủ chưa phản hồi kịp thời. Tin nhắn vẫn được giữ; bạn có thể nhấn Thử lại.', { code: 'CLIENT_TIMEOUT', kind: 'timeout', retryable: true,
      ...(issuedSession ? { session_id: issuedSession, request_id: request.request_id } : {}) });
    if (signal?.aborted) throw chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' });
    if (issuedSession && error.retryable) Object.assign(error, { session_id: issuedSession, request_id: request.request_id });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function sendChatMessage(input, options = {}) {
  return postChat('/api/chat', normalizeRequest(input), options);
}

function sessionResult(data, request) {
  if (data?.success !== true || data.request_id !== request.request_id || typeof data.session_id !== 'string' || !SESSION.test(data.session_id)) throw invalidResponse();
  return data.session_id;
}

export function verifyChatSession(session, { token, signal } = {}) {
  return postChat('/api/chat/session', { request_id: createChatRequestId(), session_id: session },
    { token, signal, timeoutMs: 10000, validate: sessionResult });
}

export function loadChatConversation(session, { token, signal } = {}) {
  return postChat('/api/chat/session', { request_id: createChatRequestId(), session_id: session, restore_history: true },
    { token, signal, timeoutMs: 10000, validate(data, request) {
      sessionResult(data, request);
      if (data.session_id !== session || !Array.isArray(data.turns) || data.turns.length > 20 ||
          new Set(data.turns.map(turn => turn?.request_id)).size !== data.turns.length) throw invalidResponse();
      return data.turns.map(turn => {
        const pending = normalizeRequest({ message: turn?.message, request_id: turn?.request_id, session_id: session });
        const response = validateSuccess({ ...turn.response, success: true, session_id: session, request_id: pending.request_id, replayed: true }, pending);
        return { request: pending, response, state: 'done', error: null };
      });
    } });
}

export function claimGuestChatSession(session, { token, signal } = {}) {
  if (!token || typeof session !== 'string' || !SESSION.test(session)) return Promise.reject(chatError('Phiên trò chuyện không hợp lệ.', { code: 'SESSION_FORBIDDEN', status: 403 }));
  return postChat('/api/chat/session/claim', { request_id: createChatRequestId(), session_id: session },
    { token, signal, timeoutMs: 10000, validate: sessionResult });
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(chatError('Yêu cầu trò chuyện đã được hủy.', { code: 'REQUEST_ABORTED', name: 'AbortError' }));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function sendChatMessageWithRecovery(input, { token, signal, onSession } = {}) {
  const request = normalizeRequest(input);
  if (!request.session_id) {
    // Reserve a signed capability before generation. Even a lost FIRST answer
    // can then be replayed with exactly the same session + request UUID.
    const session = await postChat('/api/chat/session', { request_id: request.request_id }, {
      token, signal, timeoutMs: 10000,
      validate(data, pending) {
        if (data?.success !== true || data.request_id !== pending.request_id || typeof data.session_id !== 'string' || !SESSION.test(data.session_id)) throw invalidResponse();
        return data.session_id;
      },
    });
    request.session_id = session;
    onSession?.(session);
  }
  const started = Date.now();
  try { return await sendChatMessage(request, { token, signal }); }
  catch (error) {
    // One short retry only. Quota, timeouts, malformed answers and permanent
    // errors always require a manual action; long Retry-After is never ignored.
    if (!error.autoRetryable || signal?.aborted || globalThis.navigator?.onLine === false ||
        error.retryAfterMs > 2000 || Date.now() - started >= 10000) throw error;
    await pause(Math.max(750, error.retryAfterMs), signal);
    return sendChatMessage(request, { token, signal });
  }
}
