import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Package, RefreshCw, Send, Star, UserRound } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { ErrorNotice } from '../components/Feedback.jsx';
import { ProductImage } from '../components/ProductCard.jsx';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import { formatOrderDate } from '../utils/orders.js';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../my-orders.css';
import '../product-review.css';

const REVIEW_PAGE_SIZE = 100;
const STARS = [1, 2, 3, 4, 5];
const positiveId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const validId = value => /^[1-9]\d*$/.test(String(value || '')) && positiveId(Number(value));
const validReview = review => review && positiveId(review.review_id) && positiveId(review.product_id) &&
  Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5 && typeof review.comment === 'string';
const reviewFields = review => ({ review_id: review.review_id, product_id: review.product_id, rating: review.rating,
  comment: review.comment, created_at: review.created_at });
const cleanComment = value => value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').trim();
// Decode the backend's five escaped entities once, then render as React text.
const reviewText = value => value.replace(/&(amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));

async function findExistingReview(readReviews, productId, signal, onProgress) {
  let total = null;
  for (let page = 1; page <= 2147483647; page++) {
    const data = await readReviews({ page, limit: REVIEW_PAGE_SIZE, signal });
    if (!Array.isArray(data.reviews) || data.page !== page || data.limit !== REVIEW_PAGE_SIZE ||
      !Number.isSafeInteger(data.total) || data.total < 0 || !data.reviews.every(validReview)) {
      throw new Error('Chưa kiểm tra được đầy đủ đánh giá của bạn. Vui lòng thử lại.');
    }
    const existing = data.reviews.find(review => review.product_id === productId);
    if (existing) return reviewFields(existing);
    if (total !== null && data.total !== total) throw new Error('Danh sách đánh giá vừa thay đổi. Vui lòng kiểm tra lại trước khi gửi.');
    total = data.total;
    const expected = Math.min(REVIEW_PAGE_SIZE, Math.max(0, total - (page - 1) * REVIEW_PAGE_SIZE));
    if (data.reviews.length !== expected) throw new Error('Dữ liệu đánh giá chưa đầy đủ. Vui lòng kiểm tra lại trước khi gửi.');
    onProgress?.(page, Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE)));
    if (page * REVIEW_PAGE_SIZE >= total) return null;
  }
  throw new Error('Chưa kiểm tra được toàn bộ đánh giá. Vui lòng thử lại sau.');
}

function ReviewLoading({ label = 'Đang kiểm tra đơn hàng và đánh giá của bạn' }) {
  return <div className="product-review-loading" role="status"><p>{label}...</p>{[0, 1, 2].map(index => <div key={index} className="skeleton skeleton-line" aria-hidden="true" />)}</div>;
}

function SavedReview({ review }) {
  const date = formatOrderDate(review.created_at, true);
  return <div className="product-review-existing"><div className="product-review-readonly-stars" role="img" aria-label={`${review.rating} trên 5 sao`}>{STARS.map(value => <Star key={value} size={22} fill={value <= review.rating ? 'currentColor' : 'none'} aria-hidden="true" />)}<span>{review.rating}/5 sao</span></div><p className="product-review-saved-comment">{reviewText(review.comment)}</p>{date && <time>{date}</time>}</div>;
}

