import { ArrowDown, ArrowUpRight, Heart, PawPrint, Sparkles } from 'lucide-react';

export default function Hero() {
  return (
    <section className="hero container" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="eyebrow"><span className="small-dot" /> CÙNG BẠN CHĂM SÓC THÚ CƯNG</p>
        <h1 id="hero-title">Chăm chút nhỏ,<br /><span>hạnh phúc to.</span></h1>
        <p className="hero-description">Từ bữa ăn ngon đến những giờ vui chơi, PetCare đồng hành cùng bạn chăm sóc người bạn nhỏ — mỗi ngày, bằng cả yêu thương.</p>
        <div className="hero-actions">
          <a className="button button-primary" href="#san-pham">Khám phá sản phẩm <ArrowUpRight size={19} aria-hidden="true" /></a>
          <a className="text-link" href="#ve-petcare">Câu chuyện PetCare <ArrowDown size={16} aria-hidden="true" /></a>
        </div>
        <div className="hero-note"><span className="note-paw"><PawPrint size={19} /></span><span>Dành cho những người bạn<br /><strong>bốn chân, một gia đình.</strong></span></div>
      </div>
      <div className="hero-visual">
        <span className="hero-sparkle"><Sparkles size={35} strokeWidth={1.5} aria-hidden="true" /></span>
        <div className="hero-photo-wrap">
          <PawPrint className="hero-photo-fallback" size={100} aria-hidden="true" />
          <img className="hero-photo" src="/images/hero-dog.jpg" alt="Chú chó Golden với ánh mắt thân thiện" width="1000" height="1000" fetchPriority="high" onError={event => { event.currentTarget.style.display = 'none'; }} />
        </div>
        <div className="love-note"><span><Heart size={21} fill="currentColor" aria-hidden="true" /></span><div>Một người bạn nhỏ.<strong>Cả một thế giới yêu thương.</strong></div></div>
        <span className="hero-caption">HAPPY PETS. HAPPY DAYS.</span>
      </div>
    </section>
  );
}
