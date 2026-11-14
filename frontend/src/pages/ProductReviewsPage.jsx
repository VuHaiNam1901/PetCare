import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, MessageSquare, Star } from 'lucide-react';
import { ErrorNotice } from '../components/Feedback.jsx';
import { ReviewList, ReviewSummary } from '../components/ProductReviewContent.jsx';
import useProductReviews from '../hooks/useProductReviews.js';
import { BRAND_NAME } from '../config/branding.js';
import '../product-reviews.css';

const maximumId = 2147483647;
const validId = value => /^[1-9]\d*$/.test(String(value || '')) && Number(value) <= maximumId;
const filters = ['', 5, 4, 3, 2, 1];
function readQuery(search) {
  const params = new URLSearchParams(search);
  const number = (key, fallback, max) => !params.has(key) ? fallback : /^[1-9]\d*$/.test(params.get(key)) && Number(params.get(key)) <= max ? Number(params.get(key)) : NaN;
  const page = number('page', 1, maximumId);
  const limit = number('limit', 10, 100);
  const rating = params.has('rating') ? params.get('rating') : '';
  const valid = [...params.keys()].every(key => ['page', 'limit', 'rating'].includes(key) && params.getAll(key).length === 1) &&
    Number.isSafeInteger(page) && Number.isSafeInteger(limit) && Number.isSafeInteger((page - 1) * limit) &&
    (!params.has('rating') || /^[1-5]$/.test(rating));
  return valid ? { valid, page, limit, rating } : { valid: false, page: 1, limit: 10, rating: '' };
}

function ReviewsLoading() {
  return <div className="product-reviews-loading" role="status"><p>Đang tải đánh giá sản phẩm...</p>{[0, 1, 2].map(index => <div className="skeleton skeleton-line" key={index} aria-hidden="true" />)}</div>;
}

