import { useEffect, useRef, useState } from 'react';
import { Mail, Phone, X } from 'lucide-react';
import zaloQrSrc from '../assets/zalo-qr.png';

const FACEBOOK_URL = 'https://www.facebook.com/share/1KeT2HbYav/?mibextid=wwXIfr';
const PHONE_HREF = 'tel:0979019346';
const PHONE_DISPLAY = '0979 019 346';
const EMAIL_HREF = 'mailto:vunam1901bg@gmail.com';
const EMAIL_DISPLAY = 'vunam1901bg@gmail.com';

function FacebookMark() {
  return (
    <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.42 28V17.06h3.67l.55-4.26h-4.22v-2.72c0-1.23.34-2.07 2.11-2.07h2.26V4.2a30.4 30.4 0 0 0-3.29-.17c-3.25 0-5.48 1.98-5.48 5.63v3.14H10.3v4.26h3.72V28h4.4Z"
      />
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
  const [zaloOpen, setZaloOpen] = useState(false);
  const dialogRef = useRef(null);
  const pressedOutsideRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (zaloOpen) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [zaloOpen]);

  const isOutsideDialog = event => {
    const dialog = dialogRef.current;
    if (!dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };

  return (
    <>
      <aside className="floating-contact" aria-label="Kênh liên hệ PetCareShop">
        <a
          className="contact-button contact-messenger"
          href={FACEBOOK_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Facebook PetCareShop"
        >
          <FacebookMark />
          <span className="contact-label">Facebook<small>PetCareShop</small></span>
        </a>
        <button
          className="contact-button contact-zalo"
          type="button"
          aria-label="Kết nối với PetCareShop qua Zalo"
          aria-haspopup="dialog"
          aria-expanded={zaloOpen}
          onClick={() => setZaloOpen(true)}
        >
          <ZaloMark />
          <span className="contact-label">Zalo<small>Quét mã QR</small></span>
        </button>
        <a
          className="contact-button contact-phone"
          href={PHONE_HREF}
          aria-label={`Điện thoại: ${PHONE_DISPLAY}`}
        >
          <Phone size={22} fill="currentColor" aria-hidden="true" />
          <span className="contact-label">Điện thoại<small>{PHONE_DISPLAY}</small></span>
        </a>
        <a
          className="contact-button contact-email"
          href={EMAIL_HREF}
          aria-label={`Email: ${EMAIL_DISPLAY}`}
        >
          <Mail size={23} aria-hidden="true" />
          <span className="contact-label">Email<small>{EMAIL_DISPLAY}</small></span>
        </a>
      </aside>

      <dialog
        ref={dialogRef}
        className="zalo-qr-dialog"
        closedby="any"
        aria-labelledby="zalo-qr-dialog-title"
        onClose={() => setZaloOpen(false)}
        onPointerDown={event => {
          pressedOutsideRef.current = isOutsideDialog(event);
        }}
        onPointerUp={event => {
          if (pressedOutsideRef.current && isOutsideDialog(event)) {
            setZaloOpen(false);
          }
          pressedOutsideRef.current = false;
        }}
      >
        <div className="zalo-qr-dialog-header">
          <div>
            <span className="zalo-qr-badge">Zalo</span>
            <h2 id="zalo-qr-dialog-title">Kết nối qua Zalo</h2>
          </div>
          <button
            className="icon-button zalo-qr-close"
            type="button"
            aria-label="Đóng cửa sổ mã QR Zalo"
            autoFocus
            onClick={() => setZaloOpen(false)}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="zalo-qr-dialog-body">
          <div className="zalo-qr-frame">
            <img
              src={zaloQrSrc}
              alt="Mã QR Zalo của Vũ Hải Nam"
              width="240"
              height="240"
            />
          </div>
          <strong className="zalo-qr-name">Vũ Hải Nam</strong>
          <p className="zalo-qr-instruction">Mở Zalo và quét mã QR để kết nối</p>
        </div>
      </dialog>
    </>
  );
}
