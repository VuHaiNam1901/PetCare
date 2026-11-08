// Synthetic catalog only. Browser checkout tests never import backend code or
// connect to the application database.
export const checkoutProducts = [
  { product_id: 1, category_id: 1, category_name: 'Thức ăn', name: 'ME-O Tuna thức ăn cho mèo 1.2kg', price: '85000.00', stock_quantity: 100, image_url: '/images/products/1-me-o-tuna-thuc-an-hat-cho-meo-vi-ca-ngu-1-2kg.webp', status: 'Đang bán', description: 'Sản phẩm giả lập dành riêng cho kiểm thử Checkout.' },
  { product_id: 19, category_id: 2, category_name: 'Chăm sóc', name: 'SHED-X dầu cá cho chó 473ml', price: '225000.00', stock_quantity: 100, image_url: '/images/products/19-shed-x-dau-ca-cho-cho-473ml.webp', status: 'Đang bán', description: 'Sản phẩm giả lập dành riêng cho kiểm thử Checkout.' },
  { product_id: 12, category_id: 3, category_name: 'Đồ chơi', name: 'Cattyman cần câu chuột cho mèo', price: '56000.00', stock_quantity: 100, image_url: '/images/products/12-cattyman-toys-can-cau-chuot-long-tho-duoi-dai.webp', status: 'Đang bán', description: 'Sản phẩm giả lập dành riêng cho kiểm thử Checkout.' },
];

export const checkoutCategories = [
  { category_id: 1, name: 'Thức ăn' },
  { category_id: 2, name: 'Chăm sóc' },
  { category_id: 3, name: 'Đồ chơi' },
];

export function previewCart(items, products = checkoutProducts) {
  const rows = items.map(item => {
    const product = products.find(candidate => candidate.product_id === item.product_id);
    const available = Boolean(product && product.status === 'Đang bán' && item.quantity <= product.stock_quantity && product.stock_quantity > 0);
    return { ...product, ...item, available, selected: Boolean(item.selected), line_total: product ? (Number(product.price) * item.quantity).toFixed(2) : null, availability_message: available ? '' : 'Sản phẩm không còn đủ hàng' };
  });
  const subtotal = selected => rows.filter(item => !selected || item.selected && item.available).reduce((sum, item) => sum + Number(item.line_total || 0), 0).toFixed(2);
  return { cart_id: null, items: rows, subtotal: subtotal(false), selected_subtotal: subtotal(true), total_quantity: rows.reduce((sum, item) => sum + item.quantity, 0) };
}
