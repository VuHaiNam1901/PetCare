import { useEffect, useRef, useState } from 'react';
import { formatOrderDate, formatOrderMoney } from '../utils/orders.js';
import '../sepay-test-qr.css';

// The backend selects the mode. Rendering never creates orders or confirms a
// payment; the original filename is retained for Sandbox compatibility.
export function getSePayStatus(order, payment) {
  const status = payment?.sepayStatus ?? payment?.sepayTestStatus;
  if (!status || status.provider !== 'SEPAY' || !['test', 'live'].includes(status.mode) || typeof status.reviewRequired !== 'boolean' ||
    typeof status.disposition !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(status.disposition) ||
    order?.payment_method !== 'ONLINE' || payment.payment_method !== 'ONLINE' ||
    order.workflow_version !== 2 || payment.workflow_version !== 2 ||
    order.order_id !== payment.order_id || order.status !== payment.order_status || order.payment_status !== payment.payment_status) return null;
  const rejected = order.approval_state === 'rejected' || payment.approval_state === 'rejected' || Boolean(order.rejection_reason || payment.rejection_reason);
  const cancelled = order.status === 'Đã hủy' || order.payment_status === 'Đã hủy';
  const deadline = typeof order.payment_expires_at === 'string' && order.payment_expires_at === payment.payment_expires_at
    ? Date.parse(order.payment_expires_at) : NaN;
  const expired = Number.isFinite(deadline) && deadline <= Date.now();
  const view = rejected ? 'rejected' : cancelled ? (order.cancellation_reason_code === 'payment_expired' ? 'expired' : 'cancelled')
    : payment.payment_status === 'Đã thanh toán' ? 'paid' : expired ? 'expired' : status.reviewRequired ? 'review' : 'pending';
  return { ...status, view };
}

export function getSePayQr(order, payment) {
  const qr = payment?.sepay ?? payment?.sepayTest;
  const status = getSePayStatus(order, payment);
  if (!qr || qr.provider !== 'SEPAY' || !['test', 'live'].includes(qr.mode) || typeof qr.reconciliationOnly !== 'boolean' ||
    (status && status.mode !== qr.mode) || (qr.mode === 'live' && qr.reconciliationOnly) ||
    (qr.reconciliationOnly === false && !status) || status?.reviewRequired === true || status?.view === 'expired' ||
    order?.payment_method !== 'ONLINE' || payment.payment_method !== 'ONLINE' ||
    order.workflow_version !== 2 || payment.workflow_version !== 2 ||
    order.status !== 'Chờ thanh toán' || payment.order_status !== 'Chờ thanh toán' ||
    !['Chưa thanh toán', 'Thất bại'].includes(payment.payment_status) || order.payment_status !== payment.payment_status ||
    order.approval_state === 'rejected' || payment.approval_state === 'rejected' ||
    order.transaction_date || payment.transaction_date || order.rejection_reason || payment.rejection_reason ||
    !Number.isSafeInteger(qr.orderId) || qr.orderId <= 0 || qr.orderId !== order.order_id || qr.orderId !== payment.order_id ||
    typeof qr.amount !== 'string' || !/^[1-9]\d{0,9}\.00$/.test(qr.amount) ||
    Number(qr.amount) < 1000 || Number(qr.amount) > 499000000 ||
    qr.amount !== order.total_amount || qr.amount !== payment.amount ||
    qr.paymentCode !== `PCS${qr.orderId}` || qr.transferContent !== `SEVQR PCS${qr.orderId}` ||
    qr.bank !== 'VietinBank' || typeof qr.accountNumber !== 'string' || !/^[0-9]{4,32}$/.test(qr.accountNumber) ||
    typeof qr.accountName !== 'string' || !qr.accountName.trim() || qr.accountName.length > 128 ||
    typeof qr.expiresAt !== 'string' || !Number.isFinite(Date.parse(qr.expiresAt)) ||
    Date.parse(qr.expiresAt) <= Date.now() ||
    qr.expiresAt !== payment.payment_expires_at || qr.expiresAt !== order.payment_expires_at ||
    typeof qr.qrUrl !== 'string') return null;
  try {
    const url = new URL(qr.qrUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'vietqr.app' || url.port || url.username || url.password ||
      url.pathname !== '/img' || url.hash || [...url.searchParams].length !== 4 ||
      url.searchParams.get('bank') !== qr.bank || url.searchParams.get('acc') !== qr.accountNumber ||
      url.searchParams.get('amount') !== qr.amount.slice(0, -3) || url.searchParams.get('des') !== qr.transferContent) return null;
  } catch { return null; }
  return qr;
}

