import { useEffect, useState } from 'react';
import { Tag, Ticket, X } from 'lucide-react';
import VoucherPicker from './VoucherPicker.jsx';

export default function CheckoutVoucher({ ready, available, readinessLoading, code, appliedCode, quote, error, notice, busy, locked, disabled, subtotal, selectionKey, onChange, onApply, onSelect, onRemove }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const canChoose = ready && available && !locked && !disabled && !busy;
  useEffect(() => { setPickerOpen(false); }, [selectionKey, canChoose]);
  // Unknown/unready backend state never offers a new Voucher control. A saved
  // selection may still be removed without requiring the feature to be enabled.
  if (!ready && !appliedCode) return null;
  return <section className="checkout-voucher" aria-labelledby="checkout-voucher-title" aria-busy={busy}>
    <h3 id="checkout-voucher-title"><Tag size={17} aria-hidden="true" />Voucher của bạn</h3>
    {ready && <><label htmlFor="checkout-voucher-code">Mã Voucher</label><div className="checkout-voucher-input-row"><input id="checkout-voucher-code" value={code} maxLength={64} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="Nhập mã ưu đãi" disabled={locked || !available || disabled} aria-invalid={Boolean(error)} aria-describedby={error ? 'checkout-voucher-error' : undefined} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!locked && available && !disabled && !busy) onApply(); } }} /><button className="button button-outline" type="button" disabled={locked || !available || disabled || busy || !code.trim()} onClick={onApply}>{busy ? 'Đang kiểm tra...' : 'Áp dụng'}</button><button className="button button-outline checkout-voucher-picker-open" type="button" disabled={!canChoose} aria-haspopup="dialog" onClick={() => setPickerOpen(true)}><Ticket size={15} aria-hidden="true" />Chọn Voucher</button></div></>}
    {appliedCode && <div className="checkout-voucher-applied"><span>{quote && available ? 'Đã áp dụng' : 'Mã đã chọn'}: <strong>{appliedCode}</strong></span><button type="button" onClick={onRemove} disabled={locked} aria-label="Bỏ Voucher"><X size={14} aria-hidden="true" />Bỏ Voucher</button></div>}
    {!available && appliedCode && !locked && <p className="checkout-voucher-hint" role="status">{readinessLoading ? 'Đang kiểm tra khả năng sử dụng Voucher.' : ready ? 'Voucher Online chưa sẵn sàng. Chọn COD hoặc bỏ Voucher để tiếp tục.' : 'Voucher hiện chưa sẵn sàng. Bỏ mã để tiếp tục đặt hàng.'}</p>}
    {quote && available && !error && !locked && <p className="checkout-voucher-hint" role="status">Ưu đãi sẽ được kiểm tra lại khi đặt hàng; lượt dùng chưa được giữ.</p>}
    {busy && <p className="checkout-voucher-hint" role="status">Đang kiểm tra mã và số tiền giảm từ cửa hàng...</p>}
    {notice && <p className="checkout-voucher-hint" role="status">{notice}</p>}
    {error && <p className="checkout-voucher-error" id="checkout-voucher-error" role="alert">{error}</p>}
    {pickerOpen && canChoose && <VoucherPicker subtotal={subtotal} appliedCode={appliedCode} onClose={() => setPickerOpen(false)} onSelect={onSelect} />}
  </section>;
}
