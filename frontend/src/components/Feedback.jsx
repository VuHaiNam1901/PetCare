import { CircleAlert, PawPrint, RefreshCw } from 'lucide-react';

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
