const quantityFormatter = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });

export default function ProductSoldCount({ count }) {
  const label = Number.isSafeInteger(count) && count >= 0
    ? `Đã bán ${quantityFormatter.format(count)}` : 'Chưa có số liệu đã bán';
  return <span className="product-sold-count" title={label}>{label}</span>;
}
