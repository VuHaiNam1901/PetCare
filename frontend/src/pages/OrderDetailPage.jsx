import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, Check, ChevronRight, CircleX, CreditCard, Info, MapPin, Package, RefreshCw, Truck, UserRound } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { ErrorNotice } from '../components/Feedback.jsx';
import { OrderHistory, OrderItems, OrderStatusBadge, OrdersLoading } from '../components/OrderContent.jsx';
import OrderReviewLinks from '../components/OrderReviewLinks.jsx';
import { formatPrice } from '../utils/catalog.js';
import { formatOrderDate, orderStatusLabel, recordedDate } from '../utils/orders.js';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../my-orders.css';
import '../order-detail.css';

function RecordedTime({ value }) {
  const label = formatOrderDate(value, true);
  return label ? <time dateTime={value}>{label}</time> : null;
}

function OrderProgress({ order }) {
  const cancelled = order.status === 'Đã hủy';
  const rejected = order.approval_state === 'rejected' || Boolean(order.rejection_reason);
  const pending = orderStatusLabel(order) === 'Chờ duyệt';
  const stages = ['Chờ duyệt', ...(order.payment_method === 'ONLINE' ? ['Chờ thanh toán'] : []), 'Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng'];
  const activeIndex = pending ? 0 : order.approval_state === 'legacy' ? -1 : stages.indexOf(order.status);
  return <section className="order-detail-card order-detail-progress" aria-labelledby="order-progress-title">
    <div className="order-detail-section-heading"><Truck size={20} aria-hidden="true" /><h2 id="order-progress-title">Theo dõi đơn hàng</h2></div>
    {cancelled ? <div className="order-detail-cancelled" role="status"><CircleX size={26} aria-hidden="true" /><div><h3>{rejected ? 'Đơn hàng đã bị từ chối' : 'Đơn hàng đã hủy'}</h3><p>Tiến trình giao hàng đã dừng. Vui lòng liên hệ cửa hàng nếu bạn cần thêm thông tin.</p></div></div>
      : activeIndex < 0 ? <p className="order-detail-muted">Trạng thái hiện tại: {order.status || 'Chưa có thông tin'}. Chưa có tiến trình tương ứng để hiển thị.</p>
        : <ol className="order-detail-steps" aria-label="Tiến trình đơn hàng">
          <li className="is-complete"><span className="order-detail-step-dot"><Check size={15} aria-hidden="true" /></span><div><strong>Đã đặt hàng</strong><RecordedTime value={order.order_date} /></div></li>
          {stages.map((stage, index) => <li key={stage} className={index < activeIndex ? 'is-complete' : index === activeIndex ? 'is-current' : ''} aria-current={index === activeIndex ? 'step' : undefined}><span className="order-detail-step-dot">{index < activeIndex ? <Check size={15} aria-hidden="true" /> : <span aria-hidden="true" />}</span><div><strong>{stage}</strong></div></li>)}
        </ol>}
    <dl className="order-detail-recorded-times">
      {cancelled && recordedDate(order.order_date) && <div><dt>Ngày đặt</dt><dd><RecordedTime value={order.order_date} /></dd></div>}
      {recordedDate(order.approved_at) && <div><dt>Cửa hàng duyệt đơn</dt><dd><RecordedTime value={order.approved_at} /></dd></div>}
      {recordedDate(order.transaction_date) && <div><dt>Ghi nhận thanh toán</dt><dd><RecordedTime value={order.transaction_date} /></dd></div>}
    </dl>
    <p className="order-detail-progress-note"><Info size={14} aria-hidden="true" />Tiến trình phản ánh trạng thái hiện tại. Chỉ hiển thị ngày giờ đã được ghi nhận.</p>
  </section>;
}

