import { useState } from 'react';
import Header from './components/Header.jsx';
import Hero from './components/Hero.jsx';
import CategorySection from './components/CategorySection.jsx';
import ProductSection from './components/ProductSection.jsx';
import ProductsPage from './pages/ProductsPage.jsx';
import ProductDetailPage from './pages/ProductDetailPage.jsx';
import CartPage from './pages/CartPage.jsx';
import AuthPage from './pages/AuthPage.jsx';
import CheckoutPage from './pages/CheckoutPage.jsx';
import MyOrdersPage from './pages/MyOrdersPage.jsx';
import OrderDetailPage from './pages/OrderDetailPage.jsx';
import AdminOrdersPage from './pages/AdminOrdersPage.jsx';
import AdminProductsPage from './pages/AdminProductsPage.jsx';
import AdminCategoriesPage from './pages/AdminCategoriesPage.jsx';
import AdminUsersPage from './pages/AdminUsersPage.jsx';
import AdminVouchersPage from './pages/AdminVouchersPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import ProductReviewPage from './pages/ProductReviewPage.jsx';
import Footer from './components/Footer.jsx';
import FloatingContact from './components/FloatingContact.jsx';
import ChatbotWidget from './components/ChatbotWidget.jsx';
import { X } from 'lucide-react';
import { useApiList } from './hooks/useApiList.js';
import { useCommerce } from './context/CommerceContext.jsx';

export default function App() {
  const commerce = useCommerce();
  // Các liên kết dùng điều hướng trình duyệt; Vite phục vụ cùng entry cho các URL.
  const pathname = window.location.pathname.replace(/\/+$/, '');
  const isProductsPage = pathname === '/products';
  const detailMatch = pathname.match(/^\/products\/([^/]+)$/);
  const isProductDetailPage = Boolean(detailMatch);
  const isCartPage = pathname === '/cart';
  const isCheckoutPage = pathname === '/checkout';
  const orderDetailMatch = pathname.match(/^\/my-orders\/([^/]+)$/);
  const isMyOrdersPage = pathname === '/my-orders' || Boolean(orderDetailMatch);
  const adminDetailMatch = pathname.match(/^\/admin\/orders\/([^/]+)$/);
  const isAdminOrdersPage = pathname === '/admin/orders' || Boolean(adminDetailMatch);
  const isAdminProductsPage = pathname === '/admin/products';
  const isAdminCategoriesPage = pathname === '/admin/categories';
  const isAdminUsersPage = pathname === '/admin/users';
  const isAdminVouchersPage = pathname === '/admin/vouchers';
  const isProfilePage = pathname === '/profile';
  const productReviewMatch = pathname.match(/^\/my-orders\/([^/]+)\/review\/([^/]+)$/);
  const isProductReviewPage = Boolean(productReviewMatch);
  const authMode = pathname === '/login' ? 'login' : pathname === '/register' ? 'register' : '';
  const isHomePage = !isProductsPage && !isProductDetailPage && !isCartPage && !isCheckoutPage && !isMyOrdersPage && !isAdminOrdersPage && !isAdminProductsPage && !isAdminCategoriesPage && !isAdminUsersPage && !isAdminVouchersPage && !isProfilePage && !isProductReviewPage && !authMode;
  const searchParams = new URLSearchParams(window.location.search);
  const products = useApiList('/api/products', 'products');
  const categories = useApiList('/api/categories', 'categories');
  const [selectedCategory, setSelectedCategory] = useState(() => isProductsPage && /^[1-9]\d*$/.test(searchParams.get('category') || '') ? searchParams.get('category') : 'all');
  const [query, setQuery] = useState(() => isProductsPage ? searchParams.get('q') || '' : '');
  const showUnavailable = feature => commerce.notify(`${feature} chưa được kết nối trên giao diện. Tính năng sẽ được bổ sung sau.`);
  const onProductAction = (feature, product, quantity = 1) => {
    if (!product) { showUnavailable(feature); return; }
    const action = feature === 'Giỏ hàng' ? commerce.addItem : feature === 'Mua ngay' ? commerce.buyNow : null;
    if (action) return action(Number(product.product_id), quantity, product.price).catch(error => commerce.notify(error.message));
    showUnavailable(feature);
  };
  const catalogProps = {
    products: products.data, categories: categories.data,
    loading: products.loading, error: products.error, retry: products.retry,
    selectedCategory, onCategoryChange: setSelectedCategory,
    query, onQueryChange: setQuery, onAction: onProductAction, cartBusy: commerce.busy || commerce.authLoading,
  };

  return (
    <div id="trang-chu">
      <a className="skip-link" href="#main-content">Đến nội dung chính</a>
      <Header query={query} onQueryChange={setQuery} categories={categories.data} onCategoryChange={setSelectedCategory} onUnavailable={showUnavailable} isProductsPage={isProductsPage} isProductDetailPage={isProductDetailPage} />
      <main id="main-content">
        {isProductReviewPage ? <ProductReviewPage orderId={productReviewMatch[1]} productId={productReviewMatch[2]} /> : isProfilePage ? <ProfilePage /> : isAdminVouchersPage ? <AdminVouchersPage /> : isAdminUsersPage ? <AdminUsersPage /> : isAdminCategoriesPage ? <AdminCategoriesPage /> : isAdminProductsPage ? <AdminProductsPage /> : isAdminOrdersPage ? <AdminOrdersPage orderId={adminDetailMatch?.[1]} /> : isCartPage ? <CartPage /> : isCheckoutPage ? <CheckoutPage /> : isMyOrdersPage ? (orderDetailMatch ? <OrderDetailPage orderId={orderDetailMatch[1]} /> : <MyOrdersPage />) : authMode ? <AuthPage mode={authMode} /> : isProductDetailPage ? (
          <ProductDetailPage productId={detailMatch[1]} products={products.data} categories={categories.data} loading={products.loading} error={products.error} retry={products.retry} onAction={onProductAction} cartBusy={commerce.busy || commerce.authLoading} />
        ) : isProductsPage ? (
          <ProductsPage {...catalogProps} categoriesLoading={categories.loading} categoriesError={categories.error} retryCategories={categories.retry} />
        ) : (
          <>
            <Hero />
            <CategorySection categories={categories.data} products={products.data} productsReady={!products.loading && !products.error} loading={categories.loading} error={categories.error} retry={categories.retry} selectedCategory={selectedCategory} onSelect={setSelectedCategory} />
            <ProductSection {...catalogProps} />
          </>
        )}
      </main>
      <Footer />
      {isHomePage && <><FloatingContact /><ChatbotWidget /></>}
      {commerce.notice && <div className="feature-notice" role="status"><p>{commerce.notice}</p><button className="icon-button" type="button" aria-label="Đóng thông báo" onClick={commerce.clearNotice}><X size={18} /></button></div>}
    </div>
  );
}
