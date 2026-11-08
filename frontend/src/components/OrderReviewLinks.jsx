import { Star } from 'lucide-react';
import '../product-review.css';

export default function OrderReviewLinks({ order }) {
  if (order.status !== 'Đã giao hàng' || !Array.isArray(order.items)) return null;
  const products = [...new Map(order.items.filter(item => Number.isSafeInteger(item.product_id) && item.product_id > 0 && item.quantity > 0)
    .map(item => [item.product_id, item])).values()];
  if (!products.length) return null;
  return <div className="order-review-links"><h3>Chia sẻ trải nghiệm sản phẩm</h3>
    {products.map(product => <div key={product.product_id} className="order-review-link"><span>{product.name}</span><a className="button button-outline" href={`/my-orders/${order.order_id}/review/${product.product_id}`} aria-label={`Đánh giá sản phẩm ${product.name}`}><Star size={15} aria-hidden="true" />Đánh giá sản phẩm</a></div>)}
    <p>Mỗi tài khoản chỉ được đánh giá một lần cho mỗi sản phẩm, kể cả khi mua ở nhiều đơn hàng.</p>
  </div>;
}
