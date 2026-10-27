# UC13 — Rà soát grounding, độ trễ và khôi phục phiên

Ngày đánh giá: 27/10/2026. API giữ nguyên `POST /api/chat`. Model giữ nguyên
`gemini-3.5-flash-lite`, timeout 45 giây, SDK attempts=1, output tối đa 1024 tokens.
Không sửa Frontend, API đặt hàng/thanh toán hay bổ sung migration.

## Vấn đề và bản sửa

- Tách `grounding.js` khỏi assistant. Ngân sách chỉ được chuẩn hóa khi khớp bộ lọc
  Backend; hỗ trợ “ngân sách là/tầm/khoảng 200k”, có/không dấu. Giá không rõ nguồn,
  sai giá hoặc giá gắn nhầm sản phẩm vẫn bị từ chối.
- Tên đầy đủ của sản phẩm đã chọn và giá đúng gắn với chính tên đó trong cùng mệnh
  đề được đổi thành tham chiếu thẻ. Thẻ tên/giá/tồn/ảnh vẫn lấy trực tiếp từ MySQL.
  Không cho phép model tạo thêm trường sản phẩm hoặc chọn ID ngoài context.
- Sửa nhận diện câu phủ định, thiếu thông tin tuổi/thành phần và hướng dẫn kiểm tra
  nhãn. Đã tái hiện false positive bằng mock trước khi sửa. Không coi mọi câu có
  chữ “chưa” là an toàn: khẳng định nối tiếp qua “nhưng”, dấu phẩy hoặc “và khẳng
  định” vẫn bị kiểm tra. Thuốc cụ thể/liều dùng vẫn bị từ chối.
- Bịt hai lỗ có bằng chứng mock: “hạt này/pate này chứa…” thiếu nguồn và disclaimer
  che một khẳng định độ tuổi phía sau. Giữ kiểm tra ở cả advice/follow_up/warnings.
- Câu “Trong những loại đó…” chọn rẻ nhất trong các ID vừa hiển thị; “Loại đó…”
  kế thừa ID đã chọn. Câu hỏi rẻ nhất không giới hạn nhóm vẫn tìm trong bộ lọc cũ.
- Giảm dữ liệu gửi model: bỏ URL ảnh khỏi context, giữ URL trong thẻ API; rút gọn
  System Prompt, giữ giới hạn 6 sản phẩm/16KB và lịch sử 8 tin có giới hạn byte.
  SDK client được tái sử dụng trong mỗi process. Không giảm output tokens thiếu
  bằng chứng và không đổi model để tăng tỷ lệ thành công.
- Thêm đo thời gian theo request bằng AsyncLocalStorage. Mặc định không log;
  `CHAT_METRICS=1` chỉ ghi trường cố định về mã kết quả, thời gian và số lần đo.
  Không ghi prompt, nội dung chat, draft bị từ chối, API key, JWT, token phiên
  hoặc raw error. Script đánh giá chỉ lưu các câu thử công khai và response đã qua
  guard; chẩn đoán guard là mã allowlist.

## Gemini thật — đúng 5 request, không retry tự động

Bằng chứng đầy đủ: [live-evaluation-v2.json](live-evaluation-v2.json).
Đợt trước trong `live-evaluation.json` được giữ nguyên, không cộng vào đợt này.
Không gặp lỗi quota/kết nối. Bốn request đầu cùng một session; Backend được dừng
và chạy process mới giữa lượt 2 và 3. Request thứ năm là lần thử thủ công câu 3
sau vá guard, cùng session nhưng sau câu chăm sóc; không phải chuỗi ba lượt đầu
đều thành công. Mã COMPLETE của runner chỉ nói mỗi câu đã có ít nhất một lần OK.

| Request | Câu hỏi | Kết quả | HTTP tính bằng ms |
|---|---|---|---:|
|1|Shop có thức ăn cho mèo dưới 200k không?|OK: ID 1, 4, 3|8088|
|2|Trong những loại đó, loại nào rẻ nhất?|OK: ID 3, 18.000đ|11562|
|3|Loại đó có phù hợp với mèo 6 tháng tuổi không?|GROUNDING_REJECTED; fallback an toàn|8962|
|4|Chăm sóc vệ sinh bát ăn của mèo hằng ngày thế nào cho hợp lý?|OK: kiến thức chăm sóc chung, không có thẻ sản phẩm|9158|
|5|Thử thủ công lại câu 3 sau vá guard|OK: chưa đủ dữ liệu xác nhận độ tuổi|1725|

