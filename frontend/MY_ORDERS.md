# Đơn hàng của tôi

`/my-orders` dùng Header/Footer, font Be Vietnam Pro, CSS variables xanh biển nhạt và `ProductImage`, `ErrorNotice`, `EmptyState` hiện có. Người dùng xác nhận chưa có mockup Figma; giao diện được triển khai theo hệ thống giao diện của dự án.

## Dữ liệu và quyền truy cập

- Tái sử dụng `GET /api/orders?page=1&limit=10&status=...` với JWT Bearer. Backend mặc định limit 20, tối đa 100; frontend hiển thị 10 đơn/trang.
- `status` tùy chọn và phải khớp chính xác giá trị hiện có. API trả `success`, `page`, `limit`, `total`, `orders`, `statuses`; `total` là số đơn sau lọc, trước phân trang.
- `user_id` chỉ lấy từ `req.user.user_id`; query `user_id`, `userId`, `owner` hoặc trường lạ bị từ chối. Không nhận định danh chủ đơn từ frontend. SQL count/list và chi tiết luôn giới hạn theo chủ đơn.
- API hiện có `GET /api/orders/:id` trả 404 khi đơn thuộc tài khoản khác. Tài khoản chưa xác thực/token hết hạn nhận 401; tài khoản khóa hoặc vai trò không phù hợp nhận 403.
- Tên trường thực là `orders.status`, không tạo cột hoặc giá trị `order_status` mới. Bộ lọc lấy danh sách trạng thái từ API, dùng lại domain trong model quản trị: **Chờ xử lý**, **Chờ thanh toán**, **Chờ giao hàng**, **Đang giao hàng**, **Đã giao hàng**, **Đã hủy**.
- Thẻ đơn dùng mã, ngày đặt, `total_amount`, các dòng `quantity`, `unit_price`, `subtotal`, tên và ảnh từ API. Không tính lịch sử theo giá catalog hiện tại, không dựng đơn mẫu trong mã ứng dụng.

## Giao diện và xác thực

Header tài khoản khách hàng và menu mobile dẫn tới `/my-orders`. Có lọc trạng thái trên toàn bộ dữ liệu ở backend, phân trang, tải dữ liệu, danh sách trống, lọc không có kết quả và lỗi/Thử lại. Query status/page được giữ trong URL để tải lại hoặc đăng nhập lại.

Khách được chuyển qua `/login?returnTo=...`; chuyển đăng ký và đăng nhập vẫn giữ trang đích. Hết phiên lúc tải đơn dùng cơ chế hết phiên hiện có rồi đăng nhập lại. Đọc lịch sử không bị khóa bởi thao tác sửa/hợp nhất giỏ. Kết quả gắn tài khoản và filter/page; request cũ bị hủy và không được hiển thị sau thay đổi tài khoản/bộ lọc.

Nếu có yêu cầu Checkout đang chờ kết quả, bản nháp/khóa chống trùng được giữ nguyên. Đích returnTo rõ ràng của trang đơn được tôn trọng; đăng nhập từ luồng mua hàng thực sự vẫn khôi phục Checkout. Khi mở trang danh sách/chi tiết với token có sẵn, không tự hợp nhất giỏ khách hoặc tiếp tục purchase flow.

`Xem chi tiết` mở `/my-orders/:orderId`, tải chi tiết thật, thông tin nhận hàng, giá lúc đặt, tiến trình và thông tin thanh toán. Xem [ORDER_DETAIL.md](ORDER_DETAIL.md) về tính chỉ đọc, eligibility Online và giới hạn lịch sử trạng thái.

Không đổi schema, logic tạo đơn, thanh toán hoặc tồn kho. Tổng tiền hiển thị đúng dữ liệu đơn đã lưu, ghi rõ chưa gồm phí vận chuyển như Checkout.

## Kiểm thử

```powershell
# Từ backend: database test tạm riêng, không ghi database ứng dụng
npm.cmd run test:my-orders

# Từ frontend: API tổng hợp ở 3102, Vite ở 5175, không kết nối MySQL
npm.cmd run test:my-orders
npm.cmd run build

# Hồi quy Checkout đã có
npm.cmd run test:checkout
```

Test backend kiểm tra token, user A/B, chi tiết thuộc tài khoản khác, claim giả, user_id query, trạng thái thật, SQL count/phân trang và hash dữ liệu không đổi. Test trình duyệt giả lập API ở tầng network để kiểm tra auth/returnTo, dữ liệu, lọc/phân trang, lỗi, empty/loading, điều hướng và responsive; dữ liệu giả chỉ có trong thư mục test.

## File cập nhật

- Trang/style: `frontend/src/pages/MyOrdersPage.jsx`, `frontend/src/my-orders.css`.
- Điều hướng/xác thực/đọc API: `frontend/src/App.jsx`, `frontend/src/components/Header.jsx`, `frontend/src/context/CommerceContext.jsx`, `frontend/src/utils/auth-navigation.js`, `frontend/src/services/commerce.js`.
- Backend: `backend/routes/orders.js` (chỉ GET), `backend/models/order.js` (chỉ list), `backend/tests/my-orders.test.js`.
- Test/cấu hình: `frontend/playwright.my-orders.config.js`, `frontend/tests/my-orders.spec.js`, `frontend/tests/helpers/my-orders-fixtures.js`, `frontend/package.json`, `backend/package.json`.
- Tài liệu: `frontend/MY_ORDERS.md`, `frontend/README.md`, `backend/ORDERS.md`.
