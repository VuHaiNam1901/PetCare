import { commerceApi } from './commerce.js';

const messages = {
  'Customer account not found': 'Không tìm thấy tài khoản khách hàng. Tài khoản có thể đã thay đổi hoặc không thuộc nhóm khách hàng.',
  'Active admin account required': 'Bạn cần tài khoản Admin đang hoạt động để quản lý người dùng.',
  'Invalid account status': 'Trạng thái tài khoản phải là Đang hoạt động hoặc Đã khóa.',
  'Only status active or inactive may be updated': 'Chỉ được thay đổi trạng thái tài khoản thành Đang hoạt động hoặc Đã khóa.',
  'Account is busy; retry the request': 'Tài khoản đang được xử lý. Vui lòng thử lại sau.',
  'Invalid user ID or query parameters': 'Mã khách hàng không hợp lệ. Vui lòng tải lại danh sách.',
  'Invalid pagination': 'Trang hoặc số khách hàng mỗi trang không hợp lệ.',
  'Invalid search query': 'Từ khóa tìm kiếm tối đa 150 ký tự, không chứa emoji hoặc ký tự điều khiển.',
  'Unsupported query parameters': 'Bộ lọc không được hỗ trợ. Vui lòng tải lại danh sách.',
};

async function adminUsersRequest(token, path, options = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw Object.assign(new Error('Vui lòng đăng nhập bằng tài khoản Admin để quản lý người dùng.'), { status: 401 });
  }
  try {
    return await commerceApi(path, { ...options, token });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error.status === 401) error.message = 'Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.';
    else if (error.status === 403) error.message = 'Bạn không có quyền quản lý người dùng. Vui lòng dùng tài khoản Admin đang hoạt động.';
    else if (messages[error.message]) error.message = messages[error.message];
    else if (error.status) error.message = 'Chưa thực hiện được thao tác quản lý người dùng. Vui lòng thử lại.';
    throw error;
  }
}

export function getAdminUsers(token, { page = 1, limit = 20, q = '', status = '', signal } = {}) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (q.trim()) params.set('q', q.trim());
  if (status) params.set('status', status);
  return adminUsersRequest(token, `/api/admin/users?${params}`, { signal });
}

export function updateAdminUserStatus(token, userId, status) {
  return adminUsersRequest(token, `/api/admin/users/${userId}/status`, { method: 'PATCH', body: { status } });
}
