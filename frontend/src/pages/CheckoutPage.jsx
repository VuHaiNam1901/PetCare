import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle2, ChevronRight, CreditCard, Info, PackageCheck, RefreshCw, ShieldCheck, ShoppingBag, Truck } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { ProductImage } from '../components/ProductCard.jsx';
import { commerceApi } from '../services/commerce.js';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import { orderStatusLabel } from '../utils/orders.js';
import { beginCheckoutSubmission, clearCheckoutSubmission, completeCheckoutSubmission, readCheckoutDraft, saveCheckoutDraft, validateShipping } from '../utils/checkout.js';
import { BRAND_NAME } from '../config/branding.js';
import { useVoucherReadiness } from '../hooks/useVoucherReadiness.js';
import CheckoutVoucher from '../components/CheckoutVoucher.jsx';
import '../checkout.css';
import '../checkout-voucher.css';

const emptyShipping = { recipient_name: '', phone: '', address: '', note: '' };

function cents(value) {
  const source = String(value ?? '');
  if (source.length > 24 || !/^\d+(?:\.\d{1,2})?$/.test(source)) return null;
  const [whole, fraction = ''] = source.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

const decimal = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
const amount = value => value == null ? 'Chưa xác định' : formatPrice(value);
const voucherMoney = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 2 });
const voucherAmount = value => value == null ? 'Chưa xác định' : voucherMoney.format(Number(value));
const sameItems = (first, second) => JSON.stringify(first) === JSON.stringify(second);

function previewRows(items, cart) {
  if (!cart || !Array.isArray(cart.items)) throw new Error('Chưa nhận được thông tin sản phẩm hợp lệ. Vui lòng thử lại.');
  const byId = new Map(cart.items.map(item => [Number(item.product_id), item]));
  let subtotal = 0n;
  let allPricesKnown = true;
  const prices = {};
  const rows = items.map(item => {
    const product = byId.get(item.product_id);
    const unitCents = cents(product?.price);
    const stock = Number(product?.stock_quantity);
    let reason = product?.availability_message || '';
    if (!product || product.status == null) reason ||= 'Sản phẩm không còn tồn tại.';
    else if (product.status !== 'Đang bán') reason ||= 'Sản phẩm đã ngừng bán.';
    else if (!Number.isInteger(stock) || stock <= 0) reason ||= 'Sản phẩm đã hết hàng.';
    else if (item.quantity > stock) reason ||= `Số lượng vượt tồn kho hiện tại (${stock}).`;
    else if (product.available !== true) reason ||= 'Sản phẩm hiện chưa thể đặt hàng.';
    if (unitCents == null) { allPricesKnown = false; reason ||= 'Chưa xác định được giá sản phẩm.'; }
    else { subtotal += unitCents * BigInt(item.quantity); prices[item.product_id] = decimal(unitCents); }
    return { ...product, ...item, name: product?.name || `Sản phẩm #${item.product_id}`, price: unitCents == null ? null : decimal(unitCents),
      line_total: unitCents == null ? null : decimal(unitCents * BigInt(item.quantity)), available: !reason, availability_message: reason };
  });
  return { rows, prices, subtotal: allPricesKnown ? decimal(subtotal) : null };
}

async function fetchPreview(items) {
  const body = await commerceApi('/api/cart/preview', { method: 'POST', body: { items: items.map(({ product_id, quantity }) => ({ product_id, quantity, selected: true })) } });
  return previewRows(items, body.cart);
}

