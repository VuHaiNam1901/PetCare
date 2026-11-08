# FINAL CODE REVIEW — Giai đoạn 1

Ngày review: 06/11/2026, Asia/Bangkok. Đây là kết quả review code sau các bản vá,
không phải biên bản triển khai database thật. Báo cáo triển khai trước đó được
giữ nguyên tại `STAGE1_REVIEW_REPORT.md`.

## Kết luận

1. **Hoàn tất code trong phạm vi Giai đoạn 1 sau các bản vá dưới đây.**
2. **Không còn CRITICAL/HIGH chưa xử lý được phát hiện trong lượt review này.**
   Có các giới hạn MEDIUM/LOW cần xử lý hoặc chốt khi tích hợp/vận hành.
3. **Có thể bắt đầu Giai đoạn 2 trong môi trường cô lập sau khi duyệt bản vá.**
   Chưa được coi là VNPAY/frontend đã sẵn sàng hoặc đã được kiểm chứng end-to-end.
4. **Chưa đủ điều kiện vận hành để chạy migration thật.** Cần duyệt đúng artifact,
   database đích, dừng writers, backup/manifest được kiểm chứng và caller apply có
   safety callbacks. Kích hoạt workflow cần một xác nhận riêng.

## Phát hiện và xử lý

CRITICAL: không phát hiện trong phạm vi đã đọc và kiểm thử.

| Mức | Phát hiện đã chứng minh | Xử lý và bằng chứng |
| --- | --- | --- |
| HIGH H1 | Callback muộn ghi receipt/refund rồi hoàn tồn trong cùng transaction; nếu Admin đặt tồn khả dụng INT_MAX qua catalog hợp lệ, lỗi overflow rollback cả bằng chứng tiền | `services/online-orders.js`: savepoint riêng cho expiry compensation. Giữ receipt/event/refund, trả/log `compensation_pending`; chỉ rollback phần hủy/hoàn tồn và cho worker thử lại. Test cả success/failed/unknown, lỗi insert/COMMIT và mất phản hồi COMMIT |
| HIGH H2 | Admin v2 duyệt/giao dựa vào payment summary paid, thiếu receipt gốc vẫn thành công; reject với receipt sai có thể tạo refund sai và hoàn tồn | `assertAppliedPayment` kiểm canonical receipt, applied capture, amount/currency, mã giao dịch và provider time dưới khóa; áp dụng cho approve/ship/deliver và reject paid. HTTP test tái hiện 200 sai trước vá, sau vá 409 và không ghi side effect |
| HIGH H3 | MySQL UTC+7, Node UTC làm marker NOW đọc thành tương lai; policy chặn payment/expiry, API hiển thị lệch giờ | `models/order-time.js` lấy epoch/validity từ MySQL, normalize khi đọc order/payment/history; policy dùng bằng chứng thời gian DB. Không rewrite dữ liệu hoặc đặt timezone môi trường thật. Test Node TZ=UTC qua thanh toán/duyệt/expiry và đọc legacy |
| HIGH H4 | FK sang database khác nhưng có cùng tên bảng/cột vẫn qua kiểm schema | Helper kiểm thêm `TABLE_SCHEMA` và `REFERENCED_TABLE_SCHEMA`; từ chối khác schema hoặc thiếu metadata. Test metadata chứng minh trước/sau |
| HIGH H5 | Baseline chưa kiểm UNIQUE idempotency và ba FK orders/details nên preflight chấp nhận schema đã mất ràng buộc | 006 kiểm đúng `uq_orders_user_idempotency`, `fk_orders_User1`, `fk_order_details_orders1`, `fk_order_details_products1`; tên/kiểu đối chiếu read-only với MySQL hiện tại |
| MEDIUM — đã sửa | Worker được gọi trước khi HTTP bind thành công; lỗi bind không đi qua startup catch; shutdown thiếu coverage | `server-lifecycle.js` và `server.js` chờ listening trước worker; bắt lỗi bind, đợi HTTP và worker kết thúc trước pool.end. Test port bận và drain/shutdown error |
| MEDIUM — đã bổ sung coverage | 54 test cũ chủ yếu gọi model/service, chưa đủ chứng minh v2 HTTP/Admin hoặc nhiều process | Thêm HTTP mixed legacy/v2, pending filter/pagination, auth/input, ship/deliver, paid approve–reject race; hai process Node thực quét cùng DB và SKIP LOCKED/catch-up; test timezone và lifecycle |

Các lỗi HIGH được viết test tái hiện trước khi sửa: lượt đầu 23 test bổ sung có
13 lỗi đúng các khoảng trống trên. Nhánh reject receipt sai được kiểm thêm sau đó,
tái hiện cả refund sai/hoàn tồn trước khi nối cùng guard receipt.

## Giới hạn còn lại

- **MEDIUM M1 — tải worker/readiness:** đã bỏ kiểm dependency 006 lặp. Một lần
  readiness vẫn thực hiện 97 truy vấn metadata; đo read-only trên máy này khoảng
  169ms, không phải benchmark tải hoặc cam kết production. Cần kiểm thử backlog,
  độ trễ DB/pool và giám sát trước khi bật worker thực tế. Deadline là 24h; việc
  cộng lại tồn vẫn có thể trễ do chu kỳ quét hoặc downtime.
- **MEDIUM M2 — độ chính xác thời gian provider:** quy tắc hiện tại kiểm instant
  đến millisecond. Giai đoạn 2 phải chốt cách xác minh timestamp chỉ có độ chính
  xác giây, clock skew và biên deadline trước tích hợp VNPAY. Chưa có adapter thật
  để kết luận xác thực chữ ký/callback của VNPAY đã an toàn.
