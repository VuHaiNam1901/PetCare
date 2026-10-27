import { ArrowUpRight, Heart, PawPrint } from 'lucide-react';

export default function AboutSection() {
  return (
    <section className="container about-section section-space" id="ve-petcare" aria-labelledby="about-title">
      <div className="about-art" aria-hidden="true"><span className="about-orbit" /><PawPrint className="about-paw" size={118} strokeWidth={1.1} /><Heart className="about-heart" size={36} fill="currentColor" /><span className="about-art-label">LITTLE PAWS. BIG LOVE.</span></div>
      <div className="about-copy"><p className="eyebrow">VỀ PETCARE</p><h2 id="about-title">Vì bạn nhỏ<br />là một phần gia đình.</h2><p>Chúng tôi tin rằng sự quan tâm nằm trong những điều giản dị: một bữa ăn hợp khẩu vị, một món đồ chơi yêu thích, hay bộ lông được chăm sóc mỗi ngày.</p><p>PetCare là nơi bạn khám phá sản phẩm cho những nhu cầu ấy, để hành trình chăm sóc thú cưng trở nên gần gũi và dễ dàng hơn.</p><a className="text-link" href="#danh-muc">Tìm sản phẩm phù hợp <ArrowUpRight size={18} aria-hidden="true" /></a></div>
    </section>
  );
}
