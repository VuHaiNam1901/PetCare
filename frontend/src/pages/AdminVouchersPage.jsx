import { useEffect, useRef, useState } from 'react';
import { Ban, Check, ChevronLeft, ChevronRight, ClipboardList, Eye, FolderTree, Home, Package, Pencil, Plus, RefreshCw, Search, ShieldCheck, Ticket, Users, X } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { useVoucherReadiness } from '../hooks/useVoucherReadiness.js';
import AdminVoucherNavLink from '../components/AdminVoucherNavLink.jsx';
import { EmptyState, ErrorNotice } from '../components/Feedback.jsx';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../admin-orders.css';
import '../admin-products.css';
import '../admin-vouchers.css';

const PAGE_SIZE = 20;
const STATUSES = { draft: 'Nháp', active: 'Đang bật', disabled: 'Đã vô hiệu hóa' };
const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const moneyFormat = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 2 });
const money = value => moneyFormat.format(Number(value));
const date = value => Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : 'Chưa có thời gian';
const amount = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value);
const validVoucher = voucher => voucher && /^[1-9]\d{0,19}$/.test(String(voucher.voucher_id)) &&
  /^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(voucher.code) && ['fixed', 'percent'].includes(voucher.discount_type) &&
  amount(voucher.discount_value) && amount(voucher.minimum_order_amount) && (voucher.max_discount_amount === null || amount(voucher.max_discount_amount)) &&
  Number.isFinite(Date.parse(voucher.starts_at_utc)) && Number.isFinite(Date.parse(voucher.ends_at_utc)) && Object.hasOwn(STATUSES, voucher.status) &&
  ['total_limit', 'per_user_limit'].every(field => voucher[field] === null || (Number.isSafeInteger(voucher[field]) && voucher[field] > 0));
