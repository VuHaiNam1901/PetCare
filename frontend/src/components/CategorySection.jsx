import { ArrowUpRight, Bone, HeartPulse, PawPrint, Shirt, Sparkles, UtensilsCrossed } from 'lucide-react';
import { normalizeText } from '../utils/catalog.js';
import { EmptyState, ErrorNotice } from './Feedback.jsx';

function categoryIcon(name) {
  const normalized = normalizeText(name);
  if (normalized.includes('thuc an')) return UtensilsCrossed;
  if (normalized.includes('do choi')) return Bone;
  if (normalized.includes('phu kien')) return Shirt;
  if (normalized.includes('ve sinh')) return Sparkles;
  if (normalized.includes('dinh duong')) return HeartPulse;
  return PawPrint;
}

export default function CategorySection({ categories, products, productsReady, loading, error, retry, selectedCategory, onSelect }) {
  const selectCategory = id => {
    onSelect(String(id));
    document.getElementById('san-pham')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <section className="container category-section section-space" id="danh-muc" aria-labelledby="category-title">
      <div className="section-heading">
        <div><p className="eyebrow">CHĂM SÓC THEO CÁCH CỦA BẠN</p><h2 id="category-title">Bạn nhỏ cần gì hôm nay?</h2></div>
        <a href="#san-pham" className="text-link" onClick={() => onSelect('all')}>Khám phá tất cả <ArrowUpRight size={18} aria-hidden="true" /></a>
      </div>
      {loading ? (
        <div className="category-grid" role="status" aria-label="Đang tải danh mục">
          {Array.from({ length: 5 }, (_, index) => <div className="category-skeleton skeleton" key={index} aria-hidden="true" />)}
          <span className="sr-only">Đang tải danh mục...</span>
        </div>
      ) : error ? (
        <ErrorNotice title="Chưa tải được danh mục" message={error} onRetry={retry} />
      ) : categories.length === 0 ? (
        <EmptyState title="Danh mục đang được cập nhật" message="Bạn vẫn có thể khám phá các sản phẩm bên dưới." />
      ) : (
        <div className="category-grid">
          {categories.map((category, index) => {
            const Icon = categoryIcon(category.name);
            const count = products.filter(product => String(product.category_id) === String(category.category_id)).length;
            return (
              <button
                key={category.category_id}
                type="button"
                className={`category-tile tone-${index % 5} ${selectedCategory === String(category.category_id) ? 'is-selected' : ''}`}
                aria-pressed={selectedCategory === String(category.category_id)}
                onClick={() => selectCategory(category.category_id)}
              >
                <span className="category-icon"><Icon size={30} strokeWidth={1.5} aria-hidden="true" /></span>
                <span className="category-name">{category.name}</span>
                <span className="category-count">{productsReady ? `${count} sản phẩm` : 'Khám phá danh mục'} <ArrowUpRight size={13} aria-hidden="true" /></span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