export default function ProductReviewsPage({ productId }) {
  const [search, setSearch] = useState(() => window.location.search);
  const query = readQuery(search);
  const productValid = validId(productId);
  const productHref = productValid ? `/products/${productId}` : '/products';
  const reviewsHref = productValid ? `${productHref}/reviews` : '/products';
  const { loading, error, status, data, retry } = useProductReviews(productId, { page: query.page, limit: query.limit, rating: query.rating, enabled: productValid && query.valid });
  const productName = data?.product.name;
  const pageCount = Math.max(1, Math.ceil((data?.total || 0) / query.limit));

  useEffect(() => {
    const previous = document.title;
    document.title = `${productName ? `Đánh giá ${productName}` : 'Đánh giá sản phẩm'} | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, [productName]);
  useEffect(() => {
    const restore = () => setSearch(window.location.search);
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  function navigate(page, rating = query.rating) {
    if (query.valid && page === query.page && String(rating) === String(query.rating)) return;
    const params = new URLSearchParams();
    if (rating !== '') params.set('rating', String(rating));
    if (page > 1) params.set('page', String(page));
    if (query.limit !== 10) params.set('limit', String(query.limit));
    const next = params.size ? `?${params}` : '';
    window.history.pushState(null, '', `${reviewsHref}${next}`);
    setSearch(next);
  }

  const notFound = !productValid || status === 404;
  return <div className="container product-reviews-page">
    <nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><a href="/products">Sản phẩm</a><ChevronRight size={14} aria-hidden="true" /><a href={productHref}>{productName || 'Chi tiết sản phẩm'}</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">Đánh giá</span></nav>
    <div className="product-reviews-heading"><div><p className="product-reviews-eyebrow">NHẬN XÉT TỪ KHÁCH HÀNG</p><h1>Đánh giá sản phẩm</h1>{productName && <p className="product-reviews-name">{productName}</p>}</div><a className="button button-outline" href={productHref}><ArrowLeft size={16} aria-hidden="true" />{productValid ? 'Quay lại sản phẩm' : 'Danh sách sản phẩm'}</a></div>
    {notFound ? <section className="product-reviews-state"><MessageSquare size={35} aria-hidden="true" /><h2>Không tìm thấy sản phẩm</h2><p>{productValid ? 'Sản phẩm không tồn tại hoặc không còn truy cập được.' : 'Mã sản phẩm không hợp lệ. Vui lòng chọn sản phẩm từ danh sách.'}</p><a className="button button-primary" href="/products">Xem sản phẩm</a></section>
      : !query.valid ? <section className="product-reviews-state"><MessageSquare size={35} aria-hidden="true" /><h2>Tham số đánh giá không hợp lệ</h2><p>Trang phải là số nguyên dương, số đánh giá mỗi trang từ 1–100 và bộ lọc sao từ 1–5.</p><a className="button button-outline" href={reviewsHref}>Xem đánh giá sản phẩm</a></section>
        : <>
          {data && <section className="product-reviews-summary-card" aria-label="Tổng quan đánh giá sản phẩm"><ReviewSummary summary={data.summary} /></section>}
          <section className="product-reviews-results" aria-labelledby="product-reviews-results-title" aria-busy={loading}>
            <div className="product-reviews-results-heading"><h2 id="product-reviews-results-title">Đánh giá của khách hàng</h2><p>Mới nhất trước · {query.limit} đánh giá/trang</p></div>
            <div className="product-reviews-filters" role="group" aria-label="Lọc đánh giá theo số sao">{filters.map(value => {
              const active = String(query.rating) === String(value);
              const count = data ? value === '' ? data.summary.total : data.summary.distribution[value] : null;
              return <button className={`button button-outline product-reviews-filter${active ? ' is-active' : ''}`} key={value || 'all'} type="button" aria-pressed={active} disabled={loading} onClick={() => navigate(1, value)}>{value === '' ? 'Tất cả' : <>{value}<Star size={13} fill="currentColor" aria-hidden="true" /><span className="sr-only"> sao</span></>}{count !== null && <span className="product-reviews-filter-count">({count})</span>}</button>;
            })}</div>
            {loading ? <ReviewsLoading /> : error ? <ErrorNotice title="Chưa tải được đánh giá" message={error} onRetry={retry} /> : data?.reviews.length ? <>
              <p className="product-reviews-matches" role="status">{data.total} đánh giá{query.rating ? ` · ${query.rating} sao` : ''}</p><ReviewList reviews={data.reviews} />
            </> : <div className="product-reviews-empty" role="status"><MessageSquare size={32} aria-hidden="true" /><h3>{data?.total > 0 ? 'Không có đánh giá ở trang này' : query.rating ? `Chưa có đánh giá ${query.rating} sao` : 'Sản phẩm chưa có đánh giá'}</h3><p>{data?.total > 0 ? 'Danh sách có thể đã thay đổi. Quay về trang đầu để xem các đánh giá mới nhất.' : query.rating ? 'Thử bộ lọc khác để xem thêm nhận xét của khách hàng.' : 'Những nhận xét được gửi sẽ xuất hiện tại đây.'}</p>{data?.total > 0 && <button className="button button-outline" type="button" onClick={() => navigate(1)}>Về trang đầu</button>}</div>}
            {!loading && !error && data?.total > 0 && <nav className="product-reviews-pagination" aria-label="Phân trang đánh giá"><p>Trang <strong>{query.page}</strong> / {pageCount}</p><div><button className="button button-outline" type="button" aria-label="Trang đánh giá trước" disabled={query.page <= 1} onClick={() => navigate(query.page - 1)}><ChevronLeft size={16} aria-hidden="true" />Trước</button><button className="button button-outline" type="button" aria-label="Trang đánh giá tiếp theo" disabled={query.page >= pageCount} onClick={() => navigate(query.page + 1)}>Tiếp<ChevronRight size={16} aria-hidden="true" /></button></div></nav>}
          </section>
        </>}
  </div>;
}
