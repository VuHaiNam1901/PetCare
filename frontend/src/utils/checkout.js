export const CHECKOUT_DRAFT_KEY = 'petcare.checkout-draft.v1';
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const shippingFields = ['recipient_name', 'phone', 'address', 'note'];
const voucherCode = value => value == null || value === '' ? '' : typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.trim()) ? value.trim().toUpperCase() : null;

// Match the API's UTF-16 limits while allowing full Unicode and multiline delivery notes.
function invalidText(value, multiline = false) {
  const controls = multiline ? /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/u : /[\u0000-\u001F\u007F]/u;
  return controls.test(value) || [...value].some(char => char.length === 1 && /[\uD800-\uDFFF]/u.test(char));
}

export function validateShipping(shipping) {
  const errors = {};
  const name = shipping.recipient_name.trim();
  const phone = shipping.phone.trim();
  const address = shipping.address.trim();
  const note = shipping.note.trim();
  if (!name) errors.recipient_name = 'Vui lòng nhập họ và tên người nhận.';
  else if (name.length > 100) errors.recipient_name = 'Họ và tên tối đa 100 ký tự.';
  else if (invalidText(shipping.recipient_name)) errors.recipient_name = 'Họ và tên chứa ký tự không hợp lệ.';
  if (!phone) errors.phone = 'Vui lòng nhập số điện thoại.';
  else if (!/^\+?[0-9 ()-]{6,20}$/.test(phone) || phone.replace(/\D/g, '').length < 6) errors.phone = 'Vui lòng nhập số điện thoại hợp lệ, ít nhất 6 chữ số và tối đa 20 ký tự.';
  if (!address) errors.address = 'Vui lòng nhập địa chỉ giao hàng đầy đủ.';
  else if (address.length < 5) errors.address = 'Vui lòng nhập địa chỉ đầy đủ, ít nhất 5 ký tự.';
  else if (address.length > 255) errors.address = 'Địa chỉ tối đa 255 ký tự.';
  else if (invalidText(shipping.address, true)) errors.address = 'Địa chỉ chứa ký tự không hợp lệ.';
  if (note.length > 200) errors.note = 'Ghi chú tối đa 200 ký tự.';
  else if (invalidText(shipping.note, true)) errors.note = 'Ghi chú chứa ký tự không hợp lệ.';
  return errors;
}

function purchaseItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100 || items.some(item => !item || !positive(item.product_id) || !positive(item.quantity)) || new Set(items.map(item => item.product_id)).size !== items.length) return null;
  return items.map(({ product_id, quantity }) => ({ product_id, quantity }));
}

export function readCheckoutDraft(userId) {
  try {
    const draft = JSON.parse(sessionStorage.getItem(CHECKOUT_DRAFT_KEY) || 'null');
    if (!draft || draft.version !== 1 || typeof draft.intent_id !== 'string' || !['cart', 'buy-now'].includes(draft.type) || !purchaseItems(draft.items) || (draft.type === 'buy-now' && draft.items.length !== 1)) return null;
    if (draft.user_id !== null && !positive(draft.user_id)) return null;
    if (arguments.length && draft.user_id !== userId) return null;
    if (!draft.shipping || shippingFields.some(field => typeof draft.shipping[field] !== 'string') || !['COD', 'ONLINE'].includes(draft.payment_method)) return null;
    if (voucherCode(draft.voucher_code) === null || (draft.submission && voucherCode(draft.submission.payload?.voucher_code) === null)) return null;
    if (draft.submission && (typeof draft.submission.key !== 'string' || !draft.submission.payload ||
      !purchaseItems(draft.submission.payload.items) || draft.submission.payload.source !== draft.type ||
      JSON.stringify(draft.submission.payload.items) !== JSON.stringify(purchaseItems(draft.items)))) return null;
    if (draft.order && (!positive(draft.order.order_id) || typeof draft.order.total_amount !== 'string' || !Array.isArray(draft.order.items))) return null;
    return { ...draft, voucher_code: voucherCode(draft.voucher_code), items: purchaseItems(draft.items), prices: draft.prices && typeof draft.prices === 'object' && !Array.isArray(draft.prices) ? draft.prices : {} };
  } catch { return null; }
}

export function clearCheckoutDraft() {
  sessionStorage.removeItem(CHECKOUT_DRAFT_KEY);
}

function persist(draft) {
  try { sessionStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(draft)); }
  catch { throw new Error('Không lưu được bản nháp đặt hàng. Vui lòng cho phép lưu trữ trong trình duyệt.'); }
  return draft;
}

