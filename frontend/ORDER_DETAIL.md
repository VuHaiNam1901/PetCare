# Chi tiết đơn hàng / Theo dõi đơn

Trang `/my-orders/:orderId` thay trang thông báo cũ, mở từ nút Xem chi tiết trong danh sách. Header/Footer, font, màu và các thành phần hiển thị đơn được dùng lại. Không cần migration hay thay đổi API/backend nghiệp vụ.

## API và dữ liệu

- `GET /api/orders/:id`: chi tiết đơn trong MySQL; JWT bắt buộc, chỉ chủ đơn được đọc. ID không tồn tại và đơn khác tài khoản đều trả 404. Query định danh người dùng bị từ chối.
- `GET /api/orders/:id/payment`: trạng thái đơn/thanh toán và điều kiện mô phỏng từ backend (`can_simulate`, `simulation_only`, `approved_at`). Endpoint cũng kiểm tra chủ đơn.
- Số lượng, đơn giá, thành tiền và tổng tiền lấy từ `order_details.quantity`, `unit_price`, `subtotal`, `orders.total_amount`, không tính lại bằng giá catalog hiện tại.
- Tên người nhận, điện thoại, địa chỉ, ghi chú giữ Unicode và xuống dòng; ảnh dùng ProductImage hiện có và fallback trong khung cố định.
- Lỗi eligibility thanh toán không làm mất chi tiết đơn. Nút Thử lại ở khu vực này chỉ gọi lại GET thanh toán.

## Trạng thái và tiến trình

Trạng thái đơn và trạng thái thanh toán hiển thị riêng. Tiến trình dùng đúng các trạng thái hiện có: Chờ xử lý, Chờ thanh toán, Chờ giao hàng, Đang giao hàng, Đã giao hàng, Đã hủy. COD và ONLINE có giai đoạn chờ ban đầu khác nhau; đơn hủy được tách khỏi tiến trình giao hàng.

Chỉ hiển thị thời điểm thực có trong `order_date`, `approved_at`, `transaction_date`. Không tự tạo giờ chuyển sang chờ giao/đang giao/đã giao; không lấy `stock_restored_at` làm ngày hủy. Database chưa có lịch sử vận chuyển hoặc trạng thái Từ chối/lý do từ chối riêng, nên trang không suy diễn những dữ liệu đó.

COD ghi rõ Thanh toán khi nhận hàng và dùng payment_status thật. ONLINE chưa duyệt phải chờ Admin. Sau duyệt, trang chỉ thông báo mô phỏng khi backend cho phép; chưa có giao diện thanh toán/cổng thanh toán hoàn chỉnh nên không dựng nút Thanh toán hoặc gọi POST mô phỏng. Không đánh dấu đã thanh toán khi xem trang.

Tổng tiền chưa gồm phí vận chuyển; không thêm số phí hoặc cam kết thời điểm thông báo phí.

## Phiên và tính chỉ đọc

Khách được chuyển sang đăng nhập/đăng ký rồi quay lại đúng URL chi tiết. Đích returnTo rõ ràng của trang đơn được giữ ngay cả khi có Checkout đang chờ kết quả; bản nháp/payload/idempotency key vẫn giữ nguyên. Luồng đăng nhập từ Checkout thực sự vẫn hoạt động như trước.

Khi khởi tạo trang danh sách/chi tiết với token có sẵn, chỉ đọc giỏ tài khoản, không tự hợp nhất/xóa giỏ khách hoặc merge marker và không tự tiếp tục purchase flow. Đăng nhập, mở Giỏ hàng và retry hợp nhất vẫn giữ cơ chế hiện có. Đọc chi tiết không phụ thuộc vào khóa thao tác giỏ. Kết quả gắn tài khoản/ID đơn, request cũ bị hủy và không hiển thị sau đổi phiên/ID.

Trang không gọi API đổi trạng thái, trừ tồn kho, sửa giỏ, hủy đơn, mua lại, đánh giá hoặc Admin.

## Kiểm tra

```powershell
# Backend: database test riêng, chỉ sao chép schema và dùng dữ liệu tổng hợp
npm.cmd run test:order-detail
npm.cmd test

# Frontend: API fixture độc lập, không kết nối MySQL
npm.cmd run test:order-detail
npm.cmd run test:my-orders
npm.cmd run test:checkout
npm.cmd run build
```

Test kiểm tra chủ đơn A/B, ID không tồn tại/không hợp lệ, token hết hạn, tài khoản khóa/Admin, giá lịch sử, trạng thái/eligibility thật và hash dữ liệu không đổi trên mỗi GET. Browser tests kiểm tra danh sách → chi tiết, URL trực tiếp/reload, returnTo, lỗi/retry, Unicode/xuống dòng, nhiều sản phẩm, hủy, Online chưa duyệt và 320–1440px. Dữ liệu giả chỉ ở test; không ghi dữ liệu thử vào database ứng dụng.

Kết quả kiểm tra ngày 31/10/2026:

- Backend toàn bộ: 327 đạt, 4 bỏ qua (live chat), không có lỗi; database test riêng đã được dọn sau khi chạy.
- Frontend danh sách/chi tiết: 50/50 đạt, gồm kiểm tra giỏ khách/merge marker không bị thay đổi khi mở và tải lại chi tiết.
- Hồi quy Checkout/giỏ hàng: đạt toàn bộ. Build frontend: thành công.
- Đã xem ảnh desktop/mobile và kiểm tra local frontend, kết nối MySQL. Chưa thử giao dịch tiền thật; chưa có giao diện/cổng thanh toán thật để kiểm chứng.

## File cập nhật

- Trang/style: `frontend/src/pages/OrderDetailPage.jsx`, `frontend/src/order-detail.css`.
- Thành phần dùng chung: `frontend/src/components/OrderContent.jsx`, `frontend/src/utils/orders.js`; danh sách `frontend/src/pages/MyOrdersPage.jsx` dùng lại các thành phần này.
- Điều hướng/xác thực/API đọc: `frontend/src/App.jsx`, `frontend/src/context/CommerceContext.jsx`.
- Tests: `backend/tests/order-detail.test.js`, `frontend/tests/order-detail.spec.js`, `frontend/tests/my-orders.spec.js`, `frontend/tests/helpers/my-orders-fixtures.js`, `frontend/playwright.my-orders.config.js`.
- Script/tài liệu: `backend/package.json`, `frontend/package.json`, `frontend/ORDER_DETAIL.md`, `frontend/MY_ORDERS.md`, `frontend/README.md`.
