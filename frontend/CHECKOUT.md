# Checkout PetCareShop

`/checkout` giữ Header, Footer, Logo và giao diện hiện có. Xác nhận gửi `POST /api/orders`; chỉ hiển thị thành công sau khi backend commit và trả mã đơn thật.

## Nội dung lần mua

- Đặt hàng từ giỏ lưu ID/số lượng của đúng các dòng đã chọn, trước khi refresh có thể bỏ chọn hàng vừa mất tồn kho.
- Mua ngay lưu riêng một sản phẩm và số lượng. Không thêm/xóa/sửa sản phẩm đó trong giỏ.
- Khách đăng nhập/đăng ký với `flow` được giữ nguyên; chỉ tiếp tục checkout khi đồng bộ giỏ được xác nhận. Xung đột hợp nhất vẫn được xử lý tại giỏ.
- Checkout giữ số lượng ở thời điểm bấm mua. Hợp nhất giỏ vẫn cộng số lượng như trước và không tự mở rộng số lượng định mua.
- Đăng nhập thường từ Header về trang chủ; đăng xuất về `/login` và xóa bản nháp.

## Bản nháp và phiên

`src/utils/checkout.js` lưu `petcare.checkout-draft.v1` trong sessionStorage, gồm ID ý định mua, chủ tài khoản, ID/số lượng sản phẩm, thông tin nhận hàng, COD/ONLINE và giá tham chiếu. Trước khi gửi, lưu `submission: { key, payload }` với UUID và toàn bộ yêu cầu. Khi nhận kết quả đã commit, lưu `order` và khóa nút xác nhận. Dữ liệu giữ qua tải lại và xác thực lại trong cùng phiên tab. Bản nháp của tài khoản khác không được hiển thị; điền thông tin nhận hàng không sửa hồ sơ.

Double click bị chặn đồng bộ bằng ref trước lần await đầu tiên. Mất phản hồi, lỗi server và lỗi khóa DB giữ nguyên key/payload; form tạm khóa để không vô tình gửi một yêu cầu khác. Retry gửi lại trực tiếp, kể cả khi lần commit trước đã làm hết kho hoặc xóa dòng giỏ. Chỉ các lỗi xác định chưa commit (validation, thiếu kho, giỏ thay đổi) mới mở lại form. HTTP 401/403 xóa phiên, quay qua đăng nhập rồi phục hồi đúng draft và key; không tự động gửi lại đơn sau đăng nhập.

Snapshot trong tab là nguồn cho ý định mua của tab đó, kể cả khi tab khác thay đổi ý định mua trong localStorage. Các giá lưu chỉ dùng để nhận biết thay đổi, không dùng tính tiền hoặc cho phép đặt hàng.

## Kiểm tra catalog và form

`POST /api/cart/preview` chỉ đọc database và phân giải tất cả ID đã chọn. Checkout gọi khi tải, cập nhật lại và khi xác nhận. Tên, ảnh, giá, tồn kho, trạng thái và thành tiền đều lấy/tính từ kết quả API mới nhất. Dòng mất sản phẩm hoặc không còn đủ điều kiện được giữ lại, có lý do và liên kết sửa; không âm thầm bỏ hàng. Khi giá thay đổi ở lần xác nhận, trang cập nhật giá và yêu cầu xem lại trước lần xác nhận tiếp theo.

Tên (100 ký tự), điện thoại (6–20 ký tự, ít nhất 6 chữ số) và địa chỉ (5–255 ký tự) bắt buộc; ghi chú tối đa 200 ký tự. Frontend/backend cùng chấp nhận Unicode và xuống dòng trong địa chỉ/ghi chú, từ chối ký tự điều khiển khác hoặc Unicode lỗi. Backend lưu tên người nhận riêng, không đọc lại tên tài khoản để thay tên trên đơn mới.

Chưa có quy tắc phí vận chuyển trong dự án. Phí hiển thị “Chưa xác định”, tổng là tiền hàng chưa gồm vận chuyển. ONLINE hiển thị “Thanh toán sau khi cửa hàng xác nhận đơn.” và không thu thông tin thẻ.

