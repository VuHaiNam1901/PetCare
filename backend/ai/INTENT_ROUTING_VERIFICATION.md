# Kiểm chứng Intent/Routing — 07/11/2026

Đã hoàn thiện phạm vi Intent/Routing và kiểm thử bằng dữ liệu tổng hợp/API mock.
Chưa xác minh Gemini API hoặc MySQL thật. Không triển khai fallback mới.

## Trạng thái khi tiếp nhận

Working tree có nhiều thay đổi chưa commit của các chức năng khác. Chỉ tiếp tục
phần Chatbot, không reset/checkout/stash hoặc ghi đè các thay đổi đó. Snapshot
các file Chatbot liên quan trước khi sửa nằm ở
[baseline](../../.codex-chatbot-validation/baseline/); diff có sẵn được lưu ở
[existing-chatbot.diff](../../.codex-chatbot-validation/baseline/existing-chatbot.diff).
Đây là bằng chứng trạng thái tiếp nhận, không phải một commit được xác định theo ngày.

Các thay đổi Chatbot đã có trước phiên này:

- `assistant.js`: trả lời trực tiếp danh mục, hỏi làm rõ, ngoài phạm vi và
  giá/tồn kho; chỉ gắn `model` khi generate thành công qua grounding.
- `products.js`: adapter danh mục lazy, tái sử dụng catalog model và hỗ trợ
  category reader inject trong test.
- `context.js`: nhãn intent mới, định tuyến danh mục, bước xử lý dấu tiếng Việt,
  ngân sách và tham chiếu lịch sử đã được viết một phần.
- `chat-intents.test.js`, các thay đổi `chat-route`, `chat-quality`, `chatbot`,
  evaluation và tài liệu routing đã tồn tại. Widget, service và test frontend
  Chatbot cũng đã có sẵn.

Phần còn dở được kiểm chứng bằng test trước khi sửa:

| Kiểm tra ban đầu | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| Riêng `chat-intents.test.js` | 65 | 6 | 0 |
| Toàn bộ 12 file Chatbot backend | 359 | 6 | 4 |

Sáu FAIL theo cách đếm `node:test` gồm ba câu tổng quan có ràng buộc sản phẩm
và test cha của chúng, câu hỏi hành vi nhắc “điện thoại”, câu giá “sữa tắm”
gọi generation không cần thiết. Các lỗi dải tần suất, không dấu và chuyển chủ
đề qua lịch sử được tái hiện thêm trong quá trình rà soát.

## Những phần đã hoàn thiện

- Phân biệt tổng quan cửa hàng, danh mục, tìm/tư vấn sản phẩm, chăm sóc và
  câu thiếu đối tượng cần hỏi lại. Nhu cầu sản phẩm cụ thể/bộ lọc được ưu tiên
  hơn câu tổng quan hay danh mục trong cùng lượt hỏi.
- `shop` là xưng hô, không tự mang ý định mua hàng. Chăm sóc/hành vi có nhắc
  thiết bị điện tử vẫn là chăm sóc; yêu cầu mua thiết bị ngoài phạm vi vẫn bị
  phân loại riêng.
- Phân biệt `đồ/đó`, kể cả `mon do dung`, `mon do choi` không dấu và tham
  chiếu thật `món đó`.
- Phân biệt `già/giá`, không hiểu `mèo con không ăn` thành “còn không”; không
  bỏ qua câu hỏi giá thật chỉ vì cùng câu có “gia đình”.
- Giữ `tầm/tam`, `tầm giá/tam gia` là ngân sách; không biến `tắm 2 lần mỗi
  tuần`, dải `từ 2 đến 3 lần`, tuổi và khối lượng thành tiền. Có test NFC/NFD.
- Tên `sữa tắm/cát vệ sinh` và giá/tồn kho đi nhánh sản phẩm; cách dùng/thay/
  tần suất đi chăm sóc; hỏi giá kèm cách dùng vẫn cần generation có grounding.
- Từ “phù hợp” trong chủ đề mới không tự kéo ID cũ. Tham chiếu thật vẫn giữ
  ID; chuyển sang tìm hàng mới bỏ tham chiếu cũ.
- Thêm 58 test/subtest theo cách đếm `node:test`, kiểm cả intent, câu trả lời,
  filter/ID, số lần truy xuất dữ liệu và số lần gọi generation.

## Kết quả cuối

Môi trường: Windows PowerShell, Node.js `v24.14.1`.

