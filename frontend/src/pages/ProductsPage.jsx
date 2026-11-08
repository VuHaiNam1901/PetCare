import { useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import ProductSection from '../components/ProductSection.jsx';
import { BRAND_NAME } from '../config/branding.js';

export default function ProductsPage(props) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `Danh sách sản phẩm | ${BRAND_NAME}`;
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <div className="products-page">
      <nav className="container catalog-breadcrumbs" aria-label="Đường dẫn">
        <a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">Sản phẩm</span>
      </nav>
      <ProductSection {...props} listing />
    </div>
  );
}
