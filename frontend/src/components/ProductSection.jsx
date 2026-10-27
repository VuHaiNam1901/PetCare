import { useMemo, useState } from 'react';
import { ArrowDown, Search, SlidersHorizontal, X } from 'lucide-react';
import ProductCard from './ProductCard.jsx';
import { EmptyState, ErrorNotice } from './Feedback.jsx';
import { normalizeText } from '../utils/catalog.js';

const PAGE_SIZE = 8;

export default function ProductSection({ products, categories, loading, error, retry, selectedCategory, onCategoryChange }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  // Lưu giới hạn cùng bộ lọc để mỗi lần đổi bộ lọc đều trở về trang đầu.
  const filterKey = `${selectedCategory}|${query}|${sort}`;
  const [pagination, setPagination] = useState({ key: '', limit: PAGE_SIZE });
  const visibleLimit = pagination.key === filterKey ? pagination.limit : PAGE_SIZE;

  const categoryNames = useMemo(() => new Map(categories.map(category => [String(category.category_id), category.name])), [categories]);
  const filtered = useMemo(() => {
    const keyword = normalizeText(query);
    const result = products.filter(product => {
      const inCategory = selectedCategory === 'all' || String(product.category_id) === selectedCategory;
      const categoryName = product.category_name || categoryNames.get(String(product.category_id)) || '';
      return inCategory && normalizeText(`${product.name} ${categoryName}`).includes(keyword);
    });
    if (sort === 'price-asc') result.sort((a, b) => Number(a.price) - Number(b.price));
    else if (sort === 'price-desc') result.sort((a, b) => Number(b.price) - Number(a.price));
    else result.sort((a, b) => Number(b.product_id) - Number(a.product_id));
    return result;
  }, [products, selectedCategory, query, sort, categoryNames]);

  const selectedName = categories.find(category => String(category.category_id) === selectedCategory)?.name
    || products.find(product => String(product.category_id) === selectedCategory)?.category_name
    || 'Danh mục đã chọn';
  const resetFilters = () => { setQuery(''); onCategoryChange('all'); };

  return (
    <section className="products-section section-space" id="san-pham" aria-labelledby="products-title">
      <div className="container">
        <div className="section-heading">
          <div><p className="eyebrow">NHỮNG ĐIỀU NHỎ, TRAO YÊU THƯƠNG LỚN</p><h2 id="products-title">Góc mua sắm cho bạn nhỏ</h2></div>
          <p className="section-description">Tìm điều phù hợp cho mỗi ngày bên nhau.</p>
        </div>
        <div className="catalog-toolbar">
          <div className="catalog-filter">
            <button className={`filter-pill ${selectedCategory === 'all' ? 'active' : ''}`} type="button" onClick={() => onCategoryChange('all')} aria-pressed={selectedCategory === 'all'}>Tất cả sản phẩm</button>
            {selectedCategory !== 'all' && <button className="filter-pill active selected-filter" type="button" onClick={() => onCategoryChange('all')} aria-label={`Bỏ lọc ${selectedName}`}>{selectedName}<X size={14} aria-hidden="true" /></button>}
          </div>
          <div className="catalog-controls">
            <div className="search-field">
              <Search size={18} aria-hidden="true" />
              <input type="search" aria-label="Tìm kiếm sản phẩm" placeholder="Tìm cho bạn nhỏ..." value={query} onChange={event => setQuery(event.target.value)} />
              {query && <button type="button" className="clear-search" aria-label="Xóa tìm kiếm" onClick={() => setQuery('')}><X size={15} /></button>}
            </div>
            <div className="sort-field">
              <SlidersHorizontal size={16} aria-hidden="true" />
              <select aria-label="Sắp xếp sản phẩm" value={sort} onChange={event => setSort(event.target.value)}>
                <option value="newest">Mới nhất</option>
                <option value="price-asc">Giá: thấp đến cao</option>
                <option value="price-desc">Giá: cao đến thấp</option>
              </select>
            </div>
          </div>
        </div>
        {loading ? (
          <div className="product-grid" role="status" aria-label="Đang tải sản phẩm">
            {Array.from({ length: PAGE_SIZE }, (_, index) => <div className="product-skeleton" key={index} aria-hidden="true"><div className="skeleton skeleton-image" /><div className="skeleton skeleton-line short" /><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line medium" /></div>)}
            <span className="sr-only">Đang tải sản phẩm...</span>
          </div>
        ) : error ? (
          <ErrorNotice title="Chưa tải được sản phẩm" message={error} onRetry={retry} />
        ) : products.length === 0 ? (
          <EmptyState title="Sản phẩm đang được cập nhật" message="Bạn hãy ghé lại sau để khám phá sản phẩm dành cho thú cưng nhé." />
        ) : filtered.length === 0 ? (
          <EmptyState title="Chưa tìm thấy sản phẩm phù hợp" message="Thử từ khóa khác hoặc chọn tất cả sản phẩm nhé." onReset={resetFilters} />
        ) : (
          <>
            <p className="result-count" role="status">Hiển thị <strong>{Math.min(visibleLimit, filtered.length)}</strong> / {filtered.length} sản phẩm{selectedCategory !== 'all' ? ` trong ${selectedName}` : ''}</p>
            <div className="product-grid">
              {filtered.slice(0, visibleLimit).map(product => <ProductCard key={product.product_id} product={product} categoryName={product.category_name || categoryNames.get(String(product.category_id))} />)}
            </div>
            {visibleLimit < filtered.length && <div className="load-more"><button className="button button-outline" type="button" onClick={() => setPagination({ key: filterKey, limit: visibleLimit + PAGE_SIZE })}>Xem thêm sản phẩm <ArrowDown size={17} aria-hidden="true" /></button><p>Còn {filtered.length - visibleLimit} sản phẩm để khám phá</p></div>}
          </>
        )}
      </div>
    </section>
  );
}