Kết quả gốc: **3/4 phản hồi được guard chấp nhận**. Cả đợt: **4/5**.
Request 3 có mã phụ `UNVERIFIED_SUITABILITY_OR_MEDICAL_ADVICE`. Không giữ draft nên
chưa xác định được câu cụ thể bị chặn hoặc kết luận đây là false positive. Các
bản sửa phủ định sau đó có bằng chứng test mock riêng; lần thử thứ năm cũng có
thể khác nội dung do tính biến thiên của model, không chứng minh quan hệ nhân quả.

Đã SELECT đối chiếu lại MySQL: tên, ID, danh mục, giá, tồn, trạng thái và ảnh trong
tất cả thẻ trả về khớp database. Lượt 1 gồm ID 1 giá 152.900đ, ID 4 giá 199.000đ,
ID 3 giá 18.000đ; cả ba đang bán/còn hàng. Lượt 2 chọn đúng rẻ nhất trong nhóm đó.
Câu hỏi tiếp lượt 1 hỏi hạt hay pate, phù hợp nhu cầu. Lượt 2 hỏi thêm hương vị
nhưng database chưa xác nhận có hương vị khác; không nên coi câu hỏi đó là cam kết
cửa hàng đang có hàng tương ứng.

Lượt 5 trả lời:

> Hiện dữ liệu cửa hàng chưa đủ thông tin để xác nhận sản phẩm có phù hợp với mèo
> 6 tháng tuổi hay không. Bạn vui lòng kiểm tra kỹ thông tin trên nhãn sản phẩm hoặc
> hỏi bác sĩ thú y để được tư vấn chính xác nhé.

Response này có `products: []`, không tạo tên/giá/ID mới và không khẳng định phù
hợp độ tuổi. Logic kế thừa ID 3 được xác nhận riêng qua HTTP/MySQL + Gemini mock;
không có thẻ ID 3 trong response thật lượt 5 để tuyên bố model đã chọn lại ID đó.

Lượt 4 có lời văn tự nhiên, đưa cách vệ sinh/tráng bát và gợi ý chất liệu; được
gắn `general_knowledge`, không truy vấn sản phẩm. Câu hỏi tiếp về hạt/pate hơi lệch
trọng tâm vệ sinh. Một câu chăm sóc chưa đủ để đánh giá độ chính xác y khoa hoặc
độ hữu ích tổng quát; các phát biểu sức khỏe trong lời model chưa có nguồn độc lập.

## Thời gian từng công đoạn

Đơn vị **ms**, không phải giây. Cột context là CPU chuẩn bị nội dung/lịch sử;
cột load/save là các driver call MySQL. HTTP gồm thêm overhead loopback.

| Request | SQL sản phẩm | SQL load lịch sử/replay | Context/lịch sử | Gemini | Grounding | SQL lưu lịch sử | Tổng route | HTTP |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|1|4.009|2.317|2.728|7916.935|76.717|17.032|8041.264|8088|
|2|1.270|1.206|1.036|11476.297|45.405|15.922|11544.687|11562|
|3, bị từ chối|4.975|1.591|3.275|8853.008|59.889|16.940|8946.392|8962|
|4, chăm sóc|0|1.158|1.142|9076.590|35.483|14.250|9130.374|9158|
|5, thử thủ công|4.423|3.208|3.486|1610.666|41.749|7.694|1689.538|1725|
|Replay sau restart|0|1.419|0|0|0|0|15.938|40|

Tổng SQL năm request lần lượt: 24.627 / 18.869 / 24.012 / 15.709 / 16.134ms.
Chờ kết nối/GET_LOCK: 10.540 / 0.700 / 0.831 / 0.712 / 10.077ms.
Thả lock SQL: 1.270 / 0.470 / 0.506 / 0.302 / 0.807ms. Đây là các bucket riêng;
context/grounding thuộc processing residual, không cộng hai lần vào tổng.
Xem [CHAT_API.md](CHAT_API.md) để biết định nghĩa đầy đủ và cách bật metrics.

Gemini chiếm phần lớn độ trễ (1.61–11.48 giây); SQL chỉ khoảng 16–25ms.
Thời gian HTTP trong mẫu này 1.725–11.562 giây, nhưng không phải benchmark A/B
với đợt 4–31 giây trước. Không đủ dữ liệu để kết luận mức cải thiện do rút prompt,
cache client, thay guard hay biến thiên dịch vụ. Giữ timeout hiện tại; Frontend
sau này cần trạng thái đang xử lý và phân biệt fallback/lỗi có thể thử lại.

## Lưu/khôi phục và bảo toàn dữ liệu

- Process mới có PID khác, dùng lại capability chỉ giữ trong bộ nhớ evaluator.
  DB giữ đủ 4 row của hai lượt đầu trước và sau restart.