export function prepareCheckoutDraft(intent, account = null, referencePrices = {}) {
  const items = purchaseItems(intent?.items);
  if (!items || typeof intent.id !== 'string' || !['cart', 'buy-now'].includes(intent.type) || (intent.type === 'buy-now' && items.length !== 1)) throw new Error('Chưa có sản phẩm hợp lệ để đặt hàng.');
  const existing = readCheckoutDraft();
  const owner = account?.user_id ?? null;
  const keep = existing?.intent_id === intent.id && (existing.user_id === null || existing.user_id === owner);
  if (existing?.submission && !keep) throw new Error('Lần đặt hàng trước chưa có kết quả. Vui lòng quay lại trang Đặt hàng và thử lại để tránh tạo đơn trùng.');
  const shipping = keep ? { ...existing.shipping } : { recipient_name: '', phone: '', address: '', note: '' };
  if (account) {
    if (!shipping.recipient_name) shipping.recipient_name = account.full_name || '';
    if (!shipping.phone) shipping.phone = account.phone || '';
    if (!shipping.address) shipping.address = account.address || '';
  }
  const prices = {};
  for (const item of items) {
    const value = keep ? existing.prices[item.product_id] : referencePrices[item.product_id];
    if (typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value)) prices[item.product_id] = value;
  }
  return persist({ version: 1, intent_id: intent.id, type: intent.type, user_id: owner, items,
    shipping, payment_method: keep ? existing.payment_method : 'COD', prices, voucher_code: keep ? existing.voucher_code || '' : '',
    submission: keep ? existing.submission || null : null, order: keep ? existing.order || null : null });
}

// The form may update its own fields and API price references, never its purchase snapshot.
export function saveCheckoutDraft(userId, patch) {
  const draft = readCheckoutDraft(userId);
  if (!draft || (patch.intent_id && patch.intent_id !== draft.intent_id)) throw new Error('Bản nháp đặt hàng không còn thuộc phiên hiện tại. Vui lòng chọn lại sản phẩm.');
  if ((draft.submission || draft.order) && (patch.shipping || patch.payment_method || Object.hasOwn(patch, 'voucher_code'))) throw new Error('Vui lòng nhận kết quả lần đặt hàng hiện tại trước khi thay đổi thông tin.');
  const code = Object.hasOwn(patch, 'voucher_code') ? voucherCode(patch.voucher_code) : draft.voucher_code || '';
  if (code === null) throw new Error('Mã Voucher chỉ gồm 1–64 chữ cái, chữ số, dấu gạch ngang hoặc gạch dưới.');
  const shipping = { ...draft.shipping };
  for (const field of shippingFields) if (typeof patch.shipping?.[field] === 'string') shipping[field] = patch.shipping[field];
  const payment_method = ['COD', 'ONLINE'].includes(patch.payment_method) ? patch.payment_method : draft.payment_method;
  let prices = draft.prices;
  if (patch.prices && typeof patch.prices === 'object') {
    prices = {};
    for (const item of draft.items) {
      const price = patch.prices[item.product_id];
      if (typeof price === 'string' && /^\d+(?:\.\d{1,2})?$/.test(price)) prices[item.product_id] = price;
    }
  }
  return persist({ ...draft, shipping, payment_method, prices, voucher_code: code });
}

export function beginCheckoutSubmission(userId) {
  const draft = readCheckoutDraft(userId);
  if (!draft || draft.order) throw new Error('Không có lần đặt hàng mới để xác nhận.');
  if (draft.submission) return draft;
  if (Object.keys(validateShipping(draft.shipping)).length) throw new Error('Vui lòng kiểm tra lại thông tin nhận hàng.');
  const submission = {
    key: crypto.randomUUID(),
    payload: {
      source: draft.type, items: draft.items.map(item => ({ ...item })),
      recipient_name: draft.shipping.recipient_name.trim(), phone: draft.shipping.phone.trim(),
      shipping_address: draft.shipping.address.trim(), note: draft.shipping.note.trim() || null,
      payment_method: draft.payment_method,
      ...(draft.voucher_code ? { voucher_code: draft.voucher_code } : {}),
    },
  };
  // Persist before sending. A lost response/reload must reuse the exact same request and key.
  return persist({ ...draft, submission });
}

export function clearCheckoutSubmission(userId, key) {
  const draft = readCheckoutDraft(userId);
  if (!draft || draft.submission?.key !== key || draft.order) return draft;
  return persist({ ...draft, submission: null });
}

export function completeCheckoutSubmission(userId, key, order) {
  const draft = readCheckoutDraft(userId);
  if (!draft || draft.submission?.key !== key || !positive(order?.order_id) || typeof order.total_amount !== 'string' || !Array.isArray(order.items)) throw new Error('Chưa nhận được mã đơn hợp lệ. Vui lòng thử lại để kiểm tra kết quả.');
  return persist({ ...draft, submission: null, order });
}
