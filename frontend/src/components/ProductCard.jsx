import { useState } from 'react';
import { Heart, ImageOff, Plus, ShoppingCart } from 'lucide-react';
import { displayImageUrl, formatPrice, resolveImageUrl } from '../utils/catalog.js';

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
  return (
    <article className="product-card" data-product-id={product.product_id}>
      <div className="product-image">
        <a className="product-image-link" href={`/products/${product.product_id}`} aria-label={`Xem chi tiết ${product.name}`}><ProductImage key={imageUrl} source={imageUrl} name={product.name} /></a>
        {outOfStock && <span className="stock-badge">Tạm hết hàng</span>}
        <button className="product-favorite icon-button" type="button" aria-label={`Yêu thích ${product.name} (chưa kết nối)`} aria-disabled="true" title="Yêu thích chưa kết nối" onClick={() => onAction?.('Yêu thích')}><Heart size={19} aria-hidden="true" /></button>
      </div>
      <div className="product-info">
        <p className="product-category">{categoryName || 'Chưa phân loại'}</p>
        <h3><a className="product-name-link" href={`/products/${product.product_id}`}>{product.name}</a></h3>
        <p className="product-price">{formatPrice(product.price)}</p>
        <div className="product-actions">
          <button className="button button-primary buy-now" type="button" disabled={outOfStock || cartBusy} aria-label={`Mua ngay: ${product.name}`} title={outOfStock ? 'Sản phẩm đã hết hàng' : 'Mua ngay'} onClick={() => onAction?.('Mua ngay', product, 1)}>Mua ngay</button>
          <button className="button button-outline add-to-cart" type="button" disabled={outOfStock || cartBusy} aria-label={`Thêm vào giỏ hàng: ${product.name}`} title={outOfStock ? 'Sản phẩm đã hết hàng' : 'Thêm vào giỏ hàng'} onClick={() => onAction?.('Giỏ hàng', product, 1)}>
            <span className="cart-add-icon" aria-hidden="true"><ShoppingCart size={19} /><Plus className="cart-add-plus" size={10} strokeWidth={3} /></span>
          </button>
        </div>
      </div>
    </article>
  );
}