- Replay cùng request UUID, nội dung và session trả đúng response cũ, không thêm
  row, không gọi Gemini; 40ms HTTP, `gemini_ms=0`, `mysql_history_save_ms=0`.
- Lượt 3 tiếp tục được xử lý sau restart. Test MySQL + mock riêng còn kiểm tra
  lịch sử đầu vào thực sự có các lượt cũ/ID đã chọn, guest/User isolation và emoji.
- DB chỉ lưu SHA256 của token phiên; báo cáo/console không chứa token. Giữ cùng
  JWT_SECRET khi restart là điều kiện để token đã ký tiếp tục có hiệu lực.
- Đã dọn đúng phiên thử sau 5 request. Hash toàn bộ sản phẩm/danh mục trước/sau
  trùng nhau (`catalog_unchanged=true`): 21 sản phẩm, 5 danh mục được giữ nguyên.
  Các fixture tài khoản/giỏ/đơn/thanh toán/đánh giá trong hồi quy cũng được dọn.

## Test thực sự đã chạy

Sau bản sửa cuối, từ `backend` trên PowerShell:

```powershell
$env:UC13_LIVE_DB_TEST = '1'
npm.cmd test
```

**306 đạt, 0 thất bại, 0 skip; 19 file; khoảng 17.937 giây.** Bao gồm test Chatbot,
grounding, SDK serialization, timing/privacy, hội thoại, lưu/khôi phục qua process
restart; và hồi quy auth, cart, catalog, orders, payments, admin orders/users,
reviews. Các test này không gọi Gemini thật. Có cả unit/protocol mock và tích hợp
HTTP/MySQL thật, không đánh đồng hai loại. Riêng guard mới 87 test; metrics 10;
restart/diagnostics/budget 5 test (gồm 1 restart với MySQL thật và Gemini mock).

Lệnh `npm test` trong sandbox Windows bị `spawn EPERM` trước khi chạy test;
đã chạy lại ngoài sandbox và lấy kết quả ở trên. Trong test giỏ, case sản phẩm
ngừng bán trên dữ liệu gốc không được kích hoạt vì cả 21 đang bán; các test catalog,
orders/reviews và mock kiểm tra ngừng bán bằng fixture/read injection riêng.
Không tuyên bố đã đổi trạng thái sản phẩm thật để thử.

## File tạo/sửa trong đợt này

- Logic: `ai/assistant.js`, `ai/products.js`, `ai/context.js`, `ai/prompt.js`,
  `ai/sessions.js`, `routes/chat.js`; mới `ai/grounding.js`, `ai/metrics.js`.
- Đánh giá: mới `scripts/chat-eval-worker.cjs`, `scripts/evaluate-chat-v2.cjs`,
  `ai/live-evaluation-v2.json`; counter riêng trong `backups/` (ignored).
- Test: sửa `tests/chatbot.test.js`; mới `tests/chat-grounding-v2.test.js`,
  `tests/chat-metrics.test.js`, `tests/chat-restart.test.js`.
- Tài liệu/cấu hình mẫu: `ai/README.md`, `ai/CHAT_API.md`, báo cáo này,
  `.env.example` thêm `CHAT_METRICS=0`. Không ghi secret thật hoặc sửa `.env`.

## Điều kiện tích hợp Frontend và phần còn thiếu

**Đủ để bắt đầu tích hợp Frontend trong môi trường thử nghiệm có kiểm soát.**
Contract API, ownership, persistence/replay/restart và grounding thẻ sản phẩm đã có
test/evidence. Frontend cần giữ kín session token, gửi UUID ổn định khi retry, hiển
thị thẻ từ `products`, và xử lý loading/fallback/rate limit theo CHAT_API.

Chưa đủ bằng chứng để coi chất lượng hội thoại và độ trễ ổn định cho triển khai
diện rộng: chuỗi ba câu đầu vẫn có một lần fallback. Guard regex còn false
positive/negative, nhất là tên bịa chữ thường và công dụng diễn đạt khác; giá mơ hồ
hoặc tên rút gọn vẫn bị chặn bảo thủ. Cần đánh giá thêm theo quota được cấp, bổ sung
phân loại mã guard cụ thể hơn mà không lưu nội dung nhạy cảm, đo p50/p95 thực tế,
và chấm chất lượng câu hỏi tiếp/chăm sóc bởi người có chuyên môn. Không gọi thêm
Gemini trong đợt này. Quota theo process, thiếu index/lifecycle lịch sử lớn và retry
khi mất response đầu chưa nhận token vẫn là các giới hạn đã ghi ở CHAT_API/README.
