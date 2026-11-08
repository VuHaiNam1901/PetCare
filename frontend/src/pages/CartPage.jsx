import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Minus, Plus, RefreshCw, ShoppingCart, Trash2 } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { ProductImage } from '../components/ProductCard.jsx';
import { ErrorNotice } from '../components/Feedback.jsx';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import { BRAND_NAME } from '../config/branding.js';

function selectable(item) {
  return Boolean(item.available) && Number.isInteger(Number(item.quantity)) && Number(item.quantity) > 0
    && Number(item.quantity) <= Number(item.stock_quantity);
}

function CartRow({ item, disabled, updateItem, removeItem, selectItem, run }) {
  const name = item.name || `Sản phẩm #${item.product_id}`;
  const quantity = Number(item.quantity);
  const stock = Number(item.stock_quantity);
  const canEditQuantity = item.status === 'Đang bán' && Number.isInteger(stock) && stock > 0;
  const [draft, setDraft] = useState(String(item.quantity));
  const [quantityError, setQuantityError] = useState('');
  const available = selectable(item);
  const source = resolveImageUrl(item.image_url);

  useEffect(() => { setDraft(String(item.quantity)); setQuantityError(''); }, [item.quantity]);

  const changeQuantity = async next => {
    if (!canEditQuantity || disabled) return;
    if (!Number.isInteger(Number(next)) || Number(next) < 1 || Number(next) > stock || String(next).trim() === '') {
      setQuantityError(`Số lượng phải là số nguyên từ 1 đến ${stock}.`);
      return;
    }
    const value = Number(next);
    setDraft(String(value));
    setQuantityError('');
    if (value !== quantity) await run(() => updateItem(item.product_id, value));
  };

  return (
    <article className="cart-row" data-product-id={item.product_id}>
      <input className="cart-row-checkbox" type="checkbox" aria-label={`Chọn ${name}`} checked={available && Boolean(item.selected)} disabled={disabled || !available} onChange={event => run(() => selectItem(item.product_id, event.target.checked))} />
      <a className="cart-row-image" href={`/products/${item.product_id}`} aria-label={`Xem chi tiết ${name}`}><ProductImage key={source} source={source} name={name} width={100} height={100} /></a>
      <div className="cart-row-product">
        <h2><a href={`/products/${item.product_id}`}>{name}</a></h2>
        {!available && <p className="cart-row-unavailable">{item.availability_message || (item.status !== 'Đang bán' ? 'Sản phẩm hiện không được bán. Bạn có thể xóa khỏi giỏ.' : stock <= 0 ? 'Sản phẩm đã hết hàng. Bạn có thể xóa khỏi giỏ.' : `Số lượng trong giỏ vượt tồn kho hiện có (${stock}). Hãy điều chỉnh để đặt hàng.`)}</p>}
      </div>
      <p className="cart-row-unit"><span className="cart-mobile-label">Đơn giá</span>{formatPrice(item.price)}</p>
      <div className="cart-row-quantity">
        <div className="quantity-control">
          <button type="button" aria-label={`Giảm số lượng ${name}`} disabled={disabled || !canEditQuantity || quantity <= 1} onClick={() => changeQuantity(Math.max(1, Math.min(stock, quantity - 1)))}><Minus size={15} aria-hidden="true" /></button>
          <input type="number" inputMode="numeric" min={1} max={Math.max(1, stock || 1)} step={1} aria-label={`Số lượng ${name}`} value={draft} disabled={disabled || !canEditQuantity} onChange={event => { setDraft(event.target.value); setQuantityError(''); }} onBlur={() => changeQuantity(draft)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
          <button type="button" aria-label={`Tăng số lượng ${name}`} disabled={disabled || !canEditQuantity || quantity >= stock} onClick={() => changeQuantity(quantity + 1)}><Plus size={15} aria-hidden="true" /></button>
        </div>
        {quantityError && <p className="cart-quantity-error" role="alert">{quantityError}</p>}
      </div>
      <p className="cart-row-total"><span className="cart-mobile-label">Thành tiền</span>{formatPrice(item.line_total)}</p>
      <button className="cart-remove icon-button" type="button" aria-label={`Xóa ${name}`} disabled={disabled} onClick={() => run(() => removeItem(item.product_id))}><Trash2 size={18} aria-hidden="true" /></button>
    </article>
  );
}

export default function CartPage() {
  const commerce = useCommerce();
  const { user, authLoading, cart, cartLoading, cartError, busy, cartSource, mergeError, mergeConflicts = [], mergeCanEdit, retryCart, retryMerge, updateItem, removeItem, selectItem, selectAll, checkout, logout } = commerce;
  const [actionError, setActionError] = useState('');
  const allCheckbox = useRef(null);
  const items = cart?.items || [];
  const validItems = items.filter(selectable);
  const selected = validItems.filter(item => item.selected);
  const selectedQuantity = selected.reduce((sum, item) => sum + Number(item.quantity), 0);
  const selectedSubtotal = cart?.selected_subtotal ?? selected.reduce((sum, item) => sum + Math.round(Number(item.price) * 100) * Number(item.quantity), 0) / 100;
  const allSelected = validItems.length > 0 && selected.length === validItems.length;
  const merging = cartSource === 'guest-merge';
  const editingDisabled = Boolean(busy || authLoading || (merging && !mergeCanEdit));
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `Giỏ hàng | ${BRAND_NAME}`;
    return () => { document.title = previousTitle; };
  }, []);

  useEffect(() => {
    if (allCheckbox.current) allCheckbox.current.indeterminate = selected.length > 0 && !allSelected;
  }, [selected.length, allSelected]);

  const run = async action => {
    setActionError('');
    try { await action(); } catch (error) { setActionError(error.message || 'Chưa thực hiện được thao tác. Vui lòng thử lại.'); }
  };

  return (
    <div className="container cart-page">
      <nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">Giỏ hàng</span></nav>
      <div className="cart-page-heading"><div><h1>Giỏ hàng</h1><p>{merging ? 'Giỏ khách đang chờ hợp nhất với tài khoản.' : user ? 'Giỏ hàng được lưu theo tài khoản của bạn.' : 'Bạn có thể mua sắm với tư cách khách và đăng nhập khi đặt hàng.'}</p></div><a className="text-link" href="/products">Tiếp tục mua sắm<ChevronRight size={14} aria-hidden="true" /></a></div>

      {isAdmin ? (
        <section className="cart-role-notice"><h2>Giỏ hàng dành cho tài khoản khách hàng</h2><p>Bạn đang đăng nhập bằng tài khoản Admin. Giỏ tài khoản không được chuyển thành giỏ khách khi đăng xuất.</p><button className="button button-outline" type="button" onClick={() => run(logout)} disabled={busy}>Đăng xuất để mua sắm với tư cách khách</button></section>
      ) : <>
        {merging && <section className="cart-merge-notice" aria-labelledby="cart-merge-title">
          <h2 id="cart-merge-title">Giỏ khách chưa đồng bộ</h2>
          <p>{mergeError || 'Đang hợp nhất giỏ khách. Vui lòng chờ xác nhận trước khi đặt hàng.'}</p>
          <p>Các dòng bên dưới thuộc giỏ khách; giỏ tài khoản vẫn được giữ nguyên cho đến khi hợp nhất thành công.</p>
          {mergeConflicts.length > 0 && <ul>{mergeConflicts.map((conflict, index) => <li key={`${conflict.product_id}-${index}`}><strong>{conflict.name || `Sản phẩm #${conflict.product_id}`}</strong>: {conflict.reason || 'Không thể hợp nhất.'}{conflict.requested_quantity != null && <> Tổng cần {conflict.requested_quantity} món.</>}{conflict.stock_quantity != null && <> Tồn kho {conflict.stock_quantity}.</>}</li>)}</ul>}
          <p>{mergeCanEdit ? 'Hãy điều chỉnh hoặc xóa sản phẩm không phù hợp rồi thử đồng bộ lại.' : 'Dữ liệu giỏ khách được giữ lại. Hãy thử đồng bộ lại để xác nhận kết quả trước khi chỉnh sửa hoặc đặt hàng.'}</p>
          <button className="button button-outline" type="button" disabled={busy || authLoading} onClick={() => run(retryMerge)}><RefreshCw size={15} aria-hidden="true" />Thử đồng bộ lại</button>
        </section>}

        {actionError && <p className="commerce-action-error" role="alert">{actionError}</p>}
        {authLoading || cartLoading ? <div className="cart-loading" role="status" aria-label="Đang tải giỏ hàng"><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line medium" /><p>Đang tải giỏ hàng...</p></div>
          : cartError ? <ErrorNotice title="Chưa tải được giỏ hàng" message={cartError} onRetry={() => run(retryCart)} />
          : items.length === 0 ? <section className="cart-empty" role="status"><ShoppingCart size={48} strokeWidth={1.4} aria-hidden="true" /><h2>Giỏ hàng đang trống</h2><p>Khám phá sản phẩm và chọn những món phù hợp cho thú cưng.</p><a className="button button-primary" href="/products">Tiếp tục mua sắm</a></section>
          : <div className="cart-layout">
            <section className="cart-items" aria-label="Sản phẩm trong giỏ">
              <div className="cart-selection-bar"><label><input ref={allCheckbox} type="checkbox" aria-label="Chọn tất cả sản phẩm hợp lệ" checked={allSelected} disabled={editingDisabled || !validItems.length} onChange={event => run(() => selectAll(event.target.checked))} />Chọn tất cả</label><span>{items.length} sản phẩm trong giỏ</span></div>
              <div className="cart-table-heading" aria-hidden="true"><span>Sản phẩm</span><span>Đơn giá</span><span>Số lượng</span><span>Thành tiền</span><span /></div>
              <div className="cart-rows">{items.map(item => <CartRow key={item.product_id} item={item} disabled={editingDisabled} updateItem={updateItem} removeItem={removeItem} selectItem={selectItem} run={run} />)}</div>
            </section>
            <aside className="cart-summary" aria-labelledby="cart-summary-title">
              <h2 id="cart-summary-title">Tóm tắt giỏ hàng</h2>
              <p className="cart-selection-summary" aria-live="polite">Đã chọn {selected.length} sản phẩm ({selectedQuantity} món)</p>
              <dl><div><dt>Tạm tính</dt><dd className="cart-subtotal">{formatPrice(selectedSubtotal)}</dd></div><div className="cart-shipping"><dt>Phí vận chuyển</dt><dd>Tính ở bước đặt hàng</dd></div></dl>
              <button className="button button-primary cart-checkout" type="button" disabled={!selected.length || busy || merging || authLoading} onClick={() => run(checkout)}>Đặt hàng ({selected.length})</button>
              {!user && <p>Chỉ cần đăng nhập hoặc đăng ký khi bạn chuyển sang đặt hàng.</p>}
              {merging && <p>Vui lòng hoàn tất đồng bộ giỏ trước khi tiếp tục.</p>}
              <a className="text-link" href="/products">Tiếp tục mua sắm<ChevronRight size={14} aria-hidden="true" /></a>
            </aside>
          </div>}
      </>}
    </div>
  );
}
