import { Heart } from 'lucide-react';
import { useWishlist } from '../context/WishlistContext.jsx';
import { useCommerce } from '../context/CommerceContext.jsx';
import '../wishlist.css';

export default function WishlistButton({ product, onAction, className = '', showLabel = false, size = 19 }) {
  const { products, loading, error, busyIds } = useWishlist();
  const { user, authLoading } = useCommerce();
  if (authLoading || user?.role === 'admin') return null;
  const id = Number(product.product_id);
  const selected = products.some(item => Number(item.product_id) === id);
  const busy = busyIds.has(id);
  const label = `${selected ? 'Bỏ yêu thích' : 'Yêu thích'}: ${product.name}`;
  return <button className={`wishlist-toggle ${className}${selected ? ' is-favorite' : ''}`} type="button"
    aria-label={label} title={label} aria-pressed={selected} aria-busy={busy || undefined}
    disabled={loading || Boolean(error) || busy}
    onClick={event => onAction?.('Yêu thích', product, 1, event.currentTarget)}>
    <Heart size={size} fill={selected ? 'currentColor' : 'none'} aria-hidden="true" />
    {showLabel && <span>{selected ? 'Đã yêu thích' : 'Yêu thích'}</span>}
  </button>;
}