function ReviewContent({ orderId, productId, userId }) {
  const { getOrder, getMyReviews, createProductReview } = useCommerce();
  const methods = useRef({});
  methods.current = { getOrder, getMyReviews, createProductReview };
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [actionError, setActionError] = useState('');
  const [serverDenied, setServerDenied] = useState('');
  const [duplicateDetected, setDuplicateDetected] = useState(false);
  const [success, setSuccess] = useState(false);
  const [progress, setProgress] = useState('');
  const busyRef = useRef(false);
  const alive = useRef(false);
  const submissionController = useRef(null);
  const current = result?.revision === revision ? result : null;
  const loading = !current || current.loading;
  const orderHref = `/my-orders/${orderId}`;

  async function loadContext(signal, onProgress) {
    const data = await methods.current.getOrder(orderId, { signal });
    const order = data.order;
    if (!order || order.order_id !== orderId || order.user_id !== userId || typeof order.status !== 'string' || !Array.isArray(order.items)) {
      throw new Error('Thông tin đơn hàng không hợp lệ hoặc không thuộc tài khoản của bạn.');
    }
    const item = order.items.find(value => value.product_id === productId && Number.isInteger(value.quantity) && value.quantity > 0);
    if (!item) return { blocked: 'Sản phẩm không thuộc đơn hàng này hoặc không có số lượng hợp lệ. Hãy chọn sản phẩm từ chi tiết đơn hàng.' };
    if (typeof item.name !== 'string' || (item.image_url != null && typeof item.image_url !== 'string')) throw new Error('Chưa tải được thông tin sản phẩm trong đơn hàng.');
    const product = { product_id: item.product_id, name: item.name, image_url: item.image_url, quantity: item.quantity, unit_price: item.unit_price };
    if (order.status !== 'Đã giao hàng') return { product, blocked: `Đơn hàng hiện ở trạng thái “${order.status}”. Chỉ có thể đánh giá sản phẩm khi đơn ở trạng thái Đã giao hàng.` };
    const existing = await findExistingReview(options => methods.current.getMyReviews(options), productId, signal, onProgress);
    return { product, existing, blocked: '' };
  }

  useEffect(() => { alive.current = true; return () => { alive.current = false; submissionController.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ revision, loading: true, error: '', product: null, existing: null, blocked: '' });
    setProgress('');
    loadContext(controller.signal, (page, pages) => { if (active) setProgress(`Đang kiểm tra đánh giá của bạn · trang ${page}/${pages}`); }).then(value => {
      if (active) setResult({ revision, loading: false, error: '', ...value });
    }).catch(error => {
      if (!active || controller.signal.aborted || error.obsolete || [401, 403].includes(error.status)) return;
      setResult({ revision, loading: false, error: error.status === 404 ? 'Không tìm thấy đơn hàng hoặc bạn không có quyền truy cập.' : error.message || 'Chưa tải được dữ liệu đánh giá. Vui lòng thử lại.', product: null, existing: null, blocked: '' });
    });
    return () => { active = false; controller.abort(); };
  }, [orderId, productId, userId, revision]);

  const retry = () => { if (!busyRef.current) { setServerDenied(''); setActionError(''); setRevision(value => value + 1); } };
  const submit = async event => {
    event.preventDefault();
    if (busyRef.current || !current || current.blocked || current.existing || duplicateDetected || serverDenied) return;
    const nextErrors = {};
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) nextErrors.rating = 'Vui lòng chọn số sao từ 1 đến 5.';
    if (!comment.trim() || comment.length > 2000) nextErrors.comment = 'Nhập nội dung đánh giá từ 1 đến 2.000 ký tự.';
    else if (/[<>\uD800-\uDFFF]/u.test(comment) || [...comment].some(char => char.codePointAt(0) > 65535)) nextErrors.comment = 'Không dùng dấu <, > hoặc emoji không được hỗ trợ. Chỉ nhập nội dung văn bản.';
    else if (!cleanComment(comment)) nextErrors.comment = 'Nội dung chưa có văn bản hợp lệ sau khi loại bỏ ký tự điều khiển.';
    setErrors(nextErrors); setActionError('');
    const invalid = Object.keys(nextErrors)[0];
    if (invalid) {
      if (invalid === 'rating') event.currentTarget.querySelector('input[name="rating"]')?.focus();
      else event.currentTarget.elements.namedItem(invalid)?.focus();
      return;
    }
    busyRef.current = true; setBusy(true); setPhase('Đang kiểm tra lại điều kiện đánh giá');
    const controller = new AbortController();
    submissionController.current = controller;
    try {
      // Recheck the selected order and all required review pages before every POST.
      const checked = await loadContext(controller.signal);
      if (!alive.current) return;
      if (checked.blocked || checked.existing) {
        setResult({ revision, loading: false, error: '', ...checked });
        if (checked.existing) setDuplicateDetected(true);
        return;
      }
      setPhase('Đang gửi đánh giá');
      const data = await methods.current.createProductReview(productId, { rating, comment });
      if (!alive.current) return;
      if (!validReview(data.review) || data.review.product_id !== productId || data.review.rating !== rating) throw new Error('Chưa xác nhận được kết quả gửi. Vui lòng kiểm tra lại đánh giá của bạn trước khi thử lại.');
      setResult({ revision, loading: false, error: '', ...checked, existing: reviewFields(data.review) });
      setDuplicateDetected(true); setSuccess(true);
    } catch (error) {
      if (!alive.current || controller.signal.aborted || error.obsolete || ([401, 403].includes(error.status) && error.code !== 'REVIEW_NOT_ELIGIBLE')) return;
      if (error.code === 'REVIEW_EXISTS') {
        setDuplicateDetected(true); setActionError(error.message); setRevision(value => value + 1);
      } else if (error.code === 'REVIEW_NOT_ELIGIBLE' || error.status === 404) {
        setServerDenied(error.message);
      } else setActionError(error.message || 'Chưa gửi được đánh giá. Vui lòng thử lại.');
    } finally {
      busyRef.current = false;
      if (submissionController.current === controller) submissionController.current = null;
      if (alive.current) { setBusy(false); setPhase(''); }
    }
  };

  if (loading) return <ReviewLoading label={progress || undefined} />;
  if (current.error) return <ErrorNotice title={duplicateDetected ? 'Bạn đã đánh giá sản phẩm này; chưa tải được nội dung' : 'Chưa kiểm tra được điều kiện đánh giá'} message={current.error} onRetry={retry} />;
  if (current.blocked) return <section className="product-review-state"><Package size={36} aria-hidden="true" /><h2>Chưa thể đánh giá sản phẩm</h2><p>{current.blocked}</p><button className="button button-outline" type="button" onClick={retry}><RefreshCw size={16} aria-hidden="true" />Kiểm tra lại</button><div className="product-review-actions"><a className="button button-outline" href={orderHref}>Về chi tiết đơn hàng</a></div></section>;
  const reviewed = Boolean(current.existing || duplicateDetected);
  const image = resolveImageUrl(current.product.image_url);
  return <>
    {success && <p className="product-review-success" role="status"><Check size={18} aria-hidden="true" />Đã gửi đánh giá của bạn.</p>}
    <div className="product-review-layout"><section className="product-review-product" aria-label="Sản phẩm được đánh giá"><div className="product-review-image"><ProductImage key={image} source={image} name={current.product.name} width={210} height={210} /></div><h2>{current.product.name}</h2><p>Đơn hàng #{orderId} · Số lượng {current.product.quantity}</p>{current.product.unit_price != null && <p>Đơn giá khi đặt</p>}{current.product.unit_price != null && <p className="product-review-price">{formatPrice(current.product.unit_price)}</p>}</section>
      <section className="product-review-card"><h2>{reviewed ? 'Bạn đã đánh giá sản phẩm này' : 'Chia sẻ trải nghiệm của bạn'}</h2><p className="product-review-note">Mỗi tài khoản chỉ được đánh giá một lần cho mỗi sản phẩm, kể cả khi mua ở nhiều đơn hàng.</p>
        {reviewed ? <>{current.existing ? <SavedReview review={current.existing} /> : <div className="product-review-error" role="status"><p>Bạn đã đánh giá sản phẩm này. Chưa tải được nội dung đánh giá.</p><button className="button button-outline" type="button" onClick={retry}>Kiểm tra lại đánh giá</button></div>}<div className="product-review-actions"><a className="button button-outline" href={orderHref}>Về chi tiết đơn hàng</a></div></> : serverDenied ? <div className="product-review-error" role="alert"><p>{serverDenied}</p><button className="button button-outline" type="button" onClick={retry}>Kiểm tra lại điều kiện</button></div> : <form className="product-review-form" noValidate onSubmit={submit} aria-busy={busy}>
          <fieldset disabled={busy}><fieldset className="product-review-rating" aria-describedby={errors.rating ? 'review-rating-error' : 'review-rating-label'}><legend>Số sao *</legend><div className="product-review-stars">{STARS.map(value => <label key={value} htmlFor={`review-star-${value}`} data-selected={value <= rating} title={`${value} sao`}><input className="sr-only" id={`review-star-${value}`} type="radio" name="rating" value={value} checked={rating === value} required aria-label={`${value} sao`} onChange={() => { setRating(value); setErrors(previous => ({ ...previous, rating: '' })); }} /><span><Star size={25} fill={value <= rating ? 'currentColor' : 'none'} aria-hidden="true" /></span></label>)}</div><p className="product-review-rating-label" id="review-rating-label">{rating ? `Bạn chọn ${rating}/5 sao` : 'Chọn từ 1 đến 5 sao'}</p>{errors.rating && <small className="product-review-field-error" id="review-rating-error">{errors.rating}</small>}</fieldset>
          <div className="product-review-comment"><label htmlFor="review-comment">Nội dung đánh giá *</label><textarea id="review-comment" name="comment" rows={6} maxLength={2000} required value={comment} onChange={event => { setComment(event.target.value); setErrors(previous => ({ ...previous, comment: '' })); setActionError(''); }} aria-invalid={Boolean(errors.comment)} aria-describedby={errors.comment ? 'review-comment-error review-comment-count' : 'review-comment-count'} placeholder="Chia sẻ cảm nhận của bạn về sản phẩm..." /><small className="product-review-count" id="review-comment-count">{comment.length}/2.000 ký tự</small>{errors.comment && <small className="product-review-field-error" id="review-comment-error">{errors.comment}</small>}</div></fieldset>
          {actionError && <p className="product-review-error" role="alert">{actionError}</p>}{busy && <p className="product-review-note" role="status">{phase}...</p>}
          <div className="product-review-actions"><a className="button button-outline" href={orderHref}>Về đơn hàng</a><button className="button button-primary" type="submit" disabled={busy}><Send size={16} aria-hidden="true" />{busy ? 'Đang xử lý...' : 'Gửi đánh giá'}</button></div>
        </form>}
      </section>
    </div>
  </>;
}

