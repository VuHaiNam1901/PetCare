import { ArrowRight } from 'lucide-react';
import { EmptyState, ErrorNotice } from './Feedback.jsx';
import CategoryCard from './CategoryCard.jsx';

export default function CategorySection({ categories, products, productsReady, loading, error, retry, selectedCategory, onSelect }) {
  const selectCategory = id => {
    onSelect(String(id));
    document.getElementById('san-pham')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <section className="container category-section" id="danh-muc" aria-labelledby="category-title">
      <div className="category-content">
        <div className="section-heading"><h2 id="category-title">Danh mục nổi bật</h2><a href="#san-pham" className="text-link" onClick={() => onSelect('all')}>Xem tất cả <ArrowRight size={14} aria-hidden="true" /></a></div>
        {loading ? <div className="category-grid" role="status" aria-label="Đang tải danh mục">{Array.from({ length: 5 }, (_, index) => <div className="category-skeleton skeleton" key={index} aria-hidden="true" />)}<span className="sr-only">Đang tải danh mục...</span></div>
          : error ? <ErrorNotice title="Chưa tải được danh mục" message={error} onRetry={retry} />
          : categories.length === 0 ? <EmptyState title="Danh mục đang được cập nhật" message="Bạn vẫn có thể khám phá các sản phẩm bên dưới." />
          : <div className="category-grid">{categories.map(category => <CategoryCard key={category.category_id} category={category} selected={selectedCategory === String(category.category_id)} count={products.filter(product => String(product.category_id) === String(category.category_id)).length} productsReady={productsReady} onSelect={selectCategory} />)}</div>}
      </div>
      <aside className="care-banner" aria-label="Khám phá sản phẩm chăm sóc thú cưng"><div className="care-banner-copy"><span className="banner-label">CHĂM SÓC MỖI NGÀY</span><h3>Thêm yêu thương</h3><p>Cho người bạn nhỏ khỏe mạnh</p><a className="button button-dark" href="#san-pham" onClick={() => onSelect('all')}>Xem ngay<ArrowRight size={15} aria-hidden="true" /></a></div></aside>
    </section>
  );
}
