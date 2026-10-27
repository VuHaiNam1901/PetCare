# Kết quả kiểm thử UC13

## File thay đổi

- Cập nhật: `ai/products.js`, `ai/context.js`, `ai/prompt.js`, `ai/assistant.js`,
  `ai/README.md`, `server.js`, `.env.example`, `tests/chatbot.test.js`,
  `tests/chatbot-sdk.test.js`.
- Tạo: `ai/sessions.js`, `ai/rate-limit.js`, `routes/chat.js`,
  `scripts/evaluate-chat.cjs`, `ai/CHAT_API.md`, `ai/QUALITY_REPORT.md`,
  `ai/evaluation-questions.json`, `ai/live-evaluation.json`.
- Test mới: `tests/chat-search.test.js`, `tests/chat-quality.test.js`,
  `tests/chat-route.test.js`, `tests/chat-db.test.js`,
  `tests/chat-conversation.test.js`, `tests/chat-live-regression.test.js`.

API mới: `POST /api/chat`. Không migration, không sửa Frontend hoặc API nghiệp vụ
cũ. Cấu hình/model kết nối trong `config/gemini.js` giữ nguyên; chat nâng riêng
giới hạn output lên 1024 tokens, còn script kiểm tra kết nối giữ 512.

## Kiểm thử logic và dữ liệu

Đã chạy **202 test đạt**: 195 test AI trên 8 file và 7 test hồi quy nghiệp vụ cũ.
Phần AI gồm chatbot 117, chất lượng mock 39, truy xuất 23, SDK offline 1,
route 11, lưu phiên MySQL thật 1, hội thoại HTTP/MySQL nhiều lượt 1 và hồi quy
ngân sách từ phản hồi Gemini thật 2. Các test AI đều được chạy lại sau bản sửa cuối.
Không chạy lại auth.test.js ở lượt này; đã kiểm tra JWT/quyền/khóa tài khoản
trong các test route và hồi quy nghiệp vụ. Đây không phải tuyên bố toàn bộ
`npm test` đã chạy trong một tiến trình.

MySQL thật được dùng để SELECT tìm kiếm và lưu/đọc/dọn lịch sử phiên thử.
Test phiên xác nhận emoji utf8mb3, guest/User, request gửi đồng thời và replay.
Test protocol MySQL mock kiểm tra rollback khi INSERT cặp thất bại. Catalog
và lịch sử thực tế có snapshot trước/sau; không mất dữ liệu gốc.

## Gemini thật: đúng 3 request, không retry/đổi model

Model giữ nguyên `gemini-3.5-flash-lite`. File [live-evaluation.json](live-evaluation.json) ghi đầy đủ
câu hỏi, response cuối, mã và thời gian; không lưu APIKey/sessiontoken/prompt.
Do guard từ chối lượt đầu, script dừng sớm; các lượt sau kiểm tra lại cùng câu
“Shop có thức ăn cho mèo dưới 200k không?” thay vì tiếp tục hội thoại nhiều lượt.

| Lượt | Thời gian | Kết quả |
|---|---:|---|
|1|4.066 giây|GROUNDING_REJECTED, API trả fallback an toàn; chưa thu chẩn đoán guard|
|2|21.334 giây|Model nhắc lại ngân sách 200k trong prose; guard chặn “Generated commercial facts”|
|3|30.866 giây|OK sau sửa kiểm tra ngân sách và nhắc rõ trong prompt|

Lượt 2, lời model: “Dạ nhà mình có nhiều loại thức ăn cho mèo dưới 200k rất phù
hợp để boss nhâm nhi mỗi ngày ạ. Bạn có thể tham khảo các lựa chọn bên dưới nhé.”
Guard cũ không phân biệt ngân sách người hỏi với giá sản phẩm. Bản sửa kiểm tra
ngân sách có khớp bộ lọc Backend rồi thay phần số bằng “trong ngân sách bạn đã
nêu”; số tiền khác vẫn bị chặn. Có 2 test hồi quy riêng cho điểm này.

Lượt 3, response được chấp nhận:

> Chào bạn, cửa hàng có nhiều loại thức ăn cho mèo phù hợp trong ngân sách bạn
> đã nêu. Bạn có thể tham khảo các lựa chọn bên dưới nhé.

Câu hỏi thêm: “Bạn muốn tìm thức ăn dạng hạt hay pate cho bé mèo nhà mình?”
Các thẻ do Backend lấy từ MySQL:

- ME-O Tuna: 152900.00, tồn 30.
- CAT EYE: 199000.00, tồn 20.
- NEKKO Jelly pate: 18000.00, tồn 20.

Lượt1 fallback: “Mình chưa thể xác nhận gợi ý vừa nhận được. Bạn cho biết rõ
hơn nhu cầu để mình đối chiếu lại với dữ liệu cửa hàng nhé.” Lượt2 trả cùng
fallback, không đưa draft bị từ chối thành sản phẩm hay lời tư vấn công khai.

## Đánh giá thực tế và giới hạn

Lượt 3 đáp ứng câu hỏi mua hàng cơ bản, tách thông tin thật và lời tư vấn. Tuy
nhiên 3 lượt đều xoay quanh một câu, không đủ để kết luận chất lượng hội thoại
nhiều lượt, kiến thức chăm sóc hay độ an toàn tổng quát. Các phần đó mới được
test logic bằng mock với bộ 30 câu có rubric đánh giá thủ công riêng.

Độ trễ 4–31 giây và 2 lượt bị guard từ chối cho thấy còn cần tối ưu/đánh giá thêm.
Guard dựa trên quy tắc có falsepositive/negative; nội dung y khoa không phải
chẩn đoán. Không thể hứa xác minh tuyệt đối mọi câu tự do. Chưa kiểm thử thực
tế nhiều instance, proxy/IPquota phân tán hoặc lịch sử lớn. Lần gửi đầu bị mất
response trước khi nhận token còn có giới hạn retry đã nêu trong CHAT_API.md.

Không gọi thêm Gemini sau request 3. Đã dọn riêng toàn bộ lịch sử thử và xác nhận
21 sản phẩm/5 danh mục không đổi. Chưa có thay đổi schema hoặc Frontend.
