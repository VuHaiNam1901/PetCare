import { Star, UserRound } from 'lucide-react';
import { formatOrderDate } from '../utils/orders.js';
import '../product-reviews.css';

const stars = [1, 2, 3, 4, 5];
const averageFormatter = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
// Decode only the five entities emitted by the review API, once. React still
// renders the result as text, including any legacy markup in names/comments.
const reviewText = value => String(value ?? '').replace(/&(amp|lt|gt|quot|#39);/g,
  entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));

export const formatReviewAverage = value => value == null ? '—' : averageFormatter.format(value);

export function ReviewStars({ rating, size = 16 }) {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  return <span className="review-display-stars" style={{ '--review-star-size': `${size}px` }} role="img" aria-label={`${formatReviewAverage(value)} trên 5 sao`}>
    <span className="review-stars-track" aria-hidden="true">{stars.map(star => <Star key={star} size={size} />)}</span>
    <span className="review-stars-fill" style={{ width: `${value * 20}%` }} aria-hidden="true"><span className="review-stars-track">{stars.map(star => <Star key={star} size={size} fill="currentColor" />)}</span></span>
  </span>;
}

export function ReviewSummary({ summary }) {
  const total = summary.total;
  return <div className="review-summary">
    <div className="review-summary-score">
      <p><strong>{formatReviewAverage(summary.average_rating)}</strong><span>/ 5</span></p>
      <ReviewStars rating={summary.average_rating} size={21} />
      <span>{total === 0 ? 'Chưa có đánh giá' : `${total} lượt đánh giá`}</span>
    </div>
    <ul className="review-distribution" aria-label="Phân bố đánh giá theo số sao" role="list">
      {[5, 4, 3, 2, 1].map(rating => {
        const count = summary.distribution[rating];
        return <li key={rating} aria-label={`${rating} sao: ${count} đánh giá`}>
          <span className="review-distribution-label">{rating}<Star size={13} fill="currentColor" aria-hidden="true" /><span className="sr-only"> sao</span></span>
          <span className="review-distribution-track" aria-hidden="true"><span style={{ width: `${total ? count / total * 100 : 0}%` }} /></span>
          <span className="review-distribution-count">{count}</span>
        </li>;
      })}
    </ul>
  </div>;
}

export function ReviewList({ reviews }) {
  return <ul className="review-list" role="list" aria-label="Nhận xét của khách hàng">
    {reviews.map(review => {
      const name = reviewText(review.reviewer_name).trim() || 'Khách hàng';
      const date = formatOrderDate(review.created_at, true);
      return <li key={review.review_id}>
        <article className="review-card" aria-label={`Đánh giá ${review.rating} sao của ${name}`}>
          <header><span className="review-card-avatar" aria-hidden="true"><UserRound size={19} /></span><div className="review-card-author"><h3>{name}</h3><ReviewStars rating={review.rating} /></div>{date ? <time dateTime={review.created_at}>{date}</time> : <span className="review-card-date">Chưa có ngày đánh giá</span>}</header>
          <p className="review-card-comment">{review.comment == null || review.comment === '' ? 'Không có nội dung nhận xét.' : reviewText(review.comment)}</p>
        </article>
      </li>;
    })}
  </ul>;
}
