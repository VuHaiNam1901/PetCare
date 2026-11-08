# Backend Voucher (2.1)

Code mặc định tắt: `PETCARE_VOUCHERS_ENABLED=1` chỉ được cấu hình sau khi
migration 006–008 đã được duyệt/chạy và schema được xác minh. Không tự chạy
migration khi khởi động. Voucher Online còn yêu cầu workflow Online phiên bản 2.
Chưa tích hợp VNPAY. Giao diện Admin/Checkout chỉ mở chức năng sau xác nhận readiness.

`GET /api/vouchers/readiness` là API công khai, chỉ đọc, không cache. Trả
`{ "success": true, "readiness": { "ready": false, "online_ready": false } }`
khi tắt/chưa đủ schema. Khi tắt không truy vấn bảng Voucher. `online_ready` còn
yêu cầu đủ ba flag workflow Online. Frontend chỉ cho dùng khi nhận boolean
`true` tương ứng; lỗi mạng/response không hợp lệ giữ trạng thái chưa xác định,
không suy đoán từ lỗi quote/CRUD. API không bật tính năng hoặc chạy migration.

Giao diện: `/admin/vouchers` và ô mã/nút **Chọn Voucher** trên `/checkout`.
Khách có thể nhập mã hoặc chọn một mã từ danh sách. Checkout lấy quote mới khi thay
đổi sản phẩm/số lượng/phương thức/giá và trước khi đặt; kết quả thay đổi cần
xác nhận lại. Retry chưa rõ kết quả vẫn gửi đúng payload/key đã lưu.
Test UI: trong `frontend`, chạy `npm run test:vouchers` (toàn bộ API giả lập,
chỉ khởi động Vite; không kết nối backend/database thật).

API cần Bearer token và đúng vai trò:

| Vai trò | API | Chức năng |
| --- | --- | --- |
| Admin | `POST /api/admin/vouchers` | Tạo |
| Admin | `GET /api/admin/vouchers?page=1&limit=20&q=CODE&status=active` | Danh sách |
| Admin | `GET /api/admin/vouchers/:id` | Chi tiết |
| Admin | `PATCH /api/admin/vouchers/:id` | Cập nhật một phần |
| Admin | `PATCH /api/admin/vouchers/:id/disable` | Vô hiệu hóa, body `{}` |
| User | `GET /api/vouchers?page=1&limit=20` | Danh sách mã đang khả dụng cho khách đăng nhập |
| User | `POST /api/vouchers/quote` | Xem giá, không giữ lượt |
| User | `POST /api/orders` | Checkout hiện có, thêm `voucher_code` tùy chọn |

Danh sách khách giới hạn tối đa 50 mã/trang, chỉ trả điều kiện ưu đãi công khai
của mã đang bật, đang trong hạn và chưa hết quota tổng/của khách hiện tại
(tính cả `reserved` và `consumed`, bỏ qua `released`). Không trả dữ liệu quản trị,
redemption hoặc thông tin khách khác. Danh sách chỉ phản ánh thời điểm đọc,
không giữ lượt; chọn mã vẫn gọi quote, checkout vẫn kiểm tra lần cuối như trước.
Giao diện chỉ so sánh điều kiện đơn tối thiểu, không tự tính số tiền giảm.

Trường tạo/cập nhật: `code`, `discount_type` (`fixed`/`percent`),
`discount_value`, `max_discount_amount` (nullable), `minimum_order_amount`,
`starts_at_utc`, `ends_at_utc`, `total_limit`, `per_user_limit` (nullable),
`status` (`draft`/`active`/`disabled`, mặc định `draft`). Tiền là chuỗi có hai
chữ số thập phân; thời gian là ISO UTC có hậu tố `Z`. Mã chuẩn hóa ASCII viết
hoa. Mã đã có redemption không được đổi; không có API xóa cứng.

Quote nhận `{ "code": "SAVE10", "items": [{ "product_id": 1, "quantity": 1 }],
"payment_method": "COD" }`. Giá sản phẩm, giảm giá và tổng đều do backend tính.
Phần trăm làm tròn xuống đến 0,01đ, có giới hạn giảm và không âm. Online tổng
0đ bị từ chối với `VOUCHER_ONLINE_ZERO_TOTAL`; COD tổng 0đ hợp lệ.

Lượt được **giữ khi tạo đơn**; quota tính cả `reserved` và `consumed`.
Online tiêu thụ khi khoản thanh toán xác minh được áp dụng; COD tiêu thụ khi
Admin duyệt. Hủy quá hạn/từ chối theo nghiệp vụ hiện có hoàn lượt và tồn kho
trong cùng transaction. Tắt mã/tính năng không chặn xử lý đơn đã tạo. Hoàn tiền
Online dùng số thực thu sau giảm, vẫn cần xác nhận thực tế để thành công.

Checkout phải dùng `Idempotency-Key` như trước. Retry cùng payload trả đơn và
snapshot cũ dù mã đã đổi điều kiện/hết hạn/tắt; payload khác trả conflict.
Quote không bảo đảm còn lượt khi checkout; backend khóa và kiểm tra lại quota.
Snapshot trên đơn gồm `voucher_code_snapshot`, `subtotal_amount`,
`discount_amount`; payment lưu tổng sau giảm. Chi tiết sản phẩm giữ giá gốc.

Kiểm thử tập trung: `npm run test:vouchers`. Runner chỉ đọc metadata nguồn,
tạo database test ngẫu nhiên, seed dữ liệu giả và giữ lại schema để kiểm tra;
không chạy lại 001–005, không copy đơn thật hoặc tự xóa schema.
