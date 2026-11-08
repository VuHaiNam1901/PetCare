# Báo cáo review Giai đoạn 1

Code đã triển khai và kiểm thử với dữ liệu giả trong database cô lập. Chưa chạy
migration hoặc kích hoạt tính năng trên database thật. Không sửa `.env` thật,
không gửi yêu cầu nghiệp vụ đến các đơn thật, không thay đổi đơn #173/#174.

## 1. Danh sách file trong thay đổi này

File mới:

- `config/order-workflow.js`
- `migrations/006-order-payment-lifecycle.js`
- `migrations/007-payment-attempts-refunds.js`
- `migrations/008-voucher-foundation.js`
- `migrations/lib/stage1-schema.js`
- `services/online-orders.js`
- `providers/simulated-payments.js`
- `workers/order-expiry.js`
- `scripts/run-stage1-tests.cjs`
- `tests/stage1-config.test.js`
- `tests/stage1-migration-safety.test.js`
- `tests/stage1-migrations.test.js`
- `tests/stage1-online-workflow.test.js`
- `tests/stage1-worker.test.js`
- `STAGE1_ORDER_FOUNDATION.md`
- `STAGE1_REVIEW_REPORT.md`

File được bổ sung/sửa trong lượt này:

- `.env.example` — bốn cờ mặc định tắt, không có secret mới.
- `config/db.js` — đọc đúng UTC cho cột mới; giữ cách đọc DATETIME legacy.
- `models/order.js` — tạo Online phiên bản 2 khi được bật rõ ràng; deadline cố
  định và thông tin yêu cầu hoàn tiền; giữ canonical payload/idempotency cũ.
- `models/order-policy.js` — tách policy phiên bản 2 và legacy/COD.
- `models/order-history.js` — hỗ trợ khóa sự kiện tùy chọn, giữ nhánh legacy.
- `models/payment.js` — nối service mới và khóa simulator vào database test.
- `models/admin-order.js` — duyệt Online paid, từ chối kèm refund request,
  cập nhật bộ lọc chờ duyệt theo phiên bản.
- `server.js` — readiness chỉ đọc và worker opt-in ở entry point; dừng worker
  trước khi đóng pool khi shutdown.
- `package.json` — thêm `test:stage1` và `test:stage1:regression`.
- `ORDERS.md`, `PAYMENTS.md`, `ADMIN_ORDERS.md` — dẫn đến tài liệu mới, phân biệt
  nghiệp vụ legacy được giữ lại.

`models/order-policy.js` và `models/order-history.js` đã tồn tại dưới dạng file
chưa được Git theo dõi trước lượt này. Workspace còn nhiều thay đổi có sẵn của
dự án; danh sách trên không đồng nghĩa toàn bộ `git status` do lượt này tạo ra.
Không sửa hoặc chạy migration 001-005. Không chỉnh frontend.

## 2. Migration 006-008

| Migration | Cấu trúc |
| --- | --- |
| 006 | `schema_migrations` ghi checksum, trạng thái và bước DDL; nullable `workflow_version`, `created_at_utc`, `payment_expires_at`, `cancelled_at`, `cancellation_reason_code`; index quét hạn; nullable `event_key` và UNIQUE theo đơn trong history |
| 007 | `payment_attempts`, `payment_events`, `refund_requests`, `refund_events`; số tiền kỳ vọng và thực thu; thời điểm provider/nhận callback riêng; receipt chống trùng; refund liên kết receipt, unique business key và mã hoàn tiền provider |
| 008 | `vouchers`, `voucher_redemptions`; nullable subtotal/discount/voucher snapshot trên orders; CHECK/UNIQUE/FK cho nền tảng chưa có writer/API |

Giữ `payments` một hàng mỗi đơn. FK tài chính khớp INT signed của bảng gốc và
RESTRICT khi xóa. Các trường mới trên đơn/history mặc định NULL; không backfill
đơn cũ, không tạo lịch sử giả, không tính lại tổng tiền hoặc tồn kho cũ.

