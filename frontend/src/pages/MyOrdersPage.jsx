import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, ClipboardList, LogOut, Package, ShoppingBag, SlidersHorizontal, UserRound } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { EmptyState, ErrorNotice } from '../components/Feedback.jsx';
import { OrderItems, OrderStatusBadge, OrdersLoading } from '../components/OrderContent.jsx';
import { formatOrderDate, formatOrderMoney } from '../utils/orders.js';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../my-orders.css';

const PAGE_SIZE = 10;
function OrderCard({ order }) {
  const detailsHref = `/my-orders/${order.order_id}`;
  const hasVoucher = Boolean(order.voucher_code_snapshot) || (order.discount_amount != null && Number(order.discount_amount) > 0);
  return <article className="my-order-card" data-order-id={order.order_id} aria-labelledby={`my-order-${order.order_id}`}>
    <header className="my-order-header">
      <div className="my-order-heading"><span className="my-order-icon"><Package size={20} aria-hidden="true" /></span><div><h2 id={`my-order-${order.order_id}`}>Đơn hàng <span>#{order.order_id}</span></h2><p><CalendarDays size={13} aria-hidden="true" /><time dateTime={order.order_date || undefined}>Đặt ngày {formatOrderDate(order.order_date) || 'Chưa có ngày đặt'}</time></p></div></div>
      <OrderStatusBadge order={order} />
    </header>
    <OrderItems items={order.items} orderId={order.order_id} />
    {order.rejection_reason && <p className="my-order-rejection"><strong>Lý do từ chối: </strong>{order.rejection_reason}</p>}
    <footer className="my-order-footer"><div className="my-order-total"><p>Tổng tiền <strong>{formatOrderMoney(order.total_amount, hasVoucher)}</strong></p><small>Tiền hàng chưa gồm phí vận chuyển</small></div><a className="button button-outline my-order-details" href={detailsHref}>Xem chi tiết<ArrowRight size={15} aria-hidden="true" /></a></footer>
  </article>;
}

