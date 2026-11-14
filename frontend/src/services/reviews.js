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

const positiveInteger = value => /^[1-9]\d*$/.test(String(value)) && Number(value) <= 2147483647;
const count = value => Number.isSafeInteger(value) && value >= 0;

// Public reads do not use the authenticated review-submission flow.
export async function getProductReviews(productId, { page = 1, limit = 10, rating = '', signal } = {}) {
  if (!positiveInteger(productId) || !positiveInteger(page) || !positiveInteger(limit) || Number(limit) > 100 ||
    !Number.isSafeInteger((Number(page) - 1) * Number(limit)) || (rating !== '' && !/^[1-5]$/.test(String(rating)))) {
    throw Object.assign(new Error('Thông số trang hoặc bộ lọc đánh giá không hợp lệ.'), { status: 400 });
  }
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (rating !== '') params.set('rating', String(rating));
  let data;
  try {
    data = await commerceApi(`/api/products/${productId}/reviews?${params}`, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error.status === 404 ? 'Không tìm thấy sản phẩm.'
      : error.status === 400 ? 'Thông số trang hoặc bộ lọc đánh giá không hợp lệ.'
        : 'Chưa tải được đánh giá. Vui lòng kiểm tra kết nối và thử lại.';
    throw Object.assign(new Error(message), { status: error.status });
  }
  const summary = data?.summary;
  const distribution = summary?.distribution;
  const validSummary = count(summary?.total) && distribution && [1, 2, 3, 4, 5].every(star => count(distribution[star])) &&
    [1, 2, 3, 4, 5].reduce((sum, star) => sum + distribution[star], 0) === summary.total &&
    (summary.total === 0 ? summary.average_rating === null : typeof summary.average_rating === 'number' && Number.isFinite(summary.average_rating) && summary.average_rating >= 1 && summary.average_rating <= 5);
  const validReviews = Array.isArray(data?.reviews) && data.reviews.length <= Number(limit) && data.reviews.every(review =>
    positiveInteger(review.review_id) && Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5 &&
    (review.comment === null || typeof review.comment === 'string') && (review.reviewer_name === null || typeof review.reviewer_name === 'string') &&
    (review.created_at === null || typeof review.created_at === 'string') && (rating === '' || review.rating === Number(rating)));
  if (data?.success !== true || Number(data.product?.product_id) !== Number(productId) || typeof data.product?.name !== 'string' ||
    data.page !== Number(page) || data.limit !== Number(limit) || !count(data.total) || !validSummary || !validReviews ||
    data.total !== (rating === '' ? summary.total : distribution[rating])) {
    throw new Error('Dữ liệu đánh giá chưa đầy đủ. Vui lòng tải lại hoặc thử lại sau.');
  }
  return data;
}
