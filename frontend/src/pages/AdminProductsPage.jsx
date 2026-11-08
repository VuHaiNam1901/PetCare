import AdminVoucherNavLink from '../components/AdminVoucherNavLink.jsx';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, ClipboardList, FolderTree, Home, Package, Pencil, Plus, RefreshCw, Search, ShieldCheck, Users, X } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { EmptyState, ErrorNotice } from '../components/Feedback.jsx';
import { ProductImage } from '../components/ProductCard.jsx';
import { formatPrice, resolveImageUrl } from '../utils/catalog.js';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../admin-orders.css';
import '../admin-products.css';

const PAGE_SIZE = 20;
const STATUSES = ['Đang bán', 'Ngừng bán'];
const EMPTY_FILTERS = { q: '', category_id: '', status: '', min_price: '', max_price: '' };
const PRICE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const positiveId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const canonicalPrice = value => {
  const [whole, fraction = ''] = String(value).trim().split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
};
const invalidText = (value, multiline = false) => /[\uD800-\uDFFF]/u.test(value) || [...value].some(char => char.codePointAt(0) > 65535) ||
  (multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(value);
const validImagePath = value => value.length <= 500 && value.startsWith('/images/products/') &&
  value.slice('/images/products/'.length).split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && !part.includes('..')) &&
  /\.(?:webp|png|jpe?g|gif|avif)$/i.test(value);
const validProduct = product => product && positiveId(product.product_id) && positiveId(product.category_id) &&
  typeof product.name === 'string' && PRICE.test(String(product.price)) && Number.isInteger(product.stock_quantity) &&
  product.stock_quantity >= 0 && product.stock_quantity <= 2147483647 && STATUSES.includes(product.status) &&
  typeof product.image_url === 'string' && (product.description == null || typeof product.description === 'string');

function productValues(product) {
  return { name: product?.name || '', category_id: String(product?.category_id || ''), description: product?.description || '',
    price: product ? String(product.price) : '', stock_quantity: product ? String(product.stock_quantity) : '0',
    image_url: product?.image_url || '', status: product?.status || 'Đang bán' };
}

function prepareProduct(values, categories, original) {
  const errors = {};
  const payload = {};
  // PUT supports partial updates: do not overwrite stock or other untouched fields.
  for (const key of Object.keys(values).filter(key => !original || values[key] !== original[key])) {
    const value = values[key].trim();
    if (key === 'name') {
      if (!value || value.length > 150 || invalidText(value)) errors.name = 'Nhập tên từ 1–150 ký tự, không dùng emoji hoặc ký tự điều khiển.';
      payload.name = value;
    } else if (key === 'category_id') {
      if (!positiveId(Number(value)) || !categories.some(category => category.category_id === Number(value))) errors.category_id = 'Vui lòng chọn một danh mục hiện có.';
      payload.category_id = Number(value);
    } else if (key === 'price') {
      if (!PRICE.test(value)) errors.price = 'Giá từ 0 đến 9.999.999.999,99; dùng dấu chấm và tối đa 2 chữ số thập phân.';
      payload.price = canonicalPrice(value);
    } else if (key === 'stock_quantity') {
      const stock = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(stock) || stock < 0 || stock > 2147483647) errors.stock_quantity = 'Nhập số nguyên từ 0 đến 2.147.483.647.';
      payload.stock_quantity = stock;
    } else if (key === 'image_url') {
      if (!validImagePath(value)) errors.image_url = 'Dùng đường dẫn /images/products/... với đuôi webp, png, jpg, jpeg, gif hoặc avif; không dùng khoảng trắng hay dấu “..”.';
      payload.image_url = value;
    } else if (key === 'status') {
      if (!STATUSES.includes(value)) errors.status = 'Vui lòng chọn trạng thái hợp lệ.';
      payload.status = value;
    } else if (key === 'description') {
      if (value.length > 65535 || new TextEncoder().encode(value).length > 65535 || invalidText(value, true)) errors.description = 'Mô tả vượt giới hạn 65.535 byte hoặc chứa emoji/ký tự không được hỗ trợ.';
      payload.description = value || null;
    }
  }
  return { errors, payload };
}

