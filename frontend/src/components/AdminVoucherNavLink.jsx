import { ChevronRight, ClipboardList, FolderTree, Home, Package, ShieldCheck, TicketPercent, Users } from 'lucide-react';
import { useVoucherReadiness } from '../hooks/useVoucherReadiness.js';

export default function AdminVoucherNavLink({ active }) {
  const { ready } = useVoucherReadiness();
  if (!ready) return null;
  const isCurrent = active !== undefined ? active : window.location.pathname.replace(/\/+$/, '') === '/admin/vouchers';
  return <a href="/admin/vouchers" aria-current={isCurrent ? 'page' : undefined}>
    <TicketPercent size={18} aria-hidden="true" />Quản lý Voucher<ChevronRight size={14} aria-hidden="true" />
  </a>;
}

export function AdminSidebar({ user, active, note }) {
  return (
    <aside className="admin-orders-sidebar" aria-label="Điều hướng quản trị">
      <div className="admin-orders-profile">
        <span><ShieldCheck size={24} aria-hidden="true" /></span>
        <div><small>TÀI KHOẢN QUẢN TRỊ</small><strong>{user.full_name || user.email}</strong></div>
      </div>
      <nav>
        <AdminVoucherNavLink active={active === '/admin/vouchers'} />
        <a href="/admin/orders" aria-current={active === '/admin/orders' ? 'page' : undefined}>
          <ClipboardList size={18} aria-hidden="true" />Quản lý đơn hàng<ChevronRight size={14} aria-hidden="true" />
        </a>
        <a href="/admin/products" aria-current={active === '/admin/products' ? 'page' : undefined}>
          <Package size={18} aria-hidden="true" />Quản lý sản phẩm<ChevronRight size={14} aria-hidden="true" />
        </a>
        <a href="/admin/categories" aria-current={active === '/admin/categories' ? 'page' : undefined}>
          <FolderTree size={18} aria-hidden="true" />Quản lý danh mục<ChevronRight size={14} aria-hidden="true" />
        </a>
        <a href="/admin/users" aria-current={active === '/admin/users' ? 'page' : undefined}>
          <Users size={18} aria-hidden="true" />Quản lý người dùng<ChevronRight size={14} aria-hidden="true" />
        </a>
        <a href="/"><Home size={18} aria-hidden="true" />Về cửa hàng</a>
      </nav>
      {note && <p className="admin-orders-sidebar-note">{note}</p>}
    </aside>
  );
}
