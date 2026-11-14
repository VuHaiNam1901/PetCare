import { AdminSidebar } from '../components/AdminVoucherNavLink.jsx';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, CircleAlert, CreditCard, Info, MapPin, Package, RefreshCw, Search, ShieldCheck, Truck, X } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { ErrorNotice } from '../components/Feedback.jsx';
import { OrderHistory, OrderItems, OrderStatusBadge, OrdersLoading } from '../components/OrderContent.jsx';
import { formatPrice } from '../utils/catalog.js';
import { formatOrderDate, formatOrderMoney, recordedDate } from '../utils/orders.js';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../my-orders.css';
import '../order-detail.css';
import '../admin-orders.css';

const PAGE_SIZE = 20;
const STATUSES = ['Chờ xử lý', 'Chờ thanh toán', 'Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng', 'Đã hủy'];
const APPROVAL_FILTERS = ['pending', 'approved', 'rejected'];
const positiveId = value => /^[1-9]\d*$/.test(String(value || '')) && Number(value) <= 2147483647;
const paymentMethod = method => method === 'COD' ? 'Thanh toán khi nhận hàng (COD)' : method === 'ONLINE' ? 'Online' : 'Chưa có thông tin';
const friendlyDate = value => formatOrderDate(value, true) || 'Chưa có thông tin';
const REFUND_STATUSES = {
  requested: 'Đã ghi nhận yêu cầu hoàn tiền',
  submitted: 'Đã gửi yêu cầu hoàn tiền',
  processing: 'Đang xử lý hoàn tiền',
  succeeded: 'Đã hoàn tiền',
  failed: 'Hoàn tiền chưa thành công',
  unknown: 'Chưa xác định kết quả hoàn tiền',
  manual_review: 'Cần kiểm tra hoàn tiền',
};

function RefundDetails({ refunds }) {
  if (!Array.isArray(refunds) || !refunds.length) return null;
  return <section className="admin-orders-card admin-orders-refunds" aria-labelledby="admin-refunds-title">
    <h2 id="admin-refunds-title"><CreditCard size={20} aria-hidden="true" />Thông tin hoàn tiền</h2>
    <ul role="list" aria-label="Danh sách yêu cầu hoàn tiền">
      {refunds.map((refund, index) => <li key={refund.refund_id || index} data-refund-id={refund.refund_id}>
        <strong>{REFUND_STATUSES[refund.status] || 'Đang cập nhật hoàn tiền'}</strong>
        <p>{refund.currency && refund.currency !== 'VND' ? `${refund.amount} ${refund.currency}` : formatOrderMoney(refund.amount, true)}</p>
        {refund.reason_code === 'customer_cancelled' && <p>Khách hàng hủy đơn trước khi được duyệt.</p>}
        {refund.reason_code === 'admin_rejected' && <p>Đơn hàng bị Admin từ chối sau khi thanh toán.</p>}
        {recordedDate(refund.requested_at_utc) && <p>Ghi nhận yêu cầu: <time dateTime={refund.requested_at_utc}>{friendlyDate(refund.requested_at_utc)}</time></p>}
        {refund.status === 'succeeded' && recordedDate(refund.confirmed_at_utc) && <p>Hoàn tất hoàn tiền: <time dateTime={refund.confirmed_at_utc}>{friendlyDate(refund.confirmed_at_utc)}</time></p>}
      </li>)}
    </ul>
    {refunds.some(refund => refund.status !== 'succeeded') && <p className="admin-orders-muted">Yêu cầu hoàn tiền chỉ hoàn tất khi có xác nhận từ cổng thanh toán. Trạng thái thanh toán vẫn giữ thông tin tiền đã thu để đối chiếu.</p>}
  </section>;
}

function validOrder(order, expectedId) {
  return order && Number.isSafeInteger(order.order_id) && order.order_id > 0 &&
    (expectedId === undefined || order.order_id === expectedId) && typeof order.total_amount === 'string' &&
    Array.isArray(order.items) && order.items.every(item => item && Number.isSafeInteger(item.product_id) && Number.isSafeInteger(item.quantity) && item.quantity > 0);
}

