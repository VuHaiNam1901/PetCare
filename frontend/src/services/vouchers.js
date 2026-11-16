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
      (voucher.audience !== undefined && !['all', 'selected'].includes(voucher.audience)) ||
      (voucher.distribution_managed !== undefined && typeof voucher.distribution_managed !== 'boolean') ||
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
      (!readiness.ready && readiness.online_ready) ||
      (readiness.distribution_ready !== undefined && typeof readiness.distribution_ready !== 'boolean') ||
      (!readiness.ready && readiness.distribution_ready)) throw new Error('Chưa xác nhận được trạng thái Voucher từ máy chủ.');
  return { ...readiness, distribution_ready: readiness.distribution_ready === true };
}
export async function quoteVoucher(token, input, { signal } = {}) {
  const body = { ...input, code: input.code.trim().toUpperCase() };
  const { quote } = await commerceApi('/api/vouchers/quote', { method: 'POST', token, body, signal });
  if (!quote || typeof quote.voucher?.code !== 'string' || quote.voucher.code !== input.code.trim().toUpperCase() ||
      ![quote.subtotal_amount, quote.discount_amount, quote.total_amount].every(validMoney) || quote.reserved !== false) throw invalid();
  return quote;
}
export async function listCustomerVouchers(token, { page = 1, limit = 20, assignedOnly = false, signal } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 2147483647 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || typeof assignedOnly !== 'boolean') throw new Error('Trang danh sách Voucher không hợp lệ.');
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (assignedOnly) params.set('assigned', '1');
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

function customerId(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) ||
      !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw invalid();
  return String(value);
}
function customerFrom(user) {
  if (!user || typeof user.full_name !== 'string' || typeof user.email !== 'string' ||
      (user.phone !== null && user.phone !== undefined && typeof user.phone !== 'string') ||
      (user.status !== undefined && !['active', 'inactive'].includes(user.status))) throw invalid();
  return { user_id: customerId(user.user_id), full_name: user.full_name, email: user.email, phone: user.phone ?? null,
    ...(user.status === undefined ? {} : { status: user.status }) };
}
function customerPage(data, page, limit) {
  if (data.page !== page || data.limit !== limit || !Number.isSafeInteger(data.total) || data.total < 0 ||
      !Array.isArray(data.users) || data.users.length > limit) throw invalid();
  const users = data.users.map(customerFrom);
  if (new Set(users.map(user => user.user_id)).size !== users.length) throw invalid();
  return { page, limit, total: data.total, users };
}
function customerPagination(page, limit) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 2147483647 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger((page - 1) * limit)) throw invalid();
  return new URLSearchParams({ page: String(page), limit: String(limit) });
}
export async function searchVoucherCustomers(token, { q = '', page = 1, limit = 20, signal } = {}) {
  const params = customerPagination(page, limit);
  if (typeof q !== 'string' || q.trim().length > 150) throw new Error('Từ khóa tìm khách hàng tối đa 150 ký tự.');
  if (q.trim()) params.set('q', q.trim());
  return customerPage(await commerceApi(`/api/admin/vouchers/customers?${params}`, { token, signal, cache: 'no-store' }), page, limit);
}
export async function getVoucherAssignments(token, id, { page = 1, limit = 20, signal } = {}) {
  const params = customerPagination(page, limit);
  return customerPage(await commerceApi(`${pathFor(id)}/assignments?${params}`, { token, signal, cache: 'no-store' }), page, limit);
}
export async function grantVoucher(token, id, userIds) {
  if (!Array.isArray(userIds) || !userIds.length || userIds.length > 100) throw new Error('Chọn từ 1 đến 100 khách hàng mỗi lần cấp.');
  const user_ids = [...new Set(userIds.map(customerId))];
  const data = await commerceApi(`${pathFor(id)}/assignments`, { method: 'POST', token, body: { user_ids } });
  const voucher = voucherFrom(data);
  if (voucher.voucher_id !== String(id) || !Number.isSafeInteger(data.added) || data.added < 0 || data.added > user_ids.length ||
      !Number.isSafeInteger(data.total) || data.total < data.added) throw invalid();
  return { voucher, added: data.added, total: data.total };
}
