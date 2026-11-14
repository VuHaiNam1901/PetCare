import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { commerceApi as sendCommerceApi } from '../services/commerce.js';
import * as adminProductsApi from '../services/admin-products.js';
import * as adminCategoriesApi from '../services/admin-categories.js';
import * as adminUsersApi from '../services/admin-users.js';
import * as profileApi from '../services/profile.js';
import * as reviewsApi from '../services/reviews.js';
import * as paymentsApi from '../services/payments.js';
import * as vouchersApi from '../services/vouchers.js';
import { AUTH_REDIRECT_KEY, activeAuthRedirect, authPageUrl, clearAuthRedirect, loginReturnUrl, purchaseLoginUrl, safeReturnUrl } from '../utils/auth-navigation.js';
import { clearCheckoutDraft, prepareCheckoutDraft, readCheckoutDraft } from '../utils/checkout.js';

export const GUEST_KEY = 'petcare.guest-cart.v1';
export const MERGE_KEY = 'petcare.guest-merge.v1';
export const INTENT_KEY = 'petcare.checkout-intent.v1';
export const TOKEN_KEY = 'petcare.auth.token.v1';
const FLASH_KEY = 'petcare.flash.v1';
const emptyCart = () => ({ cart_id: null, items: [], total_quantity: 0, subtotal: '0.00', selected_subtotal: '0.00', selected_quantity: 0, selected_count: 0 });
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const canonical = items => [...items].map(({ product_id, quantity, selected }) => ({ product_id, quantity, selected: Boolean(selected) })).sort((a, b) => a.product_id - b.product_id);
const sameItems = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const Context = createContext(null);

function loadGuest() {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return { items: [], error: '' };
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.items) || data.items.length > 100 || data.items.some(item => !positive(item.product_id) || !positive(item.quantity) || typeof item.selected !== 'boolean') || new Set(data.items.map(item => item.product_id)).size !== data.items.length) throw new Error();
    return { items: canonical(data.items), error: '' };
  } catch { return { items: [], error: 'Không đọc được giỏ khách đã lưu. Dữ liệu cũ vẫn được giữ trong trình duyệt; vui lòng kiểm tra quyền lưu trữ.' }; }
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

