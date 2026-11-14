import { readCheckoutDraft } from './checkout.js';

export const AUTH_REDIRECT_KEY = 'petcare.auth-redirect.v1';
const FLOW_LIFETIME = 30 * 60 * 1000;

// These are the implemented public destinations. Auth pages cannot return to themselves.
export function safeReturnUrl(value, fallback = '/') {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || /%2f|%5c/i.test(url.pathname)) return fallback;
    if (!['/', '/products', '/cart', '/checkout', '/my-orders', '/wishlist', '/profile', '/admin/orders', '/admin/products', '/admin/categories', '/admin/users', '/admin/vouchers'].includes(url.pathname) && !/^\/(?:products|my-orders|admin\/orders)\/[1-9]\d*$/.test(url.pathname) && !/^\/products\/[1-9]\d*\/reviews$/.test(url.pathname) && !/^\/my-orders\/[1-9]\d*\/review\/[1-9]\d*$/.test(url.pathname)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}

export function loginReturnUrl(value, role) {
  const destination = safeReturnUrl(value);
  const path = destination.split(/[?#]/, 1)[0];
  const adminPage = path.startsWith('/admin/');
  if (role === 'admin') return adminPage || path === '/profile' ? destination : '/admin/orders';
  return adminPage ? '/' : destination;
}

export function activeAuthRedirect() {
  try {
    const flow = JSON.parse(sessionStorage.getItem(AUTH_REDIRECT_KEY) || 'null');
    const id = new URLSearchParams(window.location.search).get('flow');
    if (!id || !flow || flow.version !== 1 || flow.id !== id || flow.type !== 'purchase' || typeof flow.intent_id !== 'string') return null;
    if (!Number.isFinite(flow.created_at) || Date.now() < flow.created_at || Date.now() - flow.created_at > FLOW_LIFETIME) return null;
    if (!['/cart', '/checkout'].includes(safeReturnUrl(flow.return_to, ''))) return null;
    return flow;
  } catch { return null; }
}

export function clearAuthRedirect(id) {
  if (id && activeAuthRedirect()?.id !== id) return;
  sessionStorage.removeItem(AUTH_REDIRECT_KEY);
}

export function purchaseLoginUrl(intentId) {
  const flow = { version: 1, id: crypto.randomUUID(), type: 'purchase', intent_id: intentId, return_to: '/checkout', created_at: Date.now() };
  sessionStorage.setItem(AUTH_REDIRECT_KEY, JSON.stringify(flow));
  return `/login?flow=${encodeURIComponent(flow.id)}`;
}

export function authPageUrl(path, { registered = false } = {}) {
  const params = new URLSearchParams();
  let flow = activeAuthRedirect();
  if (!flow) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(AUTH_REDIRECT_KEY) || 'null');
      const id = new URLSearchParams(window.location.search).get('flow');
      // Keep the matching purchase context when switching auth forms after its
      // navigation TTL. login() renews it before resuming the saved purchase.
      if (saved?.version === 1 && saved.type === 'purchase' && saved.id === id &&
        saved.intent_id === readCheckoutDraft()?.intent_id && safeReturnUrl(saved.return_to, '') === '/checkout') flow = saved;
    } catch { /* Invalid contexts fall back to a normal login. */ }
  }
  if (flow) params.set('flow', flow.id);
  else {
    const current = new URLSearchParams(window.location.search);
    const returnTo = safeReturnUrl(current.get('returnTo'), '');
    if (returnTo) {
      params.set('returnTo', returnTo);
      if (current.get('from') === 'wishlist') params.set('from', 'wishlist');
    }
  }
  if (registered) params.set('registered', '1');
  return `${path}${params.size ? `?${params}` : ''}`;
}
