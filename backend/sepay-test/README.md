# SePay Test Mode receiver — giai đoạn 1

Giai đoạn 2 đã thêm nhánh đối chiếu và settlement DB cô lập, mặc định tắt. Xem [INTEGRATION.md](./INTEGRATION.md). Các cam kết receiver không nạp DB dưới đây áp dụng khi `SEPAY_INTEGRATION_ENABLED` tắt. Khi bật hợp lệ nhưng chưa có write binding, nhánh mới chỉ đọc DB test; settlement cần thêm `SEPAY_TEST_WRITE_DATABASE` khớp chính xác đích cô lập đã xác minh.

Receiver độc lập: `POST http://127.0.0.1:3001/webhooks/sepay/test`.
Chỉ nhận, xác thực và ghi biên nhận kỹ thuật; **không xác nhận thanh toán**.
Không cần khởi động backend cổng 3000 hoặc MySQL.

## Khảo sát và phạm vi

- `server.js` nạp `backend/.env`, pool MySQL, các route nghiệp vụ và có thể khởi động worker hết hạn đơn. Không dùng server này làm đầu vào Tunnel.
- `routes/orders.js` dùng JWT và quyền `user`, gắn `routes/payments.js` tại `/api/orders`. Payment hiện có GET `/:id/payment` và POST `/:id/payment/simulate`; các module này gọi model/service nghiệp vụ.
- `middleware/auth.js` truy vấn người dùng qua model. Webhook xác thực bằng HMAC riêng, không dùng JWT hoặc middleware này.
- Tái sử dụng Express 5/CommonJS và dotenv đã cài, không thêm dependency. Không sửa server, route cũ, QR, checkout, COD/ONLINE, schema, đơn hàng, payment, tồn kho hay voucher.
- Receiver không import module ứng dụng, không tạo kết nối MySQL và không gọi API backend. Chỉ nạp file cấu hình `sepay-test/.env` nếu có; không nạp `backend/.env`.

## Chạy receiver bằng PowerShell

Lấy/tạo Secret Key riêng ở bước Bảo mật của webhook **Test Mode**, dùng cùng khóa ở receiver. Khóa cần 32–256 ký tự ASCII in được, không khoảng trắng; không tái sử dụng khóa Live.

Mở PowerShell thứ nhất (nhập khóa ở lời nhắc ẩn, không đưa khóa vào lịch sử lệnh):

```powershell
Set-Location 'D:\petcare-website\PetCare\backend'
$env:SEPAY_TEST_MODE = '1'
$env:SEPAY_TEST_PORT = '3001'
$env:SEPAY_TEST_WEBHOOK_SECRET = [System.Net.NetworkCredential]::new('', (Read-Host 'Secret Key HMAC cua SePay Test Mode' -AsSecureString)).Password
npm.cmd run start:sepay-test
```

`npm.cmd` dùng được khi Windows chặn `npm.ps1`. Receiver chỉ bind IPv4 loopback `127.0.0.1`; cổng 3000 bị từ chối. `NODE_ENV=production`, thiếu opt-in hoặc thiếu khóa hợp lệ làm khởi động thất bại. Có thể dùng file `sepay-test/.env` theo `.env.example` thay cho biến môi trường; file chứa khóa được Git ignore, không phải tài nguyên HTTP.

## Mở URL HTTPS tạm thời

Chỉ sau khi receiver chạy, tự mở PowerShell thứ hai và chạy trực tiếp:

```powershell
cloudflared tunnel --url http://127.0.0.1:3001
```

Cloudflared in URL dạng `https://<ten-ngau-nhien>.trycloudflare.com`. URL nhập vào SePay là:

```text
https://<ten-ngau-nhien>.trycloudflare.com/webhooks/sepay/test
```

Không trỏ Tunnel vào cổng 3000. Receiver không có route khác, static files, proxy hay CORS. GET/HEAD/OPTIONS trên endpoint trả 405; đường dẫn khác trả 404, kể cả `.env`, biên nhận và `/api/*`.

Tunnel chạy ở cửa sổ hiện tại, không cài service, không chạy nền. Nhấn Ctrl+C tại hai cửa sổ để dừng. Sau khi receiver dừng, có thể xóa khóa khỏi phiên PowerShell bằng `Remove-Item -LiteralPath Env:SEPAY_TEST_WEBHOOK_SECRET`. URL tạm hết hiệu lực khi Tunnel dừng; lần chạy sau cần cập nhật URL trong SePay.

## Nhập cấu hình thủ công trên SePay

1. Giữ **Test Mode** bật → **Tích hợp Webhook** → **Thêm webhook**.
2. Cơ bản: đặt tên `PetCareShop Demo - receiver ky thuat`; nhập URL đầy đủ phía trên, chọn **Tiền vào**, **JSON / application/json**. Có thể bật gửi lại khi lỗi.
3. Tài khoản: chọn riêng VietinBank cá nhân giả lập, nhãn `PetCareShop Demo`, chủ tài khoản `VU HAI NAM`; không chọn tài khoản Live.
4. Giai đoạn khảo sát: để **Dùng để xác thực thanh toán** tắt, không lọc tiền tố và không bật **Chỉ gửi khi có mã thanh toán**. Điều này cho phép quan sát trường hợp SePay không tách được `PCS`, thay vì chặn mất webhook trước khi tới receiver.
5. Bảo mật: chọn **HMAC-SHA256**, dùng chính Secret Key đã nhập ở receiver. Lưu webhook. Receiver không hỗ trợ hạ cấp sang không xác thực/API Key.

