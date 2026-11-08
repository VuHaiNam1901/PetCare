import { Headset, HeartHandshake, SearchCheck, Tags } from 'lucide-react';

const highlights = [
  { Icon: SearchCheck, title: 'Tìm sản phẩm dễ dàng', text: 'Theo tên và danh mục' },
  { Icon: Tags, title: 'Thông tin rõ ràng', text: 'Giá niêm yết từ cửa hàng' },
  { Icon: Headset, title: 'Kết nối trực tiếp', text: 'Qua hotline và email' },
  { Icon: HeartHandshake, title: 'Chăm sóc toàn diện', text: 'Dinh dưỡng, vệ sinh, vui chơi' },
];

export default function CareHighlights() {
  return (
    <aside className="care-highlights" aria-labelledby="benefits-title">
      <h3 id="benefits-title">Vì sao chọn PetCareShop?</h3>
      {highlights.map(({ Icon, title, text }) => (
        <div className="care-highlight" key={title}>
          <span className="highlight-icon"><Icon size={25} strokeWidth={1.6} aria-hidden="true" /></span>
          <div><h4>{title}</h4><p>{text}</p></div>
        </div>
      ))}
    </aside>
  );
}
