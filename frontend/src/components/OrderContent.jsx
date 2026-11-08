import { ProductImage } from './ProductCard.jsx';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import { formatOrderDate, orderStatusLabel } from '../utils/orders.js';
import '../order-history.css';

const statusTones = {
  'Chờ xử lý': 'pending', 'Chờ thanh toán': 'payment', 'Chờ giao hàng': 'ready',
  'Đang giao hàng': 'shipping', 'Đã giao hàng': 'delivered', 'Đã hủy': 'cancelled',
};

export function OrderStatusBadge({ status, order, className = '' }) {
  const value = order?.status || status;
  const label = order ? orderStatusLabel(order) : value || 'Chưa có trạng thái';
  return <span className={`my-order-status is-${label === 'Chờ duyệt' ? 'pending' : statusTones[value] || 'unknown'} ${className}`}><span aria-hidden="true" />{label}</span>;
}

const historyActions = { created: 'Đặt hàng', approve: 'Duyệt đơn', reject: 'Từ chối đơn', status: 'Cập nhật giao hàng', payment: 'Ghi nhận thanh toán', payment_failed: 'Thanh toán chưa thành công' };

export function OrderHistory({ history = [] }) {
  const entries = Array.isArray(history) ? history : [];
  return <section className="order-history" aria-label="Lịch sử trạng thái đơn hàng"><h2>Lịch sử trạng thái</h2>
    {entries.length ? <ol>{entries.map((entry, index) => {
      const date = formatOrderDate(entry.created_at, true);
      return <li key={entry.history_id || index} data-history-id={entry.history_id}>
        <div className="order-history-heading"><strong>{historyActions[entry.action] || 'Cập nhật trạng thái'}</strong>{date && <time dateTime={entry.created_at}>{date}</time>}</div>
        <p className="order-history-status">{entry.from_status ? `${entry.from_status} → ` : ''}{entry.to_status || 'Chưa có trạng thái'}</p>
        {entry.actor_name && <p className="order-history-actor">Người thực hiện: {entry.actor_name}</p>}
        {entry.reason && <p className="order-history-reason">{entry.reason}</p>}
      </li>;
    })}</ol> : <p className="order-history-empty">Chưa có lịch sử chuyển trạng thái được ghi nhận cho đơn hàng này.</p>}
  </section>;
}

export function OrderItems({ items, orderId, className = '', itemClassName = '' }) {
  return <ul className={`my-order-items ${className}`} aria-label={`Sản phẩm đơn hàng ${orderId}`}>
    {items.map(item => {
      const source = resolveImageUrl(item.image_url);
      return <li className={`my-order-item ${itemClassName}`} key={item.order_detail_id || item.product_id} data-product-id={item.product_id}>
        <a className="my-order-image" href={`/products/${item.product_id}`} aria-label={`Xem sản phẩm ${item.name}`}><ProductImage key={source} source={source} name={item.name} width={64} height={64} /></a>
        <div className="my-order-item-copy"><h3><a href={`/products/${item.product_id}`}>{item.name}</a></h3><p>Đơn giá: {formatPrice(item.unit_price)}</p><span>Số lượng: <strong>{item.quantity}</strong></span></div>
        <p className="my-order-item-total">{formatPrice(item.subtotal)}</p>
      </li>;
    })}
    {!items.length && <li className="my-order-missing-items">Chưa có thông tin sản phẩm của đơn hàng này.</li>}
  </ul>;
}

export function OrdersLoading({ className = '', label = 'Đang tải đơn hàng' }) {
  return <div className={`my-orders-loading ${className}`} role="status" aria-label={label}>
    <span className="sr-only">{label}...</span>
    {[1, 2].map(index => <div className="my-orders-skeleton" key={index} aria-hidden="true"><div className="skeleton skeleton-line medium" /><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line short" /></div>)}
  </div>;
}
