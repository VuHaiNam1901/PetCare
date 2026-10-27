# UC13 — Trợ lý PetCare

Backend có `POST /api/chat` cho khách và User đang hoạt động. Không sửa Frontend,
schema, sản phẩm/danh mục, đặt hàng hay thanh toán. Model vẫn là
`gemini-3.5-flash-lite`; API Key đọc từ `backend/.env`, không ghi vào log/lịch sử.

## Cấu trúc

- `products.js`: truy xuất MySQL, chuẩn hóa tiếng Việt, từ đồng nghĩa, xếp hạng,
  lọc và sắp xếp giá. Chỉ SELECT; model không tạo SQL.
- `context.js`: nhận diện ý định, ngân sách, tham chiếu lượt trước, giới hạn
  ngữ cảnh và nhận diện tình huống nguy hiểm có xét phủ định.
- `prompt.js`: System Prompt tiếng Việt và JSON schema ngắn, không ghép các câu
  mẫu để trả lời các lượt thành công.
- `assistant.js`: Gemini tạo lời tư vấn tự nhiên, ID sản phẩm, câu hỏi bổ sung và
  cảnh báo; Backend xác thực, tách thẻ sản phẩm và xử lý lỗi/fallback.
- `grounding.js`: kiểm tra schema, nguồn sản phẩm, ngân sách và lời văn;
  chuẩn hóa tên/giá đã xác minh về tham chiếu thẻ thay vì chặn nhầm.
- `metrics.js`: đo từng công đoạn theo request; mặc định không ghi log.
- `sessions.js`: token phiên 256-bit + HMAC ràng buộc User/khách, khóa theo phiên,
  lịch sử, idempotency và lưu cặp tin nhắn bằng transaction.
- `rate-limit.js`: giới hạn IP/phiên có cửa sổ thời gian và bộ nhớ hữu hạn.
- `../routes/chat.js`: optional JWT, validation, rate/concurrency limit,
  gọi assistant, lưu và trả response. Xem [CHAT_API.md](CHAT_API.md).
- `../config/gemini.js`: giữ nguyên model, timeout45s, attempts1 (không retry).
  Script kiểm tra kết nối giữ512 output tokens; chat dùng tối đa1024 để chứa
  lời tư vấn JSON tự nhiên. Không tự đổi model hoặc gọi thử model khác.

## Dữ liệu thực tế và tìm kiếm

`products`: product_id, category_id, name, description, price DECIMAL(12,2),
stock_quantity, image_url, status, created_at. `categories`: category_id, name,
description, created_at. `chat_histories`: chat_history_id, user_id(nullable),
message TEXT, sender, created_at, session_id VARCHAR(100). `user` giữ schema cũ.
Không có cột riêng xác minh thành phần, độ tuổi, giống hoặc chỉ định sức khỏe.

SQL cố định `status='Đang bán'`, các giá trị lọc có tham số. Mặc định chỉ tìm
hàng còn tồn. Riêng hỏi giá/tồn kho có thể trả thẻ hết hàng với `available:false`,
không giới thiệu như hàng sẵn có. Hàng ngừng bán luôn bị loại khỏi chatbot.
Đọc keyset theo trang64, giữ tối đa6 ứng viên tốt nhất trong bộ nhớ, không còn
giới hạn bỏ sót sau100 dòng. Với21 sản phẩm hiện tại chỉ cần một trang.

Tìm tên/từ khóa/danh mục có/không dấu, xử lý đ/Đ và các nhóm từ thông dụng như
hạt/thức ăn khô, pate/thức ăn ướt, snack/bánh thưởng, đồ chơi/toys, dầu cá/fish oil.
Chấm điểm tên > danh mục > mô tả, không ép mọi từ trong câu khớp cứng. Có chặn
loại sản phẩm trái yêu cầu, phụ kiện đựng thức ăn và loài đối lập khi có bằng
chứng văn bản rõ. Các thuộc tính này là đối chiếu từ văn bản, không xác nhận
phù hợp bệnh/giống/tuổi. Lỗi chính tả chỉ hỗ trợ tập từ đã khai báo.

Bộ lọc nội bộ: query,keywords,categoryId,category,minPrice,maxPrice,limit,
sort(relevance/price_asc/price_desc),productIds. Giá so sánh bằng cents/BigInt.
Ngân sách thông dụng: dưới200k, khoảng100–300nghìn, tối đa150000đ. Các cận là
bao gồm. Tìm rẻ nhất/đắt nhất mặc định chọn đúng một kết quả toàn bộ bộ lọc cũ.
Riêng “trong những loại đó” chỉ so sánh các ID vừa được giới thiệu.
“Loại đó”, “loại đầu tiên”, hỏi độ tuổi kế thừa ID/bộ lọc đã do Backend lưu;
không lấy lịch sử, SQL hoặc bộ lọc tùy ý từ HTTP client.

