import { useEffect, useState } from 'react';
import { ChevronRight, LogIn, UserPlus } from 'lucide-react';
import { useCommerce } from '../context/CommerceContext.jsx';
import { BRAND_NAME } from '../config/branding.js';
import { authPageUrl } from '../utils/auth-navigation.js';

const messages = {
  'Invalid email or password': 'Email hoặc mật khẩu chưa đúng.',
  'Email already registered': 'Email này đã được đăng ký. Bạn có thể chuyển sang đăng nhập.',
  'Account is inactive': 'Tài khoản hiện không hoạt động. Vui lòng liên hệ quản trị viên.',
};

export default function AuthPage({ mode = 'login' }) {
  const registering = mode === 'register';
  const { user, authLoading, login, register, logout, pendingIntent, notify } = useCommerce();
  const [form, setForm] = useState({ full_name: '', email: '', password: '', confirmation: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const justRegistered = !registering && new URLSearchParams(window.location.search).get('registered') === '1';

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${registering ? 'Đăng ký' : 'Đăng nhập'} | ${BRAND_NAME}`;
    return () => { document.title = previousTitle; };
  }, [registering]);

  const change = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  const submit = async event => {
    event.preventDefault();
    setError('');
    if (registering && form.password !== form.confirmation) { setError('Mật khẩu xác nhận chưa khớp.'); return; }
    if (new TextEncoder().encode(form.password).length > 72) { setError('Mật khẩu tối đa 72 byte; ký tự có dấu có thể chiếm nhiều byte.'); return; }
    setSubmitting(true);
    try {
      if (registering) {
        await register({ full_name: form.full_name.trim(), email: form.email.trim(), password: form.password });
        notify('Đăng ký thành công. Vui lòng đăng nhập để tiếp tục.');
        window.location.assign(authPageUrl('/login', { registered: true }));
      } else await login({ email: form.email.trim(), password: form.password });
    } catch (failure) {
      setError(messages[failure.message] || failure.message || 'Chưa kết nối được với máy chủ. Vui lòng thử lại.');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="container auth-page">
      <nav className="catalog-breadcrumbs" aria-label="Đường dẫn"><a href="/">Trang chủ</a><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">{registering ? 'Đăng ký' : 'Đăng nhập'}</span></nav>
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-symbol" aria-hidden="true">{registering ? <UserPlus size={29} /> : <LogIn size={29} />}</div>
        <h1 id="auth-title">{registering ? 'Đăng ký tài khoản' : 'Đăng nhập'}</h1>
        <p className="auth-intro">{registering ? 'Tạo tài khoản khách hàng để lưu giỏ hàng và tiếp tục mua sắm.' : 'Dùng tài khoản của bạn để lưu giỏ hàng và tiếp tục.'}</p>
        {pendingIntent && <p className="auth-intent-note">Giỏ hàng và lựa chọn mua của bạn được giữ lại khi chuyển giữa đăng nhập và đăng ký.</p>}
        {justRegistered && <p className="auth-registration-notice" role="status">Đăng ký thành công. Vui lòng đăng nhập để tiếp tục.</p>}
        {authLoading ? <p role="status">Đang kiểm tra tài khoản...</p> : user ? <div className="auth-current-account"><p>Bạn đã đăng nhập với tên <strong>{user.full_name || user.email}</strong>.</p><p>Loại tài khoản: {user.role === 'admin' ? 'Admin' : 'Khách hàng'}.</p><a className="button button-primary" href={user.role === 'admin' ? '/admin/orders' : '/cart'}>{user.role === 'admin' ? 'Quản lý đơn hàng' : 'Đến giỏ hàng'}</a><button className="button button-outline" type="button" disabled={submitting} onClick={async () => { setSubmitting(true); try { await logout(); } catch (failure) { setError(failure.message); } finally { setSubmitting(false); } }}>Đăng xuất</button></div> : (
          <form className="auth-form" onSubmit={submit}>
            {registering && <label>Họ và tên<input type="text" name="full_name" autoComplete="name" required maxLength={100} value={form.full_name} onChange={change} disabled={submitting} /></label>}
            <label>Email<input type="email" name="email" autoComplete="email" required maxLength={150} value={form.email} onChange={change} disabled={submitting} /></label>
            <label>Mật khẩu<input type="password" name="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 8 : 1} maxLength={72} value={form.password} onChange={change} disabled={submitting} /></label>
            {registering && <><p className="auth-password-help">Ít nhất 8 ký tự, tối đa 72 byte.</p><label>Xác nhận mật khẩu<input type="password" name="confirmation" autoComplete="new-password" required minLength={8} maxLength={72} value={form.confirmation} onChange={change} disabled={submitting} /></label></>}
            {error && <p className="commerce-action-error" role="alert">{error}</p>}
            <button className="button button-primary auth-submit" type="submit" disabled={submitting}>{submitting ? 'Đang xử lý...' : registering ? 'Đăng ký' : 'Đăng nhập'}</button>
          </form>
        )}
        {user && error && <p className="commerce-action-error" role="alert">{error}</p>}
        {!user && <p className="auth-switch">{registering ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'} <a href={authPageUrl(registering ? '/login' : '/register')}>{registering ? 'Đăng nhập' : 'Đăng ký'}</a></p>}
        <a className="auth-back text-link" href="/cart">Trở về giỏ hàng</a>
      </section>
    </div>
  );
}
