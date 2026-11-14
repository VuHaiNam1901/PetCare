import { useMemo, useState } from 'react';
import { ArrowDown, ArrowRight, SlidersHorizontal, X } from 'lucide-react';
import ProductCard from './ProductCard.jsx';
import CareHighlights from './CareHighlights.jsx';
import { EmptyState, ErrorNotice } from './Feedback.jsx';
import { normalizeText } from '../utils/catalog.js';
import { PetTypeChoices, PET_TYPE_LABELS } from './PetTypeSection.jsx';

const PAGE_SIZE = 8;

export default function ProductSection({ products, categories, loading, error, retry, selectedCategory, onCategoryChange, query, onQueryChange, onAction, cartBusy, listing = false, categoriesLoading = false, categoriesError = '', retryCategories,
  petTypes = [], petTypesLoading = false, petTypesError = '', retryPetTypes, selectedPetType = '', onPetTypeChange, sortValue = 'newest', onSortChange, page = 1, onPageChange, onResetFilters }) {
  const [localSort, setLocalSort] = useState('newest');
  const sort = listing && onSortChange ? sortValue : localSort;
  const setSort = listing && onSortChange ? onSortChange : setLocalSort;
  // Lưu giới hạn cùng bộ lọc để mỗi lần đổi bộ lọc đều trở về trang đầu.
  const filterKey = JSON.stringify([selectedCategory, query, sort, selectedPetType]);
  const [pagination, setPagination] = useState({ key: '', limit: PAGE_SIZE });
  const visibleLimit = listing && onPageChange ? page * PAGE_SIZE : pagination.key === filterKey ? pagination.limit : PAGE_SIZE;
  const selectedPet = petTypes.find(pet => pet.slug === selectedPetType);
  const petName = selectedPet?.name || (Object.hasOwn(PET_TYPE_LABELS, selectedPetType) ? PET_TYPE_LABELS[selectedPetType] : 'Loài đã chọn');
  const catalogLoading = loading || Boolean(selectedPetType && petTypesLoading);
  const catalogError = error || (selectedPetType ? petTypesError : '');

  const categoryNames = useMemo(() => new Map(categories.map(category => [String(category.category_id), category.name])), [categories]);
  const filtered = useMemo(() => {
    const keyword = normalizeText(query);
    const result = products.filter(product => {
      const inCategory = selectedCategory === 'all' || String(product.category_id) === selectedCategory;
      const inPetType = !selectedPetType || Boolean(selectedPet && product.pet_type_ids?.includes(selectedPet.pet_type_id));
      const categoryName = product.category_name || categoryNames.get(String(product.category_id)) || '';
      return inCategory && inPetType && normalizeText(`${product.name} ${categoryName}`).includes(keyword);
    });
    if (sort === 'price-asc') result.sort((a, b) => Number(a.price) - Number(b.price));
    else if (sort === 'price-desc') result.sort((a, b) => Number(b.price) - Number(a.price));
    else result.sort((a, b) => Number(b.product_id) - Number(a.product_id));
    return result;
  }, [products, selectedCategory, selectedPetType, selectedPet, query, sort, categoryNames]);

  const selectedName = categories.find(category => String(category.category_id) === selectedCategory)?.name
    || products.find(product => String(product.category_id) === selectedCategory)?.category_name
    || 'Danh mục đã chọn';
  const resetFilters = () => {
    if (listing && onResetFilters) { onResetFilters(); return; }
    onQueryChange(''); onCategoryChange('all'); onPetTypeChange?.('');
    if (listing) setSort('newest');
  };
  const Heading = listing ? 'h1' : 'h2';
  const categoryFilters = (
    <div className="catalog-filter" aria-label="Lọc danh mục sản phẩm">
      <button className={`filter-pill ${selectedCategory === 'all' ? 'active' : ''}`} type="button" onClick={() => onCategoryChange('all')} aria-label="Tất cả sản phẩm" aria-pressed={selectedCategory === 'all'}>Tất cả</button>
      {categories.map(category => <button key={category.category_id} className={`filter-pill ${selectedCategory === String(category.category_id) ? 'active' : ''}`} type="button" aria-pressed={selectedCategory === String(category.category_id)} onClick={() => onCategoryChange(String(category.category_id))}>{category.name.replace(/ thú cưng$/i, '').replace('Vệ sinh và chăm sóc', 'Vệ sinh').replace('Dinh dưỡng bổ sung', 'Dinh dưỡng')}</button>)}
    </div>
  );

  return (
    <section className="products-section" id="san-pham" aria-labelledby="products-title">
      <div className="container">
        <div className="section-heading">
          <Heading id="products-title">{listing ? 'Danh sách sản phẩm' : 'Sản phẩm nổi bật'}</Heading>
          {!listing && categoryFilters}
          {!listing && <a href="/products" className="text-link">Xem tất cả<ArrowRight size={14} aria-hidden="true" /></a>}
        </div>
        {listing && <>
          <p className="catalog-intro">Khám phá thức ăn, đồ chơi, phụ kiện và sản phẩm chăm sóc dành cho thú cưng.</p>
          <div className="listing-category-status" id="danh-muc">
            {categoriesLoading ? <p role="status">Đang tải danh mục...</p>
              : categoriesError ? <ErrorNotice title="Chưa tải được danh mục" message={categoriesError} onRetry={retryCategories} />
              : <>{categories.length === 0 && <p className="catalog-category-empty">Danh mục đang được cập nhật. Bạn vẫn có thể tìm kiếm và sắp xếp sản phẩm.</p>}{categoryFilters}</>}
          </div>
          {(petTypesLoading || petTypesError || petTypes.length > 0) && <div className="listing-pet-types">
            <h2>Mua sắm theo thú cưng</h2>
            {petTypesLoading ? <p className="pet-type-status" role="status">Đang tải nhóm thú cưng...</p>
              : petTypesError ? <ErrorNotice title="Chưa tải được nhóm thú cưng" message={petTypesError} onRetry={retryPetTypes} />
                : <PetTypeChoices petTypes={petTypes} selected={selectedPetType} onSelect={onPetTypeChange} />}
          </div>}
          {selectedPetType && <div className="selected-pet-type"><span>Sản phẩm dành cho <strong>{petName}</strong></span><button className="text-link" type="button" onClick={() => onPetTypeChange('')}>Bỏ lọc thú cưng<X size={12} aria-hidden="true" /></button></div>}
        </>}
        <div className="catalog-toolbar">
          <div className="catalog-summary" role="status">{!catalogLoading && !catalogError && (listing || products.length > 0) && <><span>Hiển thị <strong>{Math.min(visibleLimit, filtered.length)}</strong> / {filtered.length} sản phẩm{selectedCategory !== 'all' ? ` trong ${selectedName}` : ''}</span>{(listing || filtered.length > 0) && (query || selectedCategory !== 'all' || selectedPetType || (listing && sort !== 'newest')) && <button className="text-link reset-filters" type="button" onClick={resetFilters}>Xóa bộ lọc<X size={12} /></button>}</>}</div>
          <div className="catalog-controls">
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
        <div className="catalog-layout"><div className="catalog-products">
        {catalogLoading ? (
          <div className="product-grid" role="status" aria-label="Đang tải sản phẩm">
            {Array.from({ length: PAGE_SIZE }, (_, index) => <div className="product-skeleton" key={index} aria-hidden="true"><div className="skeleton skeleton-image" /><div className="skeleton skeleton-line short" /><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line medium" /></div>)}
            <span className="sr-only">Đang tải sản phẩm...</span>
          </div>
        ) : catalogError ? (
          <ErrorNotice title="Chưa tải được sản phẩm" message={catalogError} onRetry={error ? retry : retryPetTypes} />
        ) : products.length === 0 ? (
          <EmptyState title="Sản phẩm đang được cập nhật" message="Bạn hãy ghé lại sau để khám phá sản phẩm dành cho thú cưng nhé." />
        ) : filtered.length === 0 ? (
          <EmptyState title="Chưa tìm thấy sản phẩm phù hợp" message="Thử từ khóa khác hoặc chọn tất cả sản phẩm nhé." onReset={resetFilters} />
        ) : (
          <>
            <div className="product-grid">
              {filtered.slice(0, visibleLimit).map(product => <ProductCard key={product.product_id} product={product} categoryName={product.category_name || categoryNames.get(String(product.category_id))} onAction={onAction} cartBusy={cartBusy} />)}
            </div>
            {visibleLimit < filtered.length && <div className="load-more"><button className="button button-outline" type="button" onClick={() => listing && onPageChange ? onPageChange(page + 1) : setPagination({ key: filterKey, limit: visibleLimit + PAGE_SIZE })}>Xem thêm sản phẩm <ArrowDown size={17} aria-hidden="true" /></button><p>Còn {filtered.length - visibleLimit} sản phẩm để khám phá</p></div>}
          </>
        )}
        <p className="catalog-availability">Kiểm tra thông tin nhận hàng trước khi xác nhận đặt hàng.</p>
        </div>{!listing && <CareHighlights />}</div>
      </div>
    </section>
  );
}