export default function ProductReviewPage({ orderId, productId }) {
  const { user, authLoading } = useCommerce();
  const validIds = validId(orderId) && validId(productId);
  const orderHref = validId(orderId) ? `/my-orders/${orderId}` : '/my-orders';
  useEffect(() => {
    const previous = document.title;
    document.title = `Đánh giá sản phẩm | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, []);
  useEffect(() => {
    if (authLoading || user) return;
    const returnTo = safeReturnUrl(window.location.pathname, '/my-orders');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id]);
  return <div className="container my-orders-page product-review-page"><nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/my-orders">Đơn hàng của tôi</a><ChevronRight size={13} aria-hidden="true" /><a href={orderHref}>Chi tiết đơn hàng</a><ChevronRight size={13} aria-hidden="true" /><span aria-current="page">Đánh giá sản phẩm</span></nav><div className="my-orders-page-heading"><div><p className="my-orders-eyebrow">TRẢI NGHIỆM CỦA BẠN</p><h1>Đánh giá sản phẩm</h1><p>Chia sẻ cảm nhận về sản phẩm trong đơn hàng đã giao.</p></div><a className="button button-outline" href={orderHref}><ArrowLeft size={16} aria-hidden="true" />Về đơn hàng</a></div>
    {authLoading || !user ? <ReviewLoading label="Đang kiểm tra đăng nhập" /> : user.role !== 'user' ? <section className="product-review-state"><UserRound size={36} aria-hidden="true" /><h2>Đánh giá dành cho khách hàng</h2><p>Vui lòng sử dụng tài khoản khách hàng đã mua sản phẩm.</p><a className="button button-outline" href="/">Về cửa hàng</a></section> : !validIds ? <section className="product-review-state"><Package size={36} aria-hidden="true" /><h2>Thông tin đánh giá không hợp lệ</h2><p>Hãy mở đơn hàng đã giao và chọn đúng sản phẩm cần đánh giá.</p><a className="button button-outline" href="/my-orders">Đơn hàng của tôi</a></section> : <ReviewContent key={`${user.user_id}:${orderId}:${productId}`} userId={user.user_id} orderId={Number(orderId)} productId={Number(productId)} />}
  </div>;
}
