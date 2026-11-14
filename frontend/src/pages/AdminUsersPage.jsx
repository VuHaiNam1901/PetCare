import { AdminSidebar } from '../components/AdminVoucherNavLink.jsx';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, LockKeyhole, RefreshCw, Search, ShieldCheck, UnlockKeyhole, X } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { EmptyState, ErrorNotice } from '../components/Feedback.jsx';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../admin-orders.css';
import '../admin-products.css';
import '../admin-users.css';

const PAGE_SIZE = 20;
const STATUSES = ['active', 'inactive'];
const STATUS_LABELS = { active: 'Đang hoạt động', inactive: 'Đã khóa' };
const EMPTY_FILTERS = { q: '', status: '' };
const positiveId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const invalidSearch = value => value.trim().length > 150 || /[\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(value) || [...value].some(char => char.codePointAt(0) > 65535);

function customerFields(customer) {
  if (!customer || !positiveId(customer.user_id) || customer.role !== 'user' || !STATUSES.includes(customer.status) ||
    typeof customer.full_name !== 'string' || typeof customer.email !== 'string' || (customer.phone != null && typeof customer.phone !== 'string')) {
    throw new Error('Thông tin tài khoản khách hàng chưa hợp lệ. Vui lòng tải lại danh sách.');
  }
  // Keep and render only the fields needed to identify a customer account.
  return { user_id: customer.user_id, full_name: customer.full_name, email: customer.email,
    phone: customer.phone || '', role: customer.role, status: customer.status };
}

function UsersLoading({ label = 'Đang tải người dùng' }) {
  return <div className="admin-products-loading" role="status"><p>{label}...</p>{[0, 1, 2, 3].map(index => <div key={index} className="skeleton skeleton-line" aria-hidden="true" />)}</div>;
}

function StatusConfirmation({ customer, targetStatus, busy, error, onClose, onConfirm }) {
  const ref = useRef(null);
  const locking = targetStatus === 'inactive';
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="admin-orders-dialog admin-products-dialog admin-users-dialog" aria-labelledby="admin-user-status-title" aria-describedby="admin-user-status-note" aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="admin-products-dialog-heading"><h2 id="admin-user-status-title">{locking ? 'Khóa tài khoản' : 'Mở khóa tài khoản'}</h2><button className="icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Đóng hộp thoại"><X size={22} aria-hidden="true" /></button></div>
    <dl className="admin-users-confirm-account"><div><dt>Tài khoản</dt><dd>{customer.full_name || 'Chưa có tên'} · #{customer.user_id}</dd></div><div><dt>Email</dt><dd>{customer.email || 'Chưa có email'}</dd></div><div><dt>Trạng thái</dt><dd>{STATUS_LABELS[customer.status]} → <strong>{STATUS_LABELS[targetStatus]}</strong></dd></div></dl>
    <div className="admin-products-stop-copy"><p id="admin-user-status-note">{locking ? 'Tài khoản sẽ bị chặn ở các yêu cầu cần đăng nhập tiếp theo. Đơn hàng và dữ liệu liên quan vẫn được giữ lại.' : 'Tài khoản có thể tiếp tục sử dụng các chức năng dành cho khách hàng khi phiên đăng nhập hợp lệ.'}</p></div>
    {error && <p className="admin-products-form-error" role="alert">{error}</p>}
    <div className="admin-products-dialog-actions"><button type="button" className="button button-outline" autoFocus disabled={busy} onClick={onClose}>Hủy</button><button type="button" className={`button ${locking ? 'admin-orders-button-danger-outline' : 'button-primary'}`} disabled={busy} onClick={onConfirm}>{busy ? 'Đang cập nhật...' : locking ? 'Xác nhận khóa' : 'Xác nhận mở khóa'}</button></div>
  </dialog>;
}

function AdminUserList() {
  const { getAdminUsers, updateAdminUserStatus } = useCommerce();
  const methods = useRef({});
  methods.current = { getAdminUsers, updateAdminUserStatus };
  const [draft, setDraft] = useState({ ...EMPTY_FILTERS });
  const [query, setQuery] = useState({ ...EMPTY_FILTERS, page: 1 });
  const [filterError, setFilterError] = useState('');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const busyRef = useRef(false);
  const alive = useRef(false);
  const current = result?.query === query && result?.revision === revision ? result : null;
  const loading = !current || current.loading;
  const hasFilters = Boolean(query.q || query.status);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ query, revision, loading: true, users: [], total: 0, error: '' });
    methods.current.getAdminUsers({ ...query, limit: PAGE_SIZE, signal: controller.signal }).then(data => {
      if (!active) return;
      if (!Array.isArray(data.users) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('Danh sách người dùng chưa hợp lệ. Vui lòng thử lại.');
      const customers = data.users.map(customerFields);
      const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (query.page > lastPage) { setQuery(previous => ({ ...previous, page: lastPage })); return; }
      setResult({ query, revision, loading: false, users: customers, total: data.total, error: '' });
    }).catch(error => {
      if (active && !controller.signal.aborted && !error.obsolete && ![401, 403].includes(error.status)) setResult({ query, revision, loading: false, users: [], total: 0, error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [query, revision]);

  const reload = () => { if (!busyRef.current) setRevision(value => value + 1); };
  const reset = () => { if (!busyRef.current) { setDraft({ ...EMPTY_FILTERS }); setFilterError(''); setQuery({ ...EMPTY_FILTERS, page: 1 }); } };
  const applyFilters = event => {
    event.preventDefault();
    if (busyRef.current) return;
    if (invalidSearch(draft.q)) { setFilterError('Tìm theo tên hoặc email, tối đa 150 ký tự; không dùng emoji hoặc ký tự điều khiển.'); return; }
    setFilterError(''); setQuery({ q: draft.q.trim(), status: draft.status, page: 1 });
  };
  const openConfirmation = customer => {
    if (busyRef.current || customer.role !== 'user' || !STATUSES.includes(customer.status)) return;
    setActionError(''); setSuccess('');
    setConfirmation({ customer, targetStatus: customer.status === 'active' ? 'inactive' : 'active' });
  };
  const closeConfirmation = () => { if (!busyRef.current) { setConfirmation(null); setActionError(''); } };
  const confirmStatus = async () => {
    if (busyRef.current || !confirmation || confirmation.customer.role !== 'user' || !STATUSES.includes(confirmation.targetStatus)) return;
    busyRef.current = true; setBusy(true); setActionError(''); setSuccess('');
    const { customer, targetStatus } = confirmation;
    try {
      const data = await methods.current.updateAdminUserStatus(customer.user_id, targetStatus);
      if (!alive.current) return;
      const saved = customerFields(data.user);
      if (saved.user_id !== customer.user_id || saved.status !== targetStatus) throw new Error('Chưa xác nhận được trạng thái sau khi lưu. Hãy đóng hộp thoại và tải lại danh sách để kiểm tra.');
      setConfirmation(null);
      setSuccess(`Đã ${targetStatus === 'inactive' ? 'khóa' : 'mở khóa'} tài khoản ${saved.full_name || saved.email} (#${saved.user_id}).`);
      // A failed refresh does not change the outcome of a confirmed status update.
      setRevision(value => value + 1);
    } catch (error) {
      if (alive.current && !error.obsolete && ![401, 403].includes(error.status)) setActionError((error.message || 'Chưa cập nhật được trạng thái tài khoản.') + (!error.status ? ' Hãy tải lại danh sách để kiểm tra trước khi thử lại.' : ''));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return <>
    {success && <p className="admin-orders-success" role="status"><Check size={18} aria-hidden="true" />{success}</p>}
    <form className="admin-products-filters admin-users-filters" noValidate onSubmit={applyFilters} aria-label="Tìm kiếm và lọc người dùng">
      <div className="admin-products-filter"><label htmlFor="admin-users-q">Tên hoặc email</label><div className="admin-products-filter-search"><Search size={17} aria-hidden="true" /><input id="admin-users-q" type="search" maxLength={150} value={draft.q} onChange={event => setDraft(previous => ({ ...previous, q: event.target.value }))} placeholder="Nhập tên hoặc email..." /></div></div>
      <div className="admin-products-filter"><label htmlFor="admin-users-status">Trạng thái tài khoản</label><select id="admin-users-status" value={draft.status} onChange={event => setDraft(previous => ({ ...previous, status: event.target.value }))}><option value="">Tất cả trạng thái</option>{STATUSES.map(status => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></div>
      <div className="admin-products-filter-actions"><button className="button button-primary" type="submit" disabled={busy}><Search size={16} aria-hidden="true" />Áp dụng</button><button className="button button-outline" type="button" disabled={busy} onClick={reset}>Xóa bộ lọc</button></div>
    </form>
    {filterError && <p className="admin-products-form-error" role="alert">{filterError}</p>}
    <div className="admin-products-list-heading"><p aria-live="polite">{loading ? 'Đang tải danh sách...' : current.error ? 'Chưa tải được danh sách' : `${current.total} tài khoản khách hàng${hasFilters ? ' phù hợp bộ lọc' : ''}`}</p><button className="button button-outline" type="button" disabled={busy || loading} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Tải lại</button></div>
    {loading ? <UsersLoading /> : current.error ? <ErrorNotice title="Chưa tải được người dùng" message={current.error} onRetry={reload} /> : !current.users.length ? <EmptyState title={hasFilters ? 'Chưa tìm thấy tài khoản phù hợp' : 'Chưa có tài khoản khách hàng'} message={hasFilters ? 'Thử tên hoặc email khác, hoặc thay đổi bộ lọc trạng thái.' : 'Danh sách hiện chưa có tài khoản khách hàng để quản lý.'} onReset={hasFilters ? reset : undefined} /> : <>
      <div className="admin-products-table-wrap"><table className="admin-products-table"><caption className="sr-only">Danh sách tài khoản khách hàng</caption><thead><tr><th scope="col">Tài khoản</th><th scope="col">Liên hệ</th><th scope="col">Trạng thái</th><th scope="col">Thao tác</th></tr></thead><tbody>{current.users.map(customer => <tr key={customer.user_id}>
        <td className="admin-products-product-cell" data-label="Tài khoản"><div><strong>{customer.full_name || 'Chưa có tên'}</strong><small>#{customer.user_id}</small><span className="admin-users-email">{customer.email || 'Chưa có email'}</span></div></td>
        <td data-label="Liên hệ"><div className="admin-users-contact"><span>{customer.phone || 'Chưa có số điện thoại'}</span></div></td>
        <td data-label="Trạng thái"><span className={`admin-products-badge${customer.status === 'inactive' ? ' is-stopped' : ''}`}>{STATUS_LABELS[customer.status]}</span></td>
        <td data-label="Thao tác"><div className="admin-products-row-actions"><button className={`button ${customer.status === 'active' ? 'admin-orders-button-danger-outline' : 'button-outline'}`} type="button" disabled={busy} aria-label={`${customer.status === 'active' ? 'Khóa' : 'Mở khóa'} tài khoản ${customer.email || customer.full_name} #${customer.user_id}`} onClick={() => openConfirmation(customer)}>{customer.status === 'active' ? <LockKeyhole size={14} aria-hidden="true" /> : <UnlockKeyhole size={14} aria-hidden="true" />}{customer.status === 'active' ? 'Khóa tài khoản' : 'Mở khóa'}</button></div></td>
      </tr>)}</tbody></table></div>
      <div className="admin-orders-pagination"><p>Trang {query.page} / {Math.max(1, Math.ceil(current.total / PAGE_SIZE))} · {current.users.length} / {current.total} tài khoản</p><div><button className="button button-outline" type="button" disabled={busy || query.page <= 1} onClick={() => setQuery(previous => ({ ...previous, page: previous.page - 1 }))}><ChevronLeft size={16} aria-hidden="true" />Trang trước</button><button className="button button-outline" type="button" disabled={busy || query.page * PAGE_SIZE >= current.total} onClick={() => setQuery(previous => ({ ...previous, page: previous.page + 1 }))}>Trang sau<ChevronRight size={16} aria-hidden="true" /></button></div></div>
    </>}
    {confirmation && <StatusConfirmation customer={confirmation.customer} targetStatus={confirmation.targetStatus} busy={busy} error={actionError} onClose={closeConfirmation} onConfirm={confirmStatus} />}
  </>;
}

export default function AdminUsersPage() {
  const { user, authLoading } = useCommerce();
  useEffect(() => {
    const previous = document.title;
    document.title = `Quản lý người dùng · Admin | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, []);
  useEffect(() => {
    if (authLoading || user) return;
    const returnTo = safeReturnUrl('/admin/users', '/admin/users');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id]);
  return <div className="container admin-orders-page admin-products-page admin-users-page">
    <div className="admin-orders-page-heading"><div><p className="admin-orders-eyebrow">PETCARESHOP ADMIN</p><h1>Quản lý người dùng</h1><p>Tra cứu và bật/tắt trạng thái tài khoản khách hàng.</p></div><span className="admin-orders-admin-label"><ShieldCheck size={17} aria-hidden="true" />Khu vực quản trị</span></div>
    {authLoading || !user ? <UsersLoading label="Đang kiểm tra quyền quản trị" /> : user.role !== 'admin' ? <section className="admin-orders-state"><ShieldCheck size={36} aria-hidden="true" /><h2>Bạn không có quyền quản trị</h2><p>Khu vực này chỉ dành cho tài khoản Admin.</p><a className="button button-outline" href="/">Về cửa hàng</a></section> : <div className="admin-orders-layout">
      <AdminSidebar user={user} active="/admin/users" note="Chỉ quản lý tài khoản khách hàng. Mỗi thay đổi trạng thái cần được xác nhận." />
      <div className="admin-orders-content"><AdminUserList key={user.user_id} /></div>
    </div>}
  </div>;
}
