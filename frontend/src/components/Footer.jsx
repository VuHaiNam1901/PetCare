import { ArrowUpRight, Heart } from 'lucide-react';
import Brand from './Brand.jsx';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-main">
        <div className="footer-brand"><Brand light /><p>Chăm chút mỗi ngày.<br />Trao trọn yêu thương cho bạn nhỏ.</p></div>
        <div className="footer-links"><h2>Khám phá PetCare</h2><a href="#trang-chu">Trang chủ</a><a href="#danh-muc">Danh mục sản phẩm</a><a href="#san-pham">Tất cả sản phẩm</a><a href="#ve-petcare">Về PetCare</a></div>
        <div className="footer-message"><Heart size={25} strokeWidth={1.5} aria-hidden="true" /><h2>Mỗi ngày bên nhau,<br />thêm một ngày hạnh phúc.</h2><a href="#san-pham">Chọn điều nhỏ, gửi yêu thương <ArrowUpRight size={16} aria-hidden="true" /></a></div>
      </div>
      <div className="container footer-bottom"><p>© {new Date().getFullYear()} PetCare. Đồ án website giới thiệu sản phẩm chăm sóc thú cưng.</p><a href="#trang-chu">Về đầu trang ↑</a></div>
    </footer>
  );
}