Chưa tự đăng ký webhook hoặc tạo giao dịch trên SePay. Khi người dùng chủ động thử trong bước tiếp theo, giữ nội dung **`SEVQR PCS{orderId}`**. Tài liệu VietinBank yêu cầu bắt đầu bằng `SEVQR`; nhận diện mã thanh toán là cơ chế riêng theo cấu hình tiền tố `PCS`, hậu tố 1–10 chữ số. Cần xem payload thực trong **Test Mode → Tích hợp Webhook → Lịch sử gửi** để xác minh trường `code`; tài liệu không chứng minh cấu hình tài khoản cụ thể đã tách mã thành công.

## Hành vi và cô lập dữ liệu

- HMAC: `X-SePay-Signature: sha256=<64 hex>` và `X-SePay-Timestamp` (Unix giây). Tính HMAC-SHA256 trên **`timestamp.raw_body`**; so sánh constant-time, chặn timestamp lệch quá ±300 giây. Dùng raw bytes trước khi parse JSON. Cần đồng hồ máy Windows đúng giờ.
- Chỉ JSON UTF-8, body tối đa **16 KiB**, không nhận body nén; server giới hạn header 8 KiB và timeout nhận request 10 giây. Không tin các header IP do client/proxy gửi để thay cho HMAC.
- Kiểm tra object, `id` và `transferAmount` là số nguyên dương an toàn của JavaScript (VNĐ), `transferType` là `in`/`out`, độ dài/kiểu của `gateway`, `content`, `code`, `referenceCode`. `referenceCode` có thể rỗng; `code` có thể null/không có. Các trường khác bị bỏ qua.
- Trích xuất mã, hậu tố `orderId` dạng chuỗi (1–10 chữ số), số tiền, chiều giao dịch và mã tham chiếu trong bộ nhớ; không tra cứu đơn hàng. Mã trong `code` được đối chiếu với mã trong `content`; nếu `code` không nhận diện được PCS thì quét nội dung có ranh giới rõ ràng. Nhiều mã khác nhau → `ambiguous_code`, không chọn đơn hàng.
- `codeSource`: `code` / `content` / `both` / `none` / `ambiguous`. `content` chỉ chứng minh receiver tự tách được PCS, không chứng minh SePay đã tách được mã.
- Tiền ra/ngân hàng khác, thiếu `SEVQR`, thiếu mã hoặc mã mâu thuẫn được ghi kết quả kỹ thuật tương ứng, rồi ACK. `recorded` chỉ là ghi nhận kỹ thuật, không phải đơn hàng đã thanh toán.
- Biên nhận riêng tại `backend/sepay-test/.receipts/`: mỗi SePay `id` có một tên file SHA-256; tạo file độc quyền, không ghi đè. Chặn gửi trùng, kể cả đồng thời hoặc khởi động lại receiver. Không dùng `referenceCode` làm khóa chống trùng.
- Biên nhận chỉ có version, mode, thời điểm nhận, digest giao dịch, kết quả, nguồn nhận diện mã và hai cờ có prefix/tham chiếu. Không lưu/log khóa, header, body, mã PCS, orderId, số tiền, số tài khoản, số dư hoặc mã tham chiếu thô. Thư mục biên nhận được Git ignore, không phục vụ qua HTTP.
- Giới hạn 1.000 biên nhận, không tự xóa để tránh quên ID trùng; khi đầy hoặc ghi/đọc biên nhận lỗi trả **503**. Giữ thư mục này để bảo toàn chống trùng. Đây là kho kỹ thuật giới hạn cho demo, không phải kho thanh toán.
- Request hợp lệ mới/trùng/bị bỏ qua trả **201 + `{"success":true}`**. Sai HMAC/timestamp → 401; dữ liệu sai → 400; quá lớn → 413; sai content type/encoding → 415. Response không chứa nội dung lỗi nội bộ.
- Payload Test và Live giống cấu trúc, không có cờ mode được xác thực để phân biệt. Phạm vi Test dựa vào webhook/tài khoản/khóa riêng và receiver không có đường gọi nghiệp vụ; không suy diễn môi trường từ payload. Dù cấu hình nhầm nguồn, receiver cũng chỉ ghi biên nhận riêng và không thể xác nhận đơn hàng trong PetCareShop.

## Kiểm tra kỹ thuật tối thiểu

```powershell
Set-Location 'D:\petcare-website\PetCare\backend'
npm.cmd run test:sepay-test
```

Chạy trực tiếp Node test runner, **không dùng `npm test`** vì runner chung có thao tác tạo DB kiểm thử. Các kiểm tra mới chỉ dùng HTTP loopback và thư mục tạm, có chặn nạp mysql2/các module nghiệp vụ suốt lúc import và xử lý HTTP. Dùng một payload hoàn toàn giả, không gọi SePay, không tạo giao dịch, không mở Tunnel, không dùng Playwright.

## Tài liệu chính thức đối chiếu ngày 15/11/2026

- [HMAC-SHA256, raw body, timestamp ±5 phút](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc).
- [Payload, kiểu dữ liệu, ID bất biến và phản hồi](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook).
- [Phản hồi 201 tương thích webhook cũ](https://docs.sepay.vn/tich-hop-webhooks.html).
- [Tạo webhook trong Test Mode](https://developer.sepay.vn/vi/tien-ich-khac/test-mode/tao-webhook).
- [Cấu hình mã thanh toán](https://developer.sepay.vn/vi/sepay-webhooks/cau-hinh-ma-thanh-toan).
- [VietinBank cá nhân: yêu cầu SEVQR](https://docs.sepay.vn/ket-noi-vietinbank.html).
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
