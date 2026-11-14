import { commerceApi } from './commerce.js';

const messages = {
  'Active admin account required': 'Bạn cần tài khoản Admin đang hoạt động để quản lý sản phẩm.',
  'Category does not exist': 'Danh mục không còn tồn tại. Vui lòng tải lại danh mục và chọn lại.',
  'Catalog is busy; retry the request': 'Danh mục sản phẩm đang bận. Vui lòng thử lại sau.',
  'Linked catalog data prevents this operation': 'Dữ liệu liên quan đã thay đổi. Vui lòng tải lại danh sách.',
  'Unsupported or missing fields': 'Thông tin sản phẩm chưa đầy đủ hoặc có trường không hợp lệ.',
  'Required fields are missing': 'Vui lòng điền đầy đủ các trường bắt buộc.',
  'Text fields must be strings': 'Vui lòng kiểm tra lại các trường văn bản.',
  'Invalid or oversized text': 'Nội dung quá dài hoặc có ký tự không được hỗ trợ.',
  'Description exceeds MySQL TEXT capacity': 'Mô tả quá dài. Vui lòng rút ngắn nội dung.',
  'Invalid category_id': 'Vui lòng chọn danh mục hợp lệ.',
  'Invalid price': 'Vui lòng nhập giá bán hợp lệ.',
  'Price must be nonnegative, max 9999999999.99 with at most two decimal places': 'Giá phải từ 0 đến 9.999.999.999,99 và có tối đa 2 chữ số thập phân.',
  'Stock must be a nonnegative integer': 'Tồn kho phải là số nguyên từ 0 đến 2.147.483.647.',
  'Image must use /images/products/...': 'Đường dẫn ảnh phải bắt đầu bằng /images/products/.',
  'Invalid product image path': 'Đường dẫn ảnh không hợp lệ. Hãy dùng ảnh webp, png, jpg, jpeg, gif hoặc avif trong /images/products/.',
  'Invalid product status': 'Vui lòng chọn trạng thái Đang bán hoặc Ngừng bán.',
  'Invalid pagination': 'Trang hoặc số sản phẩm mỗi trang không hợp lệ.',
  'Invalid category filter': 'Danh mục lọc không hợp lệ. Vui lòng chọn lại.',
  'Invalid status filter': 'Trạng thái lọc không hợp lệ. Vui lòng chọn lại.',
  'min_price exceeds max_price': 'Giá tối thiểu không được lớn hơn giá tối đa.',
  'Invalid pet_type_ids': 'Vui lòng chọn các loài thú cưng hợp lệ, không trùng nhau.',
  'Pet type does not exist': 'Loài thú cưng đã thay đổi. Vui lòng tải lại danh sách và chọn lại.',
  'Unknown pet type': 'Loài thú cưng đã thay đổi. Vui lòng tải lại danh sách và chọn lại.',
};

async function adminProductsRequest(token, path, options = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw Object.assign(new Error('Vui lòng đăng nhập bằng tài khoản Admin để quản lý sản phẩm.'), { status: 401 });
  }
  try {
    return await commerceApi(path, { ...options, token });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error.status === 403) error.message = 'Bạn không có quyền quản lý sản phẩm. Vui lòng dùng tài khoản Admin đang hoạt động.';
    else if (error.code === 'PET_TYPES_NOT_READY') error.message = 'Phân loại thú cưng chưa sẵn sàng. Vui lòng hoàn tất migration trước khi lưu lựa chọn loài.';
    else if (messages[error.message]) error.message = messages[error.message];
    throw error;
  }
}

export function getAdminProducts(token, {
  page = 1, limit = 20, q = '', category_id = '', status = '', min_price = '', max_price = '', signal,
} = {}) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  const filters = { q: q.trim(), category_id, status, min_price, max_price };
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '' && value !== undefined && value !== null) params.set(key, String(value));
  }
  return adminProductsRequest(token, `/api/admin/products?${params}`, { signal });
}

export function getAdminProductCategories(token, { signal } = {}) {
  return adminProductsRequest(token, '/api/admin/categories', { signal });
}

export function getAdminPetTypes(token, { signal } = {}) {
  return adminProductsRequest(token, '/api/admin/pet-types', { signal });
}

export function createAdminProduct(token, body, { signal } = {}) {
  return adminProductsRequest(token, '/api/admin/products', { method: 'POST', body, signal });
}

export function updateAdminProduct(token, productId, body, { signal } = {}) {
  return adminProductsRequest(token, `/api/admin/products/${productId}`, { method: 'PUT', body, signal });
}

export function stopAdminProduct(token, productId, { signal } = {}) {
  return adminProductsRequest(token, `/api/admin/products/${productId}`, { method: 'DELETE', signal });
}
