import { Mail, Phone } from 'lucide-react';

function MessengerMark() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <path fill="currentColor" d="M16 3C8.82 3 3 8.37 3 15c0 3.73 1.84 7.06 4.72 9.26V29l4.45-2.44c1.21.35 2.5.54 3.83.54 7.18 0 13-5.37 13-12.1S23.18 3 16 3Z" />
      <path fill="#0866FF" d="m8 19 7-7 4 3 5-3-7 8-4-3-5 2Z" />
    </svg>
  );
}

function ZaloMark() {
  return (
    <svg viewBox="0 0 36 36" width="30" height="30" aria-hidden="true">
      <path fill="currentColor" d="M18 3C9.72 3 3 8.96 3 16.32c0 3.79 1.8 7.21 4.7 9.63L6.8 32l6.28-3.16c1.54.52 3.2.8 4.92.8 8.28 0 15-5.96 15-13.32S26.28 3 18 3Z" />
      <text x="18" y="20" textAnchor="middle" fill="#008FE5" fontFamily="Arial, sans-serif" fontSize="10.5" fontWeight="700" letterSpacing="-.7">Zalo</text>
    </svg>
  );
}

export default function FloatingContact() {
  return (
    <aside className="floating-contact" aria-label="Kênh liên hệ PetCareShop">
      <button className="contact-button contact-messenger" type="button" aria-disabled="true" aria-label="Messenger — chưa cấu hình kênh liên hệ" title="Messenger: chưa cấu hình kênh liên hệ">
        <MessengerMark />
        <span className="contact-label">Messenger<small>Chưa cấu hình kênh liên hệ</small></span>
      </button>
      <button className="contact-button contact-zalo" type="button" aria-disabled="true" aria-label="Zalo — chưa cấu hình kênh liên hệ" title="Zalo: chưa cấu hình kênh liên hệ">
        <ZaloMark />
        <span className="contact-label">Zalo<small>Chưa cấu hình kênh liên hệ</small></span>
      </button>
      <a className="contact-button contact-phone" href="tel:0987654321" aria-label="Hotline: 0987 654 321">
        <Phone size={24} fill="currentColor" aria-hidden="true" />
        <span className="contact-label">Hotline<small>0987 654 321</small></span>
      </a>
      <a className="contact-button contact-email" href="mailto:petcare@gmail.com" aria-label="Email: petcare@gmail.com">
        <Mail size={25} aria-hidden="true" />
        <span className="contact-label">Email<small>petcare@gmail.com</small></span>
      </a>
    </aside>
  );
}
