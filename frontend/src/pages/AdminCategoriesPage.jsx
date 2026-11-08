import AdminVoucherNavLink from '../components/AdminVoucherNavLink.jsx';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, ClipboardList, FolderTree, Home, Package, Pencil, Plus, RefreshCw, ShieldCheck, Users, Trash2, X } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { EmptyState, ErrorNotice } from '../components/Feedback.jsx';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../admin-orders.css';
import '../admin-products.css';
import '../admin-categories.css';

const positiveId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const validCategory = category => category && positiveId(category.category_id) && typeof category.name === 'string' &&
  (category.description == null || typeof category.description === 'string');
const invalidText = (value, multiline = false) => /[\uD800-\uDFFF]/u.test(value) || [...value].some(char => char.codePointAt(0) > 65535) ||
  (multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(value);
const categoryValues = category => ({ name: category?.name || '', description: category?.description || '' });

function CategoriesLoading({ label = 'Đang tải danh mục' }) {
  return <div className="admin-products-loading" role="status"><p>{label}...</p>{[0, 1, 2].map(index => <div key={index} className="skeleton skeleton-line" aria-hidden="true" />)}</div>;
}

function CategoryDialog({ title, busy, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="admin-orders-dialog admin-products-dialog admin-categories-dialog" aria-labelledby="admin-category-dialog-title" aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="admin-products-dialog-heading"><h2 id="admin-category-dialog-title">{title}</h2><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Đóng hộp thoại"><X size={22} aria-hidden="true" /></button></div>
    {children}
  </dialog>;
}

function CategoryForm({ category, busy, error, onSave, onClose }) {
  const [original] = useState(() => category ? categoryValues(category) : null);
  const [values, setValues] = useState(() => categoryValues(category));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const change = event => {
    const { name, value } = event.target;
    setValues(previous => ({ ...previous, [name]: value }));
    setErrors(previous => ({ ...previous, [name]: '' })); setFormError('');
  };
  const field = name => ({ id: `admin-category-${name}`, name, value: values[name], onChange: change,
    'aria-invalid': Boolean(errors[name]), 'aria-describedby': errors[name] ? `admin-category-${name}-error` : `admin-category-${name}-help` });
  const submit = event => {
    event.preventDefault();
    if (busy) return;
    const nextErrors = {};
    const payload = {};
    for (const key of Object.keys(values).filter(key => !original || values[key] !== original[key])) {
      const value = values[key].trim();
      if (key === 'name') {
        if (!value || value.length > 100 || invalidText(value)) nextErrors.name = 'Nhập tên từ 1–100 ký tự, không dùng emoji, xuống dòng hoặc ký tự điều khiển.';
        payload.name = value;
      } else {
        if (value.length > 255 || invalidText(value, true)) nextErrors.description = 'Mô tả tối đa 255 ký tự, không dùng emoji hoặc ký tự điều khiển không được hỗ trợ.';
        payload.description = value || null;
      }
    }
    setErrors(nextErrors); setFormError('');
    const invalid = Object.keys(nextErrors)[0];
    if (invalid) { event.currentTarget.elements.namedItem(invalid)?.focus(); return; }
    if (!Object.keys(payload).length) { setFormError('Bạn chưa thay đổi thông tin nào.'); return; }
    onSave(payload, category);
  };
  return <CategoryDialog title={category ? `Sửa danh mục #${category.category_id}` : 'Thêm danh mục'} busy={busy} onClose={onClose}>
    <form className="admin-products-form" noValidate onSubmit={submit}>
      <fieldset disabled={busy}><legend className="sr-only">Thông tin danh mục</legend><div className="admin-products-form-grid">
        <label className="admin-products-field admin-products-field-wide" htmlFor="admin-category-name"><span>Tên danh mục *</span><input {...field('name')} required maxLength={100} autoFocus /><small id="admin-category-name-help">Tối đa 100 ký tự.</small>{errors.name && <small id="admin-category-name-error" className="admin-products-field-error">{errors.name}</small>}</label>
        <label className="admin-products-field admin-products-field-wide" htmlFor="admin-category-description"><span>Mô tả</span><textarea {...field('description')} rows={5} maxLength={255} /><small id="admin-category-description-help">Không bắt buộc, tối đa 255 ký tự.</small>{errors.description && <small id="admin-category-description-error" className="admin-products-field-error">{errors.description}</small>}</label>
      </div></fieldset>
      {(formError || error) && <p className="admin-products-form-error" role="alert">{formError || error}</p>}
      <div className="admin-products-dialog-actions"><button type="button" className="button button-outline" disabled={busy} onClick={onClose}>Hủy</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Đang lưu...' : category ? 'Lưu thay đổi' : 'Thêm danh mục'}</button></div>
    </form>
  </CategoryDialog>;
}

function AdminCategoryList() {
  const { getAdminCategories, createAdminCategory, updateAdminCategory, deleteAdminCategory } = useCommerce();
  const methods = useRef({});
  methods.current = { getAdminCategories, createAdminCategory, updateAdminCategory, deleteAdminCategory };
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const busyRef = useRef(false);
  const alive = useRef(false);
  const current = result?.revision === revision ? result : null;
  const loading = !current || current.loading;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ revision, loading: true, categories: [], total: 0, error: '' });
    methods.current.getAdminCategories({ signal: controller.signal }).then(data => {
      if (!active) return;
      if (!Array.isArray(data.categories) || !data.categories.every(validCategory) || data.total !== data.categories.length) throw new Error('Danh sách danh mục chưa hợp lệ. Vui lòng thử lại.');
      setResult({ revision, loading: false, categories: data.categories, total: data.total, error: '' });
    }).catch(error => {
      if (active && !controller.signal.aborted && !error.obsolete && ![401, 403].includes(error.status)) setResult({ revision, loading: false, categories: [], total: 0, error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [revision]);

  const reload = () => { if (!busyRef.current) setRevision(value => value + 1); };
  const openDialog = value => { if (!busyRef.current) { setActionError(''); setSuccess(''); setDialog(value); } };
  const closeDialog = () => { if (!busyRef.current) { setDialog(null); setActionError(''); } };
  const mutate = async (kind, payload, category) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setActionError(''); setSuccess('');
    try {
      const data = kind === 'delete' ? await methods.current.deleteAdminCategory(category.category_id) : category ? await methods.current.updateAdminCategory(category.category_id, payload) : await methods.current.createAdminCategory(payload);
      if (!alive.current) return;
      if (kind === 'delete') {
        if (data.deleted !== true || data.category_id !== category.category_id) throw new Error('Chưa xác nhận được kết quả xóa. Hãy đóng hộp thoại và tải lại danh sách để kiểm tra.');
        setSuccess(`Đã xóa danh mục “${category.name}” (#${category.category_id}).`);
      } else {
        if (!validCategory(data.category) || (category && data.category.category_id !== category.category_id)) throw new Error('Chưa xác nhận được dữ liệu sau khi lưu. Hãy đóng form và tải lại danh sách để kiểm tra.');
        setSuccess(category ? `Đã cập nhật danh mục “${data.category.name}”.` : `Đã thêm danh mục “${data.category.name}” (#${data.category.category_id}).`);
      }
      setDialog(null);
      // Reload errors are separate from the result of a confirmed mutation.
      setRevision(value => value + 1);
    } catch (error) {
      if (alive.current && !error.obsolete && ![401, 403].includes(error.status)) {
        const checkBeforeRetry = !error.status && kind === 'save' && !category ? ' Hãy tải lại danh sách để kiểm tra trước khi thêm lại.' : '';
        setActionError((error.message || 'Chưa thực hiện được thao tác. Vui lòng thử lại.') + checkBeforeRetry);
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return <>
    {success && <p className="admin-orders-success" role="status"><Check size={18} aria-hidden="true" />{success}</p>}
    <div className="admin-products-list-heading"><p aria-live="polite">{loading ? 'Đang tải danh sách...' : current.error ? 'Chưa tải được danh sách' : `${current.total} danh mục`}</p><div className="admin-products-heading-actions"><button className="button button-outline" type="button" disabled={busy || loading} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Tải lại</button><button className="button button-primary" type="button" disabled={busy} onClick={() => openDialog({ kind: 'form', category: null })}><Plus size={17} aria-hidden="true" />Thêm danh mục</button></div></div>
    {loading ? <CategoriesLoading /> : current.error ? <ErrorNotice title="Chưa tải được danh mục" message={current.error} onRetry={reload} /> : !current.categories.length ? <EmptyState title="Chưa có danh mục" message="Thêm danh mục đầu tiên bằng nút Thêm danh mục." /> : <div className="admin-products-table-wrap"><table className="admin-products-table"><caption className="sr-only">Danh sách danh mục quản trị</caption><thead><tr><th scope="col">Danh mục</th><th scope="col">Mô tả</th><th scope="col">Thao tác</th></tr></thead><tbody>{current.categories.map(category => <tr key={category.category_id}>
      <td className="admin-products-product-cell" data-label="Danh mục"><div><strong>{category.name}</strong><small>#{category.category_id}</small></div></td>
      <td className="admin-categories-description" data-label="Mô tả">{category.description?.trim() || 'Chưa có mô tả'}</td>
      <td data-label="Thao tác"><div className="admin-products-row-actions"><button className="button button-outline" type="button" disabled={busy} aria-label={`Sửa danh mục ${category.name}`} onClick={() => openDialog({ kind: 'form', category })}><Pencil size={14} aria-hidden="true" />Sửa</button><button className="button admin-orders-button-danger-outline" type="button" disabled={busy} aria-label={`Xóa danh mục ${category.name}`} onClick={() => openDialog({ kind: 'delete', category })}><Trash2 size={14} aria-hidden="true" />Xóa</button></div></td>
    </tr>)}</tbody></table></div>}
    <p className="admin-categories-rule">Chỉ có thể xóa danh mục không chứa sản phẩm, kể cả sản phẩm đã ngừng bán.</p>
    {dialog?.kind === 'form' && <CategoryForm key={dialog.category?.category_id || 'new'} category={dialog.category} busy={busy} error={actionError} onSave={(payload, category) => mutate('save', payload, category)} onClose={closeDialog} />}
    {dialog?.kind === 'delete' && <CategoryDialog title="Xóa danh mục" busy={busy} onClose={closeDialog}>
      <div className="admin-products-stop-copy"><p>Xóa danh mục <strong>{dialog.category.name}</strong> (#{dialog.category.category_id})?</p><p>Thao tác này xóa danh mục khỏi hệ thống. Chỉ có thể xóa khi danh mục không chứa sản phẩm, kể cả sản phẩm đã ngừng bán.</p></div>
      {actionError && <p className="admin-products-form-error" role="alert">{actionError}</p>}
      <div className="admin-products-dialog-actions"><button type="button" className="button button-outline" autoFocus disabled={busy} onClick={closeDialog}>Hủy</button><button type="button" className="button admin-orders-button-danger-outline" disabled={busy} onClick={() => mutate('delete', null, dialog.category)}>{busy ? 'Đang xóa...' : 'Xác nhận xóa danh mục'}</button></div>
    </CategoryDialog>}
  </>;
}

export default function AdminCategoriesPage() {
  const { user, authLoading } = useCommerce();
  useEffect(() => {
    const previous = document.title;
    document.title = `Quản lý danh mục · Admin | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, []);
  useEffect(() => {
    if (authLoading || user) return;
    const returnTo = safeReturnUrl('/admin/categories', '/admin/categories');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id]);
  return <div className="container admin-orders-page admin-products-page admin-categories-page">
    <div className="admin-orders-page-heading"><div><p className="admin-orders-eyebrow">PETCARESHOP ADMIN</p><h1>Quản lý danh mục</h1><p>Thêm, cập nhật thông tin và quản lý danh mục sản phẩm.</p></div><span className="admin-orders-admin-label"><ShieldCheck size={17} aria-hidden="true" />Khu vực quản trị</span></div>
    {authLoading || !user ? <CategoriesLoading label="Đang kiểm tra quyền quản trị" /> : user.role !== 'admin' ? <section className="admin-orders-state"><ShieldCheck size={36} aria-hidden="true" /><h2>Bạn không có quyền quản trị</h2><p>Khu vực này chỉ dành cho tài khoản Admin.</p><a className="button button-outline" href="/">Về cửa hàng</a></section> : <div className="admin-orders-layout">
      <aside className="admin-orders-sidebar" aria-label="Điều hướng quản trị"><div className="admin-orders-profile"><span><ShieldCheck size={24} aria-hidden="true" /></span><div><small>TÀI KHOẢN QUẢN TRỊ</small><strong>{user.full_name || user.email}</strong></div></div><nav><AdminVoucherNavLink /><a href="/admin/orders"><ClipboardList size={18} aria-hidden="true" />Quản lý đơn hàng<ChevronRight size={14} aria-hidden="true" /></a><a href="/admin/products"><Package size={18} aria-hidden="true" />Quản lý sản phẩm<ChevronRight size={14} aria-hidden="true" /></a><a href="/admin/categories" aria-current="page"><FolderTree size={18} aria-hidden="true" />Quản lý danh mục<ChevronRight size={14} aria-hidden="true" /></a><a href="/admin/users"><Users size={18} aria-hidden="true" />Quản lý người dùng<ChevronRight size={14} aria-hidden="true" /></a><a href="/"><Home size={18} aria-hidden="true" />Về cửa hàng</a></nav><p className="admin-orders-sidebar-note">Danh mục còn sản phẩm sẽ được giữ lại khi yêu cầu xóa bị từ chối.</p></aside>
      <div className="admin-orders-content"><AdminCategoryList key={user.user_id} /></div>
    </div>}
  </div>;
}
