import { BRAND_NAME, LOGO_SRC } from '../config/branding.js';

// Dùng lại ở trang khách hàng, đăng nhập/đăng ký và admin; không nhận src riêng.
export default function Logo({ href = '/#trang-chu', className = '' }) {
  return (
    <a className={`logo ${className}`.trim()} href={href} aria-label={`${BRAND_NAME} — Trang chủ`}>
      <img className="logo-image" src={LOGO_SRC} alt={BRAND_NAME} width={88} height={88} />
    </a>
  );
}