CLI chỉ dry-run. Hàm apply yêu cầu đúng tên database và guard test cô lập, hoặc
caller vận hành được duyệt với kiểm tra dừng writers và backup đã xác minh.
Có kiểm engine/version/type/null/default/collation/index/FK/CHECK, dependency và
checksum; ledger theo từng bước; hash dữ liệu cũ trước/sau. DDL dở dang được
kiểm tra lại; chỉ tiếp tục các phần bổ sung còn thiếu đúng định nghĩa. Bảng đã
tồn tại nhưng sai cấu trúc sẽ dừng, không tự sửa để che drift.

## 3. Nghiệp vụ đã triển khai

- Chỉ Online mới được bật rõ ràng mới có `workflow_version=2`; đơn legacy giữ
  policy cũ. COD giữ quy trình duyệt/giao/thu tiền và deadline NULL.
- Online tạo đơn giữ tồn một lần, thanh toán được ngay trong môi trường kiểm
  thử, deadline đúng thời điểm tạo UTC + 24 giờ. Replay/retry không gia hạn.
- Thanh toán hợp lệ chuyển `Chờ xử lý`, chưa duyệt; Admin duyệt mới chuyển
  `Chờ giao hàng`. Hai bước này không trừ tồn thêm.
- Xác minh backend/provider và ghi riêng thời điểm thanh toán. Callback muộn vẫn
  có thể áp dụng nếu provider trả tiền trước hạn và đơn vẫn active/giữ hàng.
  Thời điểm bằng deadline là quá hạn. Không phục hồi đơn đã hủy.
- Khoản thu muộn, thừa, sai số tiền hoặc có thời điểm cần kiểm tra được giữ lại
  để đối soát/hoàn tiền. Một khoản thu không thể áp dụng cho hai đơn; callback
  đổi ID không tạo tiền lần hai. Receipt gốc không bị ghi đè bởi dữ liệu mâu thuẫn.
- Từ chối đơn paid đang chờ duyệt giữ bằng chứng paid, giải phóng tồn một lần và
  tạo refund `requested`. Chỉ evidence provider khớp được kiểm chứng mới có thể
  chuyển refund sang `succeeded`; chưa có lời gọi hoàn tiền ra cổng nào.
- Worker chạy mỗi 30 giây, quét ngay khi khởi động, có pagination, chống overlap,
  khóa DB chống xử lý trùng giữa nhiều worker và log đã lược bỏ chi tiết nhạy cảm.
- Hủy/hoàn tồn/history trong một transaction, marker điều kiện chống hoàn hai lần.
- Bốn cờ mặc định tắt. Khởi tạo v2 cần frontend-ready và worker-ready. Chưa bật
  cho frontend hiện tại. Simulator chỉ hoạt động trên schema test ngẫu nhiên,
  có NODE_ENV/test identity guard và kiểm database thực tế của connection.

## 4. Kiểm thử

Kết quả cuối:

- **43/43 regression legacy đạt** qua allowlist, workflow mới tắt.
- **54/54 test Giai đoạn 1 đạt**, không skip.
- Kiểm tra cú pháp các file JavaScript mới/sửa đạt; kiểm tra whitespace thay đổi
  không có lỗi (Git có thông báo chuyển LF/CRLF theo cấu hình Windows).

Đã kiểm tra thật trong database cô lập: áp dụng/rerun006008, lỗi giả lập sau ALTER
006 đã commit rồi tiếp tục thành công; schema drift; bảo toàn fixture legacy;
thanh toán trước duyệt; COD; provider time trước/đúng/sau hạn; callback muộn sau
hủy; callback trùng/đảo thứ tự; hai capture; capture thứ hai cùng attempt; race
expiry/payment/reject; rollback sau hoàn tồn; refund evidence/amount/reference;
Voucher constraints; worker startup/catch-up/chống overlap/log.

