import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, Check, ChevronRight, CircleX, CreditCard, Info, MapPin, Package, RefreshCw, Truck, UserRound } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { ErrorNotice } from '../components/Feedback.jsx';
import { OrderHistory, OrderItems, OrderStatusBadge, OrdersLoading } from '../components/OrderContent.jsx';
import OrderReviewLinks from '../components/OrderReviewLinks.jsx';
import { formatOrderDate, formatOrderMoney, orderStatusLabel, recordedDate } from '../utils/orders.js';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../my-orders.css';
import '../order-detail.css';

const refundStatusLabels = {
  requested: 'Chờ xử lý hoàn tiền',
  submitted: 'Đã gửi yêu cầu hoàn tiền',
  processing: 'Đang xử lý hoàn tiền',
  succeeded: 'Đã hoàn tiền',
  failed: 'Hoàn tiền thất bại',
  unknown: 'Chưa xác định kết quả hoàn tiền',
  manual_review: 'Cần đối soát hoàn tiền',
};

const refundReasonLabels = {
  admin_rejected: 'Đơn hàng bị từ chối sau khi đã thanh toán.',
  customer_cancelled: 'Bạn đã hủy đơn hàng sau khi thanh toán.',
  late_capture: 'Giao dịch ghi nhận sau hạn thanh toán.',
  cancelled_order: 'Giao dịch ghi nhận trên đơn đã hủy.',
  excess_capture: 'Giao dịch thu dư hoặc thu trùng cần hoàn lại.',
  amount_mismatch: 'Số tiền giao dịch không khớp đơn hàng.',
  manual_review: 'Giao dịch cần cửa hàng kiểm tra thủ công.',
};

function refundTone(status) {
  if (status === 'succeeded') return 'succeeded';
  if (['failed', 'unknown', 'manual_review'].includes(status)) return 'attention';
  return 'pending';
}

function RecordedTime({ value }) {
  const label = formatOrderDate(value, true);
  return label ? <time dateTime={value}>{label}</time> : null;
}

const cancellationReasons = [
  ['changed_mind', 'Tôi không còn nhu cầu mua'],
  ['change_address', 'Tôi muốn thay đổi thông tin nhận hàng'],
  ['change_products', 'Tôi muốn thay đổi sản phẩm'],
  ['delivery_time', 'Thời gian giao hàng không phù hợp'],
  ['other', 'Lý do khác'],
];

function CancelOrderDialog({ order, busy, error, onClose, onConfirm, onReload }) {
  const dialog = useRef(null);
  const [reasonCode, setReasonCode] = useState('');
  const [reason, setReason] = useState('');
  const reasonLength = Array.from(reason.trim()).length;
  const valid = Boolean(reasonCode) && (reasonCode !== 'other' || (reasonLength > 0 && reasonLength <= 500));
  useEffect(() => {
    const node = dialog.current;
    const opener = document.activeElement;
    node.showModal();
    node.querySelector('select')?.focus();
    return () => { if (node.open) node.close(); if (opener?.isConnected) opener.focus(); };
  }, []);

  return <dialog ref={dialog} className="order-cancel-dialog" aria-labelledby="order-cancel-title" aria-describedby="order-cancel-description" aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (valid && !busy && !error) onConfirm({ reason_code: reasonCode, ...(reasonCode === 'other' ? { reason: reason.trim() } : {}) }); }}>
      <h2 id="order-cancel-title">Hủy đơn hàng #{order.order_id}?</h2>
      <p id="order-cancel-description">Đơn hàng sẽ ngừng xử lý sau khi hủy thành công. Bạn chỉ có thể hủy trước khi cửa hàng duyệt đơn.</p>
      {order.payment_method === 'ONLINE' && order.payment_status === 'Đã thanh toán' && <p className="order-cancel-payment-note">Đơn đã thanh toán sẽ được ghi nhận yêu cầu hoàn tiền. Tiền chỉ được xác nhận đã hoàn khi việc hoàn tiền hoàn tất.</p>}
      <label htmlFor="order-cancel-reason">Lý do hủy đơn</label>
      <select id="order-cancel-reason" value={reasonCode} required disabled={busy} onChange={event => setReasonCode(event.target.value)}>
        <option value="" disabled>Chọn lý do hủy</option>
        {cancellationReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select>
      {reasonCode === 'other' && <><label htmlFor="order-cancel-other">Nhập lý do khác</label><textarea id="order-cancel-other" rows={4} value={reason} required disabled={busy} onChange={event => setReason(event.target.value)} aria-describedby="order-cancel-reason-help" /><small id="order-cancel-reason-help">{reasonLength}/500 ký tự.</small></>}
      {error && <div className="order-cancel-error" role="alert"><p>{error}</p><p>Vui lòng cập nhật đơn hàng để kiểm tra kết quả và điều kiện hủy trước khi thử lại.</p><button className="button button-outline" type="button" onClick={onReload} disabled={busy}>Cập nhật đơn hàng</button></div>}
      <div className="order-cancel-actions"><button className="button button-outline" type="button" disabled={busy} onClick={onClose}>Giữ đơn hàng</button><button className="button order-cancel-confirm" type="submit" disabled={busy || !valid || Boolean(error)}>{busy ? 'Đang hủy đơn...' : 'Xác nhận hủy đơn'}</button></div>
    </form>
  </dialog>;
}

