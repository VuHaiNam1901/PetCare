import { commerceApi } from './commerce.js';

const validMoney = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value);
const validId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const invalid = () => new Error('Dữ liệu Voucher từ máy chủ chưa hợp lệ. Vui lòng tải lại.');
function voucherFrom(data) {
  const voucher = data.voucher;
  if (!voucher || !validId(voucher.voucher_id) || typeof voucher.code !== 'string' ||
      !/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(voucher.code) || !['fixed', 'percent'].includes(voucher.discount_type) ||
      !validMoney(voucher.discount_value) || !validMoney(voucher.minimum_order_amount) ||
      (voucher.max_discount_amount !== null && !validMoney(voucher.max_discount_amount)) ||
      !['draft', 'active', 'disabled'].includes(voucher.status) ||
      !Number.isFinite(Date.parse(voucher.starts_at_utc)) || !Number.isFinite(Date.parse(voucher.ends_at_utc))) throw invalid();
  return voucher;
}
function pathFor(id) {
  if (!validId(String(id))) throw new Error('Mã định danh Voucher không hợp lệ.');
  return `/api/admin/vouchers/${id}`;
}
export async function getVoucherReadiness({ signal } = {}) {
  const data = await commerceApi('/api/vouchers/readiness', { signal });
  const readiness = data.readiness;
  if (!readiness || typeof readiness.ready !== 'boolean' || typeof readiness.online_ready !== 'boolean' ||
      (!readiness.ready && readiness.online_ready)) throw new Error('Chưa xác nhận được trạng thái Voucher từ máy chủ.');
  return readiness;
}
export async function quoteVoucher(token, input, { signal } = {}) {
  const body = { ...input, code: input.code.trim().toUpperCase() };
  const { quote } = await commerceApi('/api/vouchers/quote', { method: 'POST', token, body, signal });
  if (!quote || typeof quote.voucher?.code !== 'string' || quote.voucher.code !== input.code.trim().toUpperCase() ||
      ![quote.subtotal_amount, quote.discount_amount, quote.total_amount].every(validMoney) || quote.reserved !== false) throw invalid();
  return quote;
}
export async function listCustomerVouchers(token, { page = 1, limit = 20, signal } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 2147483647 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Trang danh sách Voucher không hợp lệ.');
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  const data = await commerceApi(`/api/vouchers?${params}`, { token, signal });
  if (data.page !== page || data.limit !== limit || !Number.isSafeInteger(data.total) || data.total < 0 ||
      !Array.isArray(data.vouchers) || data.vouchers.length > limit) throw invalid();
  const vouchers = data.vouchers.map(voucher => {
    if (!voucher || typeof voucher.code !== 'string' || !/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(voucher.code) ||
        !['fixed', 'percent'].includes(voucher.discount_type) || !validMoney(voucher.discount_value) ||
        !validMoney(voucher.minimum_order_amount) || (voucher.max_discount_amount !== null && !validMoney(voucher.max_discount_amount)) ||
        typeof voucher.starts_at_utc !== 'string' || typeof voucher.ends_at_utc !== 'string' ||
        !Number.isFinite(Date.parse(voucher.starts_at_utc)) || !Number.isFinite(Date.parse(voucher.ends_at_utc))) throw invalid();
    return Object.fromEntries(['code', 'discount_type', 'discount_value', 'max_discount_amount',
      'minimum_order_amount', 'starts_at_utc', 'ends_at_utc'].map(field => [field, voucher[field]]));
  });
  if (new Set(vouchers.map(voucher => voucher.code)).size !== vouchers.length) throw invalid();
  return { page, limit, total: data.total, vouchers };
}
export async function listVouchers(token, { page = 1, limit = 20, q = '', status = '', signal } = {}) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (q.trim()) params.set('q', q.trim());
  if (status) params.set('status', status);
  const data = await commerceApi(`/api/admin/vouchers?${params}`, { token, signal });
  if (!Array.isArray(data.vouchers) || !Number.isSafeInteger(data.total) || data.total < 0) throw invalid();
  return { total: data.total, vouchers: data.vouchers.map(voucher => voucherFrom({ voucher })) };
}
export async function getVoucher(token, id, { signal } = {}) {
  return voucherFrom(await commerceApi(pathFor(id), { token, signal }));
}
export async function createVoucher(token, body) {
  return voucherFrom(await commerceApi('/api/admin/vouchers', { method: 'POST', token, body }));
}
export async function updateVoucher(token, id, body) {
  return voucherFrom(await commerceApi(pathFor(id), { method: 'PATCH', token, body }));
}
export async function disableVoucher(token, id) {
  return voucherFrom(await commerceApi(`${pathFor(id)}/disable`, { method: 'PATCH', token, body: {} }));
}