function PaymentDetails({ order, state, onRetry }) {
  const payment = state?.value;
  const method = order.payment_method === 'COD' ? 'Thanh toán khi nhận hàng (COD)' : order.payment_method === 'ONLINE' ? 'Thanh toán Online' : 'Chưa có thông tin';
  const cancelled = order.status === 'Đã hủy' || order.payment_status === 'Đã hủy';
  let notice;
  if (cancelled) notice = 'Đơn hàng đã hủy. Không có thao tác thanh toán trên trang này.';
  else if (order.payment_status === 'Đã thanh toán') notice = 'Thanh toán đã được ghi nhận theo thông tin của đơn hàng.';
  else if (order.payment_method === 'COD') notice = 'Bạn thanh toán khi nhận hàng. Trạng thái thu tiền được cập nhật từ cửa hàng.';
  else if (order.payment_method === 'ONLINE' && payment) {
    if (!payment.approved_at) notice = 'Đơn hàng cần được Admin duyệt trước khi thanh toán.';
    else if (payment.can_simulate === true && payment.simulation_only === true) notice = 'Đơn hàng đã được Admin duyệt và có thể thanh toán mô phỏng. Giao diện thanh toán chưa được tích hợp.';
    else notice = 'Đơn hàng hiện chưa thể thanh toán. Vui lòng cập nhật trạng thái hoặc liên hệ cửa hàng. Giao diện thanh toán chưa được tích hợp.';
  }
  return <section className="order-detail-card order-detail-payment" aria-labelledby="order-payment-title">
    <div className="order-detail-section-heading"><CreditCard size={20} aria-hidden="true" /><h2 id="order-payment-title">Thông tin thanh toán</h2></div>
    <dl className="order-detail-data"><div><dt>Phương thức</dt><dd>{method}</dd></div><div><dt>Trạng thái thanh toán</dt><dd className="order-detail-payment-status">{order.payment_status || 'Chưa có thông tin'}</dd></div>{recordedDate(order.transaction_date) && <div><dt>Thời gian ghi nhận</dt><dd><RecordedTime value={order.transaction_date} /></dd></div>}</dl>
    {(!state || state.loading) && <p className="order-detail-payment-loading" role="status">Đang kiểm tra thông tin thanh toán...</p>}
    {state?.error ? <div className="order-detail-payment-error"><ErrorNotice title="Chưa kiểm tra được thanh toán" message={state.error} onRetry={onRetry} /></div> : notice && <div className="order-detail-payment-note" role="status"><Info size={16} aria-hidden="true" /><p>{notice}</p></div>}
    {order.payment_method === 'ONLINE' && !cancelled && order.payment_status !== 'Đã thanh toán' && <p className="order-detail-muted">Thanh toán Online hiện chỉ có mô phỏng, chưa kết nối cổng thanh toán thật. Xem đơn không thực hiện thanh toán.</p>}
  </section>;
}

