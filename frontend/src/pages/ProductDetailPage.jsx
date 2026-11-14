import { useEffect, useState } from 'react';
import { ChevronRight, Minus, Plus, ShoppingCart } from 'lucide-react';
import ProductCard, { ProductImage } from '../components/ProductCard.jsx';
import { ErrorNotice } from '../components/Feedback.jsx';
import WishlistButton from '../components/WishlistButton.jsx';
import { ReviewList, ReviewStars, formatReviewAverage } from '../components/ProductReviewContent.jsx';
import useProductReviews from '../hooks/useProductReviews.js';
import { BRAND_NAME } from '../config/branding.js';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import '../product-reviews.css';

function ProductReviewsPreview({ productId }) {
  const { data, loading, error, retry } = useProductReviews(productId, { limit: 2 });
  return (
    <section className="product-review-preview detail-description-panel" aria-labelledby="product-review-preview-title">
      <div className="product-review-preview-heading section-heading">
        <h2 id="product-review-preview-title">Đánh giá sản phẩm</h2>
        <a className="text-link" href={`/products/${productId}/reviews`}>Xem đánh giá<ChevronRight size={14} aria-hidden="true" /></a>
      </div>
      {loading ? (
        <div role="status" aria-label="Đang tải đánh giá"><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line medium" /><span className="sr-only">Đang tải đánh giá...</span></div>
      ) : error ? (
        <ErrorNotice title="Chưa tải được đánh giá" message={error} onRetry={retry} />
      ) : data ? (
        <>
          <div className="product-review-preview-summary">
            <ReviewStars rating={data.summary.average_rating || 0} />
            <strong className="product-review-preview-score">{formatReviewAverage(data.summary.average_rating)}{data.summary.total > 0 ? '/5' : ''}</strong>
            <span>{data.summary.total} lượt đánh giá</span>
          </div>
          {data.reviews.length ? <ReviewList reviews={data.reviews} /> : <p className="detail-note">Sản phẩm chưa có đánh giá.</p>}
        </>
      ) : null}
    </section>
  );
}

function ProductDetails({ product, categoryName, related, onAction, cartBusy }) {
  const [requestedQuantity, setRequestedQuantity] = useState(1);
  const stock = Number(product.stock_quantity);
  const stockKnown = product.stock_quantity != null && Number.isInteger(stock) && stock >= 0;
  const available = stockKnown && stock > 0;
  const maximum = available ? stock : 1;
  const clampQuantity = value => Math.max(1, Math.min(maximum, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 1));
  const quantity = clampQuantity(requestedQuantity);
  const imageUrl = resolveImageUrl(product.image_url);

  return (
    <>
      <section className="detail-layout" aria-labelledby="detail-title">
        <div className="detail-image"><ProductImage key={imageUrl} source={imageUrl} name={product.name} loading="eager" width={640} height={640} /></div>
        <div className="detail-info">
          <p className="detail-category">Danh mục: <a href={`/products?category=${product.category_id}`}>{categoryName}</a></p>
          <h1 id="detail-title">{product.name}</h1>
          <p className="detail-price">{formatPrice(product.price)}</p>
          <p className={`detail-stock ${available ? 'in-stock' : ''}`}>{!stockKnown ? 'Tồn kho đang được cập nhật' : available ? `Còn hàng — ${stock} sản phẩm` : 'Hết hàng'}</p>
          <div className="detail-quantity">
            <label htmlFor="product-quantity">Số lượng</label>
            <div className="quantity-control">
              <button type="button" aria-label="Giảm số lượng" disabled={!available || quantity <= 1} onClick={() => setRequestedQuantity(clampQuantity(quantity - 1))}><Minus size={17} aria-hidden="true" /></button>
              <input id="product-quantity" aria-label="Số lượng" type="number" inputMode="numeric" min={1} max={maximum} step={1} value={quantity} disabled={!available} onChange={event => setRequestedQuantity(clampQuantity(event.target.value))} onBlur={event => setRequestedQuantity(clampQuantity(event.target.value))} />
              <button type="button" aria-label="Tăng số lượng" disabled={!available || quantity >= maximum} onClick={() => setRequestedQuantity(clampQuantity(quantity + 1))}><Plus size={17} aria-hidden="true" /></button>
            </div>
          </div>
          <div className="detail-actions">
            <button className="button button-outline add-to-cart" type="button" disabled={!available || cartBusy} onClick={event => onAction('Giỏ hàng', product, quantity, event.currentTarget)}><ShoppingCart size={18} aria-hidden="true" />Thêm vào giỏ hàng</button>
            <button className="button button-primary buy-now" type="button" disabled={!available || cartBusy} onClick={() => onAction('Mua ngay', product, quantity)}>Mua ngay</button>
            <WishlistButton product={product} onAction={onAction} className="button button-outline detail-favorite" showLabel size={18} />
          </div>
          <p className="detail-note">Mua ngay mở trang đặt hàng với riêng sản phẩm và số lượng đã chọn.</p>
        </div>
      </section>

      <section className="detail-description-panel" aria-labelledby="description-title">
        <h2 id="description-title">Mô tả sản phẩm</h2>
        <p className="detail-description">{typeof product.description === 'string' && product.description.trim() ? product.description : 'Mô tả sản phẩm đang được cập nhật.'}</p>
      </section>

      <ProductReviewsPreview productId={product.product_id} />

      <section className="related-products" aria-labelledby="related-title">
        <div className="section-heading"><h2 id="related-title">Sản phẩm cùng danh mục</h2><a className="text-link" href={`/products?category=${product.category_id}`}>Xem tất cả<ChevronRight size={14} aria-hidden="true" /></a></div>
        {related.length ? <div className="product-grid">{related.map(item => <ProductCard key={item.product_id} product={item} categoryName={item.category_name || categoryName} onAction={onAction} cartBusy={cartBusy} />)}</div> : <p className="detail-note">Chưa có sản phẩm khác trong danh mục này.</p>}
      </section>
    </>
  );
}

