// Only structural UI observations leave the browser. Never copy form values,
// query text, user records, cart rows, tokens or checkout drafts into chat.
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const booleans = ['busy', 'has_draft', 'form_visible', 'locked', 'pending_submission', 'confirming',
  'products_unavailable', 'preview_error', 'storage_error', 'voucher_visible', 'voucher_selected',
  'voucher_needs_check', 'voucher_busy', 'editing', 'cancel_dialog', 'cancel_error', 'cancel_reason_valid',
  'reviewed', 'review_blocked', 'search_active', 'pet_filter_active', 'has_orders', 'preview_loading', 'submit_disabled',
  'purchase_disabled', 'quantity_disabled', 'cancel_visible', 'category_filter_visible', 'pet_filter_visible',
  'reset_visible', 'can_load_more', 'has_items', 'has_pets', 'completed', 'voucher_disabled'];
const integers = ['quantity', 'category_id', 'page'];
const enums = {
  phase: ['loading', 'ready', 'error', 'not_found'],
  sort: ['newest', 'price-asc', 'price-desc'],
  status_filter: ['', 'Chờ xử lý', 'Chờ thanh toán', 'Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng', 'Đã hủy'],
  payment_method: ['COD', 'ONLINE'],
};

export function customerChatRoute(pathname) {
  if (typeof pathname !== 'string' || pathname.length > 160) return null;
  const route = pathname.replace(/\/+$/, '') || '/';
  if (['/', '/products', '/cart', '/checkout', '/login', '/register', '/profile', '/my-orders', '/my-pets', '/wishlist'].includes(route)) return route;
  const match = route.match(/^\/(?:products\/([1-9]\d*)(?:\/reviews)?|my-orders\/([1-9]\d*)(?:\/review\/([1-9]\d*))?|my-pets\/([1-9]\d*))$/);
  return match && match.slice(1).filter(Boolean).every(id => positive(Number(id))) ? route : null;
}

export function sanitizeChatPageState(state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  const safe = {};
  for (const key of booleans) if (typeof state[key] === 'boolean') safe[key] = state[key];
  for (const key of integers) if (positive(state[key])) safe[key] = state[key];
  for (const [key, values] of Object.entries(enums)) if (values.includes(state[key])) safe[key] = state[key];
  if (Array.isArray(state.shipping_invalid)) safe.shipping_invalid = [...new Set(state.shipping_invalid
    .filter(key => ['recipient_name', 'phone', 'address', 'note'].includes(key)))];
  return safe;
}

export function buildChatPageContext(commerce, observation, pathname) {
  const route = customerChatRoute(pathname);
  if (!route || commerce.user?.role === 'admin') return undefined;
  const items = commerce.cart?.items || [];
  const selected = items.filter(item => item.selected && item.available === true && positive(Number(item.quantity)) && Number(item.quantity) <= Number(item.stock_quantity));
  return { version: 1, route,
    cart: { item_count: items.length, selected_count: selected.length, loading: Boolean(commerce.cartLoading),
      selectable_count: items.filter(item => item.available === true && positive(Number(item.quantity)) && Number(item.quantity) <= Number(item.stock_quantity)).length,
      editable_quantity_count: items.filter(item => item.status === 'Đang bán' && Number.isInteger(Number(item.stock_quantity)) && Number(item.stock_quantity) > 0).length,
      error: Boolean(commerce.cartError), busy: Boolean(commerce.busy || commerce.authLoading),
      merging: commerce.cartSource === 'guest-merge', merge_can_edit: Boolean(commerce.mergeCanEdit) },
    state: observation?.route === route && observation.owner === (commerce.user?.user_id ?? null)
      ? sanitizeChatPageState(observation.state) : route === '/cart'
        ? { phase: commerce.authLoading || commerce.cartLoading ? 'loading' : commerce.cartError ? 'error' : 'ready' } : {},
  };
}
