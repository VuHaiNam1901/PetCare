import { useState } from 'react';
import { ChevronDown, ContactRound, Heart, House, LogOut, Mail, Menu, Phone, Search, ShoppingCart, Truck, UserRound, X } from 'lucide-react';
import Logo from './Logo.jsx';
import { useCommerce } from '../context/CommerceContext.jsx';
import { useVoucherReadiness } from '../hooks/useVoucherReadiness.js';

export default function Header({ query, onQueryChange, categories, onCategoryChange, onUnavailable, isProductsPage = false, isProductDetailPage = false }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { user, authLoading, cart, busy, beginLogin, logout, notify } = useCommerce();
  const { ready: vouchersReady } = useVoucherReadiness();
  const cartProductCount = new Set((cart.items || []).map(item => String(item.product_id))).size;
  const inProducts = isProductsPage || isProductDetailPage;
  const currentPath = window.location.pathname.replace(/\/+$/, '');
  const otherPage = ['/cart', '/checkout', '/login', '/register', '/my-orders', '/profile', '/admin/orders', '/admin/products', '/admin/categories', '/admin/users', '/admin/vouchers'].includes(currentPath) || currentPath.startsWith('/my-orders/') || currentPath.startsWith('/admin/orders/');
  const leavePage = isProductDetailPage || otherPage;
  const homeHref = inProducts || otherPage ? '/#trang-chu' : '#trang-chu';
  const accountHref = user ? user.role === 'user' ? '/my-orders' : '/admin/orders' : '/login';
  const mobileLinks = [[homeHref, 'Trang chủ'], [leavePage ? '/products#danh-muc' : '#danh-muc', 'Danh mục'], ['/products', 'Sản phẩm'], ['/cart', 'Giỏ hàng'], [accountHref, user ? user.role === 'user' ? 'Đơn hàng của tôi' : 'Quản lý đơn hàng' : 'Đăng nhập / Đăng ký'], ...(user ? [['/profile', 'Thông tin cá nhân']] : []), ...(user?.role === 'admin' ? [['/admin/products', 'Quản lý sản phẩm'], ['/admin/categories', 'Quản lý danh mục'], ['/admin/users', 'Quản lý người dùng'], ...(vouchersReady ? [['/admin/vouchers', 'Quản lý Voucher']] : [])] : []), ['#ve-petcare', 'Về PetCare'], ['#lien-he', 'Liên hệ']];
  const showProducts = () => {
    if (leavePage) {
      window.location.assign(query.trim() ? `/products?q=${encodeURIComponent(query)}` : '/products');
      return;
    }
    document.getElementById('san-pham')?.scrollIntoView({ behavior: 'smooth' });
  };
  return (
    <header className="site-header">
      <div className="contact-strip"><div className="container contact-strip-inner">
        <div className="contact-strip-main"><a href="tel:0987654321"><Phone size={14} />0987 654 321</a><a href="mailto:petcare@gmail.com"><Mail size={14} />petcare@gmail.com</a><span className="shipping-note"><Truck size={15} />Đồng hành chăm sóc người bạn nhỏ</span></div>
        <div className="contact-strip-links">{user?.role === 'admin' && <><a href="/admin/products" aria-current={currentPath === '/admin/products' ? 'page' : undefined}>Quản lý sản phẩm</a>{vouchersReady && <a href="/admin/vouchers" aria-current={currentPath === '/admin/vouchers' ? 'page' : undefined}>Quản lý Voucher</a>}</>}<a href="#ve-petcare">Về PetCareShop</a><a href="#lien-he">Liên hệ</a></div>
      </div></div>
      <div className="container header-inner">
        <Logo />
        <form className="header-search" role="search" onSubmit={event => { event.preventDefault(); showProducts(); }}>
          <input type="search" aria-label="Tìm kiếm sản phẩm" placeholder="Tìm kiếm sản phẩm cho thú cưng..." value={query} onChange={event => onQueryChange(event.target.value)} />
          {query && <button className="clear-search" type="button" aria-label="Xóa tìm kiếm" onClick={() => onQueryChange('')}><X size={16} /></button>}
          <button className="search-submit" type="submit" aria-label="Tìm kiếm"><Search size={21} /></button>
        </form>
        <div className="header-actions">
          <a className="header-action account-action" href={accountHref} onClick={user ? undefined : beginLogin}><UserRound size={27} aria-hidden="true" /><span><strong>{authLoading ? 'Đang tải...' : user ? user.full_name : 'Tài khoản'}</strong><small>{user ? user.role === 'admin' ? 'Quản trị viên' : 'Khách hàng' : 'Đăng nhập / Đăng ký'}</small></span></a>
          {user && <a className="header-profile-link" href="/profile" aria-label="Thông tin cá nhân" title="Thông tin cá nhân" aria-current={currentPath === '/profile' ? 'page' : undefined}><ContactRound size={22} aria-hidden="true" /><span>Thông tin cá nhân</span></a>}
          {user && <button className="icon-button logout-button" type="button" aria-label="Đăng xuất" title="Đăng xuất" disabled={busy} onClick={() => logout().catch(error => notify(error.message))}><LogOut size={21} aria-hidden="true" /></button>}
          <button className="header-action" type="button" aria-disabled="true" title="Yêu thích chưa kết nối" onClick={() => onUnavailable('Yêu thích')}><Heart size={26} /><strong>Yêu thích</strong></button>
          <a className="header-action header-cart" href="/cart" aria-label={`Giỏ hàng, ${cartProductCount} sản phẩm`}><span className="header-cart-icon"><ShoppingCart size={27} aria-hidden="true" />{cartProductCount > 0 && <span className="cart-count">{cartProductCount}</span>}</span><strong>Giỏ hàng</strong></a>
        </div>
        <button className="menu-toggle icon-button" type="button" aria-label={menuOpen ? 'Đóng menu' : 'Mở menu'} aria-expanded={menuOpen} aria-controls="mobile-menu" onClick={() => setMenuOpen(open => !open)}>{menuOpen ? <X size={24} /> : <Menu size={24} />}</button>
      </div>
      <div className="navigation-bar"><nav className="container desktop-nav" aria-label="Điều hướng chính">
        <a href={homeHref} className={inProducts || otherPage ? undefined : 'nav-home'} aria-current={inProducts || otherPage ? undefined : 'page'}><House size={16} fill="currentColor" />Trang chủ</a>
        <a href="/products" className={inProducts ? 'nav-active' : undefined} aria-current={isProductsPage ? 'page' : isProductDetailPage ? 'location' : undefined}>Sản phẩm<ChevronDown size={13} /></a>
        {categories.map((category, index) => <a key={category.category_id} href={leavePage ? `/products?category=${category.category_id}` : '#san-pham'} onClick={leavePage ? undefined : () => onCategoryChange(String(category.category_id))}>{category.name}{index < 2 && <ChevronDown size={13} />}</a>)}
        <a href="#lien-he">Liên hệ</a>
      </nav></div>
      {menuOpen && <nav id="mobile-menu" className="mobile-nav" aria-label="Điều hướng trên điện thoại">{mobileLinks.map(([href, label]) => <a key={label} href={href} aria-current={['/profile', '/admin/products', '/admin/categories', '/admin/users', '/admin/vouchers'].includes(href) && currentPath === href ? 'page' : href === '/products' && inProducts ? (isProductDetailPage ? 'location' : 'page') : !inProducts && !otherPage && href === homeHref ? 'page' : undefined} onClick={() => { if (href === '/login') beginLogin(); setMenuOpen(false); }}>{label}</a>)}</nav>}
    </header>
  );
}
