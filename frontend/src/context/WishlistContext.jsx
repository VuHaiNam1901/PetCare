import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { TOKEN_KEY, useCommerce } from './CommerceContext.jsx';
import { safeReturnUrl } from '../utils/auth-navigation.js';

const Context = createContext(null);
const obsolete = () => Object.assign(new Error('Phiên làm việc đã thay đổi.'), { obsolete: true });
function productList(data) {
  const products = data?.products;
  if (!Array.isArray(products) || products.some(product => !product || !Number.isSafeInteger(product.product_id) || product.product_id <= 0 || typeof product.name !== 'string') ||
    new Set(products.map(product => product.product_id)).size !== products.length) throw new Error('Danh sách yêu thích chưa hợp lệ. Vui lòng thử lại.');
  return products;
}

export function WishlistProvider({ children }) {
  const { user, authLoading, getWishlist, saveWishlistProduct, beginLogin } = useCommerce();
  let token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* API authentication remains authoritative. */ }
  const key = !authLoading && user?.role === 'user' ? `${user.user_id}:${user.status}:${token}` : '';
  const authority = useRef(key);
  authority.current = key;
  const methods = useRef(null);
  methods.current = { getWishlist, saveWishlistProduct };
  const [snapshot, setSnapshot] = useState({ key: '', products: [], loading: false, error: '' });
  const latest = useRef(snapshot);
  const [pending, setPending] = useState({ key: '', ids: new Set() });
  const jobs = useRef({ key, ids: new Set(), tail: Promise.resolve() });
  const reads = useRef(0);
  if (jobs.current.key !== key) jobs.current = { key, ids: new Set(), tail: Promise.resolve() };

  function publish(value) {
    if (authority.current !== value.key) return;
    latest.current = value;
    setSnapshot(value);
  }
  async function fetchSnapshot(owner, signal) {
    if (!owner || authority.current !== owner) throw obsolete();
    const revision = ++reads.current;
    const current = latest.current.key === owner ? latest.current.products : [];
    publish({ key: owner, products: current, loading: true, error: '' });
    try {
      const data = await methods.current.getWishlist({ signal });
      if (authority.current !== owner || revision !== reads.current || signal?.aborted) throw obsolete();
      const products = productList(data);
      publish({ key: owner, products, loading: false, error: '' });
      return products;
    } catch (error) {
      if (authority.current === owner && revision === reads.current && !signal?.aborted && !error.obsolete && ![401, 403].includes(error.status)) {
        publish({ key: owner, products: current, loading: false, error: error.message });
      }
      throw error;
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    if (key) void fetchSnapshot(key, controller.signal).catch(() => {});
    const restore = event => {
      if (!event.persisted) return;
      let storedToken = '';
      try { storedToken = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return; }
      if (storedToken !== token) {
        authority.current = '';
        setSnapshot({ key: '', products: [], loading: false, error: '' });
        window.location.reload();
        return;
      }
      if (key) void refresh().catch(() => {});
    };
    window.addEventListener('pageshow', restore);
    return () => { controller.abort(); window.removeEventListener('pageshow', restore); };
  }, [key]);

  async function refresh() {
    const owner = authority.current;
    if (!owner) return [];
    await jobs.current.tail;
    return fetchSnapshot(owner);
  }
  async function toggle(productId) {
    if (authLoading) return null;
    if (!user) {
      const returnTo = safeReturnUrl(`${window.location.pathname}${window.location.search}${window.location.hash}`);
      beginLogin();
      window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}&from=wishlist`);
      return null;
    }
    if (user.role !== 'user') throw new Error('Danh sách yêu thích dành cho tài khoản khách hàng.');
    const owner = authority.current;
    if (!owner || latest.current.key !== owner || latest.current.loading || latest.current.error) throw new Error('Vui lòng tải lại danh sách yêu thích trước khi thao tác.');
    if (!Number.isSafeInteger(productId) || productId <= 0) throw new Error('Mã sản phẩm không hợp lệ.');
    const queue = jobs.current;
    if (queue.ids.has(productId)) return null;
    queue.ids.add(productId);
    setPending({ key: owner, ids: new Set(queue.ids) });
    const task = queue.tail.then(async () => {
      if (authority.current !== owner) throw obsolete();
      const selected = !latest.current.products.some(product => product.product_id === productId);
      ++reads.current;
      try {
        const data = await methods.current.saveWishlistProduct(productId, selected);
        if (authority.current !== owner) throw obsolete();
        const products = productList(data);
        ++reads.current;
        publish({ key: owner, products, loading: false, error: '' });
        return { selected: products.some(product => product.product_id === productId), changed: selected ? data.added === true : data.removed === true };
      } catch (error) {
        if (authority.current === owner && !error.obsolete && ![401, 403].includes(error.status)) {
          try { await fetchSnapshot(owner); } catch { /* Keep the mutation error. */ }
        }
        throw error;
      } finally {
        queue.ids.delete(productId);
        if (authority.current === owner) setPending({ key: owner, ids: new Set(queue.ids) });
      }
    });
    // Serialize snapshots as well as writes so an older response cannot undo a
    // newer heart state or badge. A failed request does not block the next job.
    queue.tail = task.catch(() => {});
    return task;
  }
  const current = key && snapshot.key === key ? snapshot : null;
  return <Context.Provider value={{ products: current?.products || [], loading: authLoading || Boolean(key && (!current || current.loading)),
    error: current?.error || '', busyIds: pending.key === key ? pending.ids : new Set(), refresh, toggle }}>{children}</Context.Provider>;
}

export function useWishlist() {
  const value = useContext(Context);
  if (!value) throw new Error('WishlistProvider is required');
  return value;
}
