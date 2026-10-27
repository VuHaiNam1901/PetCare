import { API_ORIGIN } from '../services/api.js';

const currencyFormatter = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
});

export function formatPrice(value) {
  if (value == null || String(value).trim() === '') return 'Liên hệ';
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? currencyFormatter.format(number) : 'Liên hệ';
}

export function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

export function resolveImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const source = value.trim();
    if (source.startsWith('/images/products/')) {
      const local = new URL(source, 'https://frontend.invalid');
      if (local.origin !== 'https://frontend.invalid' || !local.pathname.startsWith('/images/products/')) return '';
      return `${local.pathname}${local.search}${local.hash}`;
    }
    const url = new URL(source, `${API_ORIGIN}/`);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

// CDN Hstatic: ưu tiên bản lớn của cùng ảnh, không thay đổi URL trong database.
export function displayImageUrl(source) {
  const resolved = resolveImageUrl(source);
  if (!resolved || resolved.startsWith('/images/products/')) return resolved;
  const url = new URL(resolved);
  if (['cdn.hstatic.net', 'product.hstatic.net'].includes(url.hostname)) {
    url.pathname = url.pathname.replace(/_(pico|small|compact)(\.(?:png|jpe?g|webp))$/i, '_large$2');
  }
  return url.href;
}
