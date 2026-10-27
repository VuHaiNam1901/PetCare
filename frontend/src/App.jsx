import { useState } from 'react';
import Header from './components/Header.jsx';
import Hero from './components/Hero.jsx';
import CareHighlights from './components/CareHighlights.jsx';
import CategorySection from './components/CategorySection.jsx';
import ProductSection from './components/ProductSection.jsx';
import AboutSection from './components/AboutSection.jsx';
import Footer from './components/Footer.jsx';
import { useApiList } from './hooks/useApiList.js';

export default function App() {
  const products = useApiList('/api/products', 'products');
  const categories = useApiList('/api/categories', 'categories');
  const [selectedCategory, setSelectedCategory] = useState('all');

  return (
    <div id="trang-chu">
      <a className="skip-link" href="#main-content">Đến nội dung chính</a>
      <Header />
      <main id="main-content">
        <Hero />
        <CareHighlights />
        <CategorySection categories={categories.data} products={products.data} productsReady={!products.loading && !products.error} loading={categories.loading} error={categories.error} retry={categories.retry} selectedCategory={selectedCategory} onSelect={setSelectedCategory} />
        <ProductSection products={products.data} categories={categories.data} loading={products.loading} error={products.error} retry={products.retry} selectedCategory={selectedCategory} onCategoryChange={setSelectedCategory} />
        <AboutSection />
      </main>
      <Footer />
    </div>
  );
}
