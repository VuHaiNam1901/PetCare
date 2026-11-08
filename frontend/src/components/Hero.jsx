import { ArrowRight, Heart, PawPrint } from 'lucide-react';

export default function Hero() {
  return (
    <section className="hero container" aria-labelledby="hero-title">
      <img className="hero-photo" src="/images/home/hero-pets.webp" alt="Chó Golden và mèo con bên nhau trên chiếc chăn mềm" width="1600" height="533" fetchPriority="high" />
      <div className="hero-copy">
        <p className="hero-eyebrow">PETCARESHOP</p>
        <h1 id="hero-title">Sản phẩm chất lượng<br />cho <span>thú cưng khỏe mạnh</span></h1>
        <p className="hero-description">Đầy đủ thức ăn, đồ chơi, phụ kiện và sản phẩm chăm sóc<br className="desktop-break" /> thú cưng với giá tốt nhất</p>
        <a className="button button-primary hero-cta" href="#san-pham">Mua ngay<ArrowRight size={20} aria-hidden="true" /></a>
      </div>
      <div className="hero-handwriting" aria-hidden="true">Cùng thú cưng<br />trọn yêu thương<Heart size={23} fill="currentColor" /></div>
      <PawPrint className="hero-paw paw-one" size={48} fill="currentColor" aria-hidden="true" />
      <PawPrint className="hero-paw paw-two" size={60} fill="currentColor" aria-hidden="true" />
      <Heart className="hero-heart" size={45} aria-hidden="true" />
    </section>
  );
}
