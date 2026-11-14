import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ClipboardList, Compass, ContactRound, FolderTree, Heart, LogOut, Mail, Menu, Package, Phone, Search, ShoppingCart, TicketPercent, Truck, UserRound, Users, X } from 'lucide-react';
import Logo from './Logo.jsx';
import { useCommerce } from '../context/CommerceContext.jsx';
import { useWishlist } from '../context/WishlistContext.jsx';
import { useVoucherReadiness } from '../hooks/useVoucherReadiness.js';

export default function Header({ query, onQueryChange, categories, onCategoryChange, onUnavailable, isProductsPage = false, isProductDetailPage = false, isProductReviewsPage = false, keepCartVisible = false }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountMenuRef = useRef(null);
  const accountTriggerRef = useRef(null);
  const { user, authLoading, cart, busy, beginLogin, logout, notify } = useCommerce();
  const { products: wishlistProducts } = useWishlist();
  const wishlistCount = wishlistProducts.length;

  useEffect(() => {
    if (!accountOpen) return;
    const handlePointerDown = event => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target)) {
        setAccountOpen(false);
      }
    };
    const handleKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setAccountOpen(false);
        accountTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [accountOpen]);
  const { ready: vouchersReady } = useVoucherReadiness();
  const cartProductCount = new Set((cart.items || []).map(item => String(item.product_id))).size;
  const productSubpage = isProductDetailPage || isProductReviewsPage;
  const inProducts = isProductsPage || productSubpage;
  const currentPath = window.location.pathname.replace(/\/+$/, '');
  const otherPage = ['/cart', '/checkout', '/login', '/register', '/my-orders', '/wishlist', '/profile', '/admin/orders', '/admin/products', '/admin/categories', '/admin/users', '/admin/vouchers'].includes(currentPath) || currentPath.startsWith('/my-orders/') || currentPath.startsWith('/admin/orders/');
  const leavePage = productSubpage || otherPage;
  const homeHref = inProducts || otherPage ? '/#trang-chu' : '#trang-chu';
  const accountHref = user ? user.role === 'user' ? '/my-orders' : '/admin/orders' : '/login';
  const mobileLinks = [[homeHref, 'Trang chủ'], [leavePage ? '/products#danh-muc' : '#danh-muc', 'Danh mục'], ['/products', 'Sản phẩm'], ['/cart', 'Giỏ hàng'], ...(user ? [['/profile', 'Thông tin cá nhân'], ...(user.role === 'user' ? [['/my-orders', 'Đơn hàng của tôi'], ['/wishlist', 'Sản phẩm yêu thích']] : [])] : [['/login', 'Đăng nhập / Đăng ký']]), ['#ve-petcare', 'Về PetCare'], ['#lien-he', 'Liên hệ']];
  const showProducts = () => {
    if (leavePage) {
      window.location.assign(query.trim() ? `/products?q=${encodeURIComponent(query)}` : '/products');
      return;
    }
    document.getElementById('san-pham')?.scrollIntoView({ behavior: 'smooth' });
  };
  return (
    <header className={`site-header${keepCartVisible ? ' site-header--cart-visible' : ''}`}>
      <div className="contact-strip"><div className="container contact-strip-inner">
        <div className="contact-strip-main"><a href="tel:0979019346"><Phone size={14} />0979 019 346</a><a href="mailto:vunam1901bg@gmail.com"><Mail size={14} />vunam1901bg@gmail.com</a><span className="shipping-note"><Truck size={15} />Đồng hành chăm sóc người bạn nhỏ</span></div>
        <div className="contact-strip-links"><a href="#ve-petcare">Về PetCareShop</a><a href="#lien-he">Liên hệ</a></div>
      </div></div>
      <div className="container header-inner">
        <Logo />
        <form className="header-search" role="search" onSubmit={event => { event.preventDefault(); showProducts(); }}>
          <input type="search" aria-label="Tìm kiếm sản phẩm" placeholder="Tìm kiếm sản phẩm cho thú cưng..." value={query} onChange={event => onQueryChange(event.target.value)} />
          {query && <button className="clear-search" type="button" aria-label="Xóa tìm kiếm" onClick={() => onQueryChange('')}><X size={16} /></button>}
          <button className="search-submit" type="submit" aria-label="Tìm kiếm"><Search size={21} /></button>
        </form>
        <div className="header-actions">
          {user ? (
            <div className="account-dropdown" ref={accountMenuRef}>
              <button
                ref={accountTriggerRef}
                className={`header-action account-trigger${accountOpen ? ' is-open' : ''}`}
                type="button"
                aria-haspopup="true"
                aria-expanded={accountOpen}
                aria-controls="header-account-menu"
                onClick={() => setAccountOpen(open => !open)}
              >
                <UserRound size={20} aria-hidden="true" />
                <span className="account-trigger-text">
                  <strong className="account-trigger-name">{user.full_name}</strong>
                  <small>{user.role === 'admin' ? 'Quản trị viên' : 'Khách hàng'}</small>
                </span>
                <ChevronDown size={15} className="account-trigger-arrow" aria-hidden="true" />
              </button>
              {accountOpen && (
                <div id="header-account-menu" className="account-menu" role="group" aria-label="Tài khoản người dùng">
                  <a
                    className="account-menu-item"
                    href="/profile"
                    aria-current={currentPath === '/profile' ? 'page' : undefined}
                    onClick={() => setAccountOpen(false)}
                  >
                    <ContactRound size={16} aria-hidden="true" />
                    <span>Thông tin cá nhân</span>
                  </a>
                  {user.role === 'admin' ? (
                    <>
                      <hr className="account-menu-divider" />
                      <span className="account-menu-section-label">Quản trị cửa hàng</span>
                      <a
                        className="account-menu-item"
                        href="/admin/orders"
                        aria-current={currentPath === '/admin/orders' || currentPath.startsWith('/admin/orders/') ? 'page' : undefined}
                        onClick={() => setAccountOpen(false)}
                      >
                        <ClipboardList size={16} aria-hidden="true" />
                        <span>Quản lý đơn hàng</span>
                      </a>
                      <a
                        className="account-menu-item"
                        href="/admin/products"
                        aria-current={currentPath === '/admin/products' ? 'page' : undefined}
                        onClick={() => setAccountOpen(false)}
                      >
                        <Package size={16} aria-hidden="true" />
                        <span>Quản lý sản phẩm</span>
                      </a>
                      <a
                        className="account-menu-item"
                        href="/admin/categories"
                        aria-current={currentPath === '/admin/categories' ? 'page' : undefined}
                        onClick={() => setAccountOpen(false)}
                      >
                        <FolderTree size={16} aria-hidden="true" />
                        <span>Quản lý danh mục</span>
                      </a>
                      <a
                        className="account-menu-item"
                        href="/admin/users"
                        aria-current={currentPath === '/admin/users' ? 'page' : undefined}
                        onClick={() => setAccountOpen(false)}
                      >
                        <Users size={16} aria-hidden="true" />
                        <span>Quản lý người dùng</span>
                      </a>
                      {vouchersReady && (
                        <a
                          className="account-menu-item"
                          href="/admin/vouchers"
                          aria-current={currentPath === '/admin/vouchers' ? 'page' : undefined}
                          onClick={() => setAccountOpen(false)}
                        >
                          <TicketPercent size={16} aria-hidden="true" />
                          <span>Quản lý Voucher</span>
                        </a>
                      )}
                    </>
                  ) : (
                    <>
                    <a
                      className="account-menu-item"
                      href="/my-orders"
                      aria-current={currentPath === '/my-orders' || currentPath.startsWith('/my-orders/') ? 'page' : undefined}
                      onClick={() => setAccountOpen(false)}
                    >
                      <Truck size={16} aria-hidden="true" />
                      <span>Đơn hàng của tôi</span>
                    </a>
                    <a className="account-menu-item" href="/wishlist" aria-current={currentPath === '/wishlist' ? 'page' : undefined} onClick={() => setAccountOpen(false)}>
                      <Heart size={16} aria-hidden="true" />
                      <span>Sản phẩm yêu thích</span>
                    </a>
                    </>
                  )}
                  <hr className="account-menu-divider" />
                  <button
                    className="account-menu-item account-menu-logout"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAccountOpen(false);
                      logout().catch(error => notify(error.message));
                    }}
                  >
                    <LogOut size={16} aria-hidden="true" />
                    <span>Đăng xuất</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <a className="header-action account-action" href={accountHref} onClick={beginLogin}><UserRound size={27} aria-hidden="true" /><span><strong>{authLoading ? 'Đang tải...' : 'Tài khoản'}</strong><small>Đăng nhập / Đăng ký</small></span></a>
          )}
          {!authLoading && user?.role !== 'admin' && <a className="header-action header-wishlist" href="/wishlist" aria-label={`Yêu thích, ${wishlistCount} sản phẩm`} aria-current={currentPath === '/wishlist' ? 'page' : undefined}><span className="header-wishlist-icon"><Heart size={26} aria-hidden="true" />{wishlistCount > 0 && <span className="cart-count wishlist-count">{wishlistCount}</span>}</span><strong>Yêu thích</strong></a>}
          <a className="header-action header-cart" href="/cart" aria-label={`Giỏ hàng, ${cartProductCount} sản phẩm`}><span className="header-cart-icon"><ShoppingCart size={27} aria-hidden="true" />{cartProductCount > 0 && <span className="cart-count">{cartProductCount}</span>}</span><strong>Giỏ hàng</strong></a>
        </div>
        <button className="menu-toggle icon-button" type="button" aria-label={menuOpen ? 'Đóng menu' : 'Mở menu'} aria-expanded={menuOpen} aria-controls="mobile-menu" onClick={() => setMenuOpen(open => !open)}>{menuOpen ? <X size={24} /> : <Menu size={24} />}</button>
      </div>
      <div className="navigation-bar"><nav className="container desktop-nav" aria-label="Điều hướng chính">
        <a href={homeHref} className={inProducts || otherPage ? undefined : 'nav-home'} aria-current={inProducts || otherPage ? undefined : 'page'}><Compass size={15} strokeWidth={1.9} aria-hidden="true" />Trang chủ</a>
        <a href="/products" className={inProducts ? 'nav-active' : undefined} aria-current={isProductsPage ? 'page' : productSubpage ? 'location' : undefined}>Sản phẩm<ChevronDown size={13} /></a>
        {categories.map((category, index) => <a key={category.category_id} href={leavePage ? `/products?category=${category.category_id}` : '#san-pham'} onClick={leavePage ? undefined : () => onCategoryChange(String(category.category_id))}>{category.name}{index < 2 && <ChevronDown size={13} />}</a>)}
        <a href="#lien-he">Liên hệ</a>
      </nav></div>
      {menuOpen && <nav id="mobile-menu" className="mobile-nav" aria-label="Điều hướng trên điện thoại">{mobileLinks.map(([href, label]) => <a key={label} href={href} aria-current={['/profile', '/admin/products', '/admin/categories', '/admin/users', '/admin/vouchers'].includes(href) && currentPath === href ? 'page' : href === '/products' && inProducts ? (productSubpage ? 'location' : 'page') : !inProducts && !otherPage && href === homeHref ? 'page' : undefined} onClick={() => { if (href === '/login') beginLogin(); setMenuOpen(false); }}>{label}</a>)}</nav>}
    </header>
  );
}