Lỗi đầu tiên ở cách đọc CHECK_CLAUSE escaped của MySQL đã được sửa và kiểm tra
lại. Một fixture thay chữ hoa trong CHECK cũng được sửa để hoạt động với kiểu
escape đó; bộ 54 test mới chạy lại hoàn toàn và đạt. Code nghiệp vụ không đổi
sau lần regression 43/43 đã đạt.

Runner chỉ đọc metadata từ nguồn, không copy dòng khách hàng/đơn/sản phẩm thật.
Chỉ migration 006-008 chạy trên các schema này, không có DROP/restore tự động:

- `petcare_test_28b90901601f44a893eab6db00799714` — lần phát hiện định dạng CHECK.
- `petcare_test_2b165b1a8d0941788f57ef80b2e9795a` — regression43/43; 53/54 test mới,
  một fixture CHECK cần sửa.
- `petcare_test_51376757b4d24d83a15b16cb45f36be0` — lần cuối 54/54 test mới đạt.

Giới hạn: chưa kiểm thử VNPAY hoặc provider ngoài; chưa kiểm thử frontend/end-to-end,
vận hành nhiều process thật hoặc downtime dài. Worker dùng fake service trong
unit tests; SQL concurrency được kiểm trên nhiều connection trong schema test.
Regression không chạy file cũ `admin-orders.test.js` vì file đó tự gọi migration
001, cũng không dùng runner cũ tự gọi 004/005. Các test ngoài nghiệp vụ liên quan
như AI/chat không được đưa vào đợt này.

## 5. Phần chủ động chưa triển khai

- Adapter/callback/IPN/QueryDr/refund VNPAY thật hoặc Sandbox.
- Gửi refund ra provider; giao diện hoặc endpoint công khai cho phép tự đánh dấu
  refund thành công không được tạo.
- API/giao diện và cơ chế tiêu thụ quota Voucher; hiện chỉ schema nền tảng.
- Điều chỉnh frontend, kích hoạt workflow, chạy worker hoặc migration trên dữ liệu thật.
- Công cụ vận hành apply database thật có callbacks backup/writer verification:
  migration API đã có guard nhưng chưa có lệnh tự động bỏ qua các kiểm chứng đó.

Giới hạn vận hành cần giữ rõ: deadline là 24 giờ; thời điểm cộng lại tồn có thể
trễ một chu kỳ quét hoặc thời gian backend ngừng chạy. Cần giám sát backlog/log.
Provider báo đã thu nhưng timestamp không dùng được sẽ chờ đối soát; request hoàn
tiền không tự gửi và không chứng minh đã hoàn tiền.

## 6. Cần xác nhận trước migration thật

1. Duyệt code/schema và quy tắc provider time/callback muộn nêu trên.
2. Xác nhận chính xác database, thời điểm triển khai và cách dừng mọi writers/worker.
3. Cho phép tạo backup mới đầy đủ và kiểm chứng restore ở môi trường recovery
   riêng; không restore tự động lên database đang dùng.
4. Chốt snapshot/hash các trường cũ và riêng #173/#174 trước/sau; review preflight
   và caller apply có đầy đủ safety callbacks; chạy duy nhất006→007→008 khi được duyệt.
5. Xác nhận riêng việc kích hoạt sau khi frontend/provider/giám sát đã sẵn sàng.
   Giữ simulator tắt trên dữ liệu thật.

Rollback ưu tiên giữ schema/audit và deploy bản tương thích hoặc sửa tiến. Sau
khi có đơn v2, không quay về binary cũ không hiểu v2; không drop bảng tài chính,
không restore đè backup cũ lên các giao dịch mới. Nếu DDL dừng giữa chừng, giữ
writers dừng và kiểm ledger/schema trước khi cho phép tiếp tục.

Code dừng ở trạng thái review; không commit, deploy hay kích hoạt tự động.
