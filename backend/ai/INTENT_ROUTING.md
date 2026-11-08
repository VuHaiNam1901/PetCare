# Định tuyến ý định chatbot

Phạm vi: sửa nhận diện/định tuyến và câu trả lời dữ kiện; chưa triển khai fallback
thay Gemini khi provider lỗi. Frontend, route/session/idempotency, cấu hình
Gemini và grounding giữ nguyên cơ chế hiện có.

## Luồng xử lý

`prepareInput → classifyIntent → inferSearch/resolvedSearch → repository → assistant → response`

| Intent | Dữ liệu | Cách trả lời |
| --- | --- | --- |
| `catalog_overview`, `category_list` | Repository gọi lại `models/catalog.listCategories()` | Liệt kê tên danh mục thực tế, không gọi Gemini |
| `clarification` | Không truy xuất catalog | Hỏi làm rõ nhu cầu |
| `out_of_scope` | Không truy xuất catalog | Nêu phạm vi hỗ trợ, không khẳng định cửa hàng có/không bán hàng chưa xác minh |
| `compare` thiếu đối tượng | Không truy xuất catalog | Hỏi tên sản phẩm cần so sánh |
| Tham chiếu sản phẩm chưa xác định | Không truy xuất catalog | Hỏi sản phẩm nào |
| `price_stock` rõ ràng | Catalog, có thể gồm hàng hết tồn | Trả thẻ đã qua kiểm ID/ngân sách/grounding, không gọi Gemini |
| `price_stock` kèm tư vấn | Catalog | Gemini + grounding |
| `care` | Lịch sử đã làm sạch, không catalog | Gemini + grounding |
| Tìm kiếm/tư vấn/so sánh có đủ đối tượng | Catalog đã lọc và xếp hạng | Gemini + grounding |
| Khẩn cấp thú y | Không catalog | Mẫu chuyển bác sĩ hiện có, không Gemini |
| Tìm sản phẩm cụ thể không khớp | Catalog rỗng | `NO_PRODUCTS`, không tự tạo sản phẩm |
| Catalog lỗi | Không có dữ liệu đã xác minh | `CATALOG_UNAVAILABLE`; route trả lỗi như trước |

Từ xưng hô `shop/ơi/nhỉ` không tự quyết định ý định mua hàng. Quy tắc vẫn dùng
chuẩn hóa để hỗ trợ không dấu, đồng thời giữ tín hiệu dấu tiếng Việt và ngữ cảnh
để phân biệt già/giá, tầm/tắm, số tiền và tần suất chăm sóc. Câu chỉ có ngân sách
có thể kế thừa truy vấn trước; so sánh có đối tượng mới không dùng lại ID cũ.

Điều kiện sản phẩm cụ thể (loài, loại hàng, ngân sách hoặc bộ lọc) được xét trước
câu tổng quan/danh mục. `đồ/do dùng`, `đồ/do chơi` không phải tham chiếu `đó`.
Số lần, tuổi, khối lượng và khoảng như `từ 2 đến 3 lần` không tạo bộ lọc tiền;
`tầm giá 100k` vẫn là ngân sách. Tên `sữa tắm/cát vệ sinh` đứng riêng hoặc hỏi
giá không tự biến thành chăm sóc; câu hỏi cách dùng/thay/tần suất vẫn đi nhánh
chăm sóc. `phù hợp` trong một nhu cầu mới không tự kéo ID của lượt trước.

## Danh mục và ranh giới dữ liệu

Repository tái dùng model chỉ đọc danh mục qua lazy import, không sửa model
catalog hoặc tạo truy vấn SQL danh mục thứ hai. Khi test đã inject `db`, phải
inject thêm `categoryReader`; thiếu seam này sẽ trả lỗi catalog thay vì mở pool
thật. Danh sách/tên danh mục và response được giới hạn kích thước; nhãn chứa
markup, URL, PII hoặc chỉ dẫn nhạy cảm không được ghép vào câu trả lời.

Các thẻ sản phẩm vẫn dùng dữ liệu catalog; không chuyển tên/giá/tồn do Gemini
tự tạo thành dữ kiện. Câu trả lời danh mục chỉ mô tả nhóm có trong dữ liệu, không
cam kết mỗi nhóm đang có hàng hoặc toàn bộ danh mục đều nằm trong danh sách bị
giới hạn.

## Tương thích

Không thêm trường bắt buộc hoặc mode mới: vẫn `product`/`care` và
`message/products/follow_up/warnings/code`. Các câu trả lời xác định dùng
`code: OK`; các mã lỗi hiện có giữ nguyên. `intent` có thêm nhãn, vẫn là string.
Trường optional `model` chỉ có khi generate thành công qua grounding. Metadata
`context_search` vẫn chỉ dùng nội bộ và không ghi một bộ lọc rỗng cho câu hỏi làm
rõ, chăm sóc hay tổng quan. Lịch sử cũ có metadata rỗng được bỏ qua khi kế thừa
bộ lọc.

## Kiểm thử an toàn

Từ thư mục `backend`:

```powershell
npm.cmd run test:chat
```

Trên hệ khác có thể dùng `npm run test:chat`, hoặc gọi trực tiếp
`node scripts/run-chat-tests.cjs`. Runner chạy toàn bộ 12 file
`tests/chat*.test.js` trong một tiến trình; ép `UC13_LIVE_DB_TEST=0`, bỏ qua
4 test cần MySQL thật. Guard được nạp trước mọi test, chặn đọc `.env` qua
dotenv, tạo pool/kết nối MySQL, import migration và kết nối ngoài loopback;
bất kỳ lần cố gọi bị chặn nào cũng khiến runner thất bại, kể cả lỗi đã bị bắt.

Các bài còn lại dùng DB/category/Gemini stub. `chat-route.test.js` dùng HTTP
loopback, router/store thật và MySQL protocol fixture trong bộ nhớ. Test kiểm
cả response mới, lưu cặp tin, session và replay. Không chạy runner `npm test`
backend vì runner đó tạo database thử, đọc schema và chạy migration.

Test PASS xác nhận luồng và nội dung với dữ liệu tổng hợp, không chứng minh hàng
thật tồn tại hoặc chất lượng ngôn ngữ Gemini thật. Chưa xác minh kết nối Gemini
thật/MySQL thật trong bước này. Không chạy migration hoặc thay đổi `.env`.
Kết quả và bằng chứng của lần hoàn thiện ngày 07/11/2026 được ghi tại
[INTENT_ROUTING_VERIFICATION.md](INTENT_ROUTING_VERIFICATION.md).

Nhận diện vẫn dựa trên quy tắc, có giới hạn với câu đa nghĩa, tên hàng chưa biết
và cách diễn đạt mới; cần tiếp tục thêm regression từ tình huống sử dụng thực tế.