- **MEDIUM M3 — baseline test sau migration:** runner hiện yêu cầu nguồn baseline
  005 và từ chối nguồn đã có 006–008. Cần baseline schema test độc lập hoặc database
  baseline riêng cho Giai đoạn 2; không dùng database thật làm nơi reset schema.
- **MEDIUM M4 — chứng minh bảo toàn xuyên crash:** hash trong migration nằm trong
  bộ nhớ từng invocation. Khi tiếp tục sau gián đoạn cần đối chiếu manifest/hash
  từ trước lần apply đầu và backup ngoài migration; snapshot mới không thay thế
  được bằng chứng cũ. Đây là điều kiện runbook trước migration thật.
- **LOW L1 — artifact/checksum:** checksum gồm source/helper. Giữ byte/EOL của
  artifact được duyệt bất biến; thay helper trong giai đoạn sau cần versioning.
  Bản vá review này làm đổi checksum 006–008 trước khi chúng được áp dụng thật;
  không sửa ledger của schema test cũ để che mismatch.

## Nghiệp vụ và bảo mật được xác minh

- Online v2: tạo/giữ tồn một lần → thanh toán trước duyệt → `Chờ xử lý` → Admin
  approve → giao. COD và các đơn version NULL giữ policy legacy.
- Deadline cố định tạo+24h, không reset khi retry/attempt mới. Provider trả trước
  hạn có thể được áp dụng khi callback muộn nếu đơn vẫn giữ hàng và chưa hủy.
  Đơn đã hủy không mở lại; khoản thu được giữ để refund/đối soát.
- Unknown/failed không thành paid hoặc tạo refund thiếu bằng chứng thu. Test
  unknown tại hết hạn rồi nhận success on-time sau hủy giữ đơn hủy, không hoàn
  tồn lần hai và chỉ tạo refund requested khi đã có bằng chứng khoản thu.
- Receipt identity độc lập callback ID, chống replay/thu nhiều lần; callback sai
  amount/time không ghi đè khoản gốc. Payment/refund không có endpoint công khai
  nhận trạng thái thành công do client tự khẳng định.
- Provider hiện chỉ là simulator backend được kiểm soát, WeakSet evidence không
  chấp nhận object JSON `verified:true`. Guard kiểm cả NODE_ENV/test identity và
  database thực tế của connection; không thể dùng flag đơn lẻ để tạo receipt trên
  database thật. Giai đoạn 2 phải giữ ranh giới này khi thêm verifier thật.
- Refund requested không đồng nghĩa đã hoàn tiền; succeeded cần proof đúng số
  tiền/tham chiếu, không tái dùng một provider refund reference cho nhiều request.
- Cùng thứ tự khóa order→payment→attempt/receipt/refund→inventory, marker điều
  kiện và history cùng transaction bảo vệ hoàn tồn một lần. Lỗi transaction mất
  thật/deadlock/COMMIT không được báo thành ingestion đã bền vững.

## Kết quả kiểm thử và dữ liệu

- Trước sửa: chạy lại đúng bộ cũ, **43/43 regression + 54/54 Stage 1 đạt**.
- Sau sửa: `node scripts/run-stage1-tests.cjs --legacy` đạt **43/43 regression +
  86/86 Stage 1**, không skip. 32 test bổ sung gồm API8, finance7, processes2,
  schema7, server4, timezone4.
- Có kiểm tra partial ALTER 006 đã commit rồi gián đoạn/tiếp tục, rerun 006–008,
  schema drift/checksum/constraints và bảo toàn fixture legacy; không chạy 001–005.
- Chưa kiểm thử gateway ngoài, frontend, tải lớn, failover DB hoặc bộ AI/chat.
  File legacy `admin-orders.test.js` vẫn loại khỏi allowlist vì tự chạy 001.

Database thật được đọc trong READ ONLY transaction: MySQL8.0.46, 12 bảng InnoDB,
schema vẫn ở baseline005. Hash toàn bộ giá trị orders/payments/order_details/
order_status_history/products trước và sau **khớp hoàn toàn** (2/2/2/0/21 dòng).
Bao gồm #173/#174; trạng thái và reservation marker của hai đơn không đổi.
Hash byte `.env` trước/sau khớp; cả bốn feature flag vẫn tắt. Không migration thật,
restore, dọn schema/backup/file review, commit hoặc deploy.

Schema test được giữ nguyên để review:

- `petcare_test_8ea4cf5c4b80420a9d374f43de2aa73f`: xác minh lại 43/54 ban đầu.
- `petcare_test_54a7a40d15b14f29a265e0c3d7f04662`: tái hiện lỗi review.
- `petcare_test_5abf249e0a6e4ec998a78bdd746100ac`: kiểm bản vá trung gian và tái hiện reject receipt sai.
- `petcare_test_98c0fa89ea6641489095f18e8bb56b38`: bản cuối đạt 43/86.

## File thay đổi trong lượt final review

Sửa: `migrations/006-order-payment-lifecycle.js`, `migrations/lib/stage1-schema.js`,
`models/order.js`, `models/order-policy.js`, `models/order-history.js`,
`models/payment.js`, `models/admin-order.js`, `services/online-orders.js`,
`server.js`, `tests/stage1-migration-safety.test.js`.

Thêm: `models/order-time.js`, `server-lifecycle.js`, sáu file
`tests/stage1-final-{api,finance,processes,schema,server,timezone}.test.js` và báo cáo
này. Không sửa `.env`, frontend, migration001–005 hoặc chức năng Voucher.