| Kiểm tra | PASS | FAIL | SKIP | Bằng chứng |
| --- | ---: | ---: | ---: | --- |
| Backend: toàn bộ 12 file `chat*.test.js` | 423 | 0 | 4 | [backend-final.tap](../../.codex-chatbot-validation/backend-final.tap) |
| Frontend: chat service | 16 | 0 | 0 | [frontend-service-final.tap](../../.codex-chatbot-validation/frontend-service-final.tap) |
| Frontend: Chatbot và homepage widgets, Playwright | 16 | 0 | 0 | [frontend-e2e.log](../../.codex-chatbot-validation/frontend-e2e.log) |
| **Tổng test** | **455** | **0** | **4** | Không cộng các lần baseline/chạy thử |
| Backend: kiểm tra cú pháp 25 file | 25 | 0 | — | [backend-syntax.log](../../.codex-chatbot-validation/backend-syntax.log) |
| Frontend production build | 1 | 0 | — | [frontend-build.log](../../.codex-chatbot-validation/frontend-build.log) |

Backend không khai báo script `build`; kiểm cú pháp toàn bộ module `ai`, route,
config Gemini, server, runner/guard và các test Chatbot, cùng bộ regression thực
thi thay cho bước build không tồn tại. Không khởi động backend server thật.
Playwright chạy với Chrome, Vite cổng 5183, API mock và chặn request ngoài;
bao gồm desktop/tablet/mobile. Artifact nằm trong
[frontend/chat-test-results](../../frontend/chat-test-results/).

Lệnh chạy lại từ checkout:

```powershell
# cwd: backend
npm.cmd run test:chat

# cwd: frontend
node --test --test-isolation=none --test-reporter=tap tests/chat-service.test.js
npm.cmd run build
node node_modules/@playwright/test/cli.js test --config playwright.chat.config.js --reporter=line
```

`npm` có thể dùng thay `npm.cmd` trên hệ khác. Runner backend nạp guard trước
test, ép tắt live DB và từ chối dotenv, MySQL thật, migration, kết nối ngoài
loopback. Kết quả cuối: **0 guard violations**. Không dùng `npm test` backend
vì runner đó tạo DB và chạy migration.

Các lần thử frontend ban đầu bị Windows sandbox từ chối tạo tiến trình
(`spawn EPERM`), chưa chạy được test/build. Unit đã chạy thành công trong cùng
tiến trình bằng `--test-isolation=none`; build và Playwright đã được chạy lại
ngoài sandbox sau khi cấp quyền, đều exit 0. Không tính những lần lỗi hạ tầng
đó là kết quả cuối hay âm thầm bỏ qua.

## File thay đổi trong phiên này

| File | Thay đổi |
| --- | --- |
| `backend/ai/context.js` | Hoàn thiện phân loại, ngân sách và tham chiếu lịch sử |
| `backend/tests/chat-intents.test.js` | Mở rộng regression tiếng Việt và cặp dễ nhầm |
| `backend/scripts/run-chat-tests.cjs` | Runner riêng chạy đầy đủ test Chatbot offline |
| `backend/scripts/chat-test-guard.cjs` | Guard ngăn test chạm cấu hình/dịch vụ thật |
| `backend/package.json` | Thêm duy nhất script `test:chat`, giữ script hiện có |
| `backend/ai/INTENT_ROUTING.md` | Cập nhật quy tắc và cách chạy an toàn |
| `backend/ai/INTENT_ROUTING_VERIFICATION.md` | Báo cáo này |

`assistant.js`, `products.js`, `ai/README.md` đã được so SHA-256 với snapshot
tiếp nhận và giữ nguyên các sửa đổi có sẵn. Không sửa source frontend, config
Gemini, route/session/grounding hoặc các chức năng thanh toán, đơn hàng, Voucher.
Không chạy migration, không đọc/sửa dữ liệu hay schema MySQL thật, không sửa
`.env` thật, không đưa API key vào output.

## Giới hạn còn tồn tại

- Bốn SKIP đều cần MySQL thật: conversation qua HTTP, persistence/replay,
  backend restart và catalog snapshot. Chúng được chủ động bỏ qua để giữ giới
  hạn an toàn; chưa có bằng chứng integration MySQL thật trong phiên này.
- Gemini được stub trong test. Không gửi request Gemini thật, nên không kết
  luận API/model đang hoạt động hay đánh giá chất lượng lời văn thực tế.
- Build frontend thành công nhưng cảnh báo chunk JavaScript khoảng 540.65 kB,
  vượt ngưỡng 500 kB. Không chỉnh bundling ngoài phạm vi Intent/Routing.
- Phân loại vẫn dựa trên quy tắc, không bảo đảm bao phủ mọi cách viết hoặc
  câu đa nghĩa. Các kiểm thử chỉ chứng minh những trường hợp đã ghi nhận.