export default function MyOrdersPage() {
  const { user, authLoading, busy, getOrders, logout, notify } = useCommerce();
  const readOrders = useRef(getOrders);
  readOrders.current = getOrders;
  const [status, setStatus] = useState(() => new URLSearchParams(window.location.search).get('status') || '');
  const [page, setPage] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('page') || '1';
    return /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : 1;
  });
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState(null);
  const [statusOptions, setStatusOptions] = useState({ ownerId: null, values: [] });
  const queryKey = JSON.stringify([page, status]);
  // Never render a stale result, even for the one render before effect cleanup.
  const current = result && user && result.ownerId === user.user_id && result.queryKey === queryKey ? result : null;
  const options = statusOptions.ownerId === user?.user_id ? statusOptions.values : [];
  const loading = authLoading || !current || current.loading;
  const total = current?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    const previous = document.title;
    document.title = `Đơn hàng của tôi | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, []);

  useEffect(() => {
    if (authLoading || user) return;
    const returnTo = safeReturnUrl(`${window.location.pathname}${window.location.search}`, '/my-orders');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id]);

  useEffect(() => {
    if (authLoading || !user || user.role !== 'user') return;
    const ownerId = user.user_id;
    const controller = new AbortController();
    let alive = true;
    setResult({ ownerId, queryKey, loading: true, orders: [], total: 0, error: '' });
    readOrders.current({ page, status, signal: controller.signal }).then(data => {
      if (!alive) return;
      if (!Array.isArray(data.orders) || !Number.isSafeInteger(data.total) || data.total < 0 ||
        !Array.isArray(data.statuses) || data.statuses.some(value => typeof value !== 'string' || !value) ||
        data.orders.some(order => order.user_id !== ownerId || !Number.isSafeInteger(order.order_id) || order.order_id <= 0 || !Array.isArray(order.items))) {
        throw new Error('Dữ liệu đơn hàng chưa hợp lệ. Vui lòng thử lại.');
      }
      setStatusOptions({ ownerId, values: [...new Set(data.statuses)] });
      setResult({ ownerId, queryKey, loading: false, orders: data.orders, total: data.total, error: '' });
    }).catch(error => {
      if (!alive || controller.signal.aborted || error.obsolete || [401, 403].includes(error.status)) return;
      setResult({ ownerId, queryKey, loading: false, orders: [], total: 0, error: error.message });
    });
    return () => { alive = false; controller.abort(); };
  }, [authLoading, user?.user_id, user?.role, page, status, queryKey, retry]);

  function navigate(nextPage, nextStatus = status) {
    const params = new URLSearchParams();
    if (nextStatus) params.set('status', nextStatus);
    if (nextPage > 1) params.set('page', String(nextPage));
    window.history.replaceState(null, '', `/my-orders${params.size ? `?${params}` : ''}`);
    setPage(nextPage); setStatus(nextStatus);
  }

  const customer = user?.role === 'user';

  return <div className="container my-orders-page">
    <nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">Đơn hàng của tôi</span></nav>
    <div className="my-orders-page-heading"><div><p className="my-orders-eyebrow">TÀI KHOẢN CỦA BẠN</p><h1>Đơn hàng của tôi</h1><p>Theo dõi những món quà bạn dành cho người bạn nhỏ.</p></div><a className="button button-outline my-orders-shop" href="/products"><ShoppingBag size={16} aria-hidden="true" />Tiếp tục mua sắm</a></div>

    {authLoading || !user ? <OrdersLoading /> : !customer ? <section className="my-orders-state"><UserRound size={36} aria-hidden="true" /><h2>Đơn hàng dành cho tài khoản khách hàng</h2><p>Bạn đang dùng tài khoản quản trị. Vui lòng đăng nhập bằng tài khoản khách hàng để xem đơn hàng của mình.</p></section> : <div className="my-orders-layout">
      <aside className="my-orders-account" aria-label="Tài khoản khách hàng"><div className="my-orders-profile"><span><UserRound size={26} aria-hidden="true" /></span><div><small>Xin chào,</small><strong>{user.full_name || 'Khách hàng'}</strong></div></div><nav aria-label="Tài khoản"><a href="/profile"><UserRound size={18} aria-hidden="true" /><span>Thông tin cá nhân</span></a><a href="/my-orders" aria-current="page"><ClipboardList size={18} aria-hidden="true" /><span>Đơn hàng của tôi</span><ChevronRight size={14} aria-hidden="true" /></a><button className="my-orders-account-logout" type="button" disabled={busy} onClick={() => logout().catch(error => notify(error.message))}><LogOut size={18} aria-hidden="true" /><span>Đăng xuất</span></button></nav><div className="my-orders-account-note"><Package size={26} strokeWidth={1.4} aria-hidden="true" /><p>Mỗi đơn hàng là một chút yêu thương gửi đến thú cưng của bạn.</p></div></aside>
      <section className="my-orders-content" aria-label="Lịch sử đơn hàng">
        <div className="my-orders-toolbar"><div><h2>Lịch sử mua hàng</h2><p aria-live="polite">{loading ? 'Đang tải đơn hàng...' : current.error ? 'Chưa tải được danh sách' : `${total} đơn hàng${status ? ` · ${status}` : ''}`}</p></div><div className="my-orders-filter"><label htmlFor="my-orders-status"><SlidersHorizontal size={14} aria-hidden="true" />Trạng thái đơn hàng</label><select id="my-orders-status" value={status} onChange={event => navigate(1, event.target.value)}><option value="">Tất cả trạng thái</option>{status && !options.includes(status) && <option value={status}>{status}</option>}{options.map(value => <option key={value} value={value}>{value}</option>)}</select></div></div>
        {loading ? <OrdersLoading /> : current.error ? <div className="my-orders-error"><ErrorNotice title="Chưa tải được đơn hàng" message={current.error} onRetry={() => setRetry(value => value + 1)} />{status && <button type="button" className="button button-outline" onClick={() => navigate(1, '')}>Xóa bộ lọc</button>}</div> : current.orders.length ? <div className="my-orders-list">{current.orders.map(order => <OrderCard key={order.order_id} order={order} />)}</div> : <div className="my-orders-empty"><EmptyState title={status ? 'Chưa có đơn hàng ở trạng thái này' : page > 1 ? 'Không có đơn hàng ở trang này' : 'Bạn chưa có đơn hàng nào'} message={status ? 'Thử chọn trạng thái khác hoặc xem tất cả đơn hàng của bạn.' : page > 1 ? 'Danh sách có thể đã thay đổi. Vui lòng quay lại trang đầu.' : 'Khám phá sản phẩm và chọn những món phù hợp cho thú cưng của bạn.'} onReset={status ? () => navigate(1, '') : undefined} />{!status && <a className="button button-primary" href={page > 1 ? '/my-orders' : '/products'}>{page > 1 ? 'Về trang đầu' : 'Khám phá sản phẩm'}<ArrowRight size={15} aria-hidden="true" /></a>}</div>}
        {!loading && !current.error && total > 0 && <nav className="my-orders-pagination" aria-label="Phân trang đơn hàng"><p>Trang <strong>{page}</strong> / {pageCount}</p><div><button className="button button-outline" type="button" aria-label="Trang trước" disabled={page <= 1} onClick={() => navigate(page - 1)}><ChevronLeft size={16} aria-hidden="true" />Trước</button><button className="button button-outline" type="button" aria-label="Trang tiếp theo" disabled={page >= pageCount} onClick={() => navigate(page + 1)}>Tiếp theo<ChevronRight size={16} aria-hidden="true" /></button></div></nav>}
      </section>
    </div>}
  </div>;
}
