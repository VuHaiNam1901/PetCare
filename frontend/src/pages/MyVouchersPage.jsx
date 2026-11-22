import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, ClipboardList, Copy, LogOut, PawPrint, ShoppingBag, TicketPercent, UserRound } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { useVoucherReadiness } from '../hooks/useVoucherReadiness.js';
import { ErrorNotice } from '../components/Feedback.jsx';
import { BRAND_NAME } from '../config/branding.js';
import '../my-orders.css';
import '../my-vouchers.css';

const PAGE_SIZE = 12;
const money = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' });

export default function MyVouchersPage() {
  const { user, authLoading, busy, getCustomerVouchers, logout, notify } = useCommerce();
  const readiness = useVoucherReadiness();
  const readVouchers = useRef(getCustomerVouchers);
  readVouchers.current = getCustomerVouchers;
  const ownerId = user?.role === 'user' ? String(user.user_id) : null;
  const currentOwner = useRef(ownerId);
  currentOwner.current = ownerId;
  const [page, setPage] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('page') || '1';
    return /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : 1;
  });
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState({ ownerId: null, code: '' });
  const current = readiness.ready && result?.ownerId === ownerId && result?.page === page && result?.revision === revision ? result : null;
  const loading = !current || current.loading;

  useEffect(() => {
    const previous = document.title;
    document.title = `Voucher của tôi | ${BRAND_NAME}`;
    return () => { document.title = previous; currentOwner.current = null; };
  }, []);

  useEffect(() => {
    if (authLoading || user) return;
    window.location.replace('/login?returnTo=%2Fmy-vouchers');
  }, [authLoading, user?.user_id]);

  useEffect(() => {
    if (authLoading || ownerId === null || !readiness.ready) return;
    const controller = new AbortController();
    let active = true;
    setResult({ ownerId, page, revision, loading: true, vouchers: [], total: 0, error: '' });
    readVouchers.current({ assignedOnly: true, page, limit: PAGE_SIZE, signal: controller.signal }).then(data => {
      if (!active) return;
      const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (page > lastPage) { navigate(lastPage); return; }
      setResult({ ownerId, page, revision, loading: false, vouchers: data.vouchers, total: data.total, error: '' });
    }).catch(error => {
      if (!active || controller.signal.aborted || error.obsolete) return;
      setResult({ ownerId, page, revision, loading: false, vouchers: [], total: 0, error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [authLoading, ownerId, readiness.ready, page, revision]);

  function navigate(nextPage) {
    window.history.replaceState(null, '', `/my-vouchers${nextPage > 1 ? `?page=${nextPage}` : ''}`);
    setPage(nextPage);
  }

  async function copyCode(code) {
    try {
      await navigator.clipboard.writeText(code);
      if (currentOwner.current === ownerId) setCopied({ ownerId, code });
    } catch {
      if (currentOwner.current === ownerId) notify('Chưa sao chép được mã. Bạn có thể chọn mã Voucher để sao chép thủ công.');
    }
  }

  return <div className="container my-orders-page my-vouchers-page">
    <nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">Voucher của tôi</span></nav>
    <div className="my-orders-page-heading"><div><p className="my-orders-eyebrow">ƯU ĐÃI DÀNH CHO BẠN</p><h1>Voucher của tôi</h1><p>Các mã được cửa hàng tặng riêng, còn hiệu lực và còn lượt dùng cho tài khoản của bạn.</p></div><a className="button button-outline my-orders-shop" href="/products"><ShoppingBag size={16} aria-hidden="true" />Tiếp tục mua sắm</a></div>
    {authLoading || !user ? <section className="my-vouchers-state" role="status"><p>Đang kiểm tra đăng nhập...</p></section>
      : user.role !== 'user' ? <section className="my-vouchers-state"><UserRound size={36} aria-hidden="true" /><h2>Voucher dành cho tài khoản khách hàng</h2><p>Vui lòng đăng nhập bằng tài khoản khách hàng để xem các mã được tặng cho bạn.</p></section>
        : <div className="my-orders-layout">
          <aside className="my-orders-account" aria-label="Tài khoản khách hàng"><div className="my-orders-profile"><span><UserRound size={26} aria-hidden="true" /></span><div><small>Xin chào,</small><strong>{user.full_name || 'Khách hàng'}</strong></div></div><nav aria-label="Tài khoản"><a href="/profile"><UserRound size={18} aria-hidden="true" /><span>Thông tin cá nhân</span></a><a href="/my-pets"><PawPrint size={18} aria-hidden="true" /><span>Thú cưng của tôi</span></a><a href="/my-orders"><ClipboardList size={18} aria-hidden="true" /><span>Đơn hàng của tôi</span></a><a href="/my-vouchers" aria-current="page"><TicketPercent size={18} aria-hidden="true" /><span>Voucher của tôi</span><ChevronRight size={14} aria-hidden="true" /></a><button className="my-orders-account-logout" type="button" disabled={busy} onClick={() => logout().catch(error => notify(error.message))}><LogOut size={18} aria-hidden="true" /><span>Đăng xuất</span></button></nav></aside>
          <section className="my-orders-content" aria-label="Voucher được tặng">
            {readiness.loading ? <div className="my-vouchers-state" role="status"><p>Đang kiểm tra Voucher...</p></div>
              : !readiness.ready ? <ErrorNotice title="Voucher hiện chưa sẵn sàng" message={readiness.error || 'Vui lòng thử lại sau.'} onRetry={readiness.retry} />
                : loading ? <div className="my-vouchers-state" role="status"><TicketPercent size={36} aria-hidden="true" /><p>Đang tải Voucher của bạn...</p></div>
                  : current.error ? <ErrorNotice title="Chưa tải được Voucher" message={current.error} onRetry={() => setRevision(value => value + 1)} />
                    : !current.vouchers.length ? <div className="my-vouchers-state"><TicketPercent size={40} strokeWidth={1.4} aria-hidden="true" /><h2>Bạn chưa có Voucher để sử dụng</h2><p>Các mã được cửa hàng tặng sẽ xuất hiện ở đây khi còn hiệu lực và còn lượt dùng.</p><a className="button button-primary" href="/products">Khám phá sản phẩm</a></div>
                      : <><p className="my-vouchers-count" role="status">{current.total} Voucher được tặng · Mỗi đơn dùng một mã</p><ul className="my-vouchers-list">{current.vouchers.map(voucher => {
                        const isCopied = copied.ownerId === ownerId && copied.code === voucher.code;
                        return <li className="my-voucher-card" key={voucher.code}>
                          <div className="my-voucher-card-heading"><TicketPercent size={23} aria-hidden="true" /><code>{voucher.code}</code></div>
                          <h2>{voucher.discount_type === 'percent' ? `Giảm ${percent.format(Number(voucher.discount_value))}%` : `Giảm ${money.format(Number(voucher.discount_value))}`}</h2>
                          <dl><div><dt>Đơn tối thiểu</dt><dd>{money.format(Number(voucher.minimum_order_amount))}</dd></div>{voucher.max_discount_amount !== null && <div><dt>Giảm tối đa</dt><dd>{money.format(Number(voucher.max_discount_amount))}</dd></div>}<div><dt>Hạn sử dụng</dt><dd><time dateTime={voucher.ends_at_utc}>{dates.format(new Date(voucher.ends_at_utc))}</time></dd></div></dl>
                          <button className="button button-outline" type="button" aria-label={`Sao chép mã ${voucher.code}`} onClick={() => copyCode(voucher.code)}>{isCopied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}<span aria-live="polite">{isCopied ? 'Đã sao chép' : 'Sao chép mã'}</span></button>
                        </li>;
                      })}</ul><p className="my-vouchers-note">Nhập mã ở bước đặt hàng. Điều kiện và lượt dùng sẽ được kiểm tra lại khi bạn áp dụng mã và xác nhận đơn.</p></>}
            {!loading && !current.error && current.total > 0 && <nav className="my-orders-pagination" aria-label="Phân trang Voucher"><p>Trang <strong>{page}</strong> / {Math.max(1, Math.ceil(current.total / PAGE_SIZE))}</p><div><button className="button button-outline" type="button" disabled={page <= 1} onClick={() => navigate(page - 1)}><ChevronLeft size={16} aria-hidden="true" />Trước</button><button className="button button-outline" type="button" disabled={page * PAGE_SIZE >= current.total} onClick={() => navigate(page + 1)}>Tiếp theo<ChevronRight size={16} aria-hidden="true" /></button></div></nav>}
          </section>
        </div>}
  </div>;
}