export default function ProductDetailPage({ productId, products, categories, loading, error, retry, onAction, cartBusy }) {
  const validId = /^[1-9]\d*$/.test(productId) && Number.isSafeInteger(Number(productId));
  const product = validId ? products.find(item => String(item.product_id) === productId) : undefined;
  const notFound = !validId || (!loading && !error && !product);
  const categoryName = product?.category_name || categories.find(category => String(category.category_id) === String(product?.category_id))?.name || 'Chưa phân loại';
  const related = product ? products.filter(item => String(item.category_id) === String(product.category_id) && String(item.product_id) !== String(product.product_id)).slice(0, 5) : [];

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${product?.name || (notFound ? 'Không tìm thấy sản phẩm' : 'Chi tiết sản phẩm')} | ${BRAND_NAME}`;
    return () => { document.title = previousTitle; };
  }, [product?.name, notFound]);

  return (
    <div className="container product-detail-page">
      <nav className="catalog-breadcrumbs" aria-label="Đường dẫn">
        <a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><a href="/products">Sản phẩm</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">{product?.name || 'Chi tiết sản phẩm'}</span>
      </nav>
      {notFound ? (
        <div className="detail-state"><h1>Không tìm thấy sản phẩm</h1><p>Sản phẩm bạn tìm không tồn tại hoặc hiện không được bán.</p><a className="button button-primary" href="/products">Xem danh sách sản phẩm</a></div>
      ) : loading ? (
        <div className="detail-state"><h1>Chi tiết sản phẩm</h1><div className="detail-loading" role="status" aria-label="Đang tải sản phẩm"><div className="skeleton detail-loading-image" /><div><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line medium" /><div className="skeleton skeleton-line short" /></div><span className="sr-only">Đang tải sản phẩm...</span></div></div>
      ) : error ? (
        <div className="detail-state"><h1>Chi tiết sản phẩm</h1><ErrorNotice title="Chưa tải được sản phẩm" message={error} onRetry={retry} /></div>
      ) : (
        <ProductDetails key={product.product_id} product={product} categoryName={categoryName} related={related} onAction={onAction} cartBusy={cartBusy} />
      )}
    </div>
  );
}