function AdminState({ title, children }) {
  return <section className="admin-orders-state"><ShieldCheck size={36} aria-hidden="true" /><h2>{title}</h2><p>{children}</p><a href="/" className="button button-outline">Về cửa hàng</a></section>;
}

function AdminList({ userId }) {
  const { getAdminOrders } = useCommerce();
  const read = useRef(getAdminOrders);
  read.current = getAdminOrders;
  const [filter, setFilter] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status') || '';
    return APPROVAL_FILTERS.includes(params.get('approval')) ? params.get('approval') : STATUSES.includes(status) ? status : '';
  });
  const [q, setQ] = useState(() => (new URLSearchParams(window.location.search).get('q') || '').slice(0, 50));
  const [search, setSearch] = useState(q);
  const [page, setPage] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('page');
    return positiveId(value) ? Number(value) : 1;
  });
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState(null);
  const queryKey = JSON.stringify([page, filter, q]);
  const current = result && result.userId === userId && result.queryKey === queryKey ? result : null;
  const loading = !current || current.loading;
  const total = current?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', String(page));
    if (q) params.set('q', q);
    if (APPROVAL_FILTERS.includes(filter)) params.set('approval', filter);
    else if (filter) params.set('status', filter);
    window.history.replaceState(null, '', `/admin/orders${params.size ? `?${params}` : ''}`);
  }, [page, filter, q]);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setResult({ userId, queryKey, loading: true, orders: [], total: 0, error: '' });
    read.current({ page, q, status: APPROVAL_FILTERS.includes(filter) ? '' : filter, approval: APPROVAL_FILTERS.includes(filter) ? filter : '', signal: controller.signal }).then(data => {
      if (!alive) return;
      if (!Array.isArray(data.orders) || !Number.isSafeInteger(data.total) || data.total < 0 || data.orders.some(order => !validOrder(order))) throw new Error('Dữ liệu danh sách đơn chưa hợp lệ. Vui lòng thử lại.');
      const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (page > lastPage) { setPage(lastPage); return; }
      setResult({ userId, queryKey, loading: false, orders: data.orders, total: data.total, error: '' });
    }).catch(error => {
      if (!alive || controller.signal.aborted || error.obsolete || [401, 403].includes(error.status)) return;
      setResult({ userId, queryKey, loading: false, orders: [], total: 0, error: error.message });
    });
    return () => { alive = false; controller.abort(); };
  }, [userId, queryKey, retry]);

  const reset = () => { setFilter(''); setQ(''); setSearch(''); setPage(1); };
  const submitSearch = event => { event.preventDefault(); setQ(search.trim()); setPage(1); };

  return <>
    <section className="admin-orders-toolbar" aria-label="Tìm và lọc đơn hàng">
      <form className="admin-orders-search" onSubmit={submitSearch}><label htmlFor="admin-order-search">Tìm mã đơn hoặc số điện thoại</label><div><Search size={17} aria-hidden="true" /><input id="admin-order-search" type="search" maxLength={50} value={search} onChange={event => setSearch(event.target.value)} placeholder="Ví dụ: #123 hoặc 0912345678" /><button className="button button-primary" type="submit">Tìm kiếm</button></div></form>
      <div className="admin-orders-filter"><label htmlFor="admin-order-filter">Lọc trạng thái đơn</label><select id="admin-order-filter" value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}><option value="">Tất cả trạng thái</option><option value="pending">Chờ duyệt</option><option value="approved">Đã duyệt</option><option value="rejected">Đã từ chối</option>{STATUSES.map(status => <option key={status} value={status}>{status}</option>)}</select></div>
    </section>
    <div className="admin-orders-list-heading"><p>{loading ? 'Đang tải danh sách...' : `${total} đơn hàng${filter || q ? ' phù hợp' : ''}`}</p><button className="admin-orders-text-button" type="button" onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw size={15} aria-hidden="true" />Tải lại danh sách</button></div>
    {loading ? <OrdersLoading label="Đang tải đơn hàng Admin" /> : current.error ? <ErrorNotice title="Chưa tải được đơn hàng" message={current.error} onRetry={() => setRetry(value => value + 1)} /> : !current.orders.length ? <section className="admin-orders-empty" role="status"><Package size={36} aria-hidden="true" /><h2>{q || filter ? 'Không tìm thấy đơn phù hợp' : 'Chưa có đơn hàng'}</h2><p>{q || filter ? 'Thử mã đơn, số điện thoại hoặc trạng thái khác.' : 'Các đơn khách đặt thành công sẽ xuất hiện tại đây.'}</p>{(q || filter) && <button className="button button-outline" type="button" onClick={reset}>Xóa bộ lọc</button>}</section> : <>
      <div className="admin-orders-table-wrap"><table className="admin-orders-table"><caption className="sr-only">Danh sách đơn hàng trong hệ thống</caption><thead><tr><th scope="col">Đơn hàng</th><th scope="col">Người nhận</th><th scope="col">Ngày đặt</th><th scope="col">Tổng tiền hàng</th><th scope="col">Thanh toán</th><th scope="col">Trạng thái đơn</th><th scope="col"><span className="sr-only">Thao tác</span></th></tr></thead><tbody>{current.orders.map(order => <tr key={order.order_id} data-order-id={order.order_id}>
        <td data-label="Đơn hàng"><a className="admin-orders-code" href={`/admin/orders/${order.order_id}`}>#{order.order_id}</a></td><td data-label="Người nhận"><strong>{order.recipient_name || 'Chưa có thông tin'}</strong><span>{order.phone || 'Chưa có số điện thoại'}</span></td><td data-label="Ngày đặt"><time dateTime={order.order_date || undefined}>{friendlyDate(order.order_date)}</time></td><td data-label="Tổng tiền hàng" className="admin-orders-amount">{formatPrice(order.total_amount)}</td><td data-label="Thanh toán"><strong>{order.payment_method || 'Chưa có thông tin'}</strong><span className="admin-orders-payment-status">{order.payment_status || 'Chưa có thông tin'}</span></td><td data-label="Trạng thái đơn"><OrderStatusBadge status={order.status} order={order} /></td><td className="admin-orders-table-action"><a href={`/admin/orders/${order.order_id}`} className="text-link">Xem chi tiết<ArrowRight size={14} aria-hidden="true" /></a></td>
      </tr>)}</tbody></table></div>
      <nav className="admin-orders-pagination" aria-label="Phân trang đơn hàng"><p>Trang {page} / {pageCount} · {total} đơn hàng</p><div><button className="button button-outline" type="button" aria-label="Trang trước" onClick={() => setPage(value => value - 1)} disabled={page <= 1}><ChevronLeft size={15} aria-hidden="true" />Trang trước</button><button className="button button-outline" type="button" aria-label="Trang tiếp theo" onClick={() => setPage(value => value + 1)} disabled={page >= pageCount}>Trang sau<ChevronRight size={15} aria-hidden="true" /></button></div></nav>
    </>}
  </>;
}

