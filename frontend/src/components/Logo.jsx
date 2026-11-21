import { BRAND_NAME, LOGO_SRC, LOGO_WORDMARK_SRC } from '../config/branding.js';

// Dùng lại ở trang khách hàng, đăng nhập/đăng ký và admin; không nhận src riêng.
export default function Logo({ href = '/#trang-chu', className = '' }) {
  return (
    <a className={`logo header-logo ${className}`.trim()} href={href} aria-label={`${BRAND_NAME} — Trang chủ`}>
      <img className="header-logo-icon logo-image" src={LOGO_SRC} alt="" width={1024} height={765} />
      <img className="header-logo-wordmark" src={LOGO_WORDMARK_SRC} alt={BRAND_NAME} width={1024} height={318} />
    </a>
  );
}