function localTime(value) {
  const instant = new Date(value);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
}
function formValues(voucher) {
  return {
    code: voucher?.code || '', discount_type: voucher?.discount_type || 'percent', discount_value: voucher?.discount_value || '',
    minimum_order_amount: voucher?.minimum_order_amount || '0.00', max_discount_amount: voucher?.max_discount_amount || '',
    starts_at_utc: localTime(voucher?.starts_at_utc || Date.now()),
    ends_at_utc: localTime(voucher?.ends_at_utc || Date.now() + 7 * 86400000),
    total_limit: voucher?.total_limit == null ? '' : String(voucher.total_limit),
    per_user_limit: voucher?.per_user_limit == null ? '' : String(voucher.per_user_limit), status: voucher?.status || 'draft',
  };
}
function decimal(value) {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function Loading({ label = 'Đang tải Voucher' }) {
  return <div className="admin-products-loading" role="status"><p>{label}...</p>{[0, 1, 2].map(index => <div key={index} className="skeleton skeleton-line" aria-hidden="true" />)}</div>;
}
function Dialog({ title, busy, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  return <dialog ref={ref} className="admin-orders-dialog admin-products-dialog admin-vouchers-dialog" aria-labelledby="admin-voucher-dialog-title" aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="admin-products-dialog-heading"><h2 id="admin-voucher-dialog-title">{title}</h2><button className="icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Đóng hộp thoại"><X size={22} aria-hidden="true" /></button></div>
    {children}
  </dialog>;
}
function VoucherForm({ voucher, busy, error, onSave, onClose }) {
  const [original] = useState(() => voucher ? formValues(voucher) : null);
  const [values, setValues] = useState(() => formValues(voucher));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'múi giờ thiết bị';
  const change = event => {
    const { name, value } = event.target;
    setValues(previous => ({ ...previous, [name]: value }));
    setErrors(previous => ({ ...previous, [name]: '' })); setFormError('');
  };
  const field = name => ({ id: `admin-voucher-${name}`, name, value: values[name], onChange: change,
    'aria-invalid': Boolean(errors[name]), 'aria-describedby': errors[name] ? `admin-voucher-${name}-error` : undefined });
  const errorText = name => errors[name] && <small id={`admin-voucher-${name}-error`} className="admin-products-field-error">{errors[name]}</small>;
  const submit = event => {
    event.preventDefault();
    if (busy) return;
    const nextErrors = {}, payload = {};
    const code = values.code.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(code)) nextErrors.code = 'Nhập 1–64 chữ cái không dấu, số, dấu gạch ngang hoặc gạch dưới.';
    payload.code = code.toUpperCase(); payload.discount_type = values.discount_type; payload.status = values.status;
    if (!Object.hasOwn(STATUSES, values.status) || (values.status === 'disabled' && voucher?.status !== 'disabled')) nextErrors.status = 'Để vô hiệu hóa mã, hãy dùng nút Vô hiệu hóa trong danh sách và xác nhận thao tác.';
    for (const key of ['discount_value', 'minimum_order_amount', 'max_discount_amount']) {
      const nullable = key === 'max_discount_amount';
      const parsed = nullable && !values[key].trim() ? null : decimal(values[key]);
      if (parsed === null && !(nullable && !values[key].trim())) nextErrors[key] = 'Nhập số tiền hợp lệ, tối đa 10 chữ số và 2 số thập phân.';
      else if (parsed !== null && key !== 'minimum_order_amount' && Number(parsed) <= 0) nextErrors[key] = 'Giá trị phải lớn hơn 0.';
      payload[key] = parsed;
    }
    if (values.discount_type === 'percent' && payload.discount_value !== null && Number(payload.discount_value) > 100) nextErrors.discount_value = 'Phần trăm giảm phải lớn hơn 0 và không vượt quá 100%.';
    for (const key of ['total_limit', 'per_user_limit']) {
      const text = values[key].trim();
      if (text && (!/^[1-9]\d{0,9}$/.test(text) || Number(text) > 4294967295)) nextErrors[key] = 'Nhập số nguyên từ 1 đến 4.294.967.295, hoặc để trống nếu không giới hạn.';
      payload[key] = text ? Number(text) : null;
    }
    for (const key of ['starts_at_utc', 'ends_at_utc']) {
      const timestamp = Date.parse(values[key]);
      if (!values[key] || !Number.isFinite(timestamp) || new Date(timestamp).getFullYear() < 1000) nextErrors[key] = 'Vui lòng nhập ngày và giờ hợp lệ.';
      else payload[key] = new Date(timestamp).toISOString();
    }
    if (payload.starts_at_utc && payload.ends_at_utc && Date.parse(payload.ends_at_utc) <= Date.parse(payload.starts_at_utc)) nextErrors.ends_at_utc = 'Ngày kết thúc phải sau ngày bắt đầu.';
    setErrors(nextErrors); setFormError('');
    const invalid = Object.keys(nextErrors)[0];
    if (invalid) { event.currentTarget.elements.namedItem(invalid)?.focus(); return; }
    // Preserve original timestamps/terms when the administrator edits another field.
    const changed = original ? Object.fromEntries(Object.entries(payload).filter(([key]) => values[key] !== original[key])) : payload;
    if (!Object.keys(changed).length) { setFormError('Bạn chưa thay đổi thông tin nào.'); return; }
    onSave(changed, voucher);
  };
  const moneyField = (name, label, optional = false) => <label className="admin-products-field" htmlFor={`admin-voucher-${name}`}><span>{label}{optional ? '' : ' *'}</span><input {...field(name)} type="text" inputMode="decimal" autoComplete="off" placeholder={optional ? 'Không giới hạn' : '0.00'} required={!optional} />{optional && <small>Để trống nếu không giới hạn.</small>}{errorText(name)}</label>;
  return <Dialog title={voucher ? `Sửa Voucher ${voucher.code}` : 'Tạo Voucher mới'} busy={busy} onClose={onClose}>
    <form className="admin-products-form" noValidate onSubmit={submit}>
      <fieldset disabled={busy}><legend className="sr-only">Thông tin Voucher</legend><div className="admin-products-form-grid">
        <label className="admin-products-field" htmlFor="admin-voucher-code"><span>Mã Voucher *</span><input {...field('code')} maxLength={64} required autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false} /><small>Mã không được đổi sau khi đã có đơn sử dụng.</small>{errorText('code')}</label>
        <label className="admin-products-field" htmlFor="admin-voucher-status"><span>Trạng thái</span><select {...field('status')}>{Object.entries(STATUSES).filter(([status]) => status !== 'disabled' || voucher?.status === 'disabled').map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select><small>Để vô hiệu hóa mã, dùng nút Vô hiệu hóa trong danh sách và xác nhận thao tác.</small>{errorText('status')}</label>
        <label className="admin-products-field" htmlFor="admin-voucher-discount_type"><span>Loại giảm giá</span><select {...field('discount_type')}><option value="percent">Theo phần trăm (%)</option><option value="fixed">Số tiền cố định (đ)</option></select></label>
        {moneyField('discount_value', values.discount_type === 'percent' ? 'Giá trị giảm (%)' : 'Giá trị giảm (đ)')}
        {moneyField('minimum_order_amount', 'Đơn tối thiểu (đ)')}
        {moneyField('max_discount_amount', 'Giảm tối đa (đ)', true)}
        <label className="admin-products-field" htmlFor="admin-voucher-starts_at_utc"><span>Ngày bắt đầu *</span><input {...field('starts_at_utc')} type="datetime-local" step="0.001" required />{errorText('starts_at_utc')}</label>
        <label className="admin-products-field" htmlFor="admin-voucher-ends_at_utc"><span>Ngày kết thúc *</span><input {...field('ends_at_utc')} type="datetime-local" step="0.001" required />{errorText('ends_at_utc')}</label>
        <p className="admin-vouchers-timezone admin-products-field-wide">Ngày và giờ theo múi giờ thiết bị: {timezone}. Voucher ngừng áp dụng từ thời điểm kết thúc.</p>
        {['total_limit', 'per_user_limit'].map(name => <label key={name} className="admin-products-field" htmlFor={`admin-voucher-${name}`}><span>{name === 'total_limit' ? 'Tổng lượt sử dụng' : 'Giới hạn mỗi khách'}</span><input {...field(name)} type="text" inputMode="numeric" placeholder="Không giới hạn" autoComplete="off" /><small>Để trống nếu không giới hạn lượt.</small>{errorText(name)}</label>)}
      </div></fieldset>
      {(formError || error) && <p className="admin-products-form-error" role="alert">{formError || error}</p>}
      <div className="admin-products-dialog-actions"><button className="button button-outline" type="button" disabled={busy} onClick={onClose}>Hủy</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Đang lưu...' : voucher ? 'Lưu thay đổi' : 'Tạo Voucher'}</button></div>
    </form>
  </Dialog>;
}
function VoucherDetails({ voucher, onClose, onEdit }) {
  const entries = [['Mã Voucher', voucher.code], ['Loại giảm giá', voucher.discount_type === 'percent' ? 'Theo phần trăm' : 'Số tiền cố định'],
    ['Giá trị giảm', voucher.discount_type === 'percent' ? `${voucher.discount_value}%` : money(voucher.discount_value)],
    ['Đơn tối thiểu', money(voucher.minimum_order_amount)], ['Giảm tối đa', voucher.max_discount_amount === null ? 'Không giới hạn' : money(voucher.max_discount_amount)],
    ['Ngày bắt đầu', date(voucher.starts_at_utc)], ['Ngày kết thúc', date(voucher.ends_at_utc)],
    ['Tổng lượt sử dụng', voucher.total_limit === null ? 'Không giới hạn' : voucher.total_limit],
    ['Giới hạn mỗi khách', voucher.per_user_limit === null ? 'Không giới hạn' : voucher.per_user_limit], ['Trạng thái', STATUSES[voucher.status]]];
  return <Dialog title={`Chi tiết Voucher ${voucher.code}`} busy={false} onClose={onClose}>
    <dl className="admin-vouchers-details">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="admin-vouchers-timezone">Thời gian hiển thị theo múi giờ thiết bị. Thay đổi Voucher chỉ áp dụng cho đơn mới.</p>
    <div className="admin-products-dialog-actions"><button className="button button-outline" type="button" onClick={onClose}>Đóng</button><button className="button button-primary" type="button" onClick={() => onEdit(voucher)}><Pencil size={15} aria-hidden="true" />Chỉnh sửa</button></div>
  </Dialog>;
}
function VoucherList() {
  const { getAdminVouchers, getAdminVoucher, createAdminVoucher, updateAdminVoucher, disableAdminVoucher } = useCommerce();
  const methods = useRef({});
  methods.current = { getAdminVouchers, getAdminVoucher, createAdminVoucher, updateAdminVoucher, disableAdminVoucher };
  const [query, setQuery] = useState({ q: '', status: '', page: 1 });
  const [draft, setDraft] = useState({ q: '', status: '' });
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [filterError, setFilterError] = useState('');
  const [success, setSuccess] = useState('');
  const alive = useRef(false), busyRef = useRef(false);
  const current = result?.query === query && result?.revision === revision ? result : null;
  const loading = !current || current.loading;
  const hasFilters = Boolean(query.q || query.status);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ query, revision, loading: true, vouchers: [], total: 0, error: '' });
    methods.current.getAdminVouchers({ page: query.page, limit: PAGE_SIZE, ...(query.q ? { q: query.q } : {}), ...(query.status ? { status: query.status } : {}), signal: controller.signal }).then(data => {
      if (!active) return;
      if (!Array.isArray(data.vouchers) || !data.vouchers.every(validVoucher) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('Danh sách Voucher chưa hợp lệ. Vui lòng tải lại.');
      const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      // Disabling the last active voucher on a filtered page can shrink the list.
      if (query.page > lastPage) { setQuery(previous => previous === query ? { ...previous, page: lastPage } : previous); return; }
      setResult({ query, revision, loading: false, vouchers: data.vouchers, total: data.total, error: '' });
    }).catch(error => {
      if (active && !controller.signal.aborted && !error.obsolete) setResult({ query, revision, loading: false, vouchers: [], total: 0, error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [query, revision]);
  const reload = () => { if (!busyRef.current) setRevision(value => value + 1); };
  const open = value => { if (!busyRef.current) { setActionError(''); setSuccess(''); setDialog(value); } };
  const close = () => { if (!busyRef.current) { setDialog(null); setActionError(''); } };
  const loadVoucher = async (voucher, kind) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setActionError(''); setSuccess(''); setDialog({ kind: 'loading' });
    try {
      const saved = await methods.current.getAdminVoucher(voucher.voucher_id);
      if (!alive.current) return;
      if (!validVoucher(saved) || String(saved.voucher_id) !== String(voucher.voucher_id)) throw new Error('Thông tin Voucher chưa hợp lệ. Vui lòng tải lại.');
      setDialog({ kind, voucher: saved });
    } catch (error) {
      if (alive.current && !error.obsolete) { setDialog(null); setActionError(error.message); }
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const mutate = async (kind, payload, voucher) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setActionError(''); setSuccess('');
    try {
      const saved = kind === 'disable' ? await methods.current.disableAdminVoucher(voucher.voucher_id) : voucher ? await methods.current.updateAdminVoucher(voucher.voucher_id, payload) : await methods.current.createAdminVoucher(payload);
      if (!alive.current) return;
      if (!validVoucher(saved) || (voucher && String(saved.voucher_id) !== String(voucher.voucher_id)) || (kind === 'disable' && saved.status !== 'disabled')) throw new Error('Chưa xác nhận được kết quả. Hãy đóng hộp thoại và tải lại danh sách trước khi thử lại.');
      setSuccess(kind === 'disable' ? `Đã vô hiệu hóa Voucher ${saved.code}.` : voucher ? `Đã cập nhật Voucher ${saved.code}.` : `Đã tạo Voucher ${saved.code}.`);
      setDialog(null); setRevision(value => value + 1);
    } catch (error) {
      if (alive.current && !error.obsolete) setActionError((error.message || 'Chưa lưu được Voucher. Vui lòng thử lại.') + (!error.status && !voucher ? ' Hãy tải lại danh sách để kiểm tra trước khi tạo lại.' : ''));
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const reset = () => { if (!busyRef.current) { setDraft({ q: '', status: '' }); setFilterError(''); setQuery({ q: '', status: '', page: 1 }); } };
  const apply = event => {
    event.preventDefault();
    if (busyRef.current) return;
    if (draft.q.trim().length > 64 || /[^\x20-\x7e]/.test(draft.q)) { setFilterError('Tìm theo mã Voucher không dấu, tối đa 64 ký tự.'); return; }
    setFilterError(''); setQuery({ q: draft.q.trim().toUpperCase(), status: draft.status, page: 1 });
  };
  return <>
    {success && <p className="admin-orders-success" role="status"><Check size={18} aria-hidden="true" />{success}</p>}
    {!dialog && actionError && <p className="admin-products-form-error" role="alert">{actionError}</p>}
    <form className="admin-products-filters admin-vouchers-filters" noValidate onSubmit={apply} aria-label="Tìm kiếm và lọc Voucher">
      <div className="admin-products-filter"><label htmlFor="admin-vouchers-q">Mã Voucher</label><div className="admin-products-filter-search"><Search size={17} aria-hidden="true" /><input id="admin-vouchers-q" type="search" maxLength={64} value={draft.q} onChange={event => setDraft(previous => ({ ...previous, q: event.target.value }))} placeholder="Tìm theo mã..." /></div></div>
      <div className="admin-products-filter"><label htmlFor="admin-vouchers-status">Trạng thái</label><select id="admin-vouchers-status" value={draft.status} onChange={event => setDraft(previous => ({ ...previous, status: event.target.value }))}><option value="">Tất cả trạng thái</option>{Object.entries(STATUSES).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></div>
      <div className="admin-products-filter-actions"><button className="button button-primary" type="submit" disabled={busy}><Search size={15} aria-hidden="true" />Áp dụng</button><button className="button button-outline" type="button" disabled={busy} onClick={reset}>Xóa bộ lọc</button></div>
    </form>
    {filterError && <p className="admin-products-form-error" role="alert">{filterError}</p>}
    <div className="admin-products-list-heading"><p aria-live="polite">{loading ? 'Đang tải danh sách...' : current.error ? 'Chưa tải được danh sách' : `${current.total} Voucher${hasFilters ? ' phù hợp bộ lọc' : ''}`}</p><div className="admin-products-heading-actions"><button className="button button-outline" type="button" disabled={busy || loading} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Tải lại</button><button className="button button-primary" type="button" disabled={busy} onClick={() => open({ kind: 'form', voucher: null })}><Plus size={17} aria-hidden="true" />Tạo Voucher</button></div></div>
    {loading ? <Loading /> : current.error ? <ErrorNotice title="Chưa tải được Voucher" message={current.error} onRetry={reload} /> : !current.vouchers.length ? <EmptyState title={hasFilters ? 'Chưa có Voucher phù hợp' : 'Chưa có Voucher'} message={hasFilters ? 'Thử mã khác hoặc thay đổi bộ lọc trạng thái.' : 'Tạo Voucher đầu tiên để bắt đầu chương trình ưu đãi.'} onReset={hasFilters ? reset : undefined} /> : <>
      <div className="admin-products-table-wrap"><table className="admin-products-table"><caption className="sr-only">Danh sách Voucher quản trị</caption><thead><tr><th scope="col">Mã Voucher</th><th scope="col">Loại / giá trị</th><th scope="col">Thời hạn</th><th scope="col">Giới hạn sử dụng</th><th scope="col">Trạng thái</th><th scope="col">Thao tác</th></tr></thead><tbody>{current.vouchers.map(voucher => <tr key={voucher.voucher_id} data-voucher-id={voucher.voucher_id}>
        <td data-label="Mã Voucher"><strong className="admin-vouchers-code">{voucher.code}</strong><small className="admin-vouchers-subtext">Đơn từ {money(voucher.minimum_order_amount)}</small></td>
        <td data-label="Loại / giá trị"><strong>{voucher.discount_type === 'percent' ? `${voucher.discount_value}%` : money(voucher.discount_value)}</strong><small className="admin-vouchers-subtext">{voucher.discount_type === 'percent' ? 'Theo phần trăm' : 'Số tiền cố định'}{voucher.max_discount_amount === null ? '' : ` · Tối đa ${money(voucher.max_discount_amount)}`}</small></td>
        <td data-label="Thời hạn"><span>{date(voucher.starts_at_utc)}</span><small className="admin-vouchers-subtext">đến {date(voucher.ends_at_utc)}</small></td>
        <td data-label="Giới hạn"><span>Tổng: {voucher.total_limit ?? 'Không giới hạn'}</span><small className="admin-vouchers-subtext">Mỗi khách: {voucher.per_user_limit ?? 'Không giới hạn'}</small></td>
        <td data-label="Trạng thái"><span className={`admin-products-badge admin-vouchers-status-${voucher.status}`}>{STATUSES[voucher.status]}</span></td>
        <td data-label="Thao tác"><div className="admin-products-row-actions"><button className="button button-outline" type="button" disabled={busy} aria-label={`Xem Voucher ${voucher.code}`} onClick={() => loadVoucher(voucher, 'detail')}><Eye size={14} aria-hidden="true" />Xem</button><button className="button button-outline" type="button" disabled={busy} aria-label={`Sửa Voucher ${voucher.code}`} onClick={() => loadVoucher(voucher, 'form')}><Pencil size={14} aria-hidden="true" />Sửa</button><button className="button admin-orders-button-danger-outline" type="button" disabled={busy || voucher.status === 'disabled'} aria-label={`Vô hiệu hóa Voucher ${voucher.code}`} onClick={() => open({ kind: 'disable', voucher })}><Ban size={14} aria-hidden="true" />Vô hiệu hóa</button></div></td>
      </tr>)}</tbody></table></div>
      <div className="admin-orders-pagination"><p>Trang {query.page} / {Math.max(1, Math.ceil(current.total / PAGE_SIZE))} · {current.total} Voucher</p><div><button className="button button-outline" type="button" disabled={busy || query.page <= 1} onClick={() => setQuery(previous => ({ ...previous, page: previous.page - 1 }))}><ChevronLeft size={16} aria-hidden="true" />Trang trước</button><button className="button button-outline" type="button" disabled={busy || query.page * PAGE_SIZE >= current.total} onClick={() => setQuery(previous => ({ ...previous, page: previous.page + 1 }))}>Trang sau<ChevronRight size={16} aria-hidden="true" /></button></div></div>
    </>}
    <p className="admin-vouchers-rule">Lượt đã giữ cho đơn hàng cũng được tính vào giới hạn. Cập nhật Voucher không đổi số tiền của đơn cũ.</p>
    {dialog?.kind === 'loading' && <Dialog title="Đang tải chi tiết Voucher" busy={true} onClose={close}><Loading /></Dialog>}
    {dialog?.kind === 'form' && <VoucherForm key={dialog.voucher?.voucher_id || 'new'} voucher={dialog.voucher} busy={busy} error={actionError} onSave={(payload, voucher) => mutate('save', payload, voucher)} onClose={close} />}
    {dialog?.kind === 'detail' && <VoucherDetails voucher={dialog.voucher} onClose={close} onEdit={voucher => open({ kind: 'form', voucher })} />}
    {dialog?.kind === 'disable' && <Dialog title="Vô hiệu hóa Voucher" busy={busy} onClose={close}>
      <div className="admin-products-stop-copy"><p>Vô hiệu hóa mã <strong>{dialog.voucher.code}</strong>?</p><p>Khách hàng sẽ không thể áp dụng mã cho đơn mới. Các đơn đã sử dụng mã được giữ nguyên.</p></div>
      {actionError && <p className="admin-products-form-error" role="alert">{actionError}</p>}
      <div className="admin-products-dialog-actions"><button className="button button-outline" type="button" autoFocus disabled={busy} onClick={close}>Hủy</button><button className="button admin-orders-button-danger-outline" type="button" disabled={busy} onClick={() => mutate('disable', null, dialog.voucher)}>{busy ? 'Đang xử lý...' : 'Xác nhận vô hiệu hóa'}</button></div>
    </Dialog>}
  </>;
}
function VoucherWorkspace() {
  const readiness = useVoucherReadiness();
  if (readiness.loading) return <Loading label="Đang kiểm tra Voucher" />;
  if (readiness.error) return <ErrorNotice title="Chưa kiểm tra được Voucher" message="Chưa nhận được trạng thái Voucher từ máy chủ. Vui lòng thử lại sau." onRetry={readiness.retry} />;
  if (!readiness.ready) return <section className="admin-orders-state admin-vouchers-unavailable"><Ticket size={36} aria-hidden="true" /><h2>Voucher chưa khả dụng</h2><p>Chức năng quản lý Voucher hiện chưa được mở. Vui lòng quay lại sau.</p><button className="button button-outline" type="button" onClick={readiness.retry}><RefreshCw size={16} aria-hidden="true" />Kiểm tra lại</button></section>;
  return <VoucherList />;
}
export default function AdminVouchersPage() {
  const { user, authLoading } = useCommerce();
  useEffect(() => {
    const previous = document.title;
    document.title = `Quản lý Voucher · Admin | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, []);
  useEffect(() => {
    if (authLoading || user) return;
    const returnTo = safeReturnUrl('/admin/vouchers', '/admin/vouchers');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id]);
  return <div className="container admin-orders-page admin-products-page admin-vouchers-page">
    <div className="admin-orders-page-heading"><div><p className="admin-orders-eyebrow">PETCARESHOP ADMIN</p><h1>Quản lý Voucher</h1><p>Tạo và quản lý mã ưu đãi dành cho khách hàng.</p></div><span className="admin-orders-admin-label"><ShieldCheck size={17} aria-hidden="true" />Khu vực quản trị</span></div>
    {authLoading || !user ? <Loading label="Đang kiểm tra quyền quản trị" /> : user.role !== 'admin' ? <section className="admin-orders-state"><ShieldCheck size={36} aria-hidden="true" /><h2>Bạn không có quyền quản trị</h2><p>Khu vực này chỉ dành cho tài khoản Admin.</p><a className="button button-outline" href="/">Về cửa hàng</a></section> : <div className="admin-orders-layout">
      <aside className="admin-orders-sidebar" aria-label="Điều hướng quản trị"><div className="admin-orders-profile"><span><ShieldCheck size={24} aria-hidden="true" /></span><div><small>TÀI KHOẢN QUẢN TRỊ</small><strong>{user.full_name || user.email}</strong></div></div><nav><a href="/admin/orders"><ClipboardList size={18} aria-hidden="true" />Quản lý đơn hàng<ChevronRight size={14} aria-hidden="true" /></a><a href="/admin/products"><Package size={18} aria-hidden="true" />Quản lý sản phẩm<ChevronRight size={14} aria-hidden="true" /></a><a href="/admin/categories"><FolderTree size={18} aria-hidden="true" />Quản lý danh mục<ChevronRight size={14} aria-hidden="true" /></a><a href="/admin/users"><Users size={18} aria-hidden="true" />Quản lý người dùng<ChevronRight size={14} aria-hidden="true" /></a><AdminVoucherNavLink /><a href="/"><Home size={18} aria-hidden="true" />Về cửa hàng</a></nav><p className="admin-orders-sidebar-note">Voucher đã được dùng luôn được giữ lại cùng lịch sử đơn hàng.</p></aside>
      <div className="admin-orders-content"><VoucherWorkspace key={user.user_id} /></div>
    </div>}
  </div>;
}
