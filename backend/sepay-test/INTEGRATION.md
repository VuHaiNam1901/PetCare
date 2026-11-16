# Bước A — tích hợp website chính (16/11/2026)

- Backend chính nhận `POST /webhooks/sepay/test` (chỉ DB Test cô lập) và `POST /webhooks/sepay` (Live mặc định OFF), trước `express.json()`. Receiver riêng cổng 3001 vẫn dùng được; không cần chạy cả hai receiver cho cùng webhook.
- Dùng lại provider HMAC, payment attempt, canonical receipt và SQL transaction hiện có. Không thêm bảng/migration/đơn hàng riêng; trạng thái sau thanh toán vẫn là `Đã thanh toán` → `Chờ xử lý` (giao diện: Chờ duyệt). Nghiệp vụ kho/voucher/hủy/duyệt/hết hạn/refund không đổi.
- `GET /api/orders/:id/payment` giữ JWT và kiểm tra chủ đơn; bổ sung `sepay`/`sepayStatus`. Nhánh Test giữ alias `sepayTest`/`sepayTestStatus`. Frontend lấy QR/số tiền/nội dung/hạn từ API; nút cập nhật chỉ GET, không gửi trạng thái paid. Test giữ nhãn DEMO / TEST.
- Website chỉ tạo ONLINE v2 khi SePay có thể settlement, cấu hình workflow đủ và số tiền thuộc phạm vi QR. `GET /api/orders/payment-options` công bố khả dụng để checkout khóa ONLINE khi tắt; backend kiểm tra lại trước mọi ghi dữ liệu. Retry một đơn đã commit vẫn trả đúng đơn cũ bằng idempotency key.
- ONLINE mới mở QR sau checkout; nút × đóng về chi tiết đơn, `Thanh toán ngay` mở lại QR cùng đơn khi còn hạn. Admin chỉ duyệt sau thanh toán, vẫn có quyền từ chối trước/sau thanh toán. Đơn ONLINE lịch sử không được tạo thanh toán hoặc duyệt trước thanh toán; giữ dữ liệu, lịch sử và khả năng hủy/từ chối hợp lệ, không tự chuyển đổi dữ liệu.
- `SEPAY_INTEGRATION_ENABLED` và `SEPAY_LIVE_ENABLED` đều mặc định `0`. Không thay `.env` thật. Bật Test vẫn yêu cầu toàn bộ chốt cô lập và write binding ở phần dưới; startup và mỗi thao tác kiểm tra tên DB trên kết nối thật, từ chối `petcare_db` cho DEMO.
- Nhánh Live chuẩn bị sẵn cho **tài khoản VietinBank trực tiếp**, nội dung `SEVQR PCS<orderId>`, số tiền nguyên 1.000–499.000.000 VNĐ như phạm vi đã thử. Chưa hỗ trợ VA/ngân hàng khác. Live cần đồng thời hai flag, `SEPAY_ENVIRONMENT=live`, `SEPAY_TEST_MODE=0`, các giá trị `SEPAY_LIVE_*` riêng trong `.env.example`, write binding đúng DB, workflow/frontend/expiry sẵn sàng và simulator tắt; không chấp nhận DB/binding Test hoặc tài khoản/khóa Test dùng chung. Môi trường provider lưu `production` theo schema hiện có.

Kiểm tra an toàn không kết nối MySQL, không tạo schema, không gọi SePay hoặc tải QR:

```powershell
# Trong backend/
node --test sepay-test/main-integration.test.cjs sepay-test/receiver.test.cjs
# Trong frontend/
npm.cmd run build
```

Thử giao diện thủ công chỉ trên Sandbox đã xác minh: chạy `npm.cmd run start:sandbox` trong backend và `npm.cmd run dev:sandbox` trong frontend; dùng tài khoản/đơn giả. Backend Sandbox sử dụng chính `server.js`, endpoint Test mới và cùng schema Test hiện có. Nếu dùng receiver 3001 thì giữ cấu hình cũ; nếu dùng backend Sandbox trực tiếp thì webhook Test trỏ `/webhooks/sepay/test` trên cổng Sandbox (mặc định 3002). Không cần tạo lại fixture, bật flag ở backend chính hoặc mở tunnel trong Bước A.

