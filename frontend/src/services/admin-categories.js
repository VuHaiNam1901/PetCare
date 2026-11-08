import { commerceApi } from './commerce.js';

const messages = {
  'Active admin account required': 'Bạn cần tài khoản Admin đang hoạt động để quản lý danh mục.',
  'Category name already exists': 'Tên danh mục đã tồn tại. Vui lòng chọn tên khác.',
  'Category not found': 'Danh mục không còn tồn tại. Vui lòng tải lại danh sách.',
  'Category does not exist': 'Danh mục không còn tồn tại. Vui lòng tải lại danh sách.',
  'Category still contains products, including discontinued products': 'Không thể xóa vì danh mục vẫn chứa sản phẩm, kể cả sản phẩm đã ngừng bán. Danh mục được giữ nguyên.',
  'Linked catalog data prevents this operation': 'Dữ liệu liên quan đang được sử dụng hoặc đã thay đổi. Vui lòng tải lại danh sách trước khi tiếp tục.',
  'Catalog is busy; retry the request': 'Danh mục đang được xử lý. Vui lòng thử lại sau.',
  'Unsupported or missing fields': 'Thông tin danh mục chưa đầy đủ hoặc có trường không hợp lệ.',
  'Required fields are missing': 'Vui lòng nhập tên danh mục.',
  'Text fields must be strings': 'Tên và mô tả danh mục phải là văn bản.',
  'Invalid or oversized text': 'Nội dung quá dài hoặc có ký tự không được hỗ trợ. Tên tối đa 100 ký tự, mô tả tối đa 255 ký tự.',
  'Invalid ID or query parameters': 'Mã danh mục không hợp lệ. Vui lòng tải lại danh sách.',
};

async function adminCategoriesRequest(token, path, options = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw Object.assign(new Error('Vui lòng đăng nhập bằng tài khoản Admin để quản lý danh mục.'), { status: 401 });
  }
  try {
    return await commerceApi(path, { ...options, token });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error.status === 403) error.message = 'Bạn không có quyền quản lý danh mục. Vui lòng dùng tài khoản Admin đang hoạt động.';
    else if (messages[error.message]) error.message = messages[error.message];
    throw error;
  }
}

export function getAdminCategories(token, { signal } = {}) {
  return adminCategoriesRequest(token, '/api/admin/categories', { signal });
}

export function createAdminCategory(token, body) {
  return adminCategoriesRequest(token, '/api/admin/categories', { method: 'POST', body });
}

export function updateAdminCategory(token, categoryId, body) {
  return adminCategoriesRequest(token, `/api/admin/categories/${categoryId}`, { method: 'PUT', body });
}

export function deleteAdminCategory(token, categoryId) {
  return adminCategoriesRequest(token, `/api/admin/categories/${categoryId}`, { method: 'DELETE' });
}