export function SePayPaymentDialog({ qr, onRefresh, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const node = dialog.current;
    const opener = document.activeElement;
    node.showModal();
    return () => { if (node.open) node.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={dialog} className="sepay-payment-dialog" aria-labelledby="sepay-dialog-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="sepay-payment-dialog-header"><h2 id="sepay-dialog-title">Thanh toán đơn hàng #{qr.orderId}</h2>
      <button type="button" className="sepay-payment-dialog-close" aria-label="Đóng QR và xem chi tiết đơn hàng" onClick={onClose}>×</button>
    </div>
    <SePayQr qr={qr} onRefresh={onRefresh} />
  </dialog>;
}

const testStatusLabels = {
  pending: 'Chờ thanh toán thử nghiệm', paid: 'Đã ghi nhận thanh toán thử nghiệm',
  review: 'Giao dịch thử nghiệm cần đối soát', expired: 'Đã hết thời hạn thanh toán thử nghiệm',
  cancelled: 'Đơn thử nghiệm đã hủy', rejected: 'Đơn thử nghiệm đã bị từ chối',
};
const statusLabels = {
  pending: 'Chờ thanh toán', paid: 'Đã ghi nhận thanh toán', review: 'Giao dịch cần đối soát',
  expired: 'Đã hết thời hạn thanh toán', cancelled: 'Đơn hàng đã hủy', rejected: 'Đơn hàng đã bị từ chối',
};

export function SePayStatus({ status, onRefresh }) {
  const testMode = status.mode === 'test';
  const tone = status.view === 'paid' ? 'is-paid' : status.reviewRequired ? 'is-review' : 'is-neutral';
  return <div className={`sepay-test-qr sepay-test-status-card ${tone}`} aria-labelledby="sepay-test-status-title">
    <div className="sepay-test-qr-header">
      <strong className="sepay-test-qr-badge">{testMode ? 'DEMO / TEST – Không chuyển tiền thật' : 'Chuyển khoản ngân hàng'}</strong>
      <h3 id="sepay-test-status-title">{testMode ? 'Thanh toán thử nghiệm SePay' : 'Thanh toán SePay'}</h3>
    </div>
    <p className={`sepay-test-status ${tone}`} role="status">{(testMode ? testStatusLabels : statusLabels)[status.view]}</p>
    {testMode && <p className="sepay-test-qr-warning">Chỉ mô phỏng trong SePay Test Mode; tuyệt đối không chuyển tiền thật.</p>}
    {status.reviewRequired && <p className="sepay-test-qr-warning">{testMode ? 'Giao dịch thử nghiệm có thông tin cần cửa hàng đối soát. Vui lòng kiểm tra kết quả trước khi mô phỏng thêm.' : 'Giao dịch cần cửa hàng đối soát. Vui lòng liên hệ cửa hàng trước khi chuyển khoản thêm.'}</p>}
    <p className="sepay-test-qr-note">{testMode ? 'Cập nhật trạng thái sau khi mô phỏng giao dịch để xem kết quả mới nhất từ máy chủ. Đơn đã hủy, từ chối hoặc hết hạn không được khôi phục bởi giao dịch thử nghiệm.' : 'Cập nhật trạng thái để xem kết quả mới nhất. Nếu đã chuyển khoản cho đơn bị hủy, từ chối hoặc hết hạn, vui lòng liên hệ cửa hàng để được đối soát.'}</p>
    <button className="button button-outline sepay-test-refresh-btn" type="button" onClick={onRefresh}>Cập nhật trạng thái thanh toán</button>
  </div>;
}

export default function SePayQr({ qr, onRefresh }) {
  const testMode = qr.mode === 'test';
  const deadline = Date.parse(qr.expiresAt);
  const [expired, setExpired] = useState(() => deadline <= Date.now());
  const [imageError, setImageError] = useState(false);
  const [copiedField, setCopiedField] = useState('');
  useEffect(() => {
    const remaining = deadline - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setExpired(true), Math.min(remaining, 2147483647));
    return () => window.clearTimeout(timer);
  }, [deadline]);

  function copyValue(field, value) {
    if (!navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(String(value)).then(() => {
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(current => (current === field ? '' : current)), 1800);
    }).catch(() => {});
  }

  return <div className="sepay-test-qr" aria-labelledby="sepay-test-qr-title">
    <div className="sepay-test-qr-header">
      <strong className="sepay-test-qr-badge">{testMode ? 'DEMO / TEST – Không chuyển tiền thật' : 'Chuyển khoản ngân hàng'}</strong>
      <h3 id="sepay-test-qr-title">{testMode ? 'QR DEMO thanh toán SePay' : 'Quét QR thanh toán SePay'}</h3>
    </div>
    <p className="sepay-test-qr-warning">{testMode ? `Chỉ mô phỏng trong SePay Test Mode; không chuyển tiền thật. ${qr.reconciliationOnly ? 'Webhook lượt này chỉ đối chiếu, chưa xác nhận thanh toán.' : 'Thanh toán chỉ được ghi nhận khi máy chủ xác thực và đối chiếu Webhook hợp lệ.'}` : 'Chuyển đúng số tiền và nội dung bên dưới. Hệ thống sẽ cập nhật sau khi xác nhận giao dịch từ ngân hàng.'}</p>
    {expired ? <p className="sepay-test-qr-expired" role="status">Mã thanh toán đã hết hạn. Cập nhật trạng thái đơn hàng để xem thông tin mới nhất.</p>
      : imageError ? <p className="sepay-test-qr-expired" role="status">Chưa tải được hình QR. Thông tin thanh toán vẫn được hiển thị bên dưới.</p>
        : <div className="sepay-test-qr-frame">
          <img className="sepay-test-qr-image" src={qr.qrUrl} alt={testMode ? `QR DEMO SePay Test Mode cho đơn hàng ${qr.orderId}, không chuyển tiền thật` : `QR thanh toán SePay cho đơn hàng ${qr.orderId}`} width="240" height="240" referrerPolicy="no-referrer" onError={() => setImageError(true)} />
          <span className="sepay-test-qr-caption">{testMode ? 'Mã QR VietQR giả lập phục vụ SePay Test Mode' : 'Mã QR VietQR thanh toán đơn hàng'}</span>
        </div>}
    <dl className="sepay-test-qr-data">
      <div><dt>Mã đơn hàng</dt><dd><strong>#{qr.orderId}</strong></dd></div>
      <div><dt>Số tiền thanh toán</dt><dd><strong className="sepay-test-qr-amount">{formatOrderMoney(qr.amount, true)}</strong></dd></div>
      <div><dt>Nội dung chuyển khoản</dt><dd className="sepay-test-qr-copy-row"><code>{qr.transferContent}</code><button type="button" className="sepay-test-copy-btn" onClick={() => copyValue('content', qr.transferContent)}>{copiedField === 'content' ? 'Đã chép' : 'Sao chép'}</button></dd></div>
      <div><dt>{testMode ? 'Ngân hàng giả lập' : 'Ngân hàng'}</dt><dd>{qr.bank}</dd></div>
      <div><dt>{testMode ? 'Tài khoản giả lập' : 'Tài khoản nhận'}</dt><dd>{qr.accountNumber} — {qr.accountName}</dd></div>
      <div><dt>Trạng thái</dt><dd><span className={`sepay-test-inline-pill ${expired ? 'is-expired' : 'is-pending'}`}>{expired ? 'Đã hết hạn mã thanh toán' : testMode ? 'Chờ thanh toán — thử nghiệm' : 'Chờ thanh toán'}</span></dd></div>
      <div><dt>Hạn thanh toán</dt><dd><time dateTime={qr.expiresAt}>{formatOrderDate(qr.expiresAt, true)}</time></dd></div>
    </dl>
    <p className="sepay-test-qr-note">Mở lại mã QR luôn dùng đúng đơn hàng đã lưu. Việc hiển thị QR không tự xác nhận thanh toán.</p>
    <button className="button button-outline sepay-test-refresh-btn" type="button" onClick={onRefresh}>Cập nhật trạng thái thanh toán</button>
  </div>;
}

export { getSePayQr as getSePayTestQr, getSePayStatus as getSePayTestStatus, SePayStatus as SePayTestStatus };
