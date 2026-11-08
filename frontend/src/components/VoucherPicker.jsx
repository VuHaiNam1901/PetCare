import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, RefreshCw, Tag, X } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';

const PAGE_SIZE = 20;
const money = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' });
function cents(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value)) return null;
  return BigInt(value.replace('.', ''));
}
function minimumMet(subtotal, minimum) {
  const current = cents(subtotal), threshold = cents(minimum);
  return current === null || threshold === null ? null : current >= threshold;
}

export default function VoucherPicker({ subtotal, appliedCode, onSelect, onClose }) {
  const { getCheckoutVouchers } = useCommerce();
  const method = useRef(getCheckoutVouchers);
  method.current = getCheckoutVouchers;
  const dialog = useRef(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const current = result?.page === page && result?.revision === revision ? result : null;
  const loading = !current || current.loading;

  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ page, revision, loading: true, vouchers: [], total: 0, error: '' });
    method.current({ page, limit: PAGE_SIZE, signal: controller.signal }).then(data => {
      if (!active) return;
      const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (page > lastPage) { setPage(lastPage); return; }
      setResult({ page, revision, loading: false, vouchers: data.vouchers, total: data.total, error: '' });
    }).catch(error => {
      if (active && !controller.signal.aborted && !error.obsolete) setResult({ page, revision, loading: false, vouchers: [], total: 0, error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [page, revision]);

  return <dialog ref={dialog} className="voucher-picker" aria-labelledby="voucher-picker-title" aria-describedby="voucher-picker-note" aria-busy={loading}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="voucher-picker-heading"><h2 id="voucher-picker-title"><Tag size={21} aria-hidden="true" />Chọn Voucher cho đơn hàng</h2><button className="icon-button" type="button" aria-label="Đóng danh sách Voucher" onClick={onClose}><X size={22} aria-hidden="true" /></button></div>
    <p id="voucher-picker-note" className="voucher-picker-note">Mỗi đơn dùng một Voucher. Cửa hàng kiểm tra lại điều kiện và lượt còn lại khi bạn chọn mã và đặt hàng.</p>
    <div className="voucher-picker-content">
      {loading ? <p className="voucher-picker-state" role="status">Đang tải Voucher...</p> : current.error ? <div className="voucher-picker-state" role="alert"><p>{current.error}</p><button className="button button-outline" type="button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />Thử lại danh sách Voucher</button></div> : !current.vouchers.length ? <div className="voucher-picker-state" role="status"><Tag size={28} aria-hidden="true" /><h3>Chưa có Voucher để chọn</h3><p>Hiện chưa có mã còn hiệu lực và lượt dùng cho bạn. Bạn vẫn có thể nhập mã hoặc tiếp tục đặt hàng.</p></div> : <ul className="voucher-picker-list">{current.vouchers.map(voucher => {
        const eligibleMinimum = minimumMet(subtotal, voucher.minimum_order_amount);
        const selected = voucher.code === appliedCode;
        return <li key={voucher.code} className={`voucher-picker-card${eligibleMinimum === false ? ' is-ineligible' : ''}${selected ? ' is-selected' : ''}`} data-voucher-code={voucher.code}>
          <div className="voucher-picker-card-heading"><strong className="voucher-picker-code">{voucher.code}</strong>{selected && <span className="voucher-picker-selected"><Check size={13} aria-hidden="true" />Đã chọn</span>}</div>
          <p className="voucher-picker-discount">{voucher.discount_type === 'percent' ? `Giảm ${percent.format(Number(voucher.discount_value))}%` : `Giảm ${money.format(Number(voucher.discount_value))}`}</p>
          <dl className="voucher-picker-terms"><div><dt>Đơn tối thiểu</dt><dd>{money.format(Number(voucher.minimum_order_amount))}</dd></div>{voucher.max_discount_amount !== null && <div><dt>Giảm tối đa</dt><dd>{money.format(Number(voucher.max_discount_amount))}</dd></div>}<div><dt>Hạn sử dụng</dt><dd><time dateTime={voucher.ends_at_utc}>{dates.format(new Date(voucher.ends_at_utc))}</time></dd></div></dl>
          <div className="voucher-picker-card-footer"><p className="voucher-picker-eligibility">{eligibleMinimum === false ? 'Chưa đạt đơn tối thiểu' : eligibleMinimum === true ? 'Đạt đơn tối thiểu · Kiểm tra khi chọn' : 'Điều kiện sẽ được kiểm tra khi chọn'}</p><button className="button button-primary" type="button" disabled={eligibleMinimum === false} aria-label={`Chọn Voucher ${voucher.code}`} onClick={() => { onClose(); onSelect(voucher.code); }}>Chọn mã</button></div>
        </li>;
      })}</ul>}
    </div>
    <div className="voucher-picker-footer"><span>{loading ? 'Đang kiểm tra danh sách...' : current.error ? 'Chưa tải được danh sách' : `Trang ${page} / ${Math.max(1, Math.ceil(current.total / PAGE_SIZE))} · ${current.total} Voucher`}</span><div><button className="button button-outline" type="button" disabled={loading || Boolean(current?.error) || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={15} aria-hidden="true" />Trang trước</button><button className="button button-outline" type="button" disabled={loading || Boolean(current?.error) || page * PAGE_SIZE >= (current?.total || 0)} onClick={() => setPage(value => value + 1)}>Trang sau<ChevronRight size={15} aria-hidden="true" /></button></div></div>
  </dialog>;
}
