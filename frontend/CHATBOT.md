# AI Chatbot — Bước 1: kết nối giao diện

Widget trang chủ dùng `POST /api/chat` theo `backend/routes/chat.js` và
`backend/ai/CHAT_API.md`. Không thay đổi backend hoặc bổ sung fallback nội bộ.

## Request và phản hồi

- `src/services/chat.js` dùng `API_ORIGIN` hiện có; chỉ gửi `message`, UUID
  `request_id` và `session_id` nếu đã nhận được. Tài khoản khách hàng gửi bearer
  token từ phiên đăng nhập hiện tại; tài khoản quản trị không gửi dưới quyền khách.
- Timeout client là 65 giây, lớn hơn timeout Gemini 45 giây để chừa thời gian
  chờ khóa/lưu lịch sử. Hết thời gian chờ không chứng minh backend đã dừng xử lý.
- Widget hiển thị text, `products`, `follow_up`, `warnings` từ response đã kiểm
  tra cấu trúc; không render HTML/Markdown không tin cậy. Thẻ sản phẩm dẫn tới
  route `/products/:product_id`, dùng formatter và ảnh dự phòng hiện có.
- Chặn gửi trùng khi đang chờ. Khi lỗi, giữ nguyên tin và UUID; nhận thêm session
  từ response lỗi hợp lệ nếu có. Retry là thao tác thủ công và tôn trọng
  `Retry-After`. Chưa giải quyết được lượt lỗi thì không gửi lượt kế tiếp.
- Lỗi 401/403 không tự chuyển sang khách. Lỗi không thể retry có hướng đăng nhập
  lại hoặc mở cuộc trò chuyện mới. Nút cuộc trò chuyện mới chỉ đặt lại giao diện
  và session trong bộ nhớ, không xóa lịch sử MySQL.

## Phiên và lịch sử

Hội thoại/session chỉ giữ trong bộ nhớ của lần mở trang, không lưu thêm vào
localStorage/sessionStorage. Đóng/mở widget giữ hội thoại và request đang chạy.
Tải lại hoặc điều hướng sang trang khác sẽ bắt đầu phiên chat mới. Đổi danh tính
khách/tài khoản, token, role hoặc trạng thái đăng nhập hủy request cũ và tách toàn
bộ hội thoại; phản hồi đến muộn không được đưa vào phiên mới.

Backend chưa có API GET lịch sử, nên chưa tải lại được hội thoại đã lưu. Nếu mất
phản hồi đầu tiên trước khi nhận session token, retry cùng UUID vẫn có thể tạo
phiên mới; UUID riêng không bảo đảm replay theo contract hiện tại.

Widget vẫn chỉ xuất hiện trên trang chủ như trước. Bố cục, màu sắc, nút mở/đóng,
Escape, focus, ARIA log/status và responsive được kế thừa.

## Kiểm thử cô lập

Chạy tại thư mục `frontend`, dùng package đã có:

```powershell
node --test --test-isolation=none tests/chat-service.test.js
node node_modules/@playwright/test/cli.js test --config playwright.chat.config.js
npm.cmd run build -- --emptyOutDir false
```

Config chat chỉ mở Vite tại `127.0.0.1:5183`, dùng API origin giả
`127.0.0.1:3193`, không tái sử dụng server đang có. Fixture mock toàn bộ API
catalog/auth/cart/readiness/chat; API lạ và request ngoài frontend đều bị chặn
hoặc trả dữ liệu ảnh tổng hợp. Không khởi động Express, kết nối MySQL, gọi Gemini
hay chạy nghiệp vụ đơn hàng/thanh toán/voucher thật.

Test service dùng fetch stub và đồng hồ giả để kiểm timeout/hủy request. Test
trình duyệt kiểm gửi/nhận, thẻ sản phẩm, loading/chống trùng, retry, tách phiên,
text an toàn, focus/Escape và responsive.

Chưa xác minh kết nối thật, CORS/proxy triển khai, quota/model Gemini, dữ liệu
catalog thật hoặc việc lưu MySQL trong bước này. Không dùng `npm test` backend
để kiểm giao diện.

`backend/server.js` hiện dùng `cors()` mặc định, chưa expose `Retry-After`.
Nếu frontend/API khác origin và proxy không bổ sung header CORS, trình duyệt
không đọc được thời gian chờ này: vẫn hiển thị lỗi và cho retry thủ công nhưng
không có countdown chính xác. Mock có expose header để kiểm nhánh countdown;
cần cấu hình CORS/proxy ở bước được phép thay đổi backend/triển khai sau này.

Kết quả xác minh ngày 06/11/2026: 16 test service đạt, 16 test trình duyệt đạt,
build đạt; đã xem ảnh widget desktop/mobile. Build cảnh báo bundle JavaScript
khoảng 541 kB sau minify, vượt ngưỡng cảnh báo 500 kB của Vite. Chưa thay đổi
cách chia bundle trong phạm vi kết nối chatbot.
