import Header from './components/Header.jsx';
import Hero from './components/Hero.jsx';
import CategorySection from './components/CategorySection.jsx';
import PetTypeSection from './components/PetTypeSection.jsx';
import ProductSection from './components/ProductSection.jsx';
import ProductsPage from './pages/ProductsPage.jsx';
import WishlistPage from './pages/WishlistPage.jsx';
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
import ProductReviewsPage from './pages/ProductReviewsPage.jsx';
import Footer from './components/Footer.jsx';
import FloatingContact from './components/FloatingContact.jsx';
import ChatbotWidget from './components/ChatbotWidget.jsx';
import { FeatureNotice } from './components/Feedback.jsx';
import { useApiList } from './hooks/useApiList.js';
import useCatalogFilters from './hooks/useCatalogFilters.js';
import { useCommerce } from './context/CommerceContext.jsx';
import useFlyToCart, { useFlyToWishlist, animateWishlistRemoval } from './hooks/useFlyToCart.js';
import { useWishlist } from './context/WishlistContext.jsx';

export default function App() {
  const commerce = useCommerce();
  const flyToCart = useFlyToCart();
  const flyToWishlist = useFlyToWishlist();
  const wishlist = useWishlist();
  // Các liên kết dùng điều hướng trình duyệt; Vite phục vụ cùng entry cho các URL.
  const pathname = window.location.pathname.replace(/\/+$/, '');
  const isProductsPage = pathname === '/products';
  const isWishlistPage = pathname === '/wishlist';
  const detailMatch = pathname.match(/^\/products\/([^/]+)$/);
  const isProductDetailPage = Boolean(detailMatch);
  const productReviewsMatch = pathname.match(/^\/products\/([^/]+)\/reviews$/);
  const isProductReviewsPage = Boolean(productReviewsMatch);
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
  const isHomePage = !isProductsPage && !isWishlistPage && !isProductDetailPage && !isProductReviewsPage && !isCartPage && !isCheckoutPage && !isMyOrdersPage && !isAdminOrdersPage && !isAdminProductsPage && !isAdminCategoriesPage && !isAdminUsersPage && !isAdminVouchersPage && !isProfilePage && !isProductReviewPage && !authMode;
  const products = useApiList('/api/products', 'products');
  const categories = useApiList('/api/categories', 'categories');
  const petTypes = useApiList('/api/pet-types', 'pet_types');
  const filters = useCatalogFilters(isProductsPage);
  const { category: selectedCategory, query, setCategory: setSelectedCategory, setQuery } = filters;
  const showUnavailable = feature => commerce.notify(`${feature} chưa được kết nối trên giao diện. Tính năng sẽ được bổ sung sau.`);
  const onProductAction = async (feature, product, quantity = 1, button = null) => {
    if (!product) { showUnavailable(feature); return; }
    if (feature === 'Yêu thích') {
      try {
        const result = await wishlist.toggle(Number(product.product_id));
        if (!result) return;
        if (result.changed) {
          if (result.selected) flyToWishlist(button);
          else animateWishlistRemoval(button);
        }
        commerce.notify(result.selected ? 'Đã lưu sản phẩm vào danh sách yêu thích.' : 'Đã bỏ sản phẩm khỏi danh sách yêu thích.');
      } catch (error) { if (!error.obsolete && ![401, 403].includes(error.status)) commerce.notify(error.message); }
      return;
    }
    const action = feature === 'Giỏ hàng' ? commerce.addItem : feature === 'Mua ngay' ? commerce.buyNow : null;
    if (action) {
      try { await action(Number(product.product_id), quantity, product.price); }
      catch (error) { commerce.notify(error.message); return; }
      if (feature === 'Giỏ hàng') flyToCart(button);
      return;
    }
    showUnavailable(feature);
  };
  const catalogProps = {
    products: products.data, categories: categories.data,
    loading: products.loading, error: products.error, retry: products.retry,
    selectedCategory, onCategoryChange: setSelectedCategory,
    query, onQueryChange: setQuery, onAction: onProductAction, cartBusy: commerce.busy || commerce.authLoading,
    petTypes: petTypes.data, petTypesLoading: petTypes.loading, petTypesError: petTypes.error, retryPetTypes: petTypes.retry,
    selectedPetType: filters.petType, onPetTypeChange: filters.setPetType,
    sortValue: filters.sort, onSortChange: filters.setSort, page: filters.page, onPageChange: filters.setPage, onResetFilters: filters.reset,
  };

  return (
    <div id="trang-chu">
      <a className="skip-link" href="#main-content">Đến nội dung chính</a>
      <Header query={query} onQueryChange={setQuery} categories={categories.data} onCategoryChange={setSelectedCategory} onUnavailable={showUnavailable} isProductsPage={isProductsPage} isProductDetailPage={isProductDetailPage} isProductReviewsPage={isProductReviewsPage} keepCartVisible={isHomePage || isProductsPage || isProductDetailPage || isProductReviewsPage || isWishlistPage} />
      <main id="main-content">
        {isWishlistPage ? <WishlistPage onAction={onProductAction} cartBusy={commerce.busy || commerce.authLoading} /> : isProductReviewPage ? <ProductReviewPage orderId={productReviewMatch[1]} productId={productReviewMatch[2]} /> : isProfilePage ? <ProfilePage /> : isAdminVouchersPage ? <AdminVouchersPage /> : isAdminUsersPage ? <AdminUsersPage /> : isAdminCategoriesPage ? <AdminCategoriesPage /> : isAdminProductsPage ? <AdminProductsPage /> : isAdminOrdersPage ? <AdminOrdersPage orderId={adminDetailMatch?.[1]} /> : isCartPage ? <CartPage /> : isCheckoutPage ? <CheckoutPage /> : isMyOrdersPage ? (orderDetailMatch ? <OrderDetailPage orderId={orderDetailMatch[1]} /> : <MyOrdersPage />) : authMode ? <AuthPage mode={authMode} /> : isProductDetailPage ? (
          <ProductDetailPage productId={detailMatch[1]} products={products.data} categories={categories.data} loading={products.loading} error={products.error} retry={products.retry} onAction={onProductAction} cartBusy={commerce.busy || commerce.authLoading} />
        ) : isProductReviewsPage ? (
          <ProductReviewsPage productId={productReviewsMatch[1]} />
        ) : isProductsPage ? (
          <ProductsPage {...catalogProps} categoriesLoading={categories.loading} categoriesError={categories.error} retryCategories={categories.retry} />
        ) : (
          <>
            <Hero />
            <PetTypeSection petTypes={petTypes.data} loading={petTypes.loading} error={petTypes.error} retry={petTypes.retry} />
            <CategorySection categories={categories.data} products={products.data} productsReady={!products.loading && !products.error} loading={categories.loading} error={categories.error} retry={categories.retry} selectedCategory={selectedCategory} onSelect={setSelectedCategory} />
            <ProductSection {...catalogProps} />
          </>
        )}
      </main>
      <Footer />
      {isHomePage && <FloatingContact />}
      {!/^\/admin(?:\/|$)/.test(pathname) && <ChatbotWidget />}
      <FeatureNotice message={commerce.notice} type={commerce.noticeType} onClose={commerce.clearNotice} />
    </div>
  );
}
