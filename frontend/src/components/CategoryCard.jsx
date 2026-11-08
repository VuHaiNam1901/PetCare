import { PawPrint } from 'lucide-react';
import { normalizeText } from '../utils/catalog.js';

const artwork = [
  ['thuc an', 'food', 'Đa dạng dinh dưỡng'],
  ['do choi', 'toys', 'Giúp thú cưng vui khỏe'],
  ['phu kien', 'accessories', 'Vòng cổ, dây dắt, chuồng...'],
  ['ve sinh', 'care', 'Sữa tắm, dụng cụ vệ sinh'],
  ['dinh duong', 'nutrition', 'Vitamin, khoáng chất'],
];

export default function CategoryCard({ category, selected, count, productsReady, onSelect }) {
  const art = artwork.find(([keyword]) => normalizeText(category.name).includes(keyword));
  return (
    <button type="button" className={`category-tile ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={() => onSelect(category.category_id)} title={productsReady ? `${category.name}: ${count} sản phẩm` : category.name}>
      <span className="category-art">{art ? <img src={`/images/home/category-${art[1] === 'nutrition' ? 'supplements' : art[1]}.webp`} alt="" width="280" height="280" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} /> : <PawPrint size={50} aria-hidden="true" />}</span>
      <span className="category-name">{category.name}</span>
      <span className="category-description">{art?.[2] || 'Khám phá sản phẩm'}</span>
    </button>
  );
}