const pricesChanged = (previous, current) => Object.entries(current).some(([id, value]) => previous[id] != null && cents(previous[id]) != null && cents(previous[id]) !== cents(value));
const receiptPreview = order => ({ rows: order.items.map(item => ({ ...item, price: item.unit_price, line_total: item.subtotal, available: true, availability_message: '' })), prices: {}, subtotal: order.subtotal_amount ?? order.total_amount });
const voucherKey = (draft, method, prices, userId) => JSON.stringify([userId, draft?.intent_id, draft?.items, method, prices]);
const voucherRejections = ['INVALID_VOUCHER', 'VOUCHER_NOT_FOUND', 'VOUCHER_INACTIVE', 'VOUCHER_NOT_STARTED', 'VOUCHER_EXPIRED', 'VOUCHER_MINIMUM_NOT_MET', 'VOUCHER_QUOTA_EXCEEDED', 'VOUCHER_USER_LIMIT_EXCEEDED', 'VOUCHER_ONLINE_ZERO_TOTAL', 'VOUCHERS_DISABLED', 'VOUCHER_SCHEMA_NOT_READY', 'ORDER_WORKFLOW_DISABLED'];

function CheckoutItem({ item }) {
  const source = resolveImageUrl(item.image_url);
  return <article className={`checkout-item${item.available ? '' : ' is-unavailable'}`} data-product-id={item.product_id}>
    <a className="checkout-item-image" href={`/products/${item.product_id}`} aria-label={`Xem chi tiết ${item.name}`}><ProductImage key={source} source={source} name={item.name} width={64} height={64} /></a>
    <div className="checkout-item-copy">
      <h3><a href={`/products/${item.product_id}`}>{item.name}</a></h3>
      <p className="checkout-item-unit">Đơn giá: {amount(item.price)}</p>
      <div className="checkout-item-bottom"><span className="checkout-item-quantity">Số lượng: {item.quantity}</span><span className="checkout-item-total">{amount(item.line_total)}</span></div>
      {!item.available && <p className="checkout-item-error" role="alert">{item.availability_message}</p>}
    </div>
  </article>;
}

