import { ArrowUp, Mail, Phone } from 'lucide-react';
import Logo from './Logo.jsx';

export default function Footer() {
  return (
    <footer className="site-footer" id="lien-he">
      <div className="container footer-main">
        <div className="footer-brand" id="ve-petcare"><Logo /><p>Thức ăn, đồ chơi, phụ kiện và sản phẩm chăm sóc.<br />Cùng thú cưng, trọn yêu thương mỗi ngày.</p></div>
        <div className="footer-links"><h2>Khám phá PetCareShop</h2><a href="/#trang-chu">Trang chủ</a><a href="/#danh-muc">Danh mục sản phẩm</a><a href="/products">Tất cả sản phẩm</a></div>
        <div className="footer-links"><h2>Liên hệ với chúng tôi</h2><a href="tel:0979019346"><Phone size={15} />0979 019 346</a><a href="mailto:vunam1901bg@gmail.com"><Mail size={15} />vunam1901bg@gmail.com</a><p>Luôn mong được lắng nghe bạn.</p></div>
      </div>
      <div className="container footer-bottom"><p>© {new Date().getFullYear()} PetCareShop. Đồ án website sản phẩm chăm sóc thú cưng.</p><a href="#trang-chu">Về đầu trang <ArrowUp size={13} /></a></div>
    </footer>
  );
}