function OrderProgress({ order }) {
  const isV2 = order.workflow_version === 2;
  const cancelled = order.status === 'Đã hủy';
  const rejected = order.approval_state === 'rejected' || Boolean(order.rejection_reason);
  const expired = isV2 && order.cancellation_reason_code === 'payment_expired';
  const stages = isV2
    ? ['Chờ thanh toán', 'Chờ duyệt', 'Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng']
    : ['Chờ duyệt', ...(order.payment_method === 'ONLINE' ? ['Chờ thanh toán'] : []), 'Chờ giao hàng', 'Đang giao hàng', 'Đã giao hàng'];
  const currentStage = order.approval_state === 'legacy' ? null : orderStatusLabel(order);
  const activeIndex = currentStage ? stages.indexOf(currentStage) : -1;
  const hasRecordedTimes = (cancelled && Boolean(recordedDate(order.order_date))) ||
    Boolean(recordedDate(order.approved_at)) || Boolean(recordedDate(order.transaction_date));

  return <section className="order-detail-card order-detail-progress" aria-labelledby="order-progress-title">
    <div className="order-detail-section-heading"><Truck size={20} aria-hidden="true" /><h2 id="order-progress-title">Theo dõi đơn hàng</h2></div>
    {cancelled ? <div className="order-detail-cancelled" role="status"><CircleX size={26} aria-hidden="true" /><div><h3>{rejected ? 'Đơn hàng đã bị từ chối' : expired ? 'Đơn hàng đã hủy do quá hạn thanh toán' : 'Đơn hàng đã hủy'}</h3><p>{expired ? 'Đơn Online đã quá thời hạn thanh toán 24 giờ nên tiến trình xử lý đã dừng. Hàng giữ chỗ và ưu đãi (nếu có) đã được hoàn lại.' : 'Tiến trình giao hàng đã dừng. Vui lòng liên hệ cửa hàng nếu bạn cần thêm thông tin.'}</p></div></div>
      : activeIndex < 0 ? <p className="order-detail-muted">Trạng thái hiện tại: {order.status || 'Chưa có thông tin'}. Chưa có tiến trình tương ứng để hiển thị.</p>
        : <ol role="list" className="order-detail-steps" aria-label="Tiến trình đơn hàng">
          <li className="is-complete"><span className="order-detail-step-dot"><Check size={15} aria-hidden="true" /></span><div><strong>Đã đặt hàng</strong><RecordedTime value={order.order_date} /></div></li>
          {stages.map((stage, index) => <li key={stage} className={index < activeIndex ? 'is-complete' : index === activeIndex ? 'is-current' : ''} aria-current={index === activeIndex ? 'step' : undefined}><span className="order-detail-step-dot">{index < activeIndex ? <Check size={15} aria-hidden="true" /> : <span aria-hidden="true" />}</span><div><strong>{stage}</strong></div></li>)}
        </ol>}
    {hasRecordedTimes && <dl className="order-detail-recorded-times">
      {cancelled && recordedDate(order.order_date) && <div><dt>Ngày đặt</dt><dd><RecordedTime value={order.order_date} /></dd></div>}
      {recordedDate(order.approved_at) && <div><dt>Cửa hàng duyệt đơn</dt><dd><RecordedTime value={order.approved_at} /></dd></div>}
      {recordedDate(order.transaction_date) && <div><dt>Ghi nhận thanh toán</dt><dd><RecordedTime value={order.transaction_date} /></dd></div>}
    </dl>}
    <p className="order-detail-progress-note"><Info size={14} aria-hidden="true" />Tiến trình phản ánh trạng thái hiện tại. Chỉ hiển thị ngày giờ đã được ghi nhận.</p>
  </section>;
}