export function CommerceProvider({ children }) {
  const initial = useRef(null);
  if (!initial.current) initial.current = loadGuest();
  const guestRef = useRef(initial.current.items);
  const tokenRef = useRef(null);
  const userRef = useRef(null);
  const cartRef = useRef(emptyCart());
  const sourceRef = useRef('guest');
  const epoch = useRef(0);
  const profileRevision = useRef(0);
  const profileSaving = useRef(false);
  const busyRef = useRef(false);
  const mergeRef = useRef({ pending: false, canEdit: true });
  const checkoutRedirectRef = useRef(false);
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [cart, setCart] = useState(emptyCart);
  const [cartSource, setCartSource] = useState('guest');
  const [cartLoading, setCartLoading] = useState(true);
  const [cartError, setCartError] = useState(initial.current.error);
  const [busy, setBusy] = useState(false);
  const [mergeError, setMergeError] = useState('');
  const [mergeConflicts, setMergeConflicts] = useState([]);
  const [mergeCanEdit, setMergeCanEdit] = useState(true);
  const [pendingIntent, setPendingIntent] = useState(() => {
    const flow = activeAuthRedirect();
    const intent = readJson(INTENT_KEY);
    return flow && intent?.id === flow.intent_id && !intent.authenticated ? intent : null;
  });
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState('info');

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [notice, noticeType]);

  const notify = (message, type = 'info') => { setNoticeType(type); setNotice(message); };
  const current = generation => { if (epoch.current !== generation) throw Object.assign(new Error('Phiên làm việc đã thay đổi.'), { obsolete: true }); };
  async function commerceApi(path, options) {
    const generation = epoch.current;
    try { const result = await sendCommerceApi(path, options); current(generation); return result; }
    catch (error) { current(generation); throw error; }
  }
  const displayCart = value => { cartRef.current = value; setCart(value); };
  const source = value => { sourceRef.current = value; setCartSource(value); };
  function setMerge(pending, message = '', conflicts = [], canEdit = true) {
    mergeRef.current = { pending, canEdit };
    setMergeError(message); setMergeConflicts(conflicts); setMergeCanEdit(canEdit);
  }
  function saveIntent(intent) {
    try { localStorage.setItem(INTENT_KEY, JSON.stringify(intent)); }
    catch { throw new Error('Không lưu được ý định đặt hàng. Vui lòng cho phép lưu trữ trong trình duyệt.'); }
    setPendingIntent(intent);
  }
  function beginLogin() {
    clearAuthRedirect();
    // An unknown COMMIT result must keep its replay key, including across logout
    // or an ordinary Header login. It remains bound to the original account.
    if (readCheckoutDraft()?.submission) return;
    clearCheckoutDraft();
    localStorage.removeItem(INTENT_KEY); setPendingIntent(null);
  }
  function navigateAfterLogin(destination, message, type = 'info') {
    if (message) sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, type }));
    window.location.replace(safeReturnUrl(destination));
  }
  function purchaseIntent(flow) {
    if (!flow) return null;
    const draft = readCheckoutDraft();
    if (draft?.intent_id === flow.intent_id && (draft.user_id === null || draft.user_id === userRef.current?.user_id)) {
      return { version: 1, id: draft.intent_id, type: draft.type, items: draft.items,
        product_ids: draft.items.map(item => item.product_id), authenticated: false, created_at: Date.now(),
        ...(draft.type === 'buy-now' ? { product_id: draft.items[0].product_id, quantity: draft.items[0].quantity } : {}) };
    }
    return readJson(INTENT_KEY);
  }
  function persistGuest(items) {
    try { localStorage.setItem(GUEST_KEY, JSON.stringify({ version: 1, items: canonical(items) })); }
    catch { throw new Error('Không lưu được giỏ hàng. Vui lòng cho phép lưu trữ trong trình duyệt.'); }
    guestRef.current = canonical(items);
  }
  async function preview(items) {
    return (await commerceApi('/api/cart/preview', { method: 'POST', body: { items: canonical(items) } })).cart;
  }
  function checkCustomer() {
    if (userRef.current?.role === 'admin') throw new Error('Giỏ hàng dành cho tài khoản khách hàng. Vui lòng đăng xuất và đăng nhập tài khoản User.');
    if (mergeRef.current.pending) throw new Error('Giỏ khách chưa đồng bộ xong. Vui lòng mở Giỏ hàng và thử đồng bộ lại trước khi tiếp tục.');
  }
  async function expireSession(error) {
    if (!tokenRef.current || ![401, 403].includes(error.status)) return;
    epoch.current++; tokenRef.current = null; userRef.current = null;
    sessionStorage.removeItem(TOKEN_KEY); setUser(null); displayCart(emptyCart());
    if (readJson(MERGE_KEY)) { source('guest-merge'); setMerge(true, 'Phiên đã hết hạn khi giỏ khách chưa được xác nhận hợp nhất. Đăng nhập lại để tiếp tục.', [], false); }
    else { source('guest'); setMerge(false); }
    notify('Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại; giỏ tài khoản vẫn được giữ trên máy chủ.');
    try { displayCart(await preview(guestRef.current)); } catch { setCartError('Chưa tải được giỏ khách. Vui lòng thử lại.'); }
  }
  async function withGuestLock(action) {
    const run = async () => {
      const stored = loadGuest();
      if (stored.error) throw new Error(stored.error);
      guestRef.current = stored.items;
      if (readJson(MERGE_KEY) && !mergeRef.current.pending) {
        source('guest-merge'); setMerge(true, 'Giỏ khách đang chờ xác nhận hợp nhất. Vui lòng thử đồng bộ lại trước khi chỉnh sửa.', [], false);
      }
      return action();
    };
    // Serialize guest edits and merges across tabs on browsers supporting Web Locks.
    return navigator.locks ? navigator.locks.request('petcare.guest-cart', run) : run();
  }
  async function operation(action) {
    if (authLoading || busyRef.current) throw new Error('Đang xử lý giỏ hàng. Vui lòng chờ một chút.');
    busyRef.current = true; setBusy(true);
    try { return await withGuestLock(action); }
    catch (error) { await expireSession(error); throw error; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function refreshCart() {
    const generation = epoch.current;
    const account = userRef.current;
    const next = account?.role === 'admin' ? emptyCart() : account && !mergeRef.current.pending
      ? (await commerceApi('/api/cart', { token: tokenRef.current })).cart
      : await preview(guestRef.current);
    current(generation); displayCart(next); setCartError(''); return next;
  }
  async function finishIntent(account, flow) {
    try {
      const intent = purchaseIntent(flow);
      if (!flow || activeAuthRedirect()?.id !== flow.id || !intent || intent.version !== 1 || intent.id !== flow.intent_id || intent.authenticated || account.role !== 'user') return false;
      if (intent.type === 'cart') {
        const ids = Array.isArray(intent.product_ids) ? intent.product_ids : [];
        const selected = cartRef.current.items.filter(item => ids.includes(item.product_id));
        if (!ids.length || ids.some(id => !positive(id)) || new Set(ids).size !== ids.length || !Array.isArray(intent.items) || intent.items.length !== ids.length || intent.items.some(item => !ids.includes(item.product_id))) return false;
        if (selected.length === ids.length && selected.every(item => item.available)) {
          try {
            const result = await commerceApi('/api/cart/selection', { method: 'PUT', token: tokenRef.current, body: { product_ids: ids } });
            displayCart(result.cart);
          } catch (error) {
            // Catalog changes belong in the checkout review; retain every requested item.
            if (![404, 409].includes(error.status)) throw error;
          }
        }
      } else if (intent.type === 'buy-now') {
        if (!positive(intent.product_id) || !positive(intent.quantity) || intent.items?.length !== 1 || intent.items[0].product_id !== intent.product_id || intent.items[0].quantity !== intent.quantity) return false;
      } else return false;
      if (activeAuthRedirect()?.id !== flow.id || purchaseIntent(flow)?.id !== intent.id) return false;
      // Keep the purchase payload separate from the single-use navigation context.
      const { return_to, ...purchase } = intent;
      const ready = { ...purchase, authenticated: true, user_id: account.user_id };
      prepareCheckoutDraft(ready, account);
      saveIntent(ready);
      clearAuthRedirect(flow.id);
      return true;
    } catch (error) {
      if (error.obsolete || [401, 403].includes(error.status)) throw error;
      notify(error.message);
      return false;
    }
  }
  async function continuePurchase(account, synchronized) {
    const flow = activeAuthRedirect();
    if (!flow || account.role !== 'user') return false;
    const pending = purchaseIntent(flow);
    if (!pending || pending.version !== 1 || pending.id !== flow.intent_id || pending.authenticated) {
      clearAuthRedirect(flow.id); setPendingIntent(null);
      return false;
    }
    if (synchronized && await finishIntent(account, flow)) {
      navigateAfterLogin('/checkout', 'Vui lòng kiểm tra sản phẩm và thông tin nhận hàng trước khi xác nhận.');
    } else if (window.location.pathname !== '/cart') {
      navigateAfterLogin(`/cart?flow=${encodeURIComponent(flow.id)}`, 'Giỏ khách chưa đồng bộ xong hoặc lựa chọn cần kiểm tra. Vui lòng kiểm tra giỏ hàng và thử lại.');
    }
    return true;
  }
  async function synchronize(account, generation = epoch.current, { readOnly = false } = {}) {
    if (account.role !== 'user') { source('account'); displayCart(emptyCart()); return true; }
    if (readOnly) {
      // Viewing order history must not merge/clear a guest cart as a side effect.
      // Full navigation to Cart, login and explicit merge retries keep their normal flow.
      const pending = Boolean(guestRef.current.length || loadGuest().items.length || readJson(MERGE_KEY));
      setMerge(pending, pending ? 'Giỏ khách vẫn được giữ nguyên. Mở Giỏ hàng để tiếp tục đồng bộ.' : '', [], !readJson(MERGE_KEY));
      source('account');
      const next = (await commerceApi('/api/cart', { token: tokenRef.current })).cart;
      current(generation); displayCart(next); setCartError(''); return true;
    }
    let marker = readJson(MERGE_KEY);
    if (guestRef.current.length || marker) {
      source('guest-merge'); setMerge(true, '', [], false);
      if (marker && marker.user_id !== account.user_id) {
        setMerge(true, 'Lần hợp nhất trước chưa được xác nhận. Vui lòng đăng nhập lại đúng tài khoản đã bắt đầu hợp nhất để tránh cộng hàng hai lần.', [], false);
        displayCart(await preview(guestRef.current)); return false;
      }
      if (!marker) {
        marker = { key: crypto.randomUUID(), user_id: account.user_id, items: canonical(guestRef.current) };
        localStorage.setItem(MERGE_KEY, JSON.stringify(marker));
      }
      try {
        const result = await commerceApi('/api/cart/merge', { method: 'POST', token: tokenRef.current, headers: { 'Idempotency-Key': marker.key }, body: { items: marker.items } });
        current(generation);
        // Keep the exact request/key until both the server and local cleanup confirm.
        const storedGuest = loadGuest();
        if (storedGuest.error || (!sameItems(storedGuest.items, marker.items) && storedGuest.items.length)) {
          if (!storedGuest.error) guestRef.current = storedGuest.items;
          throw new Error('Giỏ khách đã thay đổi ở cửa sổ khác. Lần hợp nhất cũ đã được xác nhận nhưng dữ liệu mới được giữ nguyên để kiểm tra, chưa tiếp tục đặt hàng.');
        }
        persistGuest([]); localStorage.removeItem(MERGE_KEY);
        setMerge(false); source('account'); displayCart(result.cart); setCartError('');
        return true;
      } catch (error) {
        current(generation);
        if (error.obsolete || [401, 403].includes(error.status)) throw error;
        const canEdit = Boolean(error.conflicts?.length) || error.status === 400;
        if (canEdit) localStorage.removeItem(MERGE_KEY);
        setMerge(true, error.message, error.conflicts || [], canEdit);
        try { displayCart(await preview(guestRef.current)); } catch { setCartError('Chưa tải được thông tin giỏ khách. Vui lòng thử lại.'); }
        return false;
      }
    }
    source('account'); setMerge(false);
    const next = (await commerceApi('/api/cart', { token: tokenRef.current })).cart;
    current(generation); displayCart(next); setCartError(''); return true;
  }

  useEffect(() => {
    const generation = ++epoch.current;
    let alive = true;
    busyRef.current = true; setBusy(true);
    (async () => {
      try {
        const flash = sessionStorage.getItem(FLASH_KEY);
        if (flash) {
          let saved;
          try { saved = JSON.parse(flash); } catch { /* Older pages store plain text. */ }
          notify(typeof saved?.message === 'string' ? saved.message : flash, saved?.type === 'success' ? 'success' : 'info');
          sessionStorage.removeItem(FLASH_KEY);
        }
        const token = sessionStorage.getItem(TOKEN_KEY);
        if (token) {
          tokenRef.current = token;
          const result = await commerceApi('/api/auth/me', { token }); current(generation);
          userRef.current = result.user; setUser(result.user);
          const path = window.location.pathname.replace(/\/+$/, '');
          if (path === '/wishlist' || path === '/my-orders' || path.startsWith('/my-orders/') || path === '/admin/orders' || path.startsWith('/admin/orders/') || path === '/admin/products' || path === '/admin/categories' || path === '/admin/users' || path === '/admin/vouchers' || path === '/profile') {
            await synchronize(result.user, generation, { readOnly: true });
          } else {
            await withGuestLock(async () => {
              const synchronized = await synchronize(result.user, generation);
              await continuePurchase(result.user, synchronized);
            });
          }
        } else {
          const marker = readJson(MERGE_KEY);
          if (marker) { source('guest-merge'); setMerge(true, 'Giỏ khách đang chờ xác nhận hợp nhất. Đăng nhập lại để tiếp tục, dữ liệu vẫn được giữ nguyên.', [], false); }
          if (initial.current.error) throw new Error(initial.current.error);
          const next = await preview(guestRef.current); current(generation); displayCart(next);
        }
      } catch (error) {
        if (!alive || error.obsolete) return;
        await expireSession(error);
        if (![401, 403].includes(error.status)) setCartError(error.message);
      } finally {
        if (alive && epoch.current === generation) { setAuthLoading(false); setCartLoading(false); busyRef.current = false; setBusy(false); }
        else if (alive && !tokenRef.current) { setAuthLoading(false); setCartLoading(false); busyRef.current = false; setBusy(false); }
      }
    })();
    return () => { alive = false; epoch.current++; };
  }, []);

  async function editGuest(next) {
    if (mergeRef.current.pending && !mergeRef.current.canEdit) throw new Error('Cần xác nhận lần hợp nhất trước bằng Thử đồng bộ lại trước khi sửa giỏ.');
    persistGuest(next); localStorage.removeItem(MERGE_KEY);
    if (mergeRef.current.pending) setMerge(true, 'Đã lưu điều chỉnh giỏ khách. Nhấn Thử đồng bộ lại để tiếp tục.', [], true);
    const flow = activeAuthRedirect();
    const intent = flow ? purchaseIntent(flow) : readJson(INTENT_KEY);
    if (intent?.type === 'cart' && !intent.authenticated) {
      const chosen = next.filter(item => item.selected);
      const updated = { ...intent, product_ids: chosen.map(item => item.product_id), items: chosen.map(({ product_id, quantity }) => ({ product_id, quantity })) };
      saveIntent(updated);
      if (readCheckoutDraft()?.intent_id === intent.id) {
        if (chosen.length) prepareCheckoutDraft(updated, userRef.current);
        else { clearCheckoutDraft(); clearAuthRedirect(); localStorage.removeItem(INTENT_KEY); setPendingIntent(null); }
      }
    }
    displayCart(await preview(next)); setCartError('');
  }
  async function addItem(productId, quantity = 1) {
    return operation(async () => {
      checkCustomer();
      if (!positive(productId) || !positive(quantity)) throw new Error('Số lượng phải là số nguyên dương.');
      if (userRef.current) {
        const result = await commerceApi('/api/cart/items', { method: 'POST', token: tokenRef.current, body: { product_id: productId, quantity } });
        displayCart(result.cart); setCartError('');
      } else {
        const next = canonical(guestRef.current);
        const existing = next.find(item => item.product_id === productId);
        if (existing) existing.quantity += quantity; else next.push({ product_id: productId, quantity, selected: false });
        if (next.length > 100 || next.some(item => !positive(item.quantity))) throw new Error('Giỏ hàng vượt giới hạn số sản phẩm hoặc số lượng.');
        const fresh = await preview(next);
        const added = fresh.items.find(item => item.product_id === productId);
        if (!added?.available) throw new Error(added?.availability_message || 'Sản phẩm không thể thêm vào giỏ.');
        persistGuest(next); displayCart(fresh); setCartError('');
      }
      notify('Đã thêm sản phẩm vào giỏ hàng.');
    });
  }
  async function updateItem(productId, quantity) {
    return operation(async () => {
      if (!positive(quantity)) throw new Error('Số lượng phải là số nguyên dương.');
      if (sourceRef.current !== 'account') {
        const next = guestRef.current.map(item => item.product_id === productId ? { ...item, quantity } : item);
        const fresh = await preview(next); const item = fresh.items.find(row => row.product_id === productId);
        if (!item?.available) throw new Error(item?.availability_message || 'Số lượng không hợp lệ.');
        await editGuest(next);
      } else {
        checkCustomer(); const item = cartRef.current.items.find(row => row.product_id === productId);
        if (!item) throw new Error('Không tìm thấy sản phẩm trong giỏ.');
        displayCart((await commerceApi(`/api/cart/items/${item.cart_item_id}`, { method: 'PUT', token: tokenRef.current, body: { quantity } })).cart);
      }
    });
  }
  async function removeItem(productId) {
    return operation(async () => {
      if (sourceRef.current !== 'account') await editGuest(guestRef.current.filter(item => item.product_id !== productId));
      else {
        checkCustomer(); const item = cartRef.current.items.find(row => row.product_id === productId);
        if (!item) throw new Error('Không tìm thấy sản phẩm trong giỏ.');
        displayCart((await commerceApi(`/api/cart/items/${item.cart_item_id}`, { method: 'DELETE', token: tokenRef.current })).cart);
      }
    });
  }
  async function changeSelection(ids) {
    if (authLoading || busyRef.current) throw new Error('Đang xử lý giỏ hàng. Vui lòng chờ một chút.');
    const previous = cartRef.current;
    if (previous.items.some(item => ids.includes(item.product_id) && !item.available)) throw new Error('Có sản phẩm không còn đủ hàng để chọn đặt hàng.');
    // Reflect the event before waiting for the cross-tab lock or server validation.
    displayCart({ ...previous, selected_subtotal: null, items: previous.items.map(item => ({ ...item, selected: item.available && ids.includes(item.product_id) })) });
    try {
      return await operation(async () => {
        if (sourceRef.current !== 'account') await editGuest(guestRef.current.map(item => ({ ...item, selected: ids.includes(item.product_id) })));
        else { checkCustomer(); displayCart((await commerceApi('/api/cart/selection', { method: 'PUT', token: tokenRef.current, body: { product_ids: ids } })).cart); }
      });
    } catch (error) { if (!error.obsolete) displayCart(previous); throw error; }
  }
  const selectItem = (productId, selected) => changeSelection([...new Set([...cartRef.current.items.filter(item => item.selected && item.product_id !== productId).map(item => item.product_id), ...(selected ? [productId] : [])])]);
  const selectAll = selected => changeSelection(selected ? cartRef.current.items.filter(item => item.available).map(item => item.product_id) : []);
  async function retryCart() {
    return operation(async () => { setCartLoading(true); try { await refreshCart(); if (userRef.current && !mergeRef.current.pending) await continuePurchase(userRef.current, true); } catch (error) { setCartError(error.message); throw error; } finally { setCartLoading(false); } });
  }
  async function retryMerge() {
    if (!userRef.current) { window.location.assign(authPageUrl('/login')); return; }
    return operation(async () => {
      const ok = await synchronize(userRef.current);
      if (ok && !await continuePurchase(userRef.current, true)) notify('Đã đồng bộ giỏ hàng.');
    });
  }
  async function login(credentials) {
    return operation(async () => {
      let flow = activeAuthRedirect();
      const returnTo = safeReturnUrl(new URLSearchParams(window.location.search).get('returnTo'));
      const returnPath = returnTo.split(/[?#]/, 1)[0];
      const explicitAccountReturn = /^\/(?:my-orders|wishlist|admin)(?:\/|$)/.test(returnPath) || returnPath === '/profile';
      const wishlistReturn = new URLSearchParams(window.location.search).get('from') === 'wishlist';
      const saved = readCheckoutDraft();
      let oldFlow;
      try { oldFlow = JSON.parse(sessionStorage.getItem(AUTH_REDIRECT_KEY) || 'null'); } catch { oldFlow = null; }
      const urlFlow = new URLSearchParams(window.location.search).get('flow');
      const expiredPurchase = oldFlow?.version === 1 && oldFlow.type === 'purchase' && oldFlow.id === urlFlow && oldFlow.intent_id === saved?.intent_id;
      if (!flow && !explicitAccountReturn && !wishlistReturn && saved && (saved.submission || expiredPurchase)) {
        // Renew an expired navigation context without discarding purchase data.
        window.history.replaceState(null, '', purchaseLoginUrl(saved.intent_id));
        flow = activeAuthRedirect();
      }
      if (!flow) beginLogin();
      const result = await commerceApi('/api/auth/login', { method: 'POST', body: credentials });
      sessionStorage.setItem(TOKEN_KEY, result.token); tokenRef.current = result.token; userRef.current = result.user; setUser(result.user);
      let synchronized = false;
      try { synchronized = await synchronize(result.user); }
      catch (error) {
        if (error.obsolete || [401, 403].includes(error.status)) throw error;
        setCartError(error.message);
      }
      if (result.user.role === 'admin') {
        beginLogin();
        navigateAfterLogin(loginReturnUrl(returnTo, result.user.role), 'Đã đăng nhập quản trị viên.', 'success');
      } else if (!await continuePurchase(result.user, synchronized)) {
        navigateAfterLogin(loginReturnUrl(returnTo, result.user.role), synchronized ? 'Đã đăng nhập.' : 'Đã đăng nhập. Giỏ khách chưa đồng bộ; mở Giỏ hàng để kiểm tra và thử lại.', 'success');
      }
      return result.user;
    });
  }
  const register = data => operation(async () => (await commerceApi('/api/auth/register', { method: 'POST', body: data })).user);
  async function readAccountOrder(path, signal, options = {}, assertSession) {
    // Order history does not depend on cart edits or an outstanding cart merge.
    if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập để xem đơn hàng.'), { status: 401 });
    if (userRef.current.role !== 'user') throw Object.assign(new Error('Đơn hàng của tôi dành cho tài khoản khách hàng.'), { status: 403 });
    assertSession?.();
    try {
      const result = await commerceApi(path, { ...options, token: tokenRef.current, signal });
      assertSession?.();
      return result;
    }
    catch (error) {
      assertSession?.();
      if (!error.obsolete && !signal?.aborted) await expireSession(error);
      throw error;
    }
  }
  async function getOrders({ page = 1, status = '', signal } = {}) {
    const params = new URLSearchParams({ page: String(page), limit: '10' });
    if (status) params.set('status', status);
    return readAccountOrder(`/api/orders?${params}`, signal);
  }
  function orderPath(orderId) {
    const id = Number(orderId);
    if (!positive(id)) throw Object.assign(new Error('Mã đơn hàng không hợp lệ.'), { status: 400 });
    return `/api/orders/${id}`;
  }
  const getOrder = (orderId, { signal } = {}) => readAccountOrder(orderPath(orderId), signal);
  const getOrderPayment = (orderId, { signal } = {}) => readAccountOrder(`${orderPath(orderId)}/payment`, signal);
  const assertWishlistSession = () => {
    if (sessionStorage.getItem(TOKEN_KEY) !== tokenRef.current) throw Object.assign(new Error('Phiên làm việc đã thay đổi.'), { obsolete: true });
  };
  const getWishlist = ({ signal } = {}) => readAccountOrder('/api/wishlist', signal, {}, assertWishlistSession);
  const saveWishlistProduct = (productId, selected) => {
    if (!positive(productId)) throw new Error('Mã sản phẩm không hợp lệ.');
    return readAccountOrder(`/api/wishlist/${productId}`, undefined, { method: selected ? 'PUT' : 'DELETE' }, assertWishlistSession);
  };
  const cancelOrder = (orderId, body) => readAccountOrder(`${orderPath(orderId)}/cancel`, undefined, { method: 'POST', body });
  async function adminOrderRequest(path, options = {}) {
    if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập để quản lý đơn hàng.'), { status: 401 });
    if (userRef.current.role !== 'admin') throw Object.assign(new Error('Chỉ quản trị viên được quản lý đơn hàng.'), { status: 403 });
    try { return await commerceApi(path, { ...options, token: tokenRef.current }); }
    catch (error) {
      if (!error.obsolete && !options.signal?.aborted) await expireSession(error);
      throw error;
    }
  }
  async function getAdminOrders({ page = 1, status = '', q = '', approval = '', signal } = {}) {
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (status) params.set('status', status);
    if (q.trim()) params.set('q', q.trim());
    if (approval) params.set('approval', approval);
    return adminOrderRequest(`/api/admin/orders?${params}`, { signal });
  }
  const adminOrderPath = orderId => `/api/admin${orderPath(orderId).slice(4)}`;
  const getAdminOrder = (orderId, { signal } = {}) => adminOrderRequest(adminOrderPath(orderId), { signal });
  const approveAdminOrder = orderId => adminOrderRequest(`${adminOrderPath(orderId)}/approve`, { method: 'PATCH', body: {} });
  const rejectAdminOrder = (orderId, reason) => adminOrderRequest(`${adminOrderPath(orderId)}/reject`, { method: 'PATCH', body: { reason } });
  const updateAdminOrder = (orderId, status, codPaymentReceived) => adminOrderRequest(`${adminOrderPath(orderId)}/status`, {
    method: 'PATCH', body: { status, ...(codPaymentReceived === undefined ? {} : { cod_payment_received: codPaymentReceived }) },
  });
  async function adminProductRequest(action, { signal } = {}) {
    if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập để quản lý sản phẩm.'), { status: 401 });
    if (userRef.current.role !== 'admin') throw Object.assign(new Error('Chỉ quản trị viên được quản lý sản phẩm.'), { status: 403 });
    const generation = epoch.current;
    try {
      const result = await action(tokenRef.current);
      current(generation);
      return result;
    } catch (error) {
      current(generation);
      if (!error.obsolete && !signal?.aborted) await expireSession(error);
      throw error;
    }
  }
  const getAdminProducts = (options = {}) => adminProductRequest(token => adminProductsApi.getAdminProducts(token, options), options);
  const getAdminProductCategories = (options = {}) => adminProductRequest(token => adminProductsApi.getAdminProductCategories(token, options), options);
  const getAdminPetTypes = (options = {}) => adminProductRequest(token => adminProductsApi.getAdminPetTypes(token, options), options);
  const createAdminProduct = body => adminProductRequest(token => adminProductsApi.createAdminProduct(token, body));
  const updateAdminProduct = (productId, body) => adminProductRequest(token => adminProductsApi.updateAdminProduct(token, productId, body));
  const stopAdminProduct = productId => adminProductRequest(token => adminProductsApi.stopAdminProduct(token, productId));
  async function adminCategoryRequest(action, { signal } = {}) {
    if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập để quản lý danh mục.'), { status: 401 });
    if (userRef.current.role !== 'admin') throw Object.assign(new Error('Chỉ quản trị viên được quản lý danh mục.'), { status: 403 });
    const generation = epoch.current;
    try {
      const result = await action(tokenRef.current);
      current(generation);
      return result;
    } catch (error) {
      current(generation);
      if (!error.obsolete && !signal?.aborted) await expireSession(error);
      throw error;
    }
  }
  const getAdminCategories = (options = {}) => adminCategoryRequest(token => adminCategoriesApi.getAdminCategories(token, options), options);
  const createAdminCategory = body => adminCategoryRequest(token => adminCategoriesApi.createAdminCategory(token, body));
  const updateAdminCategory = (categoryId, body) => adminCategoryRequest(token => adminCategoriesApi.updateAdminCategory(token, categoryId, body));
  const deleteAdminCategory = categoryId => adminCategoryRequest(token => adminCategoriesApi.deleteAdminCategory(token, categoryId));
  async function adminUserRequest(action, { signal } = {}) {
    if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập để quản lý người dùng.'), { status: 401 });
    if (userRef.current.role !== 'admin') throw Object.assign(new Error('Chỉ quản trị viên được quản lý người dùng.'), { status: 403 });
    const generation = epoch.current;
    try {
      const result = await action(tokenRef.current);
      current(generation);
      return result;
    } catch (error) {
      current(generation);
      if (!error.obsolete && !signal?.aborted) await expireSession(error);
      throw error;
    }
  }
  const getAdminUsers = (options = {}) => adminUserRequest(token => adminUsersApi.getAdminUsers(token, options), options);
  const updateAdminUserStatus = (userId, status) => adminUserRequest(token => adminUsersApi.updateAdminUserStatus(token, userId, status));
  async function voucherRequest(role, action, { signal } = {}) {
    if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập để sử dụng Voucher.'), { status: 401 });
    if (userRef.current.role !== role) throw Object.assign(new Error('Tài khoản không có quyền thực hiện thao tác Voucher này.'), { status: 403 });
    const generation = epoch.current;
    try {
      const result = await action(tokenRef.current);
      current(generation);
      if (signal?.aborted) throw Object.assign(new Error('Yêu cầu đã được hủy.'), { name: 'AbortError' });
      return result;
    } catch (error) {
      current(generation);
      if (!error.obsolete && !signal?.aborted) await expireSession(error);
      throw error;
    }
  }
  const quoteCheckoutVoucher = (input, options = {}) => voucherRequest('user', token => vouchersApi.quoteVoucher(token, input, options), options);
  const getCheckoutVouchers = (options = {}) => voucherRequest('user', token => vouchersApi.listCustomerVouchers(token, options), options);
  const getAdminVouchers = (options = {}) => voucherRequest('admin', token => vouchersApi.listVouchers(token, options), options);
  const getAdminVoucher = (id, options = {}) => voucherRequest('admin', token => vouchersApi.getVoucher(token, id, options), options);
  const createAdminVoucher = body => voucherRequest('admin', token => vouchersApi.createVoucher(token, body));
  const updateAdminVoucher = (id, body) => voucherRequest('admin', token => vouchersApi.updateVoucher(token, id, body));
  const disableAdminVoucher = id => voucherRequest('admin', token => vouchersApi.disableVoucher(token, id));
  async function accountProfileRequest(action, { signal, revision } = {}) {
    if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập để xem thông tin cá nhân.'), { status: 401 });
    const generation = epoch.current;
    const expectedUserId = Number(userRef.current.user_id);
    try {
      const result = await action(tokenRef.current);
      current(generation);
      if (signal?.aborted) throw Object.assign(new Error('Yêu cầu đã được hủy.'), { name: 'AbortError' });
      const nextUser = profileApi.safeProfileUser(result.user);
      if (nextUser.user_id !== expectedUserId || nextUser.user_id !== Number(userRef.current?.user_id)) {
        throw new Error('Thông tin tài khoản nhận được không khớp với phiên hiện tại. Vui lòng tải lại trang.');
      }
      if (revision !== undefined && (profileSaving.current || revision !== profileRevision.current)) {
        throw Object.assign(new Error('Thông tin cá nhân đã được cập nhật. Vui lòng tải lại dữ liệu mới.'), { obsolete: true });
      }
      userRef.current = nextUser;
      setUser(nextUser);
      return { success: true, user: nextUser };
    } catch (error) {
      current(generation);
      if (!error.obsolete && !signal?.aborted) await expireSession(error);
      throw error;
    }
  }
  const getProfile = ({ signal } = {}) => accountProfileRequest(token => profileApi.getProfile(token, { signal }), { signal, revision: profileRevision.current });
  async function updateProfile(body) {
    if (profileSaving.current) throw Object.assign(new Error('Đang lưu thông tin cá nhân. Vui lòng chờ hoàn tất.'), { status: 409 });
    profileSaving.current = true;
    profileRevision.current++;
    try { return await accountProfileRequest(token => profileApi.updateProfile(token, body)); }
    finally { profileSaving.current = false; profileRevision.current++; }
  }
  async function accountReviewRequest(action, { signal } = {}) {
    if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập để đánh giá sản phẩm.'), { status: 401 });
    if (userRef.current.role !== 'user') throw Object.assign(new Error('Đánh giá sản phẩm dành cho tài khoản khách hàng.'), { status: 403 });
    const generation = epoch.current;
    try {
      const result = await action(tokenRef.current);
      current(generation);
      if (signal?.aborted) throw Object.assign(new Error('Yêu cầu đã được hủy.'), { name: 'AbortError' });
      return result;
    } catch (error) {
      current(generation);
      if (!error.obsolete && !signal?.aborted && !error.preserveSession) await expireSession(error);
      throw error;
    }
  }
  const getMyReviews = (options = {}) => accountReviewRequest(token => reviewsApi.getMyReviews(token, options), options);
  const createProductReview = (productId, body) => {
    const id = Number(productId);
    if (!positive(id)) throw Object.assign(new Error('Mã sản phẩm không hợp lệ. Vui lòng mở lại sản phẩm từ đơn hàng.'), { status: 400 });
    return accountReviewRequest(token => reviewsApi.createProductReview(token, id, body));
  };
  async function simulateOrderPayment(orderId, testCase) {
    if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập để mô phỏng thanh toán.'), { status: 401 });
    if (userRef.current.role !== 'user') throw Object.assign(new Error('Mô phỏng thanh toán dành cho tài khoản khách hàng.'), { status: 403 });
    const id = Number(orderId);
    if (!positive(id)) throw Object.assign(new Error('Mã đơn hàng không hợp lệ. Vui lòng mở lại đơn từ danh sách.'), { status: 400 });
    const generation = epoch.current;
    try {
      const result = await paymentsApi.simulateOrderPayment(tokenRef.current, id, testCase);
      current(generation);
      return result;
    } catch (error) {
      current(generation);
      if (!error.obsolete) await expireSession(error);
      throw error;
    }
  }
  async function submitOrder(payload, key) {
    return operation(async () => {
      checkCustomer();
      if (!userRef.current || !tokenRef.current) throw Object.assign(new Error('Vui lòng đăng nhập lại để đặt hàng.'), { status: 401 });
      return commerceApi('/api/orders', { method: 'POST', token: tokenRef.current, headers: { 'Idempotency-Key': key }, body: payload });
    });
  }
  async function orderCommitted(intentId) {
    // Cart refresh is separate from the committed order result: a failed refresh cannot undo an order.
    try {
      if (readJson(INTENT_KEY)?.id === intentId) localStorage.removeItem(INTENT_KEY);
      clearAuthRedirect(); setPendingIntent(null);
      await refreshCart();
    } catch (error) {
      setCartError(error.message);
      notify('Đơn hàng đã được lưu. Chưa cập nhật được giỏ hàng; bạn có thể tải lại giỏ để kiểm tra.');
    }
  }
  async function logout() {
    // Pause protected-page auth effects while leaving, so the page being
    // unloaded cannot overwrite /login with its previous account's returnTo.
    checkoutRedirectRef.current = true;
    setAuthLoading(true);
    epoch.current++; tokenRef.current = null; userRef.current = null;
    sessionStorage.removeItem(TOKEN_KEY); beginLogin();
    setUser(null); displayCart(emptyCart()); source('guest'); setMerge(false); setCartError('');
    sessionStorage.setItem(FLASH_KEY, 'Đã đăng xuất. Giỏ tài khoản vẫn được lưu trên máy chủ.');
    window.location.replace('/login');
  }
  async function checkout() {
    return operation(async () => {
      checkCustomer();
      // Capture the user's selection before any refresh can deselect a newly unavailable item.
      const chosen = cartRef.current.items.filter(item => item.selected);
      if (!chosen.length) throw new Error('Hãy chọn ít nhất một sản phẩm hợp lệ.');
      const intent = { version: 1, id: crypto.randomUUID(), type: 'cart', product_ids: chosen.map(item => item.product_id), items: chosen.map(({ product_id, quantity }) => ({ product_id, quantity })), authenticated: Boolean(userRef.current), user_id: userRef.current?.user_id ?? null, created_at: Date.now() };
      prepareCheckoutDraft(intent, userRef.current, Object.fromEntries(chosen.map(item => [item.product_id, String(item.price)])));
      saveIntent(intent);
      if (!userRef.current) window.location.assign(purchaseLoginUrl(intent.id));
      else { clearAuthRedirect(); window.location.assign('/checkout'); }
    });
  }
  async function buyNow(productId, quantity = 1, referencePrice) {
    return operation(async () => {
      checkCustomer(); if (!positive(productId) || !positive(quantity)) throw new Error('Số lượng phải là số nguyên dương.');
      const intent = { version: 1, id: crypto.randomUUID(), type: 'buy-now', product_id: productId, quantity, product_ids: [productId], items: [{ product_id: productId, quantity }], authenticated: Boolean(userRef.current), user_id: userRef.current?.user_id ?? null, created_at: Date.now() };
      prepareCheckoutDraft(intent, userRef.current, { [productId]: String(referencePrice) });
      saveIntent(intent);
      if (!userRef.current) window.location.assign(purchaseLoginUrl(intent.id));
      else { clearAuthRedirect(); window.location.assign('/checkout'); }
    });
  }
  function resumeCheckout() {
    const draft = readCheckoutDraft();
    if (authLoading || checkoutRedirectRef.current || !draft || userRef.current?.role === 'admin') return false;
    if (!userRef.current || mergeRef.current.pending) {
      checkoutRedirectRef.current = true;
      try {
        // Restore this tab's snapshot even when another tab replaced the shared intent.
        const intent = { version: 1, id: draft.intent_id, type: draft.type, items: draft.items,
          product_ids: draft.items.map(item => item.product_id), authenticated: false, created_at: Date.now(),
          ...(draft.type === 'buy-now' ? { product_id: draft.items[0].product_id, quantity: draft.items[0].quantity } : {}) };
        saveIntent(intent);
        const loginUrl = purchaseLoginUrl(intent.id);
        if (!userRef.current) window.location.replace(loginUrl);
        else window.location.replace(`/cart?flow=${encodeURIComponent(new URL(loginUrl, window.location.origin).searchParams.get('flow'))}`);
        return true;
      } catch (error) { checkoutRedirectRef.current = false; throw error; }
    }
    return false;
  }

  return <Context.Provider value={{ user, authLoading, cart, cartLoading, cartError, busy, cartSource, mergeError, mergeConflicts, mergeCanEdit, pendingIntent, beginLogin, login, register, logout, retryCart, retryMerge, addItem, updateItem, removeItem, selectItem, selectAll, checkout, buyNow, resumeCheckout, submitOrder, orderCommitted, getOrders, getOrder, getOrderPayment, cancelOrder, getWishlist, saveWishlistProduct, getAdminOrders, getAdminOrder, approveAdminOrder, rejectAdminOrder, updateAdminOrder, getAdminProducts, getAdminProductCategories, getAdminPetTypes, createAdminProduct, updateAdminProduct, stopAdminProduct, getAdminCategories, createAdminCategory, updateAdminCategory, deleteAdminCategory, getAdminUsers, updateAdminUserStatus, getAdminVouchers, getAdminVoucher, createAdminVoucher, updateAdminVoucher, disableAdminVoucher, quoteCheckoutVoucher, getCheckoutVouchers, getProfile, updateProfile, getMyReviews, createProductReview, simulateOrderPayment, notify, notice, noticeType, clearNotice: () => setNotice('') }}>{children}</Context.Provider>;
}

export function useCommerce() {
  const value = useContext(Context);
  if (!value) throw new Error('CommerceProvider is required');
  return value;
}