Khi triển khai Live sau này: xác minh schema/readiness bằng kiểm tra chỉ đọc; cấu hình tài khoản VietinBank thật, mã PCS và khóa HMAC Live riêng; đăng ký endpoint HTTPS, cấu hình worker hết hạn và quy trình vận hành đối soát/refund; người dùng duyệt UI và cấu hình trước khi bật hai flag. Không tự thực hiện các thao tác này trong Bước A. HMAC/ACK/QR giữ theo tài liệu [HMAC](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc), [webhook](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook), [VietQR](https://developer.sepay.vn/vi/tien-ich-khac/tao-qr-code).

---

# SePay giai đoạn 2 — Lượt 2 (lịch sử Sandbox)

Đã bổ sung settlement SePay Test vào state machine thanh toán sẵn có, chỉ cho database thử nghiệm cô lập. **Feature flag vẫn mặc định tắt, không sửa `.env` thật, không bật với `petcare_db`.** Phần Lượt 1 bên dưới được giữ làm lịch sử; mô tả “chỉ đọc/chưa có settlement” chỉ áp dụng khi chưa cấp write binding.

- `SEPAY_INTEGRATION_ENABLED=0` mặc định. Bật flag đơn thuần không cho phép ghi: còn cần `SEPAY_TEST_WRITE_DATABASE` trùng **chính xác** `DB_NAME=PETCARE_TEST_DATABASE=petcare_test_<32 hex thường>`, cùng mọi chốt Test Mode/tài khoản/khóa. Binding mặc định rỗng giữ đường đối chiếu chỉ đọc cũ; binding sai bị từ chối. Kết nối SQL thực tế được kiểm tra trước khi ghi.
- Nhánh settlement dùng bằng chứng HMAC riêng của SePay, khóa order → payment → attempt, lưu receipt canonical trong `payment_events` và cập nhật trạng thái cùng một SQL transaction. Chống trùng/đồng thời dựa vào DB; ledger file/`eligible` Lượt 1 không phải bằng chứng và không được dùng để bỏ qua settlement.
- Đúng tiền, đúng tài khoản/môi trường, còn hạn và đơn hợp lệ mới áp dụng: payment thành **Đã thanh toán**, order thành **Chờ xử lý** để chờ Admin duyệt. Không tự duyệt đơn. Mở lại QR dùng lại payment attempt; không tạo đơn mới hoặc thay giỏ hàng.
- Thiếu/thừa tiền không được đánh dấu thành công, không cộng dồn nhiều lần chuyển để đủ tiền: ghi `amount_mismatch`/đối soát. Capture trên đơn hủy/hết hạn/từ chối hoặc dư/trùng khác được giữ bằng chứng và đi qua nghiệp vụ refund hiện có khi phù hợp; chỉ tạo yêu cầu `requested`, không tự chuyển tiền hoàn hoặc xác nhận đã hoàn. Không hồi sinh đơn.
- Thời gian giao dịch ngân hàng có độ chính xác **giây**, trong khi attempt có mili giây. Giao dịch cùng giây với lúc tạo attempt có thể cần `manual_review`; không làm tròn/lùi timestamp để tự chấp nhận.
- UI giữ nhãn **DEMO / TEST**, không chuyển tiền thật. Chờ/đã thanh toán/cần đối soát/hủy/hết hạn lấy từ API đơn/payment; tải QR không xác nhận thanh toán. Nút cập nhật chỉ GET hiện có; deadline hết không tự đổi trạng thái đơn. Flag tắt giữ UI cũ.

## Cấu hình cần có cho preview cô lập trong bước tiếp theo

Đây là hợp đồng cấu hình cho **schema test mới đã được xác minh**, chưa phải thao tác kích hoạt. Không thay cấu hình môi trường thật hoặc dùng `petcare_db` làm đích.

```text
SEPAY_INTEGRATION_ENABLED=1
SEPAY_TEST_MODE=1
SEPAY_ENVIRONMENT=test
NODE_ENV=test
PETCARE_TEST_ISOLATED=1
DB_NAME=petcare_test_<32 hex thường của schema cô lập đã xác minh>
PETCARE_TEST_DATABASE=<trùng chính xác DB_NAME>
PETCARE_TEST_SOURCE_DATABASE=<DB nguồn, khác schema đích>
SEPAY_TEST_WRITE_DATABASE=<trùng chính xác schema cô lập đích>
SEPAY_TEST_ACCOUNT_CONFIRMED=1
SEPAY_TEST_ACCOUNT_NUMBER=<tài khoản giả lập 4-32 chữ số>
SEPAY_TEST_ACCOUNT_NAME=<chủ tài khoản giả lập>
SEPAY_TEST_WEBHOOK_SECRET=<khóa HMAC Test riêng, không đưa vào frontend>
PETCARE_ORDER_WORKFLOW_ENABLED=1
PETCARE_ORDER_FRONTEND_READY=1
PETCARE_ORDER_EXPIRY_ENABLED=1
PETCARE_PAYMENT_SIMULATION_ENABLED=0
PETCARE_VOUCHERS_ENABLED=1  # nếu preview voucher
```

Các placeholder cần được thay bằng thông tin môi trường test riêng trước khi preview được duyệt. Schema preview phải có schema nghiệp vụ hiện có; **không cần migration mới**, không tự migration database thật.

Preview web vẫn cần được người dùng xem xét và chuẩn bị **fixture sandbox đầy đủ** (đăng nhập với thông tin thử nghiệm, sản phẩm, giỏ hàng và các phụ thuộc website). Fixture settlement chỉ sao chép các bảng phụ thuộc thanh toán; các schema tối thiểu Lượt 1 và fixture kỹ thuật này không mặc nhiên là môi trường web sẵn dùng. Backend và receiver cần cấu hình riêng nhưng cùng database cô lập đã xác minh, các flag/write binding, tài khoản nhận và khóa HMAC Test; frontend phải trỏ API đúng backend cô lập đó. Chưa tự kích hoạt các tiến trình hoặc mở Tunnel.

## Kiểm tra an toàn Lượt 2

```powershell
Set-Location 'D:\petcare-website\PetCare\backend'
npm.cmd run test:sepay-settlement
```

Runner gồm 6 nhóm kiểm tra kỹ thuật, tạo schema mới tên ngẫu nhiên mỗi lần chạy, chỉ sao chép định nghĩa bảng nguồn qua transaction READ ONLY, xác minh đích trước DDL/seed và dùng dữ liệu giả. Không chạy migration, không ghi vào DB nguồn, không tái sử dụng hoặc xóa schema kiểm thử cũ. Không chạy UX/Playwright.

Kết quả ngày 15/11/2026: **6/6 settlement, 8/8 đối chiếu chỉ đọc, 10/10 receiver đạt; frontend build đạt**. Đã kiểm tra transaction rollback khi lỗi ghi payment và retry chỉ áp dụng một lần; sai tiền, ID/tham chiếu dùng cho đơn khác, bằng chứng giả, amount attempt lệch payment, hết hạn trước/sau worker và hủy/từ chối đều không được ghi nhận paid sai. Stock giữ chỗ không bị trừ lần hai; voucher reserved → consumed đúng một lần theo nghiệp vụ hiện có.

Các schema mới được giữ lại để xem xét (không xóa ba schema Lượt 1):

- `petcare_test_e18906c0af9f40e88979e28ba52e326c`: lần kiểm tra settlement đầu tiên.
- `petcare_test_a02bd67175b74b938305bfa4cb3c98ee`: kiểm tra settlement cuối có thêm cross-order/amount drift.
- `petcare_test_e640d76e0cd849f5ad551b383e601618`: kiểm tra tương thích đối chiếu chỉ đọc Lượt 1.

`backend/.env` thực tế không khai báo `SEPAY_INTEGRATION_ENABLED` và không có write binding, nên hiện mặc định OFF. Chỉ đọc đúng các khóa này để xác minh, không thay đổi file hoặc lộ giá trị bí mật. Không có lệnh ghi dữ liệu ứng dụng/schema nguồn `petcare_db` trong triển khai/kiểm tra; chỉ đọc metadata định nghĩa bảng. Không sửa migration, không commit/push.

File Lượt 2: backend `config/sepay.js`, `providers/sepay-test.js`, `services/sepay-test.js`, `services/online-orders.js`, `models/payment.js`; receiver `backend/sepay-test/receiver.cjs`; cấu hình `backend/package.json`, `backend/.env.example`, `backend/sepay-test/.env.example`; frontend `components/SePayTestQr.jsx`, `pages/OrderDetailPage.jsx`, `sepay-test-qr.css`; mới hai file kiểm tra `backend/scripts/run-sepay-settlement-tests.cjs`, `backend/sepay-test/settlement.test.cjs`; tài liệu này và `backend/sepay-test/README.md`. Không sửa Checkout, chatbot, route quản trị hoặc worker.

Tài liệu chính thức vẫn dùng chung: [xác thực HMAC](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc), [payload/ID/ACK](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook), [QR Test Mode](https://developer.sepay.vn/vi/tien-ich-khac/test-mode/mo-phong-tao-ma-vietqr).

---

# Lượt 1 — lịch sử triển khai đường đối chiếu chỉ đọc

Code chuẩn bị QR và đối chiếu đã có; `SEPAY_INTEGRATION_ENABLED=0` mặc định. Không sửa `.env` thật. Lượt này **chưa có đường ghi nhận thanh toán SePay**, kể cả khi bật flag; kết quả `eligible` chỉ là chẩn đoán tại thời điểm đọc.

## Kiến trúc và schema đã khảo sát

- Checkout hiện tạo đơn qua API sẵn có rồi tới `/my-orders/{id}`. Không sửa Checkout, không tạo đơn khi mở lại QR. `GET /api/orders/:id/payment` vẫn xác thực JWT và quyền sở hữu; nhánh ONLINE v2 có thể bổ sung `payment.sepayTest` khi cấu hình cô lập hợp lệ.
- `models/payment.js` và `services/online-orders.js` đang xử lý simulator; `confirmProviderEvent()` chỉ nhận bằng chứng riêng từ `providers/simulated-payments.js`. SePay không mạo danh SIMULATOR và không gọi hàm xác nhận đó.
- Đã đọc metadata DB ngày 15/11/2026: `orders`, `payments`, `payment_attempts`, `payment_events`, `refund_requests` tồn tại; `orders` có `workflow_version`, `created_at_utc`, `payment_expires_at`. Không đọc dòng đơn hàng thật hoặc thay đổi schema/dữ liệu thật. Không suy diễn schema chỉ từ file migration.
- Tái sử dụng `models/order-policy.js` và `models/order-time.js`. Không sửa worker hết hạn, duyệt/từ chối, hủy đơn, nghiệp vụ hoàn kho, voucher, refund hoặc chatbot. Các bảng attempts/events/refunds hiện có được để nguyên.

## Các lớp chặn bắt buộc

Để có QR hoặc đối chiếu DB, tất cả điều kiện sau phải đúng:

```text
SEPAY_INTEGRATION_ENABLED=1
SEPAY_TEST_MODE=1
SEPAY_ENVIRONMENT=test
NODE_ENV=test
PETCARE_TEST_ISOLATED=1
DB_NAME=petcare_test_<32 ky tu hex thuong>
PETCARE_TEST_DATABASE=<trung chinh xac DB_NAME>
PETCARE_TEST_SOURCE_DATABASE=<ten DB nguon, khac DB_NAME>
SEPAY_TEST_ACCOUNT_CONFIRMED=1
SEPAY_TEST_ACCOUNT_NUMBER=<so tai khoan GIA LAP, 4-32 chu so>
SEPAY_TEST_ACCOUNT_NAME=<ten chu tai khoan GIA LAP>
SEPAY_TEST_WEBHOOK_SECRET=<khoa HMAC RIENG cho Test, 32-256 ky tu ASCII khong khoang trang>
```

Đây là hợp đồng cấu hình cho môi trường kiểm thử riêng, **không phải hướng dẫn bật trên `petcare_db`**. Không tự thay tên DB hoặc sao chép khóa Live. `SEPAY_TEST_ACCOUNT_CONFIRMED=1` là xác nhận thủ công đã kiểm tra tài khoản thuộc Test Mode; payload không có cờ môi trường đáng tin cậy để thay thế việc này. Đổi mỗi feature flag vẫn không vượt được các chốt môi trường.

Service kiểm tra `SELECT DATABASE()` trên kết nối thực tế trước `START TRANSACTION READ ONLY`. Một SELECT JOIN đọc cùng snapshot đơn/payment/giờ MySQL. Không `UPDATE`, `INSERT`, `DELETE`, DDL, tạo attempt hoặc gọi worker trong luồng SePay. Giao dịch giả không thể chuyển đơn thật thành đã thanh toán.

Receiver giữ endpoint riêng `POST /webhooks/sepay/test` trên loopback cổng 3001. **Flag tắt:** receiver giai đoạn 1 tiếp tục chỉ ghi biên nhận kỹ thuật, không nạp MySQL/module nghiệp vụ. **Flag bật + mọi chốt hợp lệ:** receiver chỉ đối chiếu DB cô lập, không mount route backend nào khác. Vẫn chỉ dùng Tunnel tới 3001; không công khai backend 3000. Không tự chạy Tunnel/đăng ký webhook/tạo giao dịch SePay.

## QR DEMO/TEST

Backend lấy mã đơn, tổng tiền cuối cùng, trạng thái và deadline từ snapshot tin cậy, không đọc số tiền/frontend status do client gửi. Chỉ ONLINE v2 đang chờ thanh toán, chưa hủy/từ chối, còn hạn và giữ kho hợp lệ mới có QR. Tổng đơn/payment phải khớp; không làm tròn phần lẻ VNĐ để tạo QR. Áp dụng giới hạn QR Test SePay 1.000–499.000.000 VNĐ.

URL ảnh QR dùng `https://vietqr.app/img` theo tài liệu hiện hành, với `acc`, `bank=VietinBank`, `amount`, `des=SEVQR PCS{orderId}`; `qr.sepay.vn` là giao diện tạo mã. Tài khoản phải lấy từ Test Mode đã được xác nhận, không hardcode hoặc tự suy đoán. Không gọi dịch vụ QR trong kiểm tra; trình duyệt chỉ tải ảnh khi nhánh DEMO hợp lệ được bật trên môi trường cô lập.

Card trong trang chi tiết đơn có nhãn **DEMO / TEST**, cảnh báo **không chuyển tiền thật**, mã đơn, số tiền, nội dung, deadline và trạng thái chờ. Kiểm tra URL/params và dữ liệu khớp hợp đồng backend, tự ẩn ảnh khi hết hạn; nút cập nhật chỉ gọi GET hiện có. Khi API không có `sepayTest`, giao diện cũ giữ nguyên. COD không thay đổi, việc tạo/hiển thị/mở lại QR không tạo đơn, thay giỏ hàng hoặc đánh dấu đã thanh toán.

## Webhook và đối chiếu

- `protocol.cjs` dùng chung xác thực HMAC-SHA256 trên `{timestamp}.{raw_body}`, so sánh constant-time và timestamp ±300 giây. Receiver vẫn giới hạn JSON UTF-8 16 KiB, không nén. Provider xác thực lại trước khi sử dụng bất kỳ trường nào.
- Chỉ tiền vào, ngân hàng VietinBank và chính xác tài khoản giả lập đã cấu hình; không nhận VA chưa cấu hình. PCS có hậu tố 1–10 chữ số, phải là order ID dương được hỗ trợ; mã trong `code` và nội dung khác nhau bị từ chối. Giữ tiền tố `SEVQR`.
- Mã tham chiếu phải không rỗng, 1–128 ký tự gồm chữ/số và `._:/-`. Kiểm tra ngày giao dịch thực theo giờ Việt Nam, không chấp nhận ngày lịch sai, ngày trước khi tạo đơn hoặc tương lai. Hạn thanh toán luôn đọc từ DB, không gia hạn từ webhook.
- Đối chiếu đơn tồn tại, v2 ONLINE, pending, số tiền khớp tuyệt đối bằng BigInt đơn vị xu; chưa paid, chưa hủy/từ chối, deadline đúng 24 giờ, không hết hạn. Thiếu/thừa tiền là `underpaid`/`overpaid`, không cộng dồn hoặc tự chấp nhận phần dư.
- Kết quả gồm `eligible`, `underpaid`, `overpaid`, `expired`, `cancelled`, `rejected`, `not_found`, `already_paid`, `unsupported_order`, `review_required`, `wrong_account`, `invalid_reference`, `invalid_code`, `outgoing`. Không kết quả nào thực hiện settlement/refund hoặc tái kích hoạt đơn.
- Kho đối chiếu **riêng** `.integration-receipts/ledger.json` lưu digest ID, digest tham chiếu, fingerprint, kết quả và thời điểm nhận; không lưu mã đơn, số tiền, số tài khoản, nội dung hoặc khóa thô. Biên nhận giai đoạn 1 không được dùng để bỏ qua đối chiếu giai đoạn 2.
- Tuần tự hóa request trong tiến trình và khóa thư mục liên tiến trình, ghi ledger qua file tạm + rename. Trùng ID hoặc tham chiếu được ACK mà không đối chiếu lần hai; ID/tham chiếu trùng nhưng bằng chứng thay đổi là `event_conflict`. Duplicate không trả `eligible:true`.
- Giới hạn 1.000 biên nhận, không tự xóa. Lỗi/đầy kho hoặc khóa đang giữ trả 503. Nếu tiến trình bị tắt đột ngột để lại `.lock`, dừng toàn bộ receiver và kiểm tra thủ công trước khi phục hồi; không tự phá khóa.
- HTTP trả **201 + `{"success":true}`** khi đã đối chiếu/nhận diện trường hợp cần xem xét, không gửi order/amount/disposition cho bên gọi. HMAC/timestamp sai trả 401; body sai trả 400; lỗi hạ tầng/cấu hình trả 503, không lộ lỗi nội bộ. Log chỉ có disposition và cờ duplicate.

## Kiểm tra tối thiểu

```powershell
Set-Location 'D:\petcare-website\PetCare\backend'
npm.cmd run test:sepay-test
npm.cmd run test:sepay-integration
```

Runner tích hợp tạo schema mới ngẫu nhiên `petcare_test_<hex32>`, xác minh tên thật trước DDL/seed và chỉ chèn 6 đơn/payment hoàn toàn giả. Fixture là bản tối thiểu của hợp đồng truy vấn, không phải migration hay hệ thống đơn hàng mới. Không sao chép dữ liệu thật, không chọn DB nguồn, không chạy migration, không xóa schema test sau chạy. Mọi truy vấn trong service kiểm thử đều bị chặn nếu có SQL ghi; snapshot toàn bộ fixture trước/sau phải giống hệt. Các ca gồm flag/isolation, mở lại QR, đúng/thiếu/thừa, hủy/hết hạn/từ chối/paid/COD/không tồn tại, HMAC, tài khoản/tham chiếu, trùng/đồng thời/restart và kiểm tra tên DB thực tế. Không dùng runner hồi quy chung, mock DB lớn, Playwright hoặc UX tự động.

Frontend được kiểm tra biên dịch bằng `npm.cmd run build` trong thư mục `frontend`; không chạy giao dịch hoặc tải QR Test từ SePay trong kiểm tra.

## Dừng tại đây; công việc Lượt 2

Lượt 2 cần được người dùng xem xét trước khi nối provider SePay vào state machine thanh toán hiện có, tạo/tái sử dụng payment attempt, ghi canonical `payment_events`, đối chiếu lại dưới thứ tự khóa order → payment → attempt, xử lý capture không áp dụng qua nghiệp vụ refund hiện có và kiểm tra race với worker/hủy đơn. **Không dùng `eligible` hoặc ledger file này làm bằng chứng settlement**, vì snapshot có thể cũ ngay sau khi đọc. Không tự động hoàn tiền.

Lượt 1 **không cần migration**; không thêm/sửa bảng thật. Chưa kích hoạt flag với DB thật, chưa sửa `.env` thật hoặc khóa, chưa có thanh toán thật, commit/push.

## File thêm/sửa trong Lượt 1

| Nhóm | Thêm | Sửa |
| --- | --- | --- |
| Backend | `config/sepay.js`, `providers/sepay-test.js`, `services/sepay-test.js` | `models/payment.js`, `package.json`, `.env.example` |
| Receiver (trong `backend/sepay-test/`) | `protocol.cjs`, `integration.test.cjs`, `INTEGRATION.md` | `receiver.cjs`, `.env.example`, `.gitignore`, `README.md` |
| Kiểm tra | `backend/scripts/run-sepay-tests.cjs` | Không sửa runner chung |
| Frontend (trong `frontend/src/`) | `components/SePayTestQr.jsx`, `sepay-test-qr.css` | `pages/OrderDetailPage.jsx` (chỉ nhánh QR; giữ các sửa đổi có sẵn của người dùng) |

Tài liệu chính thức: [HMAC](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc), [payload/ID/ACK](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook), [QR Test Mode](https://developer.sepay.vn/vi/tien-ich-khac/test-mode/mo-phong-tao-ma-vietqr), [URL ảnh QR](https://developer.sepay.vn/vi/tien-ich-khac/tao-qr-code), [VietinBank SEVQR](https://docs.sepay.vn/ket-noi-vietinbank.html).