function PaymentDetails({ order, state, onRetry }) {
  const payment = state?.value;
  const isV2 = order.workflow_version === 2;
  const method = order.payment_method === 'COD' ? 'Thanh toán khi nhận hàng (COD)' : order.payment_method === 'ONLINE' ? 'Thanh toán Online' : 'Chưa có thông tin';
  const cancelled = order.status === 'Đã hủy' || order.payment_status === 'Đã hủy';
  const refunds = isV2 && Array.isArray(order.refunds) ? order.refunds : [];
  let notice;
  if (cancelled) {
    if (isV2 && order.payment_status === 'Đã thanh toán') {
      notice = 'Đơn hàng đã hủy sau khi ghi nhận thanh toán. Trạng thái xử lý hoàn tiền được hiển thị bên dưới; không có thao tác thanh toán trên trang này.';
    } else if (isV2 && order.cancellation_reason_code === 'payment_expired') {
      notice = 'Đơn hàng đã quá thời hạn thanh toán 24 giờ và đã tự động hủy. Không có thao tác thanh toán trên trang này.';
    } else {
      notice = 'Đơn hàng đã hủy. Không có thao tác thanh toán trên trang này.';
    }
  } else if (order.payment_status === 'Đã thanh toán') {
    notice = isV2 && !order.approved_at && order.status === 'Chờ xử lý'
      ? 'Thanh toán đã được ghi nhận. Đơn hàng đang chờ cửa hàng duyệt trước khi chuẩn bị giao.'
      : 'Thanh toán đã được ghi nhận theo thông tin của đơn hàng.';
  } else if (order.payment_method === 'COD') {
    notice = 'Bạn thanh toán khi nhận hàng. Trạng thái thu tiền được cập nhật từ cửa hàng.';
  } else if (order.payment_method === 'ONLINE' && payment) {
    if (isV2) {
      const failedPrefix = order.payment_status === 'Thất bại' ? 'Lần thanh toán gần nhất chưa thành công. ' : '';
      if (payment.can_simulate === true && payment.simulation_only === true) {
        notice = `${failedPrefix}Đơn Online được thanh toán trước khi Admin duyệt và có thể thanh toán mô phỏng trong môi trường kiểm thử. Giao diện thanh toán chưa được tích hợp.`;
      } else {
        notice = `${failedPrefix}Đơn Online được thanh toán trước khi Admin duyệt trong thời hạn quy định. Hiện cổng thanh toán trực tuyến và giao diện thanh toán chưa được tích hợp.`;
      }
    } else if (!payment.approved_at) {
      notice = 'Đơn hàng cần được Admin duyệt trước khi thanh toán.';
    } else if (payment.can_simulate === true && payment.simulation_only === true) {
      notice = 'Đơn hàng đã được Admin duyệt và có thể thanh toán mô phỏng. Giao diện thanh toán chưa được tích hợp.';
    } else {
      notice = 'Đơn hàng hiện chưa thể thanh toán. Vui lòng cập nhật trạng thái hoặc liên hệ cửa hàng. Giao diện thanh toán chưa được tích hợp.';
    }
  }
  return <section className="order-detail-card order-detail-payment" aria-labelledby="order-payment-title">
    <div className="order-detail-section-heading"><CreditCard size={20} aria-hidden="true" /><h2 id="order-payment-title">Thông tin thanh toán</h2></div>
    <dl className="order-detail-data">
      <div><dt>Phương thức</dt><dd>{method}</dd></div>
      <div><dt>Trạng thái thanh toán</dt><dd className="order-detail-payment-status">{order.payment_status || 'Chưa có thông tin'}</dd></div>
      {isV2 && recordedDate(order.payment_expires_at) && <div><dt>Hạn thanh toán</dt><dd><RecordedTime value={order.payment_expires_at} /></dd></div>}
      {recordedDate(order.transaction_date) && <div><dt>Thời gian ghi nhận</dt><dd><RecordedTime value={order.transaction_date} /></dd></div>}
    </dl>
    {(!state || state.loading) && <p className="order-detail-payment-loading" role="status">Đang kiểm tra thông tin thanh toán...</p>}
    {state?.error ? <div className="order-detail-payment-error"><ErrorNotice title="Chưa kiểm tra được thanh toán" message={state.error} onRetry={onRetry} /></div> : notice && <div className="order-detail-payment-note" role="status"><Info size={16} aria-hidden="true" /><p>{notice}</p></div>}
    {refunds.length > 0 && <div className="order-detail-refund-block">
      <h3 className="order-detail-subheading">Thông tin hoàn tiền</h3>
      <ul role="list" className="order-detail-refunds" aria-label="Danh sách yêu cầu hoàn tiền">
        {refunds.map((refund, index) => {
          const amountLabel = refund.currency && refund.currency !== 'VND' ? `${refund.amount} ${refund.currency}` : formatOrderMoney(refund.amount, true);
          return <li key={refund.refund_id || index} className={`order-detail-refund is-${refundTone(refund.status)}`} data-refund-id={refund.refund_id}>
            <div className="order-detail-refund-heading">
              <strong>{refundStatusLabels[refund.status] || 'Đang cập nhật hoàn tiền'}</strong>
              <span>{amountLabel}</span>
            </div>
            {refundReasonLabels[refund.reason_code] && <p>{refundReasonLabels[refund.reason_code]}</p>}
            <div className="order-detail-refund-times">
              {recordedDate(refund.requested_at_utc) && <span>Ghi nhận yêu cầu: <RecordedTime value={refund.requested_at_utc} /></span>}
              {refund.status === 'succeeded' && recordedDate(refund.confirmed_at_utc) && <span>Hoàn tất hoàn tiền: <RecordedTime value={refund.confirmed_at_utc} /></span>}
            </div>
          </li>;
        })}
      </ul>
      {refunds.some(refund => refund.status !== 'succeeded') && <p className="order-detail-muted">Yêu cầu hoàn tiền chỉ hoàn tất khi cổng thanh toán xác nhận trạng thái Đã hoàn tiền.</p>}
    </div>}
    {order.payment_method === 'ONLINE' && !cancelled && order.payment_status !== 'Đã thanh toán' && <p className="order-detail-muted">{isV2 ? 'Cổng thanh toán trực tuyến chưa được kết nối trên giao diện khách hàng. Xem đơn không thực hiện thanh toán.' : 'Thanh toán Online hiện chỉ có mô phỏng, chưa kết nối cổng thanh toán thật. Xem đơn không thực hiện thanh toán.'}</p>}
  </section>;
}

