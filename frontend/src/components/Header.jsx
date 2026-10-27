import { useState } from 'react';
import { ArrowUpRight, Heart, Menu, X } from 'lucide-react';
import Brand from './Brand.jsx';

const links = [
  ['#trang-chu', 'Trang chủ'],
  ['#danh-muc', 'Danh mục'],
  ['#san-pham', 'Sản phẩm'],
  ['#ve-petcare', 'Về PetCare'],
];

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <div className="announcement"><Heart size={13} aria-hidden="true" /> Một chút quan tâm. Thêm nhiều hạnh phúc.</div>
      <header className="site-header">
        <div className="container header-inner">
          <Brand />
          <nav aria-label="Điều hướng chính" className="desktop-nav">
            {links.map(([href, label], index) => (
              <a key={href} href={href} className={index === 0 ? 'nav-home' : ''}>{label}</a>
            ))}
          </nav>
          <a className="header-cta" href="#san-pham">Khám phá ngay <ArrowUpRight size={17} aria-hidden="true" /></a>
          <button
            className="menu-toggle icon-button"
            type="button"
            aria-label={menuOpen ? 'Đóng menu' : 'Mở menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen(open => !open)}
          >{menuOpen ? <X size={24} /> : <Menu size={24} />}</button>
        </div>
        {menuOpen && (
          <nav id="mobile-menu" className="mobile-nav" aria-label="Điều hướng trên điện thoại">
            {links.map(([href, label]) => (
              <a key={href} href={href} onClick={() => setMenuOpen(false)}>{label}</a>
            ))}
          </nav>
        )}
      </header>
    </>
  );
}
