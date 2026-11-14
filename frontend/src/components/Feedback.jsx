import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, PawPrint, RefreshCw, X } from 'lucide-react';

export function FeatureNotice({ message, type = 'info', onClose }) {
  const [retained, setRetained] = useState(null);
  useEffect(() => {
    if (message) { setRetained({ message, type }); return; }
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    const timer = window.setTimeout(() => setRetained(null), delay);
    return () => window.clearTimeout(timer);
  }, [message, type]);

  const notice = message ? { message, type } : retained;
  if (!notice) return null;
  const leaving = !message;
  return <div className={`feature-notice${notice.type === 'success' ? ' feature-notice--success' : ''}${leaving ? ' is-leaving' : ''}`}
    key={notice.message} role="status" aria-atomic="true" aria-hidden={leaving || undefined}>
    {notice.type === 'success' && <CircleCheck className="feature-notice-icon" size={21} aria-hidden="true" />}
    <p>{notice.message}</p>
    <button className="icon-button" type="button" aria-label="Đóng thông báo" disabled={leaving} onClick={onClose}><X size={18} aria-hidden="true" /></button>
  </div>;
}

export function ErrorNotice({ title, message, onRetry }) {
  return (
    <div className="error-notice" role="alert">
      <CircleAlert size={25} aria-hidden="true" />
      <div><h3>{title}</h3><p>{message}</p></div>
      <button className="button button-outline button-small" type="button" onClick={onRetry}><RefreshCw size={15} aria-hidden="true" /> Thử lại</button>
    </div>
  );
}

export function EmptyState({ title, message, onReset }) {
  return (
    <div className="empty-state" role="status">
      <PawPrint size={40} strokeWidth={1.3} aria-hidden="true" />
      <h3>{title}</h3><p>{message}</p>
      {onReset && <button className="button button-outline button-small" type="button" onClick={onReset}>Xóa bộ lọc</button>}
    </div>
  );
}
