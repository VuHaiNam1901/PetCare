import { commerceApi } from './commerce.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;
const EDITABLE_FIELDS = ['full_name', 'email', 'phone', 'address'];
const messages = {
  'Invalid full_name': 'Họ và tên là bắt buộc, tối đa 100 ký tự.',
  'Invalid email': 'Vui lòng nhập email hợp lệ, tối đa 150 ký tự.',
  'Invalid phone': 'Số điện thoại cần từ 6 đến 20 ký tự số, khoảng trắng, dấu ngoặc hoặc dấu gạch ngang; có thể bắt đầu bằng dấu +.',
  'Address is too long': 'Địa chỉ tối đa 255 ký tự.',
  'At least one field is required': 'Vui lòng nhập thông tin cần cập nhật.',
  'JSON object required': 'Thông tin cập nhật không hợp lệ. Vui lòng kiểm tra lại biểu mẫu.',
  'Unsupported field (role/status cannot be changed)': 'Chỉ được cập nhật họ tên, email, số điện thoại và địa chỉ.',
  'full_name must be a string': 'Họ và tên phải là văn bản.',
  'email must be a string': 'Email phải là văn bản.',
  'phone must be a string': 'Số điện thoại phải là văn bản hoặc để trống.',
  'address must be a string': 'Địa chỉ phải là văn bản hoặc để trống.',
  'Email already registered': 'Email này đã được đăng ký. Vui lòng dùng email khác.',
  'Email này đã được đăng ký.': 'Email này đã được đăng ký. Vui lòng dùng email khác.',
};

const invalidProfile = () => new Error('Thông tin tài khoản nhận được không hợp lệ. Vui lòng tải lại trang.');
const invalidInput = message => Object.assign(new Error(message), { status: 400 });

export function safeProfileUser(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
      !Number.isSafeInteger(candidate.user_id) || candidate.user_id < 1 || candidate.user_id > 2147483647 ||
      typeof candidate.full_name !== 'string' || !candidate.full_name.trim() || candidate.full_name.length > 100 ||
      typeof candidate.email !== 'string' || candidate.email.length > 150 || !EMAIL.test(candidate.email) ||
      !(candidate.phone === null || (typeof candidate.phone === 'string' && (candidate.phone === '' || PHONE.test(candidate.phone)))) ||
      !(candidate.address === null || (typeof candidate.address === 'string' && candidate.address.length <= 255)) ||
      !['user', 'admin'].includes(candidate.role) || candidate.status !== 'active' ||
      !(candidate.created_at === null || typeof candidate.created_at === 'string')) throw invalidProfile();
  return {
    user_id: candidate.user_id, full_name: candidate.full_name, email: candidate.email,
    phone: candidate.phone, address: candidate.address, role: candidate.role,
    status: candidate.status, created_at: candidate.created_at,
  };
}

function editableProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
      Object.keys(body).some(key => !EDITABLE_FIELDS.includes(key))) {
    throw invalidInput('Chỉ được cập nhật họ tên, email, số điện thoại và địa chỉ.');
  }
  const data = {};
  for (const key of Object.keys(body)) {
    const value = body[key];
    if ((key === 'phone' || key === 'address') && value === null) data[key] = null;
    else if (typeof value === 'string') data[key] = value.trim();
    else throw invalidInput('Vui lòng kiểm tra lại định dạng thông tin cá nhân.');
  }
  if ('full_name' in data && (!data.full_name || data.full_name.length > 100)) throw invalidInput(messages['Invalid full_name']);
  if ('email' in data) {
    data.email = data.email.toLowerCase();
    if (data.email.length > 150 || !EMAIL.test(data.email)) throw invalidInput(messages['Invalid email']);
  }
  if (data.phone != null && data.phone !== '' && !PHONE.test(data.phone)) throw invalidInput(messages['Invalid phone']);
  if (data.address != null && data.address.length > 255) throw invalidInput(messages['Address is too long']);
  return data;
}

async function profileRequest(token, path, options = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw Object.assign(new Error('Vui lòng đăng nhập để xem thông tin cá nhân.'), { status: 401 });
  }
  let data;
  try {
    data = await commerceApi(path, { ...options, token });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    let message = messages[error.message];
    if (error.status === 401) message = 'Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.';
    else if (error.status === 403) message = 'Tài khoản không được phép truy cập. Vui lòng đăng nhập lại.';
    else if (!message && error.status === 400) message = 'Thông tin cập nhật chưa hợp lệ. Vui lòng kiểm tra lại biểu mẫu.';
    else if (!message && error.status === 409) message = 'Thông tin đang bị trùng hoặc đã thay đổi. Vui lòng kiểm tra lại trước khi lưu.';
    else if (!message && error.status >= 500) message = 'Máy chủ chưa xử lý được yêu cầu. Vui lòng thử lại sau.';
    else if (!message) message = 'Chưa nhận được xác nhận từ máy chủ. Vui lòng kiểm tra kết nối và thử lại.';
    throw Object.assign(new Error(message), { status: error.status });
  }
  return { success: true, user: safeProfileUser(data.user) };
}

export function getProfile(token, { signal } = {}) {
  return profileRequest(token, '/api/auth/me', { signal });
}

export function updateProfile(token, body) {
  return profileRequest(token, '/api/users/me', { method: 'PUT', body: editableProfile(body) });
}
