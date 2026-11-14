import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, ClipboardList, FolderTree, Home, LogOut, Package, Pencil, RefreshCw, Save, TicketPercent, UserRound, Users } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { useVoucherReadiness } from '../hooks/useVoucherReadiness.js';
import { ErrorNotice } from '../components/Feedback.jsx';
import { safeReturnUrl } from '../utils/auth-navigation.js';
import { BRAND_NAME } from '../config/branding.js';
import '../my-orders.css';
import '../profile.css';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;
const formValues = account => ({ full_name: account.full_name, email: account.email, phone: account.phone || '', address: account.address || '' });
const normalized = values => ({ full_name: values.full_name.trim(), email: values.email.trim().toLowerCase(),
  phone: values.phone.trim() || null, address: values.address.trim() || null });

function ProfileLoading({ label = 'Đang tải thông tin cá nhân' }) {
  return <div className="profile-loading" role="status"><p>{label}...</p>{[0, 1, 2].map(index => <div key={index} className="skeleton skeleton-line" aria-hidden="true" />)}</div>;
}

function ProfileContent({ accountId }) {
  const { getProfile, updateProfile } = useCommerce();
  const methods = useRef({});
  methods.current = { getProfile, updateProfile };
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ full_name: '', email: '', phone: '', address: '' });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [success, setSuccess] = useState('');
  const busyRef = useRef(false);
  const alive = useRef(false);
  const editButton = useRef(null);
  const current = result?.revision === revision ? result : null;
  const loading = !current || current.loading;
  const profile = current?.profile;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!editing) editButton.current?.focus(); }, [editing]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult({ revision, loading: true, profile: null, error: '' });
    methods.current.getProfile({ signal: controller.signal }).then(data => {
      if (!active) return;
      if (data.user.user_id !== accountId) throw new Error('Thông tin cá nhân không khớp tài khoản đang đăng nhập. Vui lòng thử lại.');
      setResult({ revision, loading: false, profile: data.user, error: '' });
      setDraft(formValues(data.user)); setEditing(false); setErrors({}); setSaveError('');
    }).catch(error => {
      if (!active || controller.signal.aborted || [401, 403].includes(error.status)) return;
      if (error.obsolete) {
        setResult(previous => previous?.loading ? { revision, loading: false, profile: null, error: 'Thông tin tài khoản đã thay đổi. Vui lòng tải lại hồ sơ.' } : previous);
      } else setResult({ revision, loading: false, profile: null, error: error.message || 'Chưa tải được thông tin cá nhân.' });
    });
    return () => { active = false; controller.abort(); };
  }, [accountId, revision]);

  const reload = () => { if (!busyRef.current && !editing) { setSuccess(''); setRevision(value => value + 1); } };
  const startEditing = () => {
    if (busyRef.current || !profile) return;
    setDraft(formValues(profile)); setErrors({}); setSaveError(''); setSuccess(''); setEditing(true);
  };
  const cancelEditing = () => {
    if (busyRef.current || !profile) return;
    setDraft(formValues(profile)); setErrors({}); setSaveError(''); setEditing(false);
  };
  const change = event => {
    const { name, value } = event.target;
    setDraft(previous => ({ ...previous, [name]: value }));
    setErrors(previous => ({ ...previous, [name]: '' })); setSaveError('');
  };
  const submit = async event => {
    event.preventDefault();
    if (busyRef.current || !profile) return;
    const values = normalized(draft);
    const original = normalized(formValues(profile));
    const nextErrors = {};
    if (!values.full_name || values.full_name.length > 100) nextErrors.full_name = 'Nhập họ và tên từ 1 đến 100 ký tự.';
    if (values.email.length > 150 || !EMAIL.test(values.email)) nextErrors.email = 'Nhập email hợp lệ, tối đa 150 ký tự.';
    if (values.phone !== null && !PHONE.test(values.phone)) nextErrors.phone = 'Nhập 6–20 ký tự gồm số, khoảng trắng, dấu ngoặc hoặc gạch ngang; có thể thêm dấu + ở đầu.';
    if (values.address !== null && values.address.length > 255) nextErrors.address = 'Địa chỉ tối đa 255 ký tự.';
    setErrors(nextErrors); setSaveError(''); setSuccess('');
    const invalid = Object.keys(nextErrors)[0];
    if (invalid) { event.currentTarget.elements.namedItem(invalid)?.focus(); return; }
    const payload = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== original[key]));
    if (!Object.keys(payload).length) { setSaveError('Bạn chưa thay đổi thông tin nào.'); return; }
    busyRef.current = true; setSaving(true);
    try {
      const data = await methods.current.updateProfile(payload);
      if (!alive.current) return;
      setResult({ revision, loading: false, profile: data.user, error: '' });
      setDraft(formValues(data.user)); setEditing(false); setErrors({});
      setSuccess('Đã lưu thông tin cá nhân.');
    } catch (error) {
      if (alive.current && !error.obsolete && ![401, 403].includes(error.status)) {
        setSaveError(error.message || 'Chưa lưu được thông tin cá nhân. Vui lòng thử lại.');
        if (error.status === 409 && error.message?.includes('Email')) setErrors(previous => ({ ...previous, email: error.message }));
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const field = name => ({ id: `profile-${name}`, name, value: draft[name], onChange: change,
    'aria-invalid': Boolean(errors[name]), 'aria-describedby': errors[name] ? `profile-${name}-error` : undefined });
  const fieldError = name => errors[name] && <small className="profile-field-error" id={`profile-${name}-error`}>{errors[name]}</small>;

  if (loading) return <ProfileLoading />;
  if (current.error) return <ErrorNotice title="Chưa tải được thông tin cá nhân" message={current.error} onRetry={reload} />;
  if (!profile) return null;
  return <>
    {success && <p className="profile-success" role="status"><Check size={18} aria-hidden="true" />{success}</p>}
    <section className="profile-card" aria-labelledby="profile-card-title">
      <div className="profile-card-heading"><div><h2 id="profile-card-title">{editing ? 'Chỉnh sửa thông tin' : 'Hồ sơ của bạn'}</h2><p>Mã tài khoản #{profile.user_id}</p></div>{!editing && <div className="profile-heading-actions"><button className="button button-outline" type="button" onClick={reload}><RefreshCw size={15} aria-hidden="true" />Tải lại</button><button ref={editButton} className="button button-primary" type="button" onClick={startEditing}><Pencil size={15} aria-hidden="true" />Chỉnh sửa</button></div>}</div>
      {editing ? <form className="profile-form" noValidate onSubmit={submit} aria-busy={saving}>
        <fieldset disabled={saving}><legend className="sr-only">Thông tin cá nhân</legend><div className="profile-form-grid">
          <label className="profile-field" htmlFor="profile-full_name"><span>Họ và tên *</span><input {...field('full_name')} type="text" autoComplete="name" required maxLength={100} autoFocus />{fieldError('full_name')}</label>
          <label className="profile-field" htmlFor="profile-email"><span>Email *</span><input {...field('email')} type="email" autoComplete="email" required maxLength={150} />{fieldError('email')}</label>
          <label className="profile-field" htmlFor="profile-phone"><span>Số điện thoại</span><input {...field('phone')} type="tel" autoComplete="tel" maxLength={21} /><small>Không bắt buộc. Có thể bắt đầu bằng dấu +.</small>{fieldError('phone')}</label>
          <label className="profile-field profile-field-wide" htmlFor="profile-address"><span>Địa chỉ</span><textarea {...field('address')} rows={3} autoComplete="street-address" maxLength={255} /><small>Không bắt buộc, tối đa 255 ký tự.</small>{fieldError('address')}</label>
        </div></fieldset>
        <p className="profile-form-note">Các trường có dấu * là bắt buộc.</p>
        {saveError && <p className="profile-error" role="alert">{saveError}</p>}
        <div className="profile-form-actions"><button className="button button-outline" type="button" disabled={saving} onClick={cancelEditing}>Hủy</button><button className="button button-primary" type="submit" disabled={saving}><Save size={16} aria-hidden="true" />{saving ? 'Đang lưu...' : 'Lưu thay đổi'}</button></div>
      </form> : <dl className="profile-data"><div><dt>Họ và tên</dt><dd>{profile.full_name}</dd></div><div><dt>Email</dt><dd>{profile.email}</dd></div><div><dt>Số điện thoại</dt><dd>{profile.phone || 'Chưa cập nhật'}</dd></div><div><dt>Loại tài khoản</dt><dd><span className="profile-account-badge">{profile.role === 'admin' ? 'Quản trị viên' : 'Khách hàng'}</span></dd></div><div className="profile-data-wide"><dt>Địa chỉ</dt><dd>{profile.address || 'Chưa cập nhật'}</dd></div></dl>}
    </section>
  </>;
}

export default function ProfilePage() {
  const { user, authLoading, busy, logout, notify } = useCommerce();
  const { ready: vouchersReady } = useVoucherReadiness();
  useEffect(() => {
    const previous = document.title;
    document.title = `Thông tin cá nhân | ${BRAND_NAME}`;
    return () => { document.title = previous; };
  }, []);
  useEffect(() => {
    if (authLoading || user) return;
    const returnTo = safeReturnUrl('/profile', '/profile');
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authLoading, user?.user_id]);
  return <div className="container my-orders-page profile-page">
    <nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/"><Home size={14} aria-hidden="true" />Trang chủ</a><ChevronRight size={13} aria-hidden="true" /><span aria-current="page">Thông tin cá nhân</span></nav>
    <div className="my-orders-page-heading"><div><p className="my-orders-eyebrow">TÀI KHOẢN PETCARE</p><h1>Thông tin cá nhân</h1><p>Quản lý thông tin tài khoản và liên hệ của bạn.</p></div></div>
    {authLoading || !user ? <ProfileLoading label="Đang kiểm tra đăng nhập" /> : <div className="my-orders-layout">
      <aside className="my-orders-account" aria-label="Điều hướng tài khoản"><div className="my-orders-profile"><span><UserRound size={26} aria-hidden="true" /></span><div><small>Xin chào,</small><strong>{user.full_name || user.email}</strong></div></div><nav aria-label="Tài khoản"><a href="/profile" aria-current="page"><UserRound size={18} aria-hidden="true" /><span>Thông tin cá nhân</span><ChevronRight size={14} aria-hidden="true" /></a>{user.role === 'admin' ? <><a href="/admin/orders"><ClipboardList size={18} aria-hidden="true" /><span>Quản lý đơn hàng</span></a><a href="/admin/products"><Package size={18} aria-hidden="true" /><span>Quản lý sản phẩm</span></a><a href="/admin/categories"><FolderTree size={18} aria-hidden="true" /><span>Quản lý danh mục</span></a><a href="/admin/users"><Users size={18} aria-hidden="true" /><span>Quản lý người dùng</span></a>{vouchersReady && <a href="/admin/vouchers"><TicketPercent size={18} aria-hidden="true" /><span>Quản lý Voucher</span></a>}</> : <a href="/my-orders"><ClipboardList size={18} aria-hidden="true" /><span>Đơn hàng của tôi</span></a>}<button className="my-orders-account-logout" type="button" disabled={busy} onClick={() => logout().catch(error => notify(error.message))}><LogOut size={18} aria-hidden="true" /><span>Đăng xuất</span></button></nav></aside>
      <div className="my-orders-content"><ProfileContent key={user.user_id} accountId={user.user_id} /></div>
    </div>}
  </div>;
}
