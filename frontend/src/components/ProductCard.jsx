import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { displayImageUrl, formatPrice, resolveImageUrl } from '../utils/catalog.js';

function ProductImage({ source, name }) {
  const [failed, setFailed] = useState(false);
  const [imageSource, setImageSource] = useState(() => displayImageUrl(source));
  if (!imageSource || failed) {
    return <div className="product-image-fallback" role="img" aria-label={`Chưa có ảnh cho ${name}`}><ImageOff size={34} strokeWidth={1.2} aria-hidden="true" /><span>Ảnh đang cập nhật</span></div>;
  }
  return <img src={imageSource} alt={name} loading="lazy" decoding="async" width="320" height="320" onError={() => { if (imageSource !== source) setImageSource(source); else setFailed(true); }} />;
}

export default function ProductCard({ product, categoryName }) {
  const imageUrl = resolveImageUrl(product.image_url);
  return (
    <article className="product-card" data-product-id={product.product_id}>
      <div className="product-image">
        <ProductImage key={imageUrl} source={imageUrl} name={product.name} />
        {product.stock_quantity != null && Number(product.stock_quantity) === 0 && <span className="stock-badge">Tạm hết hàng</span>}
      </div>
      <div className="product-info">
        <p className="product-category">{categoryName || 'Chưa phân loại'}</p>
        <h3>{product.name}</h3>
        <p className="product-price">{formatPrice(product.price)}</p>
      </div>
    </article>
  );
}