## Hợp đồng và dữ liệu

Yêu cầu có `source: 'cart' | 'buy-now'`, `items: [{ product_id, quantity }]`, `recipient_name`, `shipping_address`, `phone`, `note`, `payment_method` và header `Idempotency-Key`. Không gửi giá/tổng tiền; backend khóa và tính lại từ MySQL. Mua từ giỏ chỉ giảm đúng lượng đã đặt (giỏ A×5, Checkout A×3 → còn A×2); Mua ngay không thay đổi giỏ.

Chạy `npm.cmd run migrate:checkout` trong backend khi ứng dụng đã dừng ghi. Migration `004-checkout.js` backup được kiểm chứng trước khi thêm/backfill tên người nhận và nâng charset các trường nhận hàng; không xóa dữ liệu. COD tạo đơn `Chờ xử lý`, payment `Chưa thanh toán`. ONLINE tạo đơn `Chờ thanh toán`, vẫn chưa thanh toán; chỉ API mô phỏng hiện có sau Admin duyệt mới được đổi trạng thái. Checkout không tự gọi mô phỏng, chưa tích hợp cổng thanh toán thật.

API origin lấy từ `VITE_API_ORIGIN` (xem `.env.example`), mặc định `http://localhost:3000`; chuỗi rỗng dùng cùng origin. Khi triển khai SPA cần cấu hình máy chủ trả `index.html` cho `/checkout`, `/login`, `/register` và các route frontend khác.

## Kiểm tra

Từ thư mục frontend:

```powershell
npm.cmd run build
npm.cmd run test:checkout
```

`test:checkout` tự chạy catalog/preview tổng hợp ở cổng 3101 và Vite ở 5174, giả lập auth/cart/order trong bộ nhớ và chặn mọi thao tác ghi ngoài phạm vi. Không kết nối database thật. Backend `npm.cmd run test:checkout` tạo database `petcare_test_<uuid>` riêng từ schema (không sao chép dữ liệu), chạy migration và dữ liệu tự tạo rồi dọn đúng database đó; chạy test backend trực tiếp ngoài runner sẽ bị chặn.

## Các file cập nhật cho tích hợp tạo đơn

- Backend tạo đơn/schema: `backend/routes/orders.js`, `backend/models/order.js`, `backend/migrations/004-checkout.js`.
- Backend cách ly kiểm thử: `backend/config/db.js`, `backend/scripts/run-tests.cjs`, `backend/package.json`.
- Backend kiểm thử: `backend/tests/checkout.test.js`, `backend/tests/orders.test.js`, `backend/tests/payments.test.js`, `backend/tests/admin-orders.test.js`, `backend/tests/catalog.test.js`.
- Frontend xử lý đơn/phiên: `frontend/src/pages/CheckoutPage.jsx`, `frontend/src/context/CommerceContext.jsx`, `frontend/src/utils/checkout.js`, `frontend/src/utils/auth-navigation.js`, `frontend/src/services/api.js`, `frontend/src/services/commerce.js`.
- Frontend cấu hình/thông báo: `frontend/.env.example`, `frontend/package.json`, `frontend/src/components/ProductSection.jsx` (chỉ cập nhật câu thông báo cũ).
- Frontend kiểm thử: `frontend/playwright.checkout.config.js`, `frontend/tests/checkout.spec.js`, `frontend/tests/checkout-submit.spec.js`, `frontend/tests/cart-auth.spec.js`, `frontend/tests/helpers/checkout-fixtures.js`, `frontend/tests/helpers/checkout-catalog.js`, `frontend/tests/helpers/checkout-api-server.mjs`.
- Tài liệu: `frontend/CHECKOUT.md`, `frontend/README.md`, `frontend/CART_AUTH.md`, `backend/ORDERS.md`, `backend/AUTH.md`, `backend/CART.md`, `backend/CATALOG.md`, `backend/PAYMENTS.md`, `backend/ADMIN_ORDERS.md`.

Không thay thế các thay đổi giao diện/giỏ hàng đã có sẵn trong workspace trước lần tích hợp này.
