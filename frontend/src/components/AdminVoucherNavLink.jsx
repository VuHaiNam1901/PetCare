import { ChevronRight, TicketPercent } from 'lucide-react';
import { useVoucherReadiness } from '../hooks/useVoucherReadiness.js';

export default function AdminVoucherNavLink() {
  const { ready } = useVoucherReadiness();
  if (!ready) return null;
  return <a href="/admin/vouchers" aria-current={window.location.pathname.replace(/\/+$/, '') === '/admin/vouchers' ? 'page' : undefined}>
    <TicketPercent size={18} aria-hidden="true" />Quản lý Voucher<ChevronRight size={14} aria-hidden="true" />
  </a>;
}