export default function CheckoutPage() {
  const { user, authLoading, cartSource, resumeCheckout, submitOrder, orderCommitted, quoteCheckoutVoucher } = useCommerce();
  const voucherReadiness = useVoucherReadiness();
  const [draft, setDraft] = useState(null);
  const [initialized, setInitialized] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [shipping, setShipping] = useState(emptyShipping);
  const [paymentMethod, setPaymentMethod] = useState('COD');
  const [errors, setErrors] = useState({});
  const [preview, setPreview] = useState({ rows: [], prices: {}, subtotal: null });
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [priceNotice, setPriceNotice] = useState(false);
  const [order, setOrder] = useState(null);
  const [submitError, setSubmitError] = useState('');
  const [voucherInput, setVoucherInput] = useState('');
  const [voucherQuote, setVoucherQuote] = useState(null);
  const [voucherError, setVoucherError] = useState('');
  const [voucherNotice, setVoucherNotice] = useState('');
  const [voucherBusy, setVoucherBusy] = useState(false);
  const voucherSequence = useRef(0);
  const voucherController = useRef(null);
  const submitting = useRef(false);
  const requestSequence = useRef(0);
  const apiPrices = useRef({});
  const formRef = useRef(null);
  const selectedCode = draft?.voucher_code || '';
  const voucherAvailable = voucherReadiness.ready && (paymentMethod === 'COD' || voucherReadiness.onlineReady);
  const quoteKey = voucherKey(draft, paymentMethod, preview.prices, user?.user_id);
  const currentQuote = voucherQuote?.requestKey === quoteKey && voucherQuote.voucher.code === selectedCode ? voucherQuote : null;

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `Đặt hàng | ${BRAND_NAME}`;
    return () => { document.title = previousTitle; requestSequence.current++; voucherSequence.current++; voucherController.current?.abort(); };
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user || cartSource === 'guest-merge') {
      let alive = true;
      setRedirecting(true);
      Promise.resolve().then(() => resumeCheckout()).then(started => {
        if (!alive || started) return;
        setDraft(null); setInitialized(true); setLoading(false); setRedirecting(false);
      }).catch(error => {
        if (!alive) return;
        setDraft(null); setPreviewError(error.message); setInitialized(true); setLoading(false); setRedirecting(false);
      });
      return () => { alive = false; };
    }
    const saved = user.role === 'user' ? readCheckoutDraft(user.user_id) : null;
    setDraft(saved); setShipping(saved?.shipping || emptyShipping); setPaymentMethod(saved?.payment_method || 'COD');
    voucherSequence.current++; voucherController.current?.abort();
    setVoucherInput(saved?.voucher_code || ''); setVoucherQuote(null); setVoucherError(''); setVoucherNotice(''); setVoucherBusy(false);
    setOrder(saved?.order || null);
    if (saved?.order) { setPreview(receiptPreview(saved.order)); setLoading(false); }
    setInitialized(true); setRedirecting(false);
    if (!saved) setLoading(false);
  }, [authLoading, user?.user_id, user?.role, cartSource]);

  function persist(patch) {
    try {
      const saved = saveCheckoutDraft(user.user_id, { ...patch, intent_id: draft.intent_id });
      if (saved.intent_id !== draft.intent_id || !sameItems(saved.items, draft.items)) throw new Error('Sản phẩm đặt hàng đã thay đổi. Vui lòng chọn lại sản phẩm.');
      setDraft(saved); setStorageError('');
      return true;
    } catch (error) { setStorageError(error.message); return false; }
  }

  async function refreshPreview() {
    if (!draft || draft.order || order || !user || cartSource === 'guest-merge') return;
    const sequence = ++requestSequence.current;
    setLoading(true); setPreviewError('');
    try {
      const fresh = await fetchPreview(draft.items);
      if (sequence !== requestSequence.current) return;
      setPriceNotice(pricesChanged(apiPrices.current, fresh.prices));
      apiPrices.current = fresh.prices; setPreview(fresh); persist({ prices: fresh.prices });
    } catch (error) { if (sequence === requestSequence.current) setPreviewError(error.message); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }

  useEffect(() => {
    if (!draft || !user || user.role !== 'user' || cartSource === 'guest-merge') return;
    if (draft.order) { setPreview(receiptPreview(draft.order)); setOrder(draft.order); setLoading(false); return; }
    apiPrices.current = draft.prices;
    refreshPreview();
    return () => { requestSequence.current++; };
  }, [draft?.intent_id, user?.user_id, cartSource]);

  async function checkVoucher(code, commitCode = false) {
    if (!draft || !user || !voucherAvailable || submitting.current || draft.submission || order) return;
    voucherController.current?.abort();
    const controller = new AbortController();
    voucherController.current = controller;
    const sequence = ++voucherSequence.current;
    const key = quoteKey;
    setVoucherBusy(true); setVoucherQuote(null); setVoucherError(''); setVoucherNotice('');
    try {
      const quote = await quoteCheckoutVoucher({ code, items: draft.items.map(({ product_id, quantity }) => ({ product_id, quantity })), payment_method: paymentMethod }, { signal: controller.signal });
      if (sequence !== voucherSequence.current || controller.signal.aborted) return;
      if (commitCode && !persist({ voucher_code: quote.voucher.code })) return;
      setVoucherQuote({ ...quote, requestKey: key }); setVoucherInput(quote.voucher.code);
    } catch (error) {
      if (sequence === voucherSequence.current && !controller.signal.aborted) setVoucherError(error.message);
    } finally { if (sequence === voucherSequence.current) setVoucherBusy(false); }
  }

  // Quotes belong to a specific purchase, catalog price snapshot and payment
  // method. An older response is never used for a changed checkout.
  useEffect(() => {
    voucherSequence.current++; voucherController.current?.abort(); setVoucherBusy(false);
  }, [quoteKey, voucherAvailable]);

  useEffect(() => {
    if (!selectedCode || !voucherAvailable || loading || draft?.submission || order) return;
    if (voucherQuote?.requestKey === quoteKey && voucherQuote.voucher.code === selectedCode) return;
    checkVoucher(selectedCode);
    return () => { voucherSequence.current++; voucherController.current?.abort(); setVoucherBusy(false); };
  }, [selectedCode, quoteKey, voucherAvailable, loading, Boolean(draft?.submission), order?.order_id]);

  function changeVoucher(value) {
    if (submitting.current || draft?.submission || order) return;
    voucherSequence.current++; voucherController.current?.abort(); setVoucherBusy(false);
    setVoucherInput(value); setVoucherQuote(null); setVoucherError(''); setVoucherNotice(''); setSubmitError('');
    if (selectedCode) persist({ voucher_code: '' });
  }

  function removeVoucher() {
    if (submitting.current || draft?.submission || order) return;
    changeVoucher('');
  }

  function applyVoucher() {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(voucherInput.trim())) { setVoucherError('Nhập mã Voucher gồm 1–64 chữ cái, chữ số, dấu gạch ngang hoặc gạch dưới.'); return; }
    checkVoucher(voucherInput.trim(), true);
  }

  function changeShipping(event) {
    if (submitting.current || draft?.submission || order) return;
    const { name, value } = event.target;
    const next = { ...shipping, [name]: value };
    setShipping(next); setSubmitError(''); persist({ shipping: next });
    if (errors[name]) setErrors(current => ({ ...current, [name]: validateShipping(next)[name] }));
  }

  function blurField(event) {
    const name = event.target.name;
    setErrors(current => ({ ...current, [name]: validateShipping(shipping)[name] }));
  }

  async function confirm(event) {
    event.preventDefault();
    if (submitting.current || order) return;
    const invalid = validateShipping(shipping);
    setErrors(invalid);
    if (Object.keys(invalid).length) { formRef.current?.elements.namedItem(Object.keys(invalid)[0])?.focus(); return; }
    const current = readCheckoutDraft(user?.user_id);
    if (!current || current.intent_id !== draft?.intent_id || !sameItems(current.items, draft.items)) {
      setStorageError('Sản phẩm đặt hàng đã thay đổi. Vui lòng quay lại giỏ hàng hoặc chọn Mua ngay để kiểm tra lại.');
      return;
    }
    if (!current.submission && current.voucher_code !== selectedCode) { setStorageError('Mã Voucher trong bản nháp đã thay đổi. Vui lòng tải lại trang để kiểm tra.'); return; }
    if (!user || user.role !== 'user' || cartSource === 'guest-merge') { await resumeCheckout(); return; }
    if (!current.submission && selectedCode && (!voucherAvailable || !currentQuote || voucherBusy)) {
      setVoucherError('Vui lòng kiểm tra lại Voucher hoặc bỏ mã trước khi đặt hàng.'); return;
    }
    const sequence = ++requestSequence.current;
    submitting.current = true;
    voucherSequence.current++; voucherController.current?.abort(); setVoucherBusy(false);
    setConfirming(true); setSubmitError('');
    let attempt = current.submission;
    try {
      if (!attempt) {
        const fresh = await fetchPreview(draft.items);
        if (sequence !== requestSequence.current) return;
        const changed = pricesChanged(apiPrices.current, fresh.prices);
        apiPrices.current = fresh.prices; setPreview(fresh); setPriceNotice(changed);
        if (!persist({ shipping, payment_method: paymentMethod, prices: fresh.prices })) return;
        if (changed || fresh.rows.some(item => !item.available)) return;
        if (selectedCode) {
          const quote = await quoteCheckoutVoucher({ code: selectedCode, items: draft.items.map(({ product_id, quantity }) => ({ product_id, quantity })), payment_method: paymentMethod });
          if (sequence !== requestSequence.current) return;
          setVoucherQuote({ ...quote, requestKey: voucherKey(draft, paymentMethod, fresh.prices, user.user_id) });
          if (quote.discount_amount !== currentQuote.discount_amount || quote.total_amount !== currentQuote.total_amount || quote.subtotal_amount !== currentQuote.subtotal_amount) {
            setVoucherNotice('Ưu đãi hoặc giá sản phẩm đã thay đổi. Vui lòng kiểm tra số tiền mới rồi xác nhận lại.'); return;
          }
        }
        const saved = beginCheckoutSubmission(user.user_id);
        attempt = saved.submission; setDraft(saved);
      }
      // Retry a saved request directly: the first commit may already have consumed its stock/cart.
      const result = await submitOrder(attempt.payload, attempt.key);
      if (sequence !== requestSequence.current) return;
      if (!Number.isSafeInteger(result.order?.order_id) || result.order.order_id <= 0 ||
        typeof result.order.total_amount !== 'string' || !Array.isArray(result.order.items)) throw new Error('Chưa nhận được mã đơn hợp lệ. Vui lòng thử lại để kiểm tra kết quả.');
      setOrder(result.order); setPreview(receiptPreview(result.order)); setPreviewError(''); setPriceNotice(false);
      try { setDraft(completeCheckoutSubmission(user.user_id, attempt.key, result.order)); }
      catch { setStorageError('Đơn hàng đã được lưu nhưng chưa lưu được kết quả trong trình duyệt. Nếu tải lại, hãy thử lại để lấy đúng mã đơn này.'); }
      await orderCommitted(draft.intent_id);
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      // These responses prove that this request did not commit. Ambiguous failures retain the key.
      const rejected = ['INVALID_ORDER', 'CART_CHANGED', 'PRODUCT_UNAVAILABLE', 'OUT_OF_STOCK', 'ORDER_TOTAL_TOO_LARGE', ...voucherRejections].includes(error.code);
      if (attempt && rejected) {
        try { setDraft(clearCheckoutSubmission(user.user_id, attempt.key)); }
        catch (failure) { setStorageError(failure.message); }
      }
      if (voucherRejections.includes(error.code)) { setVoucherQuote(null); setVoucherError(error.message); }
      if (![401, 403].includes(error.status)) setSubmitError(error.message);
    } finally {
      submitting.current = false;
      if (sequence === requestSequence.current) { setLoading(false); setConfirming(false); }
    }
  }

  const pending = Boolean(draft?.submission);
  const locked = confirming || pending || Boolean(order);
  const unavailable = !order && !pending && preview.rows.some(item => !item.available);
  const disabled = confirming || Boolean(order || storageError) || (!pending && (loading || Boolean(previewError) || !preview.rows.length || unavailable || (selectedCode && (!voucherAvailable || !currentQuote || voucherBusy))));
  const hasVoucher = Boolean(order?.voucher_code_snapshot || (pending ? draft.submission.payload.voucher_code : selectedCode));
  const summaryAmount = hasVoucher ? voucherAmount : amount;
  const summaryQuote = currentQuote && (voucherAvailable || pending) ? currentQuote : null;
  const subtotalAmount = order ? order.subtotal_amount ?? order.total_amount : summaryQuote?.subtotal_amount ?? preview.subtotal;
  const discountAmount = order ? order.discount_amount : summaryQuote?.discount_amount;
  const totalAmount = order ? order.total_amount : hasVoucher ? summaryQuote?.total_amount ?? null : preview.subtotal;
  const editHref = draft?.type === 'buy-now' ? `/products/${draft.items[0].product_id}` : '/cart';
  const field = (name, label, options = {}) => <div className={`checkout-field${options.wide ? ' checkout-field-wide' : ''}`}>
    <label htmlFor={`checkout-${name}`}>{label}{options.optional ? <span className="checkout-optional" aria-hidden="true"> (không bắt buộc)</span> : <span className="checkout-required" aria-hidden="true"> *</span>}</label>
    {options.multiline ? <textarea id={`checkout-${name}`} name={name} rows={name === 'address' ? 3 : 2} minLength={name === 'address' ? 5 : undefined} maxLength={name === 'address' ? 255 : 200} autoComplete={options.autoComplete} placeholder={options.placeholder} value={shipping[name]} required={!options.optional} aria-invalid={Boolean(errors[name])} aria-describedby={errors[name] ? `checkout-${name}-error` : undefined} disabled={locked} onChange={changeShipping} onBlur={blurField} />
      : <input id={`checkout-${name}`} name={name} type={name === 'phone' ? 'tel' : 'text'} maxLength={name === 'phone' ? 20 : 100} autoComplete={options.autoComplete} placeholder={options.placeholder} value={shipping[name]} required aria-invalid={Boolean(errors[name])} aria-describedby={errors[name] ? `checkout-${name}-error` : undefined} disabled={locked} onChange={changeShipping} onBlur={blurField} />}
    {errors[name] && <p className="checkout-field-error" id={`checkout-${name}-error`} role="alert">{errors[name]}</p>}
  </div>;

  return <div className="container checkout-page">
    <nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><a href="/cart">Giỏ hàng</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">Đặt hàng</span></nav>
    <div className="checkout-page-heading"><div><p className="checkout-eyebrow">SẮP ĐẾN VỚI NGƯỜI BẠN NHỎ</p><h1>Đặt hàng</h1><p className="checkout-intro">Kiểm tra sản phẩm và điền thông tin nhận hàng của bạn.</p></div><a className="text-link checkout-back" href="/cart"><ArrowLeft size={15} aria-hidden="true" />Quay lại giỏ hàng</a></div>

    {authLoading || !initialized || redirecting ? <section className="checkout-state" role="status"><PackageCheck size={36} aria-hidden="true" /><h2>Đang chuẩn bị thông tin đặt hàng</h2><div className="skeleton" /><p>Vui lòng chờ trong giây lát.</p></section>
      : !user || cartSource === 'guest-merge' || !draft || draft.user_id !== user.user_id || user.role !== 'user' ? <section className="checkout-state"><ShoppingBag size={42} strokeWidth={1.4} aria-hidden="true" /><h2>{user?.role === 'admin' ? 'Đặt hàng dành cho tài khoản khách hàng' : 'Chưa có sản phẩm để đặt hàng'}</h2><p>{previewError || (user?.role === 'admin' ? 'Vui lòng đăng nhập bằng tài khoản khách hàng để tiếp tục mua sắm.' : 'Chọn sản phẩm trong giỏ hàng hoặc dùng Mua ngay để tiếp tục.')}</p><div className="checkout-state-actions"><a className="button button-primary" href="/products">Xem sản phẩm</a><a className="button button-outline" href="/cart">Đến giỏ hàng</a></div></section>
        : <>
          {previewError && <div className="checkout-alert is-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><p>{previewError}</p><button className="button button-outline" type="button" disabled={loading} onClick={refreshPreview}>Thử lại</button></div></div>}
          {storageError && <div className="checkout-alert is-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><p>{storageError}</p></div>}
          {submitError && <div className="checkout-alert is-error checkout-submit-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><p>{submitError}</p></div>}
          {pending && !order && <div className="checkout-alert checkout-pending" role="status"><Info size={18} aria-hidden="true" /><p>{confirming ? 'Đang gửi yêu cầu đặt hàng. Vui lòng chờ kết quả.' : 'Lần đặt hàng trước chưa có kết quả xác nhận. Nhấn Thử lại đặt hàng để kiểm tra đúng yêu cầu đó; thông tin được giữ nguyên để tránh tạo đơn trùng.'}</p></div>}
          {priceNotice && <div className="checkout-alert checkout-price-notice" role="status"><Info size={18} aria-hidden="true" /><p>Giá sản phẩm đã thay đổi. Vui lòng kiểm tra lại giá và tiền hàng trước khi xác nhận.</p></div>}
          {unavailable && <div className="checkout-alert is-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><p>Một số sản phẩm chưa thể đặt hàng. Vui lòng <a href={editHref}>kiểm tra lại sản phẩm và số lượng</a> trước khi tiếp tục.</p></div>}
          {!pending && !order && !loading && preview.rows.length > 0 && preview.rows.every(item => !item.available) && <div className="checkout-alert"><ShoppingBag size={18} aria-hidden="true" /><p>Chưa có sản phẩm hợp lệ để đặt hàng. <a href="/products">Quay lại mua sắm</a> để chọn sản phẩm khác.</p></div>}
          {order && <div className="checkout-alert is-success checkout-confirmation" role="status"><CheckCircle2 size={18} aria-hidden="true" /><div><p>Đặt hàng thành công. Mã đơn hàng: <strong>#{order.order_id}</strong>. Đơn hàng đã được lưu.</p><p>Trạng thái: {orderStatusLabel(order)}. Thanh toán: {order.payment_status}.</p><p>{order.payment_method === 'ONLINE' ? order.workflow_version === 2 ? 'Đơn Online được thanh toán trước khi Admin duyệt. Xem đơn hàng để theo dõi hướng dẫn thanh toán.' : 'Thanh toán ONLINE mô phỏng chỉ được thực hiện sau khi Admin duyệt đơn.' : order.total_amount === '0.00' ? 'Đơn COD được giảm toàn bộ tiền hàng. Cửa hàng sẽ duyệt đơn trước khi giao.' : 'Đơn COD cần được Admin duyệt trước khi giao. Bạn thanh toán khi nhận hàng.'}</p><a href="/products">Tiếp tục mua sắm</a></div></div>}

          <form className="checkout-form" ref={formRef} noValidate onSubmit={confirm}>
            <div className="checkout-layout">
              <div className="checkout-main">
                <section className="checkout-card" aria-labelledby="checkout-shipping-title">
                  <div className="checkout-card-heading"><span className="checkout-step" aria-hidden="true">1</span><h2 id="checkout-shipping-title">Thông tin nhận hàng</h2></div>
                  <p className="checkout-section-note">Thông tin này chỉ áp dụng cho lần đặt hàng hiện tại.</p>
                  <div className="checkout-fields">
                    {field('recipient_name', 'Họ và tên', { autoComplete: 'name', placeholder: 'Tên người nhận hàng' })}
                    {field('phone', 'Số điện thoại', { autoComplete: 'tel', placeholder: 'Số điện thoại liên hệ' })}
                    {field('address', 'Địa chỉ đầy đủ', { wide: true, multiline: true, autoComplete: 'street-address', placeholder: 'Số nhà, đường, phường/xã, quận/huyện, tỉnh/thành phố' })}
                    {field('note', 'Ghi chú', { wide: true, multiline: true, optional: true, placeholder: 'Lưu ý cho cửa hàng hoặc người giao hàng' })}
                  </div>
                </section>

                <section className="checkout-card">
                  <fieldset className="checkout-payment" disabled={locked}>
                    <legend><span className="checkout-card-heading"><span className="checkout-step" aria-hidden="true">2</span><span>Phương thức thanh toán</span></span></legend>
                    <div className="checkout-payment-options">
                      {[{ value: 'COD', title: 'Thanh toán khi nhận hàng (COD)', description: 'Cửa hàng duyệt đơn trước khi giao. Bạn thanh toán khi nhận hàng.', Icon: Truck }, { value: 'ONLINE', title: 'Thanh toán online (mô phỏng)', description: voucherReadiness.onlineReady ? 'Thanh toán trước khi Admin duyệt. Hướng dẫn thanh toán được cập nhật trên đơn hàng.' : 'Chờ Admin duyệt trước khi thanh toán mô phỏng. Không cần nhập thông tin thẻ.', Icon: CreditCard }].map(({ value, title, description, Icon }) => <label key={value} className={`checkout-payment-option${paymentMethod === value ? ' is-selected' : ''}`}><input type="radio" name="payment_method" value={value} aria-label={title} checked={paymentMethod === value} onChange={() => { if (locked) return; setPaymentMethod(value); setVoucherError(''); setVoucherNotice(''); setSubmitError(''); persist({ payment_method: value }); }} /><span className="checkout-payment-copy"><strong>{title}</strong><small>{description}</small></span><Icon className="checkout-payment-icon" size={20} aria-hidden="true" /></label>)}
                    </div>
                    <p className="checkout-payment-note"><Info size={15} aria-hidden="true" />{voucherReadiness.onlineReady ? 'Online thanh toán trước, sau đó chờ Admin duyệt; COD được duyệt trước khi giao.' : 'Cả COD và Online đều cần Admin duyệt trước khi xử lý tiếp.'}</p>
                  </fieldset>
                </section>
              </div>

              <aside className="checkout-card checkout-summary" aria-labelledby="checkout-summary-title">
                <div className="checkout-summary-heading"><h2 id="checkout-summary-title">Đơn hàng của bạn</h2><span>{draft.items.length} sản phẩm</span></div>
                <div className="checkout-source"><ShoppingBag size={12} aria-hidden="true" />{draft.type === 'buy-now' ? 'Sản phẩm Mua ngay' : 'Sản phẩm đã chọn từ giỏ hàng'}</div>
                {loading && !preview.rows.length ? <p className="checkout-preview-status" role="status">Đang kiểm tra sản phẩm...</p> : <div className="checkout-items">{preview.rows.map(item => <CheckoutItem key={item.product_id} item={item} />)}</div>}
                {!order && <CheckoutVoucher ready={voucherReadiness.ready} available={voucherAvailable} readinessLoading={voucherReadiness.loading} code={voucherInput} appliedCode={selectedCode || draft.submission?.payload.voucher_code || ''} quote={currentQuote} error={voucherError} notice={voucherNotice} busy={voucherBusy} locked={locked} disabled={loading || Boolean(previewError) || unavailable} subtotal={preview.subtotal} selectionKey={quoteKey} onChange={changeVoucher} onApply={applyVoucher} onSelect={async code => { setVoucherInput(code); await checkVoucher(code, true); }} onRemove={removeVoucher} />}
                <dl className="checkout-totals"><div><dt>Tạm tính</dt><dd className="checkout-subtotal">{summaryAmount(subtotalAmount)}</dd></div>{hasVoucher && <div className="checkout-voucher-discount"><dt>Giảm giá Voucher{order?.voucher_code_snapshot ? <small>{order.voucher_code_snapshot}</small> : null}</dt><dd>{discountAmount == null ? 'Đang chờ xác nhận' : `−${summaryAmount(discountAmount)}`}</dd></div>}<div className="checkout-shipping"><dt>Phí vận chuyển</dt><dd>Chưa xác định</dd></div><div className="checkout-grand-total"><dt>Tiền hàng chưa gồm vận chuyển</dt><dd className="checkout-total">{summaryAmount(totalAmount)}</dd></div></dl>
                <p className="checkout-shipping-note">Phí vận chuyển sẽ được cửa hàng thông báo khi xác nhận đơn.</p>
                <button className="button button-primary checkout-confirm checkout-submit" type="submit" disabled={disabled}>{order ? `Đã đặt hàng #${order.order_id}` : confirming ? 'Đang đặt hàng...' : pending ? 'Thử lại đặt hàng' : 'Xác nhận đặt hàng'}<ChevronRight size={17} aria-hidden="true" /></button>
                <p className="checkout-confirm-note">{order ? 'Tiền hàng được xác nhận từ đơn đã lưu, chưa gồm phí vận chuyển.' : 'Đơn hàng chỉ được xác nhận khi cửa hàng đã lưu đơn và trả về mã đơn hàng.'}</p>
                {!pending && !order && <a className="checkout-edit-link" href={editHref}><ArrowLeft size={14} aria-hidden="true" />{draft.type === 'buy-now' ? 'Chỉnh sản phẩm Mua ngay' : 'Chỉnh sản phẩm trong giỏ hàng'}</a>}
                <div className="checkout-preview-status"><ShieldCheck size={14} aria-hidden="true" /><span>{order ? 'Đơn hàng đã được lưu.' : loading ? 'Đang cập nhật giá và tồn kho...' : 'Giá và tồn kho được kiểm tra lại khi xác nhận.'}</span><button className="checkout-refresh" type="button" onClick={refreshPreview} disabled={loading || locked} aria-label="Cập nhật giá và tồn kho"><RefreshCw size={14} aria-hidden="true" /></button></div>
              </aside>
            </div>
          </form>
        </>}
  </div>;
}