const ACTIONS = {
  approve: { title: 'Xác nhận duyệt đơn', button: 'Xác nhận duyệt', label: 'Duyệt đơn' },
  reject: { title: 'Xác nhận từ chối đơn', button: 'Xác nhận từ chối', label: 'Từ chối đơn' },
  ship: { title: 'Xác nhận bắt đầu giao hàng', button: 'Xác nhận giao hàng', label: 'Bắt đầu giao hàng' },
  deliver: { title: 'Xác nhận đã giao', button: 'Xác nhận hoàn tất', label: 'Xác nhận đã giao' },
};

function Confirmation({ action, order, busy, error, onCancel, onConfirm, onReload }) {
  const dialog = useRef(null);
  const [reason, setReason] = useState('');
  const [cashReceived, setCashReceived] = useState(false);
  const [validation, setValidation] = useState('');
  const reject = action === 'reject';
  const collectCash = action === 'deliver' && order.payment_method === 'COD';
  const reasonLength = Array.from(reason.trim()).length;
  const config = ACTIONS[action];

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    node?.querySelector('textarea, input, .admin-orders-confirm-submit')?.focus();
    return () => { if (node?.open) node.close(); };
  }, []);

  const submit = event => {
    event.preventDefault();
    if (busy) return;
    if (reject && (reasonLength < 1 || reasonLength > 500)) { setValidation('Nhập lý do từ chối từ 1 đến 500 ký tự.'); return; }
    if (collectCash && !cashReceived) { setValidation('Cần xác nhận đã giao hàng và đã thu đủ tiền COD.'); return; }
    setValidation(''); onConfirm(reason.trim(), cashReceived);
  };

  return <dialog ref={dialog} className="admin-orders-dialog" aria-labelledby="admin-confirm-title" aria-describedby="admin-confirm-description" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={submit} noValidate><div className="admin-orders-dialog-heading"><span className={reject ? 'is-danger' : ''}>{reject ? <CircleAlert size={23} aria-hidden="true" /> : <ShieldCheck size={23} aria-hidden="true" />}</span><h2 id="admin-confirm-title">{config.title}</h2><button type="button" className="icon-button" aria-label="Đóng xác nhận" disabled={busy} onClick={onCancel}><X size={19} aria-hidden="true" /></button></div>
      <p id="admin-confirm-description">{action === 'approve' ? `Duyệt đơn #${order.order_id}? ${order.payment_method === 'ONLINE' ? 'Đơn Online tiếp tục chờ hệ thống xác nhận thanh toán trước khi giao hàng.' : 'Đơn COD chuyển sang chờ giao hàng.'}` : action === 'reject' ? `Từ chối đơn #${order.order_id}? Lý do sẽ được hiển thị cho khách. Hàng đã giữ sẽ được hoàn lại theo dữ liệu đơn.` : action === 'ship' ? `Xác nhận bắt đầu giao đơn #${order.order_id} cho khách?` : `Xác nhận đơn #${order.order_id} đã được giao thành công?`}</p>
      {reject && <div className="admin-orders-reason-field"><label htmlFor="admin-rejection-reason">Lý do từ chối <span aria-hidden="true">*</span></label><textarea id="admin-rejection-reason" name="reason" required rows={4} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} aria-describedby="admin-reason-help" /><small id="admin-reason-help">{reasonLength}/500 ký tự. Giữ rõ lý do để khách có thể kiểm tra.</small></div>}
      {collectCash && <label className="admin-orders-cash-confirm"><input type="checkbox" checked={cashReceived} onChange={event => setCashReceived(event.target.checked)} disabled={busy} /><span>Đã giao hàng và đã thu đủ tiền COD</span></label>}
      {(validation || error) && <div className="admin-orders-dialog-error" role="alert"><p>{validation || error}</p>{error && <><p>Đơn có thể đã thay đổi. Cập nhật đơn hàng để kiểm tra trạng thái mới nhất trước khi thử lại.</p><button type="button" className="admin-orders-text-button" disabled={busy} onClick={onReload}><RefreshCw size={14} aria-hidden="true" />Cập nhật đơn hàng</button></>}</div>}
      <div className="admin-orders-dialog-footer"><button className="button button-outline" type="button" onClick={onCancel} disabled={busy}>Quay lại</button><button className={`button admin-orders-confirm-submit ${reject ? 'admin-orders-button-danger' : 'button-primary'}`} type="submit" disabled={busy || (reject && (reasonLength < 1 || reasonLength > 500)) || (collectCash && !cashReceived)}>{busy ? 'Đang lưu...' : config.button}</button></div>
    </form>
  </dialog>;
}

