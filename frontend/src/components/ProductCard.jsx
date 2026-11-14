import { useState } from 'react';
import { ImageOff, Plus, ShoppingCart } from 'lucide-react';
import { displayImageUrl, formatPrice, resolveImageUrl } from '../utils/catalog.js';
import WishlistButton from './WishlistButton.jsx';

export function ProductImage({ source, name, loading = 'lazy', width = 320, height = 320 }) {
  const [failed, setFailed] = useState(false);
  const [imageSource, setImageSource] = useState(() => displayImageUrl(source));
  if (!imageSource || failed) {
    return <div className="product-image-fallback" role="img" aria-label={`Chưa có ảnh cho ${name}`}><ImageOff size={34} strokeWidth={1.2} aria-hidden="true" /><span>Ảnh đang cập nhật</span></div>;
  }
  return <img src={imageSource} alt={name} loading={loading} decoding="async" width={width} height={height} onError={() => { if (imageSource !== source) setImageSource(source); else setFailed(true); }} />;
}

export default function ProductCard({ product, categoryName, onAction, cartBusy = false }) {
  const imageUrl = resolveImageUrl(product.image_url);
  const outOfStock = product.stock_quantity != null && Number(product.stock_quantity) <= 0;
  const unavailable = outOfStock || (product.status != null && product.status !== 'Đang bán');
  return (
    <article className="product-card" data-product-id={product.product_id}>
      <div className="product-image">
        <a className="product-image-link" href={`/products/${product.product_id}`} aria-label={`Xem chi tiết ${product.name}`}><ProductImage key={imageUrl} source={imageUrl} name={product.name} /></a>
        {unavailable && <span className="stock-badge">{outOfStock ? 'Tạm hết hàng' : 'Ngừng bán'}</span>}
        <WishlistButton product={product} onAction={onAction} className="product-favorite icon-button" />
      </div>
      <div className="product-info">
        <p className="product-category">{categoryName || 'Chưa phân loại'}</p>
        <h3><a className="product-name-link" href={`/products/${product.product_id}`}>{product.name}</a></h3>
        <p className="product-price">{formatPrice(product.price)}</p>
        <div className="product-actions">
          <button className="button button-primary buy-now" type="button" disabled={unavailable || cartBusy} aria-label={`Mua ngay: ${product.name}`} title={unavailable ? 'Sản phẩm hiện chưa thể mua' : 'Mua ngay'} onClick={() => onAction?.('Mua ngay', product, 1)}>Mua ngay</button>
          <button className="button button-outline add-to-cart" type="button" disabled={unavailable || cartBusy} aria-label={`Thêm vào giỏ hàng: ${product.name}`} title={unavailable ? 'Sản phẩm hiện chưa thể mua' : 'Thêm vào giỏ hàng'} onClick={event => onAction?.('Giỏ hàng', product, 1, event.currentTarget)}>
            <span className="cart-add-icon" aria-hidden="true"><ShoppingCart size={19} /><Plus className="cart-add-plus" size={10} strokeWidth={3} /></span>
          </button>
        </div>
      </div>
    </article>
  );
}
