import { useEffect, useState } from 'react';
import { ArrowRight, ChevronRight, Heart, ShoppingBag, UserRound } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { useWishlist } from '../context/WishlistContext.jsx';
import ProductCard from '../components/ProductCard.jsx';
import { ErrorNotice } from '../components/Feedback.jsx';
import { BRAND_NAME } from '../config/branding.js';
import '../wishlist.css';

export default function WishlistPage({ onAction, cartBusy = false }) {
  const { user, authLoading } = useCommerce();
  const { products, loading, error, refresh } = useWishlist();
  const [view, setView] = useState({ ownerId: null, entries: [] });
  const ownerId = user?.role === 'user' ? user.user_id : null;
  const entries = ownerId !== null && view.ownerId === ownerId ? view.entries : [];
  const activeIds = new Set(products.map(product => Number(product.product_id)));

  useEffect(() => {
    const previous = document.title;
    document.title = `Sản phẩm yêu thích | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, []);

  useEffect(() => {
    if (authLoading || user) return;
    window.location.replace('/login?returnTo=%2Fwishlist');
  }, [authLoading, user?.user_id]);

  useEffect(() => {
    if (ownerId === null) { setView({ ownerId: null, entries: [] }); return; }
    if (loading || error) return;
    const current = new Map(products.map(product => [Number(product.product_id), product]));
    setView(previous => {
      const old = previous.ownerId === ownerId ? previous.entries : [];
      const seen = new Set(old.map(entry => Number(entry.product.product_id)));
      return { ownerId, entries: [
        ...products.filter(product => !seen.has(Number(product.product_id))).map(product => ({ product, removing: false })),
        ...old.map(entry => current.has(Number(entry.product.product_id))
          ? { product: current.get(Number(entry.product.product_id)), removing: false }
          : { ...entry, removing: true }),
      ] };
    });
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    const timer = window.setTimeout(() => setView(previous => previous.ownerId === ownerId
      ? { ...previous, entries: previous.entries.filter(entry => !entry.removing) } : previous), delay);
    return () => window.clearTimeout(timer);
  }, [ownerId, products, loading, error]);

  const pending = authLoading || !user || loading || (!error && ownerId !== null && view.ownerId !== ownerId);
  return <div className="container wishlist-page">
    <nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">Sản phẩm yêu thích</span></nav>
    <div className="wishlist-heading"><div><h1><Heart size={28} aria-hidden="true" />Sản phẩm yêu thích</h1><p>Lưu lại những món bạn muốn dành cho người bạn nhỏ.</p></div><a className="button button-outline" href="/products"><ShoppingBag size={16} aria-hidden="true" />Tiếp tục mua sắm</a></div>
    {!authLoading && user && user.role !== 'user' ? <section className="wishlist-state"><UserRound size={38} aria-hidden="true" /><h2>Danh sách dành cho tài khoản khách hàng</h2><p>Vui lòng đăng nhập bằng tài khoản khách hàng để lưu và xem sản phẩm yêu thích.</p></section>
      : pending ? <section className="wishlist-state" role="status"><Heart size={35} aria-hidden="true" /><p>Đang tải sản phẩm yêu thích...</p></section>
        : error ? <ErrorNotice title="Chưa tải được sản phẩm yêu thích" message={error} onRetry={() => { void refresh().catch(() => {}); }} />
          : entries.length ? <><p className="wishlist-count" role="status">{products.length} sản phẩm yêu thích</p><div className="product-grid wishlist-grid">{entries.map(({ product, removing }) => {
            const leaving = removing || !activeIds.has(Number(product.product_id));
            return <div className={`wishlist-product${leaving ? ' is-removing' : ''}`} key={product.product_id} inert={leaving || undefined} aria-hidden={leaving || undefined}><ProductCard product={product} categoryName={product.category_name} onAction={onAction} cartBusy={cartBusy || leaving} /></div>;
          })}</div></>
            : <section className="wishlist-state"><Heart size={40} strokeWidth={1.4} aria-hidden="true" /><h2>Bạn chưa có sản phẩm yêu thích</h2><p>Nhấn biểu tượng trái tim trên sản phẩm để lưu vào danh sách của bạn.</p><a className="button button-primary" href="/products">Khám phá sản phẩm<ArrowRight size={15} aria-hidden="true" /></a></section>}
  </div>;
}