function AdminDetail({ orderId, userId }) {
  const { getAdminOrder, approveAdminOrder, rejectAdminOrder, updateAdminOrder } = useCommerce();
  const methods = useRef({ getAdminOrder, approveAdminOrder, rejectAdminOrder, updateAdminOrder });
  methods.current = { getAdminOrder, approveAdminOrder, rejectAdminOrder, updateAdminOrder };
  const validId = positiveId(orderId);
  const id = validId ? Number(orderId) : null;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState(null);
  const [action, setAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const current = result && result.userId === userId && result.id === id ? result : null;
  const order = current?.order;
  const loading = !current || current.loading;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (!validId) return;
    const controller = new AbortController();
    let active = true;
    setResult({ userId, id, loading: true, order: null, error: '', status: null });
    methods.current.getAdminOrder(id, { signal: controller.signal }).then(data => {
      if (!active) return;
      if (!validOrder(data.order, id)) throw new Error('Dữ liệu chi tiết đơn chưa hợp lệ. Vui lòng thử lại.');
      setResult({ userId, id, loading: false, order: data.order, error: '', status: null });
    }).catch(error => {
      if (!active || controller.signal.aborted || error.obsolete || [401, 403].includes(error.status)) return;
      setResult({ userId, id, loading: false, order: null, error: error.message, status: error.status });
    });
    return () => { active = false; controller.abort(); };
  }, [userId, id, validId, retry]);

  const reload = () => { if (busyRef.current) return; setAction(null); setActionError(''); setSuccess(''); setRetry(value => value + 1); };
  const openAction = value => { if (busyRef.current) return; setActionError(''); setSuccess(''); setAction(value); };
  const confirm = async (reason, cashReceived) => {
    if (busyRef.current || !order || !action) return;
    busyRef.current = true; setBusy(true); setActionError(''); setSuccess('');
    const selectedAction = action;
    try {
      const data = selectedAction === 'approve' ? await methods.current.approveAdminOrder(id) : selectedAction === 'reject' ? await methods.current.rejectAdminOrder(id, reason) : await methods.current.updateAdminOrder(id, selectedAction === 'ship' ? 'Đang giao hàng' : 'Đã giao hàng', selectedAction === 'deliver' && order.payment_method === 'COD' ? cashReceived : undefined);
      if (!alive.current) return;
      if (!validOrder(data.order, id)) throw new Error('Chưa xác nhận được dữ liệu sau khi lưu. Vui lòng cập nhật đơn hàng.');
      setResult({ userId, id, loading: false, order: data.order, error: '', status: null });
      setAction(null); setSuccess(`Đã lưu thao tác ${ACTIONS[selectedAction].label.toLowerCase()} cho đơn #${id}.`);
    } catch (error) {
      if (alive.current && !error.obsolete && ![401, 403].includes(error.status)) setActionError(error.message || 'Chưa nhận được kết quả lưu. Vui lòng cập nhật đơn hàng.');
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  if (!validId || current?.status === 404 || current?.status === 400) return <section className="admin-orders-empty"><Package size={36} aria-hidden="true" /><h2>Không tìm thấy đơn hàng</h2><p>{validId ? 'Đơn không tồn tại hoặc không còn truy cập được.' : 'Mã đơn không hợp lệ. Chọn đơn từ danh sách để kiểm tra.'}</p><a className="button button-outline" href="/admin/orders">Về danh sách đơn hàng</a></section>;
  if (loading) return <OrdersLoading label="Đang tải chi tiết đơn hàng Admin" />;
  if (current.error) return <ErrorNotice title="Chưa tải được chi tiết đơn" message={current.error} onRetry={reload} />;
  if (!order) return null;

  const allowed = Array.isArray(order.allowed_actions) ? order.allowed_actions : [];
  const pending = order.approval_state === 'pending';
  const terminal = ['Đã hủy', 'Đã giao hàng'].includes(order.status);
  const canShip = !terminal && order.status === 'Chờ giao hàng' && order.approved_at && (order.payment_method === 'COD' || order.payment_status === 'Đã thanh toán') && allowed.includes('ship');
  const canDeliver = !terminal && order.status === 'Đang giao hàng' && order.approved_at && (order.payment_method === 'COD' || order.payment_status === 'Đã thanh toán') && allowed.includes('deliver');
  const actionable = !terminal && (pending && (allowed.includes('approve') || allowed.includes('reject')) || canShip || canDeliver);

  return <>
    <div className="admin-orders-detail-toolbar"><a className="text-link" href="/admin/orders"><ArrowLeft size={15} aria-hidden="true" />Danh sách đơn hàng</a><button className="admin-orders-text-button" type="button" disabled={busy} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Cập nhật đơn hàng</button></div>
    {success && <p className="admin-orders-success" role="status"><Check size={17} aria-hidden="true" />{success}</p>}
    <section className="admin-orders-overview"><div><p className="admin-orders-eyebrow">THÔNG TIN ĐƠN HÀNG</p><h2>Đơn hàng #{order.order_id}</h2><p>Ngày đặt: <time dateTime={order.order_date || undefined}>{friendlyDate(order.order_date)}</time></p></div><OrderStatusBadge status={order.status} order={order} /></section>
    <div className="admin-orders-detail-layout"><div className="admin-orders-detail-main">
      <section className="admin-orders-card admin-orders-recipient"><h2><MapPin size={20} aria-hidden="true" />Thông tin nhận hàng</h2><dl className="admin-orders-data"><div><dt>Người nhận</dt><dd>{order.recipient_name || 'Chưa có thông tin'}</dd></div><div><dt>Số điện thoại</dt><dd>{order.phone || 'Chưa có thông tin'}</dd></div><div><dt>Địa chỉ</dt><dd className="admin-orders-multiline">{order.shipping_address || 'Chưa có thông tin'}</dd></div><div><dt>Ghi chú</dt><dd className="admin-orders-multiline">{order.note || 'Không có ghi chú'}</dd></div></dl></section>
      <section className="admin-orders-card admin-orders-products"><h2><Package size={20} aria-hidden="true" />Sản phẩm đã đặt<span>{order.items.length} loại sản phẩm</span></h2><OrderItems orderId={order.order_id} items={order.items} className="admin-orders-items" /></section>
      {order.rejection_reason && <section className="admin-orders-card admin-orders-rejection"><h2><CircleAlert size={20} aria-hidden="true" />Lý do từ chối</h2><p className="admin-orders-multiline">{order.rejection_reason}</p></section>}
      {order.status === 'Đã hủy' && order.cancellation_reason_code === 'customer_cancelled' && <section className="admin-orders-card admin-orders-rejection admin-orders-cancellation" aria-labelledby="admin-cancellation-title"><h2 id="admin-cancellation-title"><CircleAlert size={20} aria-hidden="true" />Khách hàng đã hủy đơn</h2><dl className="admin-orders-data"><div><dt>Lý do hủy</dt><dd className="admin-orders-multiline">{order.cancellation_reason || 'Chưa có thông tin'}</dd></div>{recordedDate(order.cancelled_at) && <div><dt>Thời điểm hủy</dt><dd><time dateTime={order.cancelled_at}>{friendlyDate(order.cancelled_at)}</time></dd></div>}</dl></section>}
      <div className="admin-orders-history"><OrderHistory history={order.history || []} /></div>
    </div><aside className="admin-orders-detail-aside">
      <section className="admin-orders-card admin-orders-payment"><h2><CreditCard size={20} aria-hidden="true" />Thanh toán và tổng tiền</h2><dl className="admin-orders-data"><div><dt>Phương thức</dt><dd>{paymentMethod(order.payment_method)}</dd></div><div><dt>Trạng thái thanh toán</dt><dd className="admin-orders-payment-status">{order.payment_status || 'Chưa có thông tin'}</dd></div>{order.transaction_date && <div><dt>Ghi nhận thanh toán</dt><dd>{friendlyDate(order.transaction_date)}</dd></div>}<div><dt>Phí vận chuyển</dt><dd>Chưa tính</dd></div><div className="admin-orders-total"><dt>Tổng tiền hàng</dt><dd>{formatPrice(order.total_amount)}</dd></div></dl><p className="admin-orders-muted">Giá và số lượng được lưu tại thời điểm đặt. Tổng tiền chưa gồm phí vận chuyển.</p></section>
      <RefundDetails refunds={order.refunds} />
      <section className="admin-orders-card admin-orders-actions"><h2><Truck size={20} aria-hidden="true" />Xử lý đơn hàng</h2>
        {pending && <p className="admin-orders-action-note"><Info size={16} aria-hidden="true" />Đơn đang chờ Admin duyệt trước khi xử lý tiếp.</p>}
        {order.payment_method === 'ONLINE' && order.approval_state === 'approved' && order.status === 'Chờ thanh toán' && <p className="admin-orders-action-note"><Info size={16} aria-hidden="true" />Đơn đã duyệt, đang chờ hệ thống xác nhận thanh toán. Chỉ khi thanh toán thành công mới được giao hàng. Chưa có thao tác thanh toán trên trang Admin.</p>}
        {order.review_required && <p className="admin-orders-action-note" role="status"><CircleAlert size={16} aria-hidden="true" />{order.review_reason || 'Đơn cần được kiểm tra dữ liệu trước khi thao tác. Cập nhật đơn hàng để kiểm tra trạng thái mới nhất.'}</p>}
        {order.approval_state === 'legacy' && !order.review_required && <p className="admin-orders-action-note"><CircleAlert size={16} aria-hidden="true" />Đơn cũ cần được kiểm tra dữ liệu trước khi thao tác. Không tự suy đoán lịch sử duyệt đơn.</p>}
        {terminal && <p className="admin-orders-muted">{order.status === 'Đã hủy' ? 'Đơn đã kết thúc, không còn thao tác xử lý.' : 'Đơn đã giao thành công. Thông tin được giữ để đối chiếu.'}</p>}
        {actionable && <div className="admin-orders-action-buttons">{pending && allowed.includes('approve') && <button type="button" className="button button-primary" disabled={busy} onClick={() => openAction('approve')}><Check size={16} aria-hidden="true" />Duyệt đơn</button>}{pending && allowed.includes('reject') && <button type="button" className="button admin-orders-button-danger-outline" disabled={busy} onClick={() => openAction('reject')}>Từ chối đơn</button>}{canShip && <button type="button" className="button button-primary" disabled={busy} onClick={() => openAction('ship')}><Truck size={16} aria-hidden="true" />Bắt đầu giao hàng</button>}{canDeliver && <button type="button" className="button button-primary" disabled={busy} onClick={() => openAction('deliver')}><Check size={16} aria-hidden="true" />Xác nhận đã giao</button>}</div>}
        {!actionable && !terminal && !pending && order.status !== 'Chờ thanh toán' && order.approval_state !== 'legacy' && <p className="admin-orders-muted">Không có thao tác hợp lệ ở trạng thái hiện tại. Cập nhật đơn hàng để kiểm tra dữ liệu mới nhất.</p>}
      </section>
    </aside></div>
    {action && <Confirmation key={action} action={action} order={order} busy={busy} error={actionError} onCancel={() => { if (!busyRef.current) { setAction(null); setActionError(''); } }} onConfirm={confirm} onReload={reload} />}
  </>;
}

export default function AdminOrdersPage({ orderId }) {
  const { user, authLoading } = useCommerce();
  const detail = orderId !== undefined;

  useEffect(() => {
    const previous = document.title;
    document.title = `${detail ? 'Chi tiết đơn' : 'Quản lý đơn hàng'} · Admin | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, [detail]);

  useEffect(() => {
    if (authLoading || user) return;
    const returnTo = safeReturnUrl(`${window.location.pathname}${window.location.search}`, '/admin/orders');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id]);

  return <div className="container admin-orders-page"><div className="admin-orders-page-heading"><div><p className="admin-orders-eyebrow">PETCARESHOP ADMIN</p><h1>{detail ? 'Chi tiết đơn hàng' : 'Quản lý đơn hàng'}</h1><p>Duyệt đơn, theo dõi thanh toán và cập nhật giao hàng.</p></div><span className="admin-orders-admin-label"><ShieldCheck size={17} aria-hidden="true" />Khu vực quản trị</span></div>
    {authLoading || !user ? <OrdersLoading label="Đang kiểm tra quyền quản trị" /> : user.role !== 'admin' ? <AdminState title="Bạn không có quyền quản trị">Khu vực này chỉ dành cho tài khoản Admin. Đơn hàng của bạn vẫn có tại trang Đơn hàng của tôi.</AdminState> : <div className="admin-orders-layout"><AdminSidebar user={user} active="/admin/orders" note={detail ? 'Kiểm tra thông tin đơn và xác nhận trước mỗi thao tác.' : 'Duyệt đơn và theo dõi giao hàng từ dữ liệu thực tế.'} /><div className="admin-orders-content">{detail ? <AdminDetail key={`${user.user_id}:${orderId}`} userId={user.user_id} orderId={orderId} /> : <AdminList key={user.user_id} userId={user.user_id} />}</div></div>}
  </div>;
}
