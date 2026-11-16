import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';

const PAGE_SIZE = 20;
const MAX_SELECTED = 100;
const customerId = user => String(user.user_id);
const customerName = user => user.full_name || user.email || `Khách hàng #${user.user_id}`;
const validCustomer = user => user && /^[1-9]\d{0,19}$/.test(String(user.user_id)) &&
  typeof user.full_name === 'string' && typeof user.email === 'string' && (user.phone == null || typeof user.phone === 'string');

function validPage(data, page) {
  return data && Array.isArray(data.users) && data.users.every(validCustomer) &&
    Number.isSafeInteger(data.total) && data.total >= 0 && data.page === page && data.limit === PAGE_SIZE &&
    data.users.length <= PAGE_SIZE && new Set(data.users.map(customerId)).size === data.users.length;
}

export default function VoucherCustomerSelector({ value, onChange, disabled = false, error = '' }) {
  const { searchVoucherCustomers } = useCommerce();
  const search = useRef(searchVoucherCustomers);
  search.current = searchVoucherCustomers;
  const id = useId();
  const [query, setQuery] = useState({ q: '', page: 1 });
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const current = result?.query === query && result?.revision === revision ? result : null;
  const loading = !current || current.loading;
  const selected = new Set(value.map(customerId));

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ query, revision, loading: true, users: [], total: 0, error: '' });
    const timer = setTimeout(() => {
      search.current({ q: query.q.trim(), page: query.page, limit: PAGE_SIZE, signal: controller.signal }).then(data => {
        if (!active) return;
        if (!validPage(data, query.page) || data.users.some(user => user.status != null && user.status !== 'active')) throw new Error('Danh sách khách hàng chưa hợp lệ. Vui lòng tải lại.');
        const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (query.page > lastPage) { setQuery(previous => previous === query ? { ...previous, page: lastPage } : previous); return; }
        setResult({ query, revision, loading: false, users: data.users, total: data.total, error: '' });
      }).catch(failure => {
        if (active && !controller.signal.aborted && !failure.obsolete) setResult({ query, revision, loading: false, users: [], total: 0, error: failure.message });
      });
    }, 300);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [query, revision]);

  const toggle = user => {
    if (disabled) return;
    if (selected.has(customerId(user))) onChange(value.filter(item => customerId(item) !== customerId(user)));
    else if (value.length < MAX_SELECTED) onChange([...value, user]);
  };

  return <section className="voucher-customers" aria-labelledby={`${id}-label`} aria-busy={loading}>
    <div className="voucher-customers-heading"><h3 id={`${id}-label`}>Chọn khách hàng</h3><span aria-live="polite">Đã chọn {value.length} / {MAX_SELECTED}</span></div>
    <label className="voucher-customers-search" htmlFor={`${id}-search`}><span className="sr-only">Tìm khách hàng theo tên, email, ID hoặc số điện thoại</span><Search size={17} aria-hidden="true" /><input id={`${id}-search`} data-voucher-customer-search type="search" value={query.q} maxLength={120} disabled={disabled} placeholder="Tìm theo tên, email, ID hoặc số điện thoại..." autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} onChange={event => setQuery({ q: event.target.value, page: 1 })} /></label>
    <p className="voucher-customers-hint" id={`${id}-hint`}>Chỉ tìm tài khoản khách hàng đang hoạt động. Có thể chọn tối đa 100 khách mỗi lần.</p>
    {error && <p className="admin-products-field-error" id={`${id}-error`} role="alert">{error}</p>}
    {value.length > 0 && <ul className="voucher-customer-chips" aria-label="Khách hàng đã chọn">{value.map(user => <li key={customerId(user)}><span>{customerName(user)} <small>#{user.user_id}</small></span><button type="button" disabled={disabled} onClick={() => toggle(user)} aria-label={`Bỏ chọn ${customerName(user)} #${user.user_id}`}><X size={14} aria-hidden="true" /></button></li>)}</ul>}
    {loading ? <p className="voucher-customers-state" role="status">Đang tìm khách hàng...</p> : current.error ? <div className="voucher-customers-state" role="alert"><p>{current.error}</p><button className="button button-outline" type="button" disabled={disabled} onClick={() => setRevision(previous => previous + 1)}><RefreshCw size={14} aria-hidden="true" />Tải lại khách hàng</button></div> : !current.users.length ? <p className="voucher-customers-state" role="status">Không tìm thấy khách hàng đang hoạt động phù hợp.</p> : <ul className="voucher-customer-results" aria-label="Kết quả tìm khách hàng">{current.users.map(user => {
      const checked = selected.has(customerId(user));
      return <li key={customerId(user)}><label><input type="checkbox" checked={checked} disabled={disabled || (!checked && value.length >= MAX_SELECTED)} onChange={() => toggle(user)} /><span><strong>{customerName(user)} <small>#{user.user_id}</small></strong><span>{user.email}{user.phone ? ` · ${user.phone}` : ''}</span></span></label></li>;
    })}</ul>}
    <div className="voucher-customers-pagination"><span>{loading ? 'Đang tải...' : current.error ? 'Chưa tải được khách hàng' : `Trang ${query.page} / ${Math.max(1, Math.ceil(current.total / PAGE_SIZE))} · ${current.total} khách`}</span><div><button className="icon-button" type="button" aria-label="Trang khách hàng trước" disabled={disabled || loading || Boolean(current?.error) || query.page <= 1} onClick={() => setQuery(previous => ({ ...previous, page: previous.page - 1 }))}><ChevronLeft size={19} aria-hidden="true" /></button><button className="icon-button" type="button" aria-label="Trang khách hàng sau" disabled={disabled || loading || Boolean(current?.error) || query.page * PAGE_SIZE >= (current?.total || 0)} onClick={() => setQuery(previous => ({ ...previous, page: previous.page + 1 }))}><ChevronRight size={19} aria-hidden="true" /></button></div></div>
  </section>;
}

export function VoucherAssignedCustomers({ voucherId, disabled = false }) {
  const { getAdminVoucherAssignments } = useCommerce();
  const request = useRef(getAdminVoucherAssignments);
  request.current = getAdminVoucherAssignments;
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const current = result?.page === page && result?.revision === revision ? result : null;
  const loading = !current || current.loading;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ page, revision, loading: true, users: [], total: 0, error: '' });
    request.current(voucherId, { page, limit: PAGE_SIZE, signal: controller.signal }).then(data => {
      if (!active) return;
      if (!validPage(data, page)) throw new Error('Danh sách khách đã được cấp chưa hợp lệ. Vui lòng tải lại.');
      const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (page > lastPage) { setPage(lastPage); return; }
      setResult({ page, revision, loading: false, users: data.users, total: data.total, error: '' });
    }).catch(error => {
      if (active && !controller.signal.aborted && !error.obsolete) setResult({ page, revision, loading: false, users: [], total: 0, error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [voucherId, page, revision]);
  return <section className="voucher-assignments" aria-label="Khách hàng đã được cấp Voucher" aria-busy={loading}>
    <h3>Khách hàng đã được cấp</h3>
    {loading ? <p className="voucher-customers-state" role="status">Đang tải khách đã được cấp...</p> : current.error ? <div className="voucher-customers-state" role="alert"><p>{current.error}</p><button className="button button-outline" type="button" disabled={disabled} onClick={() => setRevision(value => value + 1)}>Tải lại danh sách đã cấp</button></div> : !current.users.length ? <p className="voucher-customers-state">Chưa cấp riêng cho khách hàng nào.</p> : <ul className="voucher-assignment-list">{current.users.map(user => <li key={customerId(user)}><strong>{customerName(user)} <small>#{user.user_id}</small></strong><span>{user.email}{user.phone ? ` · ${user.phone}` : ''}{user.status === 'inactive' ? ' · Tài khoản đang khóa' : ''}</span></li>)}</ul>}
    <div className="voucher-customers-pagination"><span>{loading ? 'Đang tải...' : current.error ? 'Chưa tải được danh sách' : `${current.total} khách · Trang ${page} / ${Math.max(1, Math.ceil(current.total / PAGE_SIZE))}`}</span><div><button className="icon-button" type="button" aria-label="Trang khách đã cấp trước" disabled={disabled || loading || Boolean(current?.error) || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={19} aria-hidden="true" /></button><button className="icon-button" type="button" aria-label="Trang khách đã cấp sau" disabled={disabled || loading || Boolean(current?.error) || page * PAGE_SIZE >= (current?.total || 0)} onClick={() => setPage(value => value + 1)}><ChevronRight size={19} aria-hidden="true" /></button></div></div>
  </section>;
}