## Phản hồi tự nhiên và grounding

Gemini chỉ trả `{advice,product_ids,follow_up,warnings}`. Nội dung advice được
sinh mới theo câu hỏi/lịch sử, không chọn mã câu trả lời mẫu. Tối đa3 ID hợp lệ;
thẻ tên/giá/tồn/ảnh luôn dựng từ MySQL và nằm riêng trong `products`.

Các trường tự sinh tên/giá/stock/ảnh ngoài schema, ID lạ/lặp/quá3, JSON sai,
response bị chặn/cắt hoặc không STOP bị từ chối. Prose được kiểm tra cả advice,
follow_up và warnings để hạn chế bịa giá/tồn/thương hiệu, công dụng, tuổi/giống,
thành phần, chẩn đoán và thuốc/liều. Ngân sách được model nhắc lại chỉ được thay
bằng “trong ngân sách bạn đã nêu” khi khớp chính xác bộ lọc Backend; số tiền khác
vẫn bị từ chối. Chưa có schema bằng chứng chuyên sâu để xác minh mọi câu tự do:
guard dạng quy tắc có thể bỏ sót hoặc từ chối nhầm, không phải bằng chứng y khoa.
Tên đầy đủ khớp chính xác một sản phẩm đã chọn, cùng giá đúng trong cùng mệnh đề,
được đổi thành tham chiếu thẻ; giá sai hoặc không rõ gắn với sản phẩm nào vẫn bị
từ chối. Câu phủ định thiếu thông tin không bị coi là khẳng định phù hợp độ tuổi.

Product/user/history là JSON dữ liệu ở user content, tách khỏi systemInstruction;
không có công cụ SQL/giao dịch. Không đưa dữ liệu tài khoản/đơn hàng vào context.
Email, điện thoại và các mẫu token/khóa trong câu hỏi/lịch sử được che trước khi
gửi Gemini. Đây là lọc PII cơ bản, không bảo đảm phát hiện mọi cách viết địa chỉ.

Context: tối đa6 sản phẩm, mô tả800ký tự, câu hỏi2000Unicode codepoints, lịch sử
tối đa8 tin/400ký tự mỗi tin và2400bytes, tổng JSON16KB. Tin nhắn cũ bị bỏ trước
khi phải giảm sản phẩm. ID bị cắt khỏi context không được model chọn.
URL ảnh chỉ có trong thẻ Backend, không gửi lên Gemini. SDK client dùng lại trong
mỗi tiến trình; model, timeout, attempts và giới hạn 1024 output tokens giữ nguyên.
Giá/tồn kho chỉ là snapshot tư vấn; đặt hàng vẫn kiểm tra lại theo nghiệp vụ cũ.

## Phiên, lưu trữ và ổn định

Không cần migration. `session_id` gửi client là capability87ký tự khó đoán,
ký bằng secret JWT hiện có và gắn với User/khách; DB chỉ lưu SHA256 của token.
Không thể dùng token phiên User dưới khách/tài khoản khác. Người giữ token khách
có quyền phiên đó: cần giữ bí mật, dùng HTTPS khi triển khai.

MySQL advisory lock tuần tự hóa từng phiên; không giữ transaction trong lúc chờ
Gemini. Sau khi có phản hồi hợp lệ mới INSERT hai tin và COMMIT cùng nhau. Lịch
sử dùng JSON envelope chứa request UUID/hash, response và metadata bộ lọc nội bộ;
sender là user/assistant. JSON escape Unicode để emoji hoạt động với utf8mb3.
Không thay đổi message cũ; có đọc tương thích tin plain-text/bot cũ.

UUID idempotency có phạm vi phiên. Gửi lại cùng token+UUID+tin nhắn trả response
cũ, không gọi Gemini/ghi thêm; đổi nội dung cùng UUID trả409. Nếu mất response
đầu tiên và chưa nhận được token, client không thể chứng minh cùng phiên; gửi
lại không token tạo phiên mới. Muốn giải quyết tuyệt đối cần quy trình tạo phiên
trước hoặc định danh khách bền vững ở bước tích hợp Frontend sau.

Mặc định10tin/phút/phiên,30/phút/IP, tối đa3 lượt đang xử lý để không cạn pool
MySQL10kết nối. Không tin X-Forwarded-For do client tự gửi. Giới hạn hiện theo
process; nhiều instance cần bộ đếm dùng chung. DB có lock theo phiên nhưng chưa
có index session_id; lượng chat lớn nên đánh giá migration index riêng.