function ProductsLoading({ label = 'Đang tải sản phẩm' }) {
  return <div className="admin-products-loading" role="status"><p>{label}...</p>{[0, 1, 2, 3].map(index => <div key={index} className="skeleton skeleton-line" aria-hidden="true" />)}</div>;
}

function ProductDialog({ title, busy, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="admin-orders-dialog admin-products-dialog" aria-labelledby="admin-product-dialog-title" aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="admin-products-dialog-heading"><h2 id="admin-product-dialog-title">{title}</h2><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Đóng hộp thoại"><X size={22} aria-hidden="true" /></button></div>
    {children}
  </dialog>;
}

function ProductForm({ product, categories, busy, error, onSave, onClose }) {
  const [original] = useState(() => product ? productValues(product) : null);
  const [values, setValues] = useState(() => productValues(product));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const change = event => {
    const { name, value } = event.target;
    setValues(previous => ({ ...previous, [name]: value }));
    setErrors(previous => ({ ...previous, [name]: '' })); setFormError('');
  };
  const field = name => ({ id: `admin-product-${name}`, name, value: values[name], onChange: change,
    'aria-invalid': Boolean(errors[name]), 'aria-describedby': errors[name] ? `admin-product-${name}-error` : undefined });
  const fieldError = name => errors[name] && <small id={`admin-product-${name}-error`} className="admin-products-field-error">{errors[name]}</small>;
  const submit = event => {
    event.preventDefault();
    if (busy) return;
    const { errors: nextErrors, payload } = prepareProduct(values, categories, original);
    setErrors(nextErrors); setFormError('');
    const invalid = Object.keys(nextErrors)[0];
    if (invalid) { event.currentTarget.elements.namedItem(invalid)?.focus(); return; }
    if (!Object.keys(payload).length) { setFormError('Bạn chưa thay đổi thông tin nào.'); return; }
    onSave(payload, product);
  };
  const imagePath = values.image_url.trim();
  return <ProductDialog title={product ? `Sửa sản phẩm #${product.product_id}` : 'Thêm sản phẩm'} busy={busy} onClose={onClose}>
    <form className="admin-products-form" noValidate onSubmit={submit}>
      <fieldset disabled={busy}><legend className="sr-only">Thông tin sản phẩm</legend><div className="admin-products-form-grid">
        <label className="admin-products-field admin-products-field-wide" htmlFor="admin-product-name"><span>Tên sản phẩm *</span><input {...field('name')} required maxLength={150} autoFocus />{fieldError('name')}</label>
        <label className="admin-products-field" htmlFor="admin-product-category_id"><span>Danh mục *</span><select {...field('category_id')} required><option value="">Chọn danh mục</option>{categories.map(category => <option key={category.category_id} value={category.category_id}>{category.name}</option>)}</select>{fieldError('category_id')}</label>
        <label className="admin-products-field" htmlFor="admin-product-status"><span>Trạng thái</span><select {...field('status')}>{STATUSES.map(status => <option key={status}>{status}</option>)}</select>{fieldError('status')}</label>
        <label className="admin-products-field" htmlFor="admin-product-price"><span>Giá bán (đ) *</span><input {...field('price')} inputMode="decimal" required maxLength={13} placeholder="Ví dụ: 125000 hoặc 125000.50" /><small>Tối đa 2 chữ số sau dấu chấm.</small>{fieldError('price')}</label>
        <label className="admin-products-field" htmlFor="admin-product-stock_quantity"><span>Tồn kho *</span><input {...field('stock_quantity')} type="number" inputMode="numeric" min="0" max="2147483647" step="1" required />{fieldError('stock_quantity')}</label>
        <label className="admin-products-field admin-products-field-wide" htmlFor="admin-product-image_url"><span>Đường dẫn ảnh *</span><input {...field('image_url')} maxLength={500} required placeholder="/images/products/ten-san-pham.webp" /><small>Chọn đường dẫn ảnh đã có trong /images/products/. Hiện chưa hỗ trợ tải ảnh lên.</small>{fieldError('image_url')}</label>
        {validImagePath(imagePath) && <div className="admin-products-image-preview"><ProductImage key={imagePath} source={resolveImageUrl(imagePath)} name={`Ảnh xem trước: ${values.name.trim() || 'Sản phẩm'}`} width={96} height={96} /></div>}
        <label className="admin-products-field admin-products-field-wide" htmlFor="admin-product-description"><span>Mô tả</span><textarea {...field('description')} rows={5} maxLength={65535} />{fieldError('description')}</label>
      </div></fieldset>
      {(formError || error) && <p className="admin-products-form-error" role="alert">{formError || error}</p>}
      <div className="admin-products-dialog-actions"><button type="button" className="button button-outline" disabled={busy} onClick={onClose}>Hủy</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Đang lưu...' : product ? 'Lưu thay đổi' : 'Thêm sản phẩm'}</button></div>
    </form>
  </ProductDialog>;
}

function AdminProductCatalog() {
  const { getAdminProducts, getAdminProductCategories, createAdminProduct, updateAdminProduct, stopAdminProduct } = useCommerce();
  const methods = useRef({});
  methods.current = { getAdminProducts, getAdminProductCategories, createAdminProduct, updateAdminProduct, stopAdminProduct };
  const [draft, setDraft] = useState({ ...EMPTY_FILTERS });
  const [query, setQuery] = useState({ ...EMPTY_FILTERS, page: 1 });
  const [filterError, setFilterError] = useState('');
  const [revision, setRevision] = useState(0);
  const [categoryRetry, setCategoryRetry] = useState(0);
  const [categories, setCategories] = useState({ loading: true, items: [], error: '' });
  const [result, setResult] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const busyRef = useRef(false);
  const alive = useRef(false);
  const current = result?.query === query && result?.revision === revision ? result : null;
  const loading = !current || current.loading;
  const canEdit = !categories.loading && !categories.error && categories.items.length > 0;
  const hasFilters = Object.keys(EMPTY_FILTERS).some(key => query[key] !== '');

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setCategories({ loading: true, items: [], error: '' });
    methods.current.getAdminProductCategories({ signal: controller.signal }).then(data => {
      if (!active) return;
      if (!Array.isArray(data.categories) || data.categories.some(category => !positiveId(category.category_id) || typeof category.name !== 'string')) throw new Error('Danh sách danh mục chưa hợp lệ. Vui lòng thử lại.');
      setCategories({ loading: false, items: data.categories, error: '' });
    }).catch(error => {
      if (active && !controller.signal.aborted && !error.obsolete && ![401, 403].includes(error.status)) setCategories({ loading: false, items: [], error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [categoryRetry]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ query, revision, loading: true, products: [], total: 0, error: '' });
    methods.current.getAdminProducts({ ...query, limit: PAGE_SIZE, signal: controller.signal }).then(data => {
      if (!active) return;
      if (!Array.isArray(data.products) || !data.products.every(validProduct) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('Danh sách sản phẩm chưa hợp lệ. Vui lòng thử lại.');
      const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (query.page > lastPage) { setQuery(previous => ({ ...previous, page: lastPage })); return; }
      setResult({ query, revision, loading: false, products: data.products, total: data.total, error: '' });
    }).catch(error => {
      if (active && !controller.signal.aborted && !error.obsolete && ![401, 403].includes(error.status)) setResult({ query, revision, loading: false, products: [], total: 0, error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [query, revision]);

  const reload = () => { if (!busyRef.current) setRevision(value => value + 1); };
  const reset = () => { setDraft({ ...EMPTY_FILTERS }); setFilterError(''); setQuery({ ...EMPTY_FILTERS, page: 1 }); };
  const applyFilters = event => {
    event.preventDefault();
    if (busyRef.current) return;
    const filters = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()]));
    if (filters.q.length > 150 || invalidText(filters.q)) { setFilterError('Tên tìm kiếm tối đa 150 ký tự, không dùng emoji hoặc ký tự điều khiển.'); return; }
    if ([filters.min_price, filters.max_price].some(value => value && !PRICE.test(value))) { setFilterError('Giá lọc phải từ 0 đến 9.999.999.999,99 và có tối đa 2 chữ số sau dấu chấm.'); return; }
    if (filters.min_price && filters.max_price && BigInt(canonicalPrice(filters.min_price).replace('.', '')) > BigInt(canonicalPrice(filters.max_price).replace('.', ''))) { setFilterError('Giá tối thiểu không được lớn hơn giá tối đa.'); return; }
    setFilterError(''); setQuery({ ...filters, page: 1 });
  };
  const openDialog = value => { if (!busyRef.current) { setActionError(''); setSuccess(''); setDialog(value); } };
  const closeDialog = () => { if (!busyRef.current) { setDialog(null); setActionError(''); } };
  const mutate = async (kind, payload, product) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setActionError(''); setSuccess('');
    try {
      const data = kind === 'stop' ? await methods.current.stopAdminProduct(product.product_id) : product ? await methods.current.updateAdminProduct(product.product_id, payload) : await methods.current.createAdminProduct(payload);
      if (!alive.current) return;
      if (!validProduct(data.product) || (product && data.product.product_id !== product.product_id) || (kind === 'stop' && data.product.status !== 'Ngừng bán')) {
        throw new Error('Chưa xác nhận được dữ liệu sau khi lưu. Hãy đóng form và tải lại danh sách để kiểm tra trước khi gửi lại.');
      }
      setDialog(null);
      setSuccess(kind === 'stop' ? `Đã ngừng bán “${data.product.name}”.` : product ? `Đã cập nhật “${data.product.name}”.` : `Đã thêm “${data.product.name}” (#${data.product.product_id}).`);
      // A later list error must not turn a confirmed save into a failed mutation.
      setRevision(value => value + 1);
    } catch (error) {
      if (alive.current && !error.obsolete && ![401, 403].includes(error.status)) setActionError(error.message + (!error.status && kind === 'save' && !product ? ' Hãy tải lại danh sách để kiểm tra trước khi thêm lại.' : ''));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return <>
    {success && <p className="admin-orders-success" role="status"><Check size={18} aria-hidden="true" />{success}</p>}
    {categories.error ? <ErrorNotice title="Chưa tải được danh mục" message={categories.error} onRetry={() => setCategoryRetry(value => value + 1)} /> : !categories.loading && !categories.items.length && <p className="admin-products-form-error" role="status">Chưa có danh mục. Cần có danh mục trước khi thêm hoặc sửa sản phẩm.</p>}
    <form className="admin-products-filters" onSubmit={applyFilters} noValidate aria-label="Tìm kiếm và lọc sản phẩm">
      <div className="admin-products-filter"><label htmlFor="admin-products-q">Tên sản phẩm</label><div className="admin-products-filter-search"><Search size={17} aria-hidden="true" /><input id="admin-products-q" type="search" maxLength={150} value={draft.q} onChange={event => setDraft(previous => ({ ...previous, q: event.target.value }))} placeholder="Nhập tên sản phẩm..." /></div></div>
      <div className="admin-products-filter"><label htmlFor="admin-products-category">Danh mục</label><select id="admin-products-category" disabled={categories.loading || Boolean(categories.error)} value={draft.category_id} onChange={event => setDraft(previous => ({ ...previous, category_id: event.target.value }))}><option value="">{categories.loading ? 'Đang tải danh mục...' : 'Tất cả danh mục'}</option>{categories.items.map(category => <option key={category.category_id} value={category.category_id}>{category.name}</option>)}</select></div>
      <div className="admin-products-filter"><label htmlFor="admin-products-status">Trạng thái</label><select id="admin-products-status" value={draft.status} onChange={event => setDraft(previous => ({ ...previous, status: event.target.value }))}><option value="">Tất cả trạng thái</option>{STATUSES.map(status => <option key={status}>{status}</option>)}</select></div>
      <div className="admin-products-filter"><label htmlFor="admin-products-min-price">Giá từ (đ)</label><input id="admin-products-min-price" inputMode="decimal" maxLength={13} value={draft.min_price} onChange={event => setDraft(previous => ({ ...previous, min_price: event.target.value }))} placeholder="Không giới hạn" /></div>
      <div className="admin-products-filter"><label htmlFor="admin-products-max-price">Giá đến (đ)</label><input id="admin-products-max-price" inputMode="decimal" maxLength={13} value={draft.max_price} onChange={event => setDraft(previous => ({ ...previous, max_price: event.target.value }))} placeholder="Không giới hạn" /></div>
      <div className="admin-products-filter-actions"><button className="button button-primary" type="submit" disabled={busy}><Search size={16} aria-hidden="true" />Áp dụng</button><button className="button button-outline" type="button" disabled={busy} onClick={reset}>Xóa bộ lọc</button></div>
    </form>
    {filterError && <p className="admin-products-form-error" role="alert">{filterError}</p>}
    <div className="admin-products-list-heading"><p aria-live="polite">{loading ? 'Đang tải danh sách...' : current.error ? 'Chưa tải được danh sách' : `${current.total} sản phẩm${hasFilters ? ' phù hợp bộ lọc' : ''}`}</p><div className="admin-products-heading-actions"><button className="button button-outline" type="button" disabled={busy || loading} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Tải lại</button><button className="button button-primary" type="button" disabled={busy || !canEdit} onClick={() => openDialog({ kind: 'form', product: null })}><Plus size={17} aria-hidden="true" />Thêm sản phẩm</button></div></div>
    {loading ? <ProductsLoading /> : current.error ? <ErrorNotice title="Chưa tải được sản phẩm" message={current.error} onRetry={reload} /> : !current.products.length ? <EmptyState title={hasFilters ? 'Chưa tìm thấy sản phẩm phù hợp' : 'Chưa có sản phẩm'} message={hasFilters ? 'Thử tên khác hoặc thay đổi bộ lọc.' : 'Thêm sản phẩm đầu tiên bằng nút Thêm sản phẩm.'} onReset={hasFilters ? reset : undefined} /> : <>
      <div className="admin-products-table-wrap"><table className="admin-products-table"><caption className="sr-only">Danh sách sản phẩm quản trị</caption><thead><tr><th scope="col">Sản phẩm</th><th scope="col">Danh mục</th><th scope="col">Giá bán</th><th scope="col">Tồn kho</th><th scope="col">Trạng thái</th><th scope="col">Thao tác</th></tr></thead><tbody>{current.products.map(product => <tr key={product.product_id}>
        <td className="admin-products-product-cell" data-label="Sản phẩm"><div className="admin-products-thumbnail"><ProductImage key={product.image_url} source={resolveImageUrl(product.image_url)} name={product.name} width={60} height={60} /></div><div><strong>{product.name}</strong><small>#{product.product_id}</small></div></td>
        <td data-label="Danh mục">{product.category_name || categories.items.find(category => category.category_id === product.category_id)?.name || 'Chưa có tên danh mục'}</td><td data-label="Giá bán">{formatPrice(product.price)}</td><td data-label="Tồn kho">{product.stock_quantity}</td><td data-label="Trạng thái"><span className={`admin-products-badge${product.status === 'Ngừng bán' ? ' is-stopped' : ''}`}>{product.status}</span></td>
        <td data-label="Thao tác"><div className="admin-products-row-actions"><button className="button button-outline" type="button" disabled={busy || !canEdit} aria-label={`Sửa ${product.name}`} onClick={() => openDialog({ kind: 'form', product })}><Pencil size={14} aria-hidden="true" />Sửa</button><button className="button admin-orders-button-danger-outline" type="button" disabled={busy || product.status === 'Ngừng bán'} aria-label={`Ngừng bán ${product.name}`} onClick={() => openDialog({ kind: 'stop', product })}>{product.status === 'Ngừng bán' ? 'Đã ngừng bán' : 'Ngừng bán'}</button></div></td>
      </tr>)}</tbody></table></div>
      <div className="admin-orders-pagination"><p>Trang {query.page} / {Math.max(1, Math.ceil(current.total / PAGE_SIZE))} · {current.products.length} / {current.total} sản phẩm</p><div><button className="button button-outline" type="button" disabled={busy || query.page <= 1} onClick={() => setQuery(previous => ({ ...previous, page: previous.page - 1 }))}><ChevronLeft size={16} aria-hidden="true" />Trang trước</button><button className="button button-outline" type="button" disabled={busy || query.page * PAGE_SIZE >= current.total} onClick={() => setQuery(previous => ({ ...previous, page: previous.page + 1 }))}>Trang sau<ChevronRight size={16} aria-hidden="true" /></button></div></div>
    </>}
    {dialog?.kind === 'form' && <ProductForm key={dialog.product?.product_id || 'new'} product={dialog.product} categories={categories.items} busy={busy} error={actionError} onClose={closeDialog} onSave={(payload, product) => mutate('save', payload, product)} />}
    {dialog?.kind === 'stop' && <ProductDialog title="Ngừng bán sản phẩm" busy={busy} onClose={closeDialog}><div className="admin-products-stop-copy"><p>Ngừng bán <strong>{dialog.product.name}</strong> (#{dialog.product.product_id})?</p><p>Sản phẩm sẽ chuyển sang trạng thái Ngừng bán. Thông tin sản phẩm và các đơn hàng liên quan vẫn được giữ lại.</p></div>{actionError && <p className="admin-products-form-error" role="alert">{actionError}</p>}<div className="admin-products-dialog-actions"><button type="button" className="button button-outline" autoFocus disabled={busy} onClick={closeDialog}>Hủy</button><button type="button" className="button admin-orders-button-danger-outline" disabled={busy} onClick={() => mutate('stop', null, dialog.product)}>{busy ? 'Đang cập nhật...' : 'Xác nhận ngừng bán'}</button></div></ProductDialog>}
  </>;
}

export default function AdminProductsPage() {
  const { user, authLoading } = useCommerce();
  useEffect(() => {
    const previous = document.title;
    document.title = `Quản lý sản phẩm · Admin | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, []);
  useEffect(() => {
    if (authLoading || user) return;
    const returnTo = safeReturnUrl('/admin/products', '/admin/products');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id]);
  return <div className="container admin-orders-page admin-products-page"><div className="admin-orders-page-heading"><div><p className="admin-orders-eyebrow">PETCARESHOP ADMIN</p><h1>Quản lý sản phẩm</h1><p>Quản lý thông tin, giá bán, tồn kho và trạng thái sản phẩm.</p></div><span className="admin-orders-admin-label"><ShieldCheck size={17} aria-hidden="true" />Khu vực quản trị</span></div>
    {authLoading || !user ? <ProductsLoading label="Đang kiểm tra quyền quản trị" /> : user.role !== 'admin' ? <section className="admin-orders-state"><ShieldCheck size={36} aria-hidden="true" /><h2>Bạn không có quyền quản trị</h2><p>Khu vực này chỉ dành cho tài khoản Admin.</p><a className="button button-outline" href="/">Về cửa hàng</a></section> : <div className="admin-orders-layout"><aside className="admin-orders-sidebar" aria-label="Điều hướng quản trị"><div className="admin-orders-profile"><span><ShieldCheck size={24} aria-hidden="true" /></span><div><small>TÀI KHOẢN QUẢN TRỊ</small><strong>{user.full_name || user.email}</strong></div></div><nav><AdminVoucherNavLink /><a href="/admin/orders"><ClipboardList size={18} aria-hidden="true" />Quản lý đơn hàng<ChevronRight size={14} aria-hidden="true" /></a><a href="/admin/products" aria-current="page"><Package size={18} aria-hidden="true" />Quản lý sản phẩm<ChevronRight size={14} aria-hidden="true" /></a><a href="/admin/categories"><FolderTree size={18} aria-hidden="true" />Quản lý danh mục<ChevronRight size={14} aria-hidden="true" /></a><a href="/admin/users"><Users size={18} aria-hidden="true" />Quản lý người dùng<ChevronRight size={14} aria-hidden="true" /></a><a href="/"><Home size={18} aria-hidden="true" />Về cửa hàng</a></nav><p className="admin-orders-sidebar-note">Cập nhật thông tin và trạng thái để quản lý danh sách sản phẩm.</p></aside><div className="admin-orders-content"><AdminProductCatalog key={user.user_id} /></div></div>}
  </div>;
}
