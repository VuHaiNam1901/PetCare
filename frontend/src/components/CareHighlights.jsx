import { HeartHandshake, Leaf, Smile } from 'lucide-react';

const highlights = [
  { Icon: Leaf, title: 'Dinh dưỡng mỗi ngày', text: 'Quan tâm từ những bữa ăn nhỏ.' },
  { Icon: HeartHandshake, title: 'Chăm sóc toàn diện', text: 'Sạch sẽ, thoải mái và được yêu thương.' },
  { Icon: Smile, title: 'Vui chơi & gắn kết', text: 'Thêm những khoảnh khắc bên nhau.' },
];

export default function CareHighlights() {
  return (
    <div className="container care-highlights" aria-label="Chăm sóc thú cưng mỗi ngày">
      {highlights.map(({ Icon, title, text }) => (
        <div className="care-highlight" key={title}>
          <span className="highlight-icon"><Icon size={25} strokeWidth={1.6} aria-hidden="true" /></span>
          <div><h2>{title}</h2><p>{text}</p></div>
        </div>
      ))}
    </div>
  );
}
