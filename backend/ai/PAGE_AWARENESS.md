# Bước 4 — Page, UI & State Awareness

Chatbot nhận biết trang chủ, danh sách/tìm kiếm/lọc sản phẩm, chi tiết sản phẩm,
giỏ hàng, checkout, đăng nhập/đăng ký, hồ sơ, danh sách/chi tiết đơn, viết/đọc
đánh giá và yêu thích. Giữ giao diện hiện có; widget được phép xuất hiện trên
đăng nhập/đăng ký và tiếp tục bị ẩn với Admin hoặc `/admin/*`.

## Luồng tích hợp

1. `ChatPageProvider` đọc Commerce Context và nhận các cờ từ chính component đang
   render giao diện. `ChatbotWidget` lấy snapshot mới lúc gửi/thử lại; không ghi
   snapshot vào transcript hoặc bộ nhớ trình duyệt. Liên kết hiện có và cơ chế
   khôi phục phiên tiếp tục giữ lịch sử khi chuyển trang.
2. `POST /api/chat` nhận thêm `page_context` tùy chọn, giới hạn 4096 byte và lọc
   theo route/trường/kiểu. Không gửi query tìm kiếm, giá trị form, hồ sơ, token,
   giỏ chi tiết hay thông tin thanh toán; chỉ có lựa chọn COD/ONLINE dạng enum.
3. Backend lấy danh tính từ middleware hiện có, kiểm tra sản phẩm qua repository
   và đọc đơn bằng `order.get(userId, orderId)`. Chỉ giữ ID, trạng thái và
   `can_cancel` đã xác minh; đánh giá kiểm tra đơn đã giao, sản phẩm thuộc đơn
   và đánh giá đã tồn tại. Lỗi/không thuộc chủ đơn không tiết lộ dữ liệu.
4. Orchestrator Bước 1 nhận `current_page` riêng từng lượt, vẫn dùng tool calling
   và `get_website_guide` của Bước 3. Guard câu trả lời đối chiếu tên chức năng,
   nút ẩn/khóa và quyền hủy. Product Tools vẫn kiểm chứng giá/tồn/tư vấn sản phẩm.
5. Memory Core Bước 2 tiếp tục lưu hội thoại và thông tin thú cưng như trước;
   snapshot không được lưu vào facts/checkpoint. Prompt cấm đưa trạng thái tạm
   vào summary; Orchestrator chặn các khóa fact trạng thái tạm. Trạng thái ở
   lịch sử không được dùng làm bằng chứng hiện tại.

Không có chuyển trang thông minh, tự bấm nút hoặc thao tác nghiệp vụ. Không đổi
schema, migration, xác thực, phân quyền hoặc quy tắc đơn/thanh toán/voucher/tồn.

## Bật và mở rộng

Chạy backend với `CHAT_PIPELINE=orchestrator` rồi khởi động lại tiến trình backend.
Mặc định của module cấu hình vẫn là legacy khi bỏ trống để giữ tương thích;
`CHAT_PIPELINE=legacy` vẫn dùng pipeline cũ và bỏ qua ngữ cảnh đã kiểm tra.
`backend/.env.example` dùng orchestrator cho Bước 1–4.

Thêm trang/trạng thái mới bằng cách cập nhật allowlist trong
`frontend/src/utils/chat-page-context.js` và `backend/ai/page-context.js`, rồi
gọi `useChatPageState` từ component sở hữu state. Sửa hướng dẫn tương ứng trong
Website Knowledge khi chức năng đổi. Không lấy nội dung từ DOM hay gửi toàn bộ
state/form. Không khai báo quyền nghiệp vụ trong frontend làm bằng chứng.

## File thêm/sửa của Bước 4

Thêm:

- `backend/ai/page-context.js`
- `backend/ai/PAGE_AWARENESS.md`
- `backend/tests/chat-page-context.test.js`
- `frontend/src/context/ChatPageContext.jsx`
- `frontend/src/utils/chat-page-context.js`
- `frontend/tests/chat-page-context.test.js`

Sửa:

- `backend/.env` — chỉ thêm/cập nhật `CHAT_PIPELINE=orchestrator` cục bộ.
- `backend/.env.example`
- `backend/routes/chat.js`
- `backend/ai/orchestrator.js`
- `backend/ai/orchestrator-prompt.js`
- `backend/ai/grounding.js`
- `backend/ai/website-knowledge.js`
- `backend/ai/website-knowledge-data.js`
- `backend/ai/CHAT_API.md`
- `frontend/src/main.jsx`
- `frontend/src/App.jsx`
- `frontend/src/components/ChatbotWidget.jsx`
- `frontend/src/components/ProductSection.jsx`
- `frontend/src/services/chat.js`
- `frontend/src/pages/AuthPage.jsx`
- `frontend/src/pages/ProductDetailPage.jsx`
- `frontend/src/pages/CheckoutPage.jsx`
- `frontend/src/pages/MyOrdersPage.jsx`
- `frontend/src/pages/OrderDetailPage.jsx`
- `frontend/src/pages/ProfilePage.jsx`
- `frontend/src/pages/ProductReviewPage.jsx`
- `frontend/src/pages/ProductReviewsPage.jsx`
- `frontend/src/pages/WishlistPage.jsx`

Các chỉnh sửa/xóa file có sẵn trước khi bắt đầu không thuộc danh sách này.

## Kiểm tra và giới hạn

- Build Vite thành công (còn cảnh báo kích thước bundle trên 500 kB).
- Kiểm tra offline Bước 4, Website Knowledge và route API: 23/23 qua; API mới/cũ, replay,
  JWT/Admin, giới hạn dữ liệu, chủ đơn, quyền hủy và snapshot tạm đều được kiểm tra.
- Frontend: 32/32 kiểm tra qua cho ngữ cảnh, API client, recovery và phiên auth.
- Hai bộ hồi quy `chat-orchestrator.test.js`, `chat-pipeline-route.test.js` có
  22 lỗi có sẵn; chạy đối chiếu cùng mã từ Git HEAD cũng 40 qua / 22 lỗi.
  Phần lớn fixture sản phẩm thiếu `pet_types`, kèm kỳ vọng cũ về lỗi memory.
  Không sửa các fixture/nghiệp vụ ngoài phạm vi Bước 4.
- Không gọi Gemini thật, không chạy kiểm thử UX/Playwright hoặc migration.
  Trải nghiệm ngôn ngữ và dữ liệu thật trên website chờ người dùng kiểm tra.
- Không commit/push. Sau khi khởi động lại backend, người dùng xác nhận kết quả.
