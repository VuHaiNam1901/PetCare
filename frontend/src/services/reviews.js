import { commerceApi } from './commerce.js';

const messages = {
  'Invalid product ID': 'Mã sản phẩm không hợp lệ. Vui lòng mở lại sản phẩm từ đơn hàng.',
  'Invalid pagination': 'Trang hoặc số đánh giá mỗi trang không hợp lệ.',
  'Unsupported query parameters': 'Yêu cầu tải đánh giá không hợp lệ. Vui lòng thử lại.',
  'Only rating and comment are accepted': 'Chỉ được gửi số sao và nội dung đánh giá.',
  'Rating must be an integer from 1 to 5': 'Vui lòng chọn số sao từ 1 đến 5.',
  'Comment must contain 1-2000 characters': 'Vui lòng nhập nội dung đánh giá từ 1 đến 2.000 ký tự.',
  'Comment must be plain text without HTML or unsupported characters': 'Nội dung đánh giá không được chứa dấu <, > hoặc emoji không được hỗ trợ.',
  'Comment is empty after removing unsafe control characters': 'Nội dung đánh giá chưa có văn bản hợp lệ. Vui lòng nhập lại.',
};

async function reviewRequest(token, path, options = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw Object.assign(new Error('Vui lòng đăng nhập bằng tài khoản khách hàng để đánh giá sản phẩm.'), { status: 401 });
  }
  try {
    return await commerceApi(path, { ...options, token });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    let message;
    let code;
    let preserveSession = false;
    if (error.message === 'You have already reviewed this product') {
      message = 'Bạn đã đánh giá sản phẩm này. Mỗi khách hàng chỉ được đánh giá một lần cho mỗi sản phẩm.';
      code = 'REVIEW_EXISTS';
    } else if (error.message === 'Reviews are busy; retry the request') {
      message = 'Đánh giá đang được xử lý. Vui lòng thử lại sau.';
      code = 'REVIEWS_BUSY';
    } else if (error.status === 403 && error.message === 'A delivered purchase of this product is required') {
      message = 'Bạn cần có đơn hàng đã giao thành công chứa sản phẩm này để gửi đánh giá.';
      code = 'REVIEW_NOT_ELIGIBLE';
      preserveSession = true;
    } else if (error.status === 401) message = 'Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.';
    else if (error.status === 403) message = 'Tài khoản không được phép đánh giá. Vui lòng đăng nhập bằng tài khoản khách hàng đang hoạt động.';
    else if (error.status === 404) message = 'Không tìm thấy sản phẩm. Vui lòng tải lại đơn hàng trước khi tiếp tục.';
    else if (messages[error.message]) message = messages[error.message];
    else if (error.status === 400) message = 'Nội dung đánh giá chưa hợp lệ. Vui lòng kiểm tra lại số sao và nội dung.';
    else if (error.status === 409) message = 'Đánh giá đang có xung đột. Vui lòng tải lại dữ liệu trước khi thử lại.';
    else if (error.status >= 500) message = 'Máy chủ chưa xử lý được đánh giá. Vui lòng thử lại sau.';
    else message = 'Chưa nhận được xác nhận từ máy chủ. Vui lòng kiểm tra kết nối và thử lại.';
    throw Object.assign(new Error(message), { status: error.status, ...(code ? { code } : {}), ...(preserveSession ? { preserveSession: true } : {}) });
  }
}

export function getMyReviews(token, { page = 1, limit = 100, signal } = {}) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  return reviewRequest(token, `/api/users/me/reviews?${params}`, { signal });
}

export function createProductReview(token, productId, { rating, comment }) {
  return reviewRequest(token, `/api/products/${productId}/reviews`, { method: 'POST', body: { rating, comment } });
}