export default function OrderDetailPage({ orderId }) {
  const { user, authLoading, getOrder, getOrderPayment, cancelOrder } = useCommerce();
  const readers = useRef({ getOrder, getOrderPayment, cancelOrder });
  readers.current = { getOrder, getOrderPayment, cancelOrder };
  const validId = /^[1-9]\d*$/.test(orderId || '') && Number(orderId) <= 2147483647;
  const id = validId ? Number(orderId) : null;
  const [retry, setRetry] = useState(0);
  const [paymentRetry, setPaymentRetry] = useState(0);
  const [result, setResult] = useState(null);
  const [paymentResult, setPaymentResult] = useState(null);
  const [cancellation, setCancellation] = useState(null);
  const [cancellationNotice, setCancellationNotice] = useState(null);
  const cancellationRequest = useRef(null);
  const current = result && user && result.ownerId === user.user_id && result.orderId === id ? result : null;
  const originalOrder = current?.order;
  const paymentState = paymentResult && user && paymentResult.ownerId === user.user_id && paymentResult.order === originalOrder ? paymentResult : null;
  const payment = paymentState?.value;
  // The payment GET reads order/payment state atomically. Prefer that newer state
  // while retaining the immutable shipping/items/amount from the detail snapshot.
  const order = originalOrder && payment ? {
    ...originalOrder,
    status: payment.order_status,
    payment_status: payment.payment_status,
    approved_at: payment.approved_at,
    transaction_date: payment.transaction_date,
    approval_state: payment.approval_state ?? originalOrder.approval_state,
    rejection_reason: payment.rejection_reason ?? originalOrder.rejection_reason,
    workflow_version: payment.workflow_version ?? originalOrder.workflow_version,
    payment_expires_at: payment.payment_expires_at ?? originalOrder.payment_expires_at,
    cancellation_reason_code: payment.cancellation_reason_code ?? originalOrder.cancellation_reason_code,
    cancellation_reason: payment.cancellation_reason ?? originalOrder.cancellation_reason,
    cancelled_at: payment.cancelled_at ?? originalOrder.cancelled_at,
    can_cancel: payment.can_cancel ?? originalOrder.can_cancel,
    refunds: Array.isArray(payment.refunds) ? payment.refunds : originalOrder.refunds,
  } : originalOrder;
  const hasVoucher = Boolean(order?.voucher_code_snapshot) || (order?.discount_amount != null && Number(order.discount_amount) > 0);
  const loading = authLoading || !current || current.loading;
  const activeCancellation = cancellation?.ownerId === user?.user_id && cancellation?.orderId === id ? cancellation : null;
  const activeNotice = cancellationNotice?.ownerId === user?.user_id && cancellationNotice?.orderId === id ? cancellationNotice.message : '';

  useEffect(() => {
    setCancellation(null);
    setCancellationNotice(null);
    return () => { cancellationRequest.current = null; };
  }, [user?.user_id, id]);

  async function confirmCancellation(payload) {
    if (cancellationRequest.current || order?.can_cancel !== true || !user || !activeCancellation) return;
    const request = { ownerId: user.user_id, orderId: id };
    cancellationRequest.current = request;
    setCancellation({ ...request, busy: true, error: '' });
    try {
      const data = await readers.current.cancelOrder(id, payload);
      if (cancellationRequest.current !== request) return;
      const updated = data.order;
      if (!updated || updated.user_id !== request.ownerId || updated.order_id !== id || updated.status !== 'Đã hủy' || !Array.isArray(updated.items)) {
        throw new Error('Chưa nhận được thông tin hủy đơn hợp lệ từ máy chủ.');
      }
      setPaymentResult(null);
      setResult({ ...request, loading: false, order: updated, error: '', status: null });
      setCancellation(null);
      setCancellationNotice({ ...request, message: 'Đã hủy đơn hàng thành công.' });
    } catch (error) {
      if (cancellationRequest.current !== request || error.obsolete || [401, 403].includes(error.status)) return;
      setCancellation({ ...request, busy: false, error: error.message });
    } finally {
      if (cancellationRequest.current === request) cancellationRequest.current = null;
    }
  }

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
        typeof value.total_amount !== 'string' || (value.workflow_version != null && value.workflow_version !== 2) ||
        (value.subtotal_amount != null && typeof value.subtotal_amount !== 'string') ||
        (value.discount_amount != null && typeof value.discount_amount !== 'string') ||
        (value.voucher_code_snapshot != null && typeof value.voucher_code_snapshot !== 'string') ||
        (value.refunds != null && !Array.isArray(value.refunds)) ||
        value.items.some(item => !item || !Number.isSafeInteger(item.product_id) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) {
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
        typeof value.payment_status !== 'string' || typeof value.can_simulate !== 'boolean' ||
        (value.workflow_version != null && originalOrder.workflow_version != null && value.workflow_version !== originalOrder.workflow_version) ||
        (value.refunds != null && !Array.isArray(value.refunds))) {
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
      <section className="order-detail-overview"><div><div className="order-detail-number"><Package size={22} aria-hidden="true" /><h2>Đơn hàng #{order.order_id}</h2></div><p><CalendarDays size={14} aria-hidden="true" />Ngày đặt: {formatOrderDate(order.order_date, true) || 'Chưa có thông tin'}</p></div><div className="order-detail-overview-actions"><OrderStatusBadge order={order} className="order-detail-status" /><button className="order-detail-refresh" type="button" disabled={activeCancellation?.busy} onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />Cập nhật trạng thái</button>{order.can_cancel === true && <button className="button order-detail-cancel-button" type="button" onClick={() => { setCancellationNotice(null); setCancellation({ ownerId: user.user_id, orderId: id, busy: false, error: '' }); }}>Hủy đơn hàng</button>}</div></section>
      {activeNotice && <p className="order-cancel-success" role="status">{activeNotice}</p>}
      {order.cancellation_reason_code === 'customer_cancelled' && <section className="order-detail-rejection" aria-labelledby="order-cancellation-title"><h2 id="order-cancellation-title">Lý do hủy đơn</h2><p>{order.cancellation_reason || 'Khách hàng yêu cầu hủy đơn.'}</p>{recordedDate(order.cancelled_at) && <p>Thời gian hủy: <RecordedTime value={order.cancelled_at} /></p>}</section>}
      {order.rejection_reason && <section className="order-detail-rejection" aria-labelledby="order-rejection-title"><h2 id="order-rejection-title">Lý do từ chối</h2><p>{order.rejection_reason}</p></section>}
      <OrderProgress order={order} />
      <div className="order-detail-layout"><div className="order-detail-main">
        <section className="order-detail-card order-detail-products" aria-labelledby="order-products-title"><div className="order-detail-section-heading"><Package size={20} aria-hidden="true" /><h2 id="order-products-title">Sản phẩm đã đặt</h2><span>{order.items.length} loại sản phẩm</span></div><OrderItems items={order.items} orderId={order.order_id} className="order-detail-items" itemClassName="order-detail-item" /><OrderReviewLinks order={order} /></section>
        <section className="order-detail-card order-detail-shipping" aria-labelledby="order-shipping-title"><div className="order-detail-section-heading"><MapPin size={20} aria-hidden="true" /><h2 id="order-shipping-title">Thông tin nhận hàng</h2></div><dl className="order-detail-data"><div><dt>Người nhận</dt><dd>{order.recipient_name || 'Chưa có thông tin'}</dd></div><div><dt>Số điện thoại</dt><dd>{order.phone || 'Chưa có thông tin'}</dd></div><div><dt>Địa chỉ</dt><dd className="order-detail-multiline">{order.shipping_address || 'Chưa có thông tin'}</dd></div><div><dt>Ghi chú</dt><dd className="order-detail-multiline">{order.note || 'Không có ghi chú'}</dd></div></dl></section>
        <OrderHistory history={order.history} />
      </div><aside className="order-detail-summary">
        <section className="order-detail-card order-detail-totals" aria-labelledby="order-total-title"><div className="order-detail-section-heading"><CreditCard size={20} aria-hidden="true" /><h2 id="order-total-title">Tổng tiền đơn hàng</h2></div><dl>{hasVoucher ? <>
          <div className="order-detail-subtotal"><dt>Tạm tính</dt><dd>{formatOrderMoney(order.subtotal_amount ?? order.total_amount, true)}</dd></div>
          <div className="order-detail-voucher-discount"><dt>Giảm giá Voucher{order.voucher_code_snapshot ? <span className="order-detail-voucher-code">{order.voucher_code_snapshot}</span> : null}</dt><dd>{order.discount_amount == null ? 'Chưa có thông tin' : `−${formatOrderMoney(order.discount_amount, true)}`}</dd></div>
        </> : <div><dt>Tiền hàng</dt><dd>{formatOrderMoney(order.total_amount)}</dd></div>}<div><dt>Phí vận chuyển</dt><dd>Chưa tính</dd></div><div className="order-detail-total"><dt>Tổng tiền hàng</dt><dd>{formatOrderMoney(order.total_amount, hasVoucher)}</dd></div></dl><p className="order-detail-muted">Tổng tiền chưa gồm phí vận chuyển. Phí vận chuyển hiện chưa được quy định.</p></section>
        <PaymentDetails order={order} state={paymentState} onRetry={() => setPaymentRetry(value => value + 1)} />
      </aside></div>
      {activeCancellation && <CancelOrderDialog order={order} busy={activeCancellation.busy} error={activeCancellation.error || (order.can_cancel !== true ? 'Trạng thái đơn hàng đã thay đổi. Đơn hàng hiện không đủ điều kiện hủy.' : '')} onClose={() => { if (!cancellationRequest.current) setCancellation(null); }} onConfirm={confirmCancellation} onReload={() => { setCancellation(null); setRetry(value => value + 1); }} />}
    </> : null}
  </div>;
}