Lỗi Gemini400/401/403/404/429/500/503 và timeout có mã nội bộ rõ, message tiếng
Việt an toàn; HTTP503/504 không lưu nửa lượt lỗi. Quota429 của ứng dụng có
Retry-After. Không retry tự động, không log key/rawerror/prompt. Mẫu fallback chỉ
dùng cho lỗi/không tìm thấy/đầu ra không đáng tin và tình huống khẩn cấp, không
thay thế nội dung tự nhiên khi Gemini trả hợp lệ.

Khẩn cấp có xét các phủ định thường dùng: “không khó thở” khác “không thở được”.
Vẫn không phải hệ thống chẩn đoán/phân loại cấp cứu đầy đủ. Tư vấn nghiêm trọng
ưu tiên bác sĩ thú y, không hướng dẫn thuốc người/đơn/liều.

## Kiểm thử và đánh giá

Từ `backend`, chạy riêng từng file để không cần tiến trình con của test runner:

    node --test --test-isolation=none tests/chatbot.test.js
    node --test --test-isolation=none tests/chat-quality.test.js
    node --test --test-isolation=none tests/chat-search.test.js
    node --test --test-isolation=none tests/chat-route.test.js
    node --test --test-isolation=none tests/chatbot-sdk.test.js
    node --test --test-isolation=none tests/chat-live-regression.test.js

Đặt `UC13_LIVE_DB_TEST=1` để bật phần SELECT MySQL thật trong chatbot.test.js,
test lưu phiên tại chat-db.test.js và hội thoại HTTP/MySQL tại chat-conversation.test.js.
Test phiên tạo rồi dọn đúng dữ liệu tạm,
không sửa21sản phẩm/5danh mục. Các test mock không gọi Gemini thật.
`evaluation-questions.json` có30câu tiếng Việt, tách expected_logic tự động và
manual_quality để người đánh giá chấm độ hữu ích/tự nhiên/đúng ngữ cảnh/an toàn.
Unit test qua không đồng nghĩa chatbot đã có chất lượng hội thoại thực tế tốt.

Đánh giá mới dùng `node scripts/evaluate-chat-v2.cjs --live --manual-retry`.
Script chạy bốn câu đã định, khởi động lại Backend giữa lượt 2 và 3, kiểm tra
replay không gọi model, rồi cho phép tối đa một lượt thứ năm do người chạy chọn.
Không retry tự động; dừng khi quota lỗi. Bộ đếm fsync trong `backups/` tồn tại qua
worker restart; không khởi chạy đợt mới để vượt hạn mức được cấp. Lưu kết quả tại
`live-evaluation-v2.json`; dọn riêng phiên thử và đối chiếu hash catalog.
Script/report cũ `evaluate-chat.cjs`/`live-evaluation.json` giữ làm bằng chứng đợt trước.
Report không chứa session token, API Key hoặc prompt. Xem file đó cho từng câu,
thời gian và phản hồi thực sự được chấp nhận/từ chối. Không suy rộng vài lượt
thành kết luận toàn bộ chatbot thông minh hoặc an toàn tuyệt đối.
Kết quả đợt trước tại [QUALITY_REPORT.md](QUALITY_REPORT.md); đợt mới tại
[QUALITY_REPORT_V2.md](QUALITY_REPORT_V2.md). Test restart với MySQL và model mock:
`UC13_LIVE_DB_TEST=1` rồi chạy `npm test`; cần cho phép Node tạo tiến trình con.

Đặt `CHAT_METRICS=1` khi cần log thời gian/mã cố định. Không log message, prompt,
API key, JWT, session token hoặc raw error. Xem định nghĩa các bucket trong CHAT_API.

## Hạn chế và bước tiếp

Intent/từ đồng nghĩa/phủ định còn là quy tắc, cần mở rộng bộ câu hỏi và đánh giá
người dùng thật. JSON bị cắt sẽ fallback; độ trễ phụ thuộc Gemini. Cần kiểm thử
hội thoại nhiều lượt và kiến thức chăm sóc đa dạng hơn sau khi được cấp quota.
Nên bổ sung bằng chứng sản phẩm có xác minh (độ tuổi/thành phần/loài) trong công
việc dữ liệu riêng; hiện không được suy diễn từ tên. Cần HTTPS, quota phân tán,
index/lifecycle lịch sử và chính sách bảo vệ/retention phù hợp khi đưa lên nhiều
instance; các hạng mục đó chưa được triển khai ở bước này.