export default function OrderDetailPage({ orderId }) {
  const { user, authLoading, getOrder, getOrderPayment } = useCommerce();
  const readers = useRef({ getOrder, getOrderPayment });
  readers.current = { getOrder, getOrderPayment };
  const validId = /^[1-9]\d*$/.test(orderId || '') && Number(orderId) <= 2147483647;
  const id = validId ? Number(orderId) : null;
  const [retry, setRetry] = useState(0);
  const [paymentRetry, setPaymentRetry] = useState(0);
  const [result, setResult] = useState(null);
  const [paymentResult, setPaymentResult] = useState(null);
  const current = result && user && result.ownerId === user.user_id && result.orderId === id ? result : null;
  const originalOrder = current?.order;
  const paymentState = paymentResult && user && paymentResult.ownerId === user.user_id && paymentResult.order === originalOrder ? paymentResult : null;
  const payment = paymentState?.value;
  // The payment GET reads order/payment state atomically. Prefer that newer state
  // while retaining the immutable shipping/items/amount from the detail snapshot.
  const order = originalOrder && payment ? { ...originalOrder, status: payment.order_status,
    payment_status: payment.payment_status, approved_at: payment.approved_at, transaction_date: payment.transaction_date,
    approval_state: payment.approval_state ?? originalOrder.approval_state,
    rejection_reason: payment.rejection_reason ?? originalOrder.rejection_reason } : originalOrder;
  const loading = authLoading || !current || current.loading;

  useEffect(() => {
    const previous = document.title;
    document.title = `Chi tiết đơn hàng | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, []);

  useEffect(() => {
    if (authLoading || user) return;
    const returnTo = safeReturnUrl(`${window.location.pathname}${window.location.search}`, '/my-orders');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id]);

  useEffect(() => {
    if (authLoading || !user || user.role !== 'user' || !validId) return;
    const ownerId = user.user_id;
    const controller = new AbortController();
    let alive = true;
    setResult({ ownerId, orderId: id, loading: true, order: null, error: '', status: null });
    readers.current.getOrder(id, { signal: controller.signal }).then(data => {
      if (!alive) return;
      const value = data.order;
      if (!value || value.user_id !== ownerId || value.order_id !== id || !Array.isArray(value.items) ||
        typeof value.total_amount !== 'string' || value.items.some(item => !item || !Number.isSafeInteger(item.product_id) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) {
        throw new Error('Dữ liệu đơn hàng chưa hợp lệ. Vui lòng thử lại.');
      }
      setResult({ ownerId, orderId: id, loading: false, order: value, error: '', status: null });
    }).catch(error => {
      if (!alive || controller.signal.aborted || error.obsolete || [401, 403].includes(error.status)) return;
      setResult({ ownerId, orderId: id, loading: false, order: null, error: error.message, status: error.status });
    });
    return () => { alive = false; controller.abort(); };
  }, [authLoading, user?.user_id, user?.role, validId, id, retry]);

  useEffect(() => {
    if (authLoading || !user || user.role !== 'user' || !originalOrder) return;
    const ownerId = user.user_id;
    const controller = new AbortController();
    let alive = true;
    setPaymentResult({ ownerId, order: originalOrder, loading: true, value: null, error: '' });
    readers.current.getOrderPayment(id, { signal: controller.signal }).then(data => {
      if (!alive) return;
      const value = data.payment;
      if (!value || value.order_id !== id || value.payment_method !== originalOrder.payment_method ||
        value.amount !== originalOrder.total_amount || typeof value.order_status !== 'string' ||
        typeof value.payment_status !== 'string' || typeof value.can_simulate !== 'boolean') {
        throw new Error('Thông tin thanh toán cần được kiểm tra lại. Vui lòng thử lại.');
      }
      setPaymentResult({ ownerId, order: originalOrder, loading: false, value, error: '' });
    }).catch(error => {
      if (!alive || controller.signal.aborted || error.obsolete || [401, 403].includes(error.status)) return;
      setPaymentResult({ ownerId, order: originalOrder, loading: false, value: null, error: error.message });
    });
    return () => { alive = false; controller.abort(); };
  }, [authLoading, user?.user_id, user?.role, id, originalOrder, paymentRetry]);

  const denied = !authLoading && user && user.role !== 'user';
  const notFound = !validId || current?.status === 404 || current?.status === 400;

  return <div className="container order-detail-page">
    <nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><a href="/my-orders">Đơn hàng của tôi</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">Chi tiết đơn hàng</span></nav>
    <div className="order-detail-page-heading"><div><p className="my-orders-eyebrow">ĐƠN HÀNG CỦA BẠN</p><h1>Chi tiết đơn hàng</h1><p>Theo dõi đơn hàng và thông tin giao nhận của bạn.</p></div><a className="button button-outline order-detail-back" href="/my-orders"><ArrowLeft size={16} aria-hidden="true" />Đơn hàng của tôi</a></div>
    {authLoading || !user ? <OrdersLoading className="order-detail-loading" label="Đang tải chi tiết đơn hàng" /> : denied ? <section className="my-orders-state"><UserRound size={36} aria-hidden="true" /><h2>Đơn hàng dành cho tài khoản khách hàng</h2><p>Vui lòng đăng nhập bằng tài khoản khách hàng để xem đơn hàng của mình.</p></section> : notFound ? <section className="my-orders-state order-detail-not-found"><Package size={38} aria-hidden="true" /><h2>Không thể mở đơn hàng</h2><p>{validId ? 'Không tìm thấy đơn hàng hoặc bạn không có quyền truy cập.' : 'Mã đơn hàng không hợp lệ. Vui lòng chọn đơn hàng từ danh sách của bạn.'}</p><a className="button button-primary" href="/my-orders">Đơn hàng của tôi</a></section> : loading ? <OrdersLoading className="order-detail-loading" label="Đang tải chi tiết đơn hàng" /> : current.error ? <div className="order-detail-error"><ErrorNotice title="Chưa tải được chi tiết đơn hàng" message={current.error} onRetry={() => setRetry(value => value + 1)} /></div> : order ? <>
      <section className="order-detail-overview"><div><div className="order-detail-number"><Package size={22} aria-hidden="true" /><h2>Đơn hàng #{order.order_id}</h2></div><p><CalendarDays size={14} aria-hidden="true" />Ngày đặt: {formatOrderDate(order.order_date, true) || 'Chưa có thông tin'}</p></div><div className="order-detail-overview-actions"><OrderStatusBadge order={order} className="order-detail-status" /><button className="order-detail-refresh" type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />Cập nhật trạng thái</button></div></section>
      {order.rejection_reason && <section className="order-detail-rejection" aria-labelledby="order-rejection-title"><h2 id="order-rejection-title">Lý do từ chối</h2><p>{order.rejection_reason}</p></section>}
      <OrderProgress order={order} />
      <div className="order-detail-layout"><div className="order-detail-main">
        <section className="order-detail-card order-detail-products" aria-labelledby="order-products-title"><div className="order-detail-section-heading"><Package size={20} aria-hidden="true" /><h2 id="order-products-title">Sản phẩm đã đặt</h2><span>{order.items.length} loại sản phẩm</span></div><OrderItems items={order.items} orderId={order.order_id} className="order-detail-items" itemClassName="order-detail-item" /><OrderReviewLinks order={order} /></section>
        <section className="order-detail-card order-detail-shipping" aria-labelledby="order-shipping-title"><div className="order-detail-section-heading"><MapPin size={20} aria-hidden="true" /><h2 id="order-shipping-title">Thông tin nhận hàng</h2></div><dl className="order-detail-data"><div><dt>Người nhận</dt><dd>{order.recipient_name || 'Chưa có thông tin'}</dd></div><div><dt>Số điện thoại</dt><dd>{order.phone || 'Chưa có thông tin'}</dd></div><div><dt>Địa chỉ</dt><dd className="order-detail-multiline">{order.shipping_address || 'Chưa có thông tin'}</dd></div><div><dt>Ghi chú</dt><dd className="order-detail-multiline">{order.note || 'Không có ghi chú'}</dd></div></dl></section>
        <OrderHistory history={order.history} />
      </div><aside className="order-detail-summary">
        <section className="order-detail-card order-detail-totals" aria-labelledby="order-total-title"><div className="order-detail-section-heading"><CreditCard size={20} aria-hidden="true" /><h2 id="order-total-title">Tổng tiền đơn hàng</h2></div><dl><div><dt>Tiền hàng</dt><dd>{formatPrice(order.total_amount)}</dd></div><div><dt>Phí vận chuyển</dt><dd>Chưa tính</dd></div><div className="order-detail-total"><dt>Tổng tiền hàng</dt><dd>{formatPrice(order.total_amount)}</dd></div></dl><p className="order-detail-muted">Tổng tiền chưa gồm phí vận chuyển. Phí vận chuyển hiện chưa được quy định.</p></section>
        <PaymentDetails order={order} state={paymentState} onRetry={() => setPaymentRetry(value => value + 1)} />
      </aside></div>
    </> : null}
  </div>;
}
