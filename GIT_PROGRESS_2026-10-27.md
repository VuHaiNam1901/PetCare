# PetCareShop — kiểm kê và bảo toàn tiến độ 27/10/2026

Đây là snapshot tiến độ ngày 27/10; commit dùng ngày thực tế của máy, không sửa ngày hoặc viết lại lịch sử Git. Không sửa logic Backend/Frontend, schema hay dữ liệu MySQL trong đợt dọn này. Không gọi Gemini thật.

## Phân loại và dọn dẹp

- Ban đầu: branch main đồng bộ origin/main; 3 file tracked (.gitignore, LICENSE, README.md), 129 file untracked cần bảo tồn. Chưa có source dự án trong commit chính ngoài ba file đó.
- Giữ source, package-lock, 2 migration, toàn bộ test, tài liệu Backend Chatbot mới nhất, FRONTEND_AUDIT.md và ảnh nguồn.
- Đã xóa duy nhất frontend/dist: 26 file, 897.774 byte. Đây là Vite build output; đã build lại thành công trước khi xóa. Đã kiểm tra đường dẫn tuyệt đối nằm trong workspace, không có tracked file/reparse point. Ảnh nguồn trong frontend/public giữ nguyên.
- Giữ node_modules local, không commit. Giữ frontend/test-results vì có ảnh desktop/mobile làm bằng chứng; không commit.
- Giữ toàn bộ backend/backups local, không commit: backup SQL/manifest UC14/UC18 và bộ đếm đợt Gemini đã dùng đủ 5 lượt. Không xóa backup hoặc đặt lại counter.
- Giữ cả ai/QUALITY_REPORT.md và QUALITY_REPORT_V2.md, live-evaluation.json và live-evaluation-v2.json, hai script evaluate-chat: bằng chứng các đợt khác nhau, không tự coi là trùng.
- Giữ cả 5 file image-migration/archive/final-20261017 (REPORT, final-plan, manifest, mapping, original-products): script/test ảnh còn tham chiếu và có giá trị khôi phục. REPORT cũ có PENDING/đường dẫn workspace cũ; chưa sửa/xóa vì là bằng chứng lịch sử.
- Không dùng git clean, reset --hard, xóa hàng loạt source, force push hoặc sửa lịch sử.

## Ignore và kiểm tra bí mật

- Bổ sung root .gitignore cho .env/.env.*, dist/, test-results/, playwright-report/, coverage/, backups/; giữ quy tắc node_modules và log. Cho phép .env.example an toàn; thêm ngoại lệ tương ứng ở frontend/.gitignore.
- Kiểm tra .env, các biến thể môi trường, node_modules, build/test output, log và backup bị loại khỏi index. .env.example, migration, tài liệu và FRONTEND_AUDIT.md không bị bỏ nhầm.
- Quét 132 file dự kiến theo dõi ban đầu và 135 phiên bản blob trong toàn bộ refs Git (gồm main và checkpoint local): không tìm thấy Gemini API key, JWT/session token, private key, URI có credential hoặc các giá trị GEMINI_API_KEY/JWT_SECRET/DB_PASSWORD thực tế lấy từ .env. Không in giá trị bí mật.
- Hai literal assignment ở tests/auth.test.js:36,45 được review riêng: chỉ là mật khẩu không hợp lệ/sai để kiểm tra HTTP400/401, không phải credential thật. Fixture dùng tài khoản thử ngẫu nhiên và dọn trong finally.
- backend/.env và SQL backup có thể chứa thông tin nhạy cảm: giữ local ignored, không đưa vào commit. URL remote origin không nhúng credential. File quét tạm ở thư mục TEMP hệ thống không thuộc commit.
- Quét bổ sung nội dung chính xác 133 file trong index trước commit: không phát hiện bí mật; hai mẫu mật khẩu thử được phân loại như trên. Kiểm tra lại commit trước push. Đây là kiểm tra theo giá trị thực tế/mẫu nhận diện và review, không phải bảo đảm tìm mọi loại bí mật có thể có.

## Xác minh đã chạy trong đợt này

- 9 file test Chatbot offline, mỗi file trong Node process riêng, UC13_LIVE_DB_TEST=0, DOTENV_CONFIG_QUIET=true: 295 test, 293 pass, 0 fail, 2 skip (hai case yêu cầu MySQL thật).
- Các file: chatbot.test.js; chatbot-sdk.test.js; chat-search.test.js; chat-quality.test.js; chat-grounding-v2.test.js; chat-live-regression.test.js; chat-metrics.test.js; chat-route.test.js; chat-restart.test.js.
- Lệnh từng file: node --test --test-isolation=none --test-reporter=tap tests/<file>.
- Test protocol/SDK dùng mock, không gọi Gemini thật, không execute query lên MySQL thật. Counter fixture riêng của test restart được tạo và dọn tự động.
- Không chạy npm test Backend vì các suite nghiệp vụ có ghi MySQL. Số 306 pass trong QUALITY_REPORT_V2.md là kết quả đợt UC13 trước, không đánh đồng với lần kiểm tra chỉ offline này.
- Frontend: npm.cmd run build thành công với Vite8.3.4, 1934 modules. Không chạy e2e cần Backend thật; không cài package. Dist sau build đã dọn như trên.
- Git diff phát hiện một dòng trắng dư cuối backend/scripts/product-images.cjs; chỉ bỏ dòng trắng đó, không đổi logic. Kiểm tra cú pháp script, không thực thi script thao tác dữ liệu.
- Sandbox ban đầu chặn Node spawn EPERM và .git/FETCH_HEAD; các bước build/scan/fetch đã chạy lại với quyền phù hợp. Fetch origin thành công, HEAD...origin/main = 0/0 trước commit.

## Danh sách file đưa vào snapshot

Bao gồm source Backend/Frontend hiện có chưa từng được commit, không chỉ riêng bản vá chatbot cuối. LICENSE và README.md đã tracked từ trước, không thay đổi. Danh sách dưới đây gồm .gitignore sửa và các file mới; hash commit/kết quả push được báo trong phản hồi cuối.

- `.gitignore`
- `backend/.env.example`
- `backend/.gitignore`
- `backend/ADMIN_ORDERS.md`
- `backend/ADMIN_USERS.md`
- `backend/ai/assistant.js`
- `backend/ai/CHAT_API.md`
- `backend/ai/context.js`
- `backend/ai/evaluation-questions.json`
- `backend/ai/grounding.js`
- `backend/ai/live-evaluation.json`
- `backend/ai/live-evaluation-v2.json`
- `backend/ai/metrics.js`
- `backend/ai/products.js`
- `backend/ai/prompt.js`
- `backend/ai/QUALITY_REPORT.md`
- `backend/ai/QUALITY_REPORT_V2.md`
- `backend/ai/rate-limit.js`
- `backend/ai/README.md`
- `backend/ai/sessions.js`
- `backend/AUTH.md`
- `backend/CART.md`
- `backend/CATALOG.md`
- `backend/config/auth.js`
- `backend/config/db.js`
- `backend/config/gemini.js`
- `backend/middleware/auth.js`
- `backend/migrations/001-admin-orders.js`
- `backend/migrations/002-reviews-unique.js`
- `backend/models/admin-order.js`
- `backend/models/admin-user.js`
- `backend/models/cart.js`
- `backend/models/catalog.js`
- `backend/models/order.js`
- `backend/models/payment.js`
- `backend/models/review.js`
- `backend/models/user.js`
- `backend/ORDERS.md`
- `backend/package.json`
- `backend/package-lock.json`
- `backend/PAYMENTS.md`
- `backend/REVIEWS.md`
- `backend/routes/admin-catalog.js`
- `backend/routes/admin-orders.js`
- `backend/routes/admin-users.js`
- `backend/routes/auth.js`
- `backend/routes/cart.js`
- `backend/routes/chat.js`
- `backend/routes/orders.js`
- `backend/routes/payments.js`
- `backend/routes/reviews.js`
- `backend/scripts/chat-eval-worker.cjs`
- `backend/scripts/evaluate-chat.cjs`
- `backend/scripts/evaluate-chat-v2.cjs`
- `backend/scripts/product-images.cjs`
- `backend/scripts/test-gemini.cjs`
- `backend/server.js`
- `backend/tests/admin-orders.test.js`
- `backend/tests/admin-users.test.js`
- `backend/tests/auth.test.js`
- `backend/tests/cart.test.js`
- `backend/tests/catalog.test.js`
- `backend/tests/chatbot.test.js`
- `backend/tests/chatbot-sdk.test.js`
- `backend/tests/chat-conversation.test.js`
- `backend/tests/chat-db.test.js`
- `backend/tests/chat-grounding-v2.test.js`
- `backend/tests/chat-live-regression.test.js`
- `backend/tests/chat-metrics.test.js`
- `backend/tests/chat-quality.test.js`
- `backend/tests/chat-restart.test.js`
- `backend/tests/chat-route.test.js`
- `backend/tests/chat-search.test.js`
- `backend/tests/orders.test.js`
- `backend/tests/payments.test.js`
- `backend/tests/reviews.test.js`
- `frontend/.gitignore`
- `frontend/index.html`
- `frontend/package.json`
- `frontend/package-lock.json`
- `frontend/playwright.config.js`
- `frontend/public/favicon.svg`
- `frontend/public/images/hero-dog.jpg`
- `frontend/public/images/products/10-royal-canin-fussy-exigent-cho-meo-2kg.webp`
- `frontend/public/images/products/11-keos-digestive-care-lamb-rice-cho-cho-1-5kg.webp`
- `frontend/public/images/products/12-cattyman-toys-can-cau-chuot-long-tho-duoi-dai.webp`
- `frontend/public/images/products/13-afp-pups-candy-chew-do-choi-can-gam-keo-xoan-cho-cho.webp`
- `frontend/public/images/products/14-thung-dung-thuc-an-royal-canin-2kg-hinh-meo-m2.webp`
- `frontend/public/images/products/15-petsmix-scoop-m2-xeng-ve-sinh-meo-13x16cm.webp`
- `frontend/public/images/products/16-kit-cat-5in1-cat-wipes-khan-uot-80-mieng.webp`
- `frontend/public/images/products/17-tropiclean-oral-care-clean-teeth-gel-rang-mieng-59ml.webp`
- `frontend/public/images/products/18-sonice-high-sided-scoop-xeng-ve-sinh-21x10cm.webp`
- `frontend/public/images/products/19-shed-x-dau-ca-cho-cho-473ml.webp`
- `frontend/public/images/products/1-me-o-tuna-thuc-an-hat-cho-meo-vi-ca-ngu-1-2kg.webp`
- `frontend/public/images/products/20-shed-x-dau-ca-cho-meo-237ml.webp`
- `frontend/public/images/products/21-shed-x-dau-ca-cho-cho-giong-nho-237ml.webp`
- `frontend/public/images/products/2-royal-canin-satiety-weight-management-feline-1-5kg.webp`
- `frontend/public/images/products/3-nekko-jelly-pate-meo-70g.webp`
- `frontend/public/images/products/4-cat-eye-thuc-an-hat-cho-meo-1-5kg.webp`
- `frontend/public/images/products/5-tellme-xuc-xich-thit-heo-ca-rot-cho-cho-85g.webp`
- `frontend/public/images/products/6-tellme-gan-bo-say-cho-cho-meo-75g.webp`
- `frontend/public/images/products/7-tellme-thanh-gam-da-heo-cho-cho-130g.webp`
- `frontend/public/images/products/8-nutrience-infusion-adult-small-breed-thit-ga-rau-cu-2-27kg.webp`
- `frontend/public/images/products/9-tellme-chicken-jerky-ga-say-cho-meo-40g.webp`
- `frontend/README.md`
- `frontend/src/App.jsx`
- `frontend/src/components/AboutSection.jsx`
- `frontend/src/components/Brand.jsx`
- `frontend/src/components/CareHighlights.jsx`
- `frontend/src/components/CategorySection.jsx`
- `frontend/src/components/Feedback.jsx`
- `frontend/src/components/Footer.jsx`
- `frontend/src/components/Header.jsx`
- `frontend/src/components/Hero.jsx`
- `frontend/src/components/ProductCard.jsx`
- `frontend/src/components/ProductSection.jsx`
- `frontend/src/hooks/useApiList.js`
- `frontend/src/main.jsx`
- `frontend/src/services/api.js`
- `frontend/src/styles.css`
- `frontend/src/utils/catalog.js`
- `frontend/tests/catalog.spec.js`
- `frontend/tests/product-images.spec.js`
- `frontend/vite.config.js`
- `FRONTEND_AUDIT.md`
- `GIT_PROGRESS_2026-10-27.md`
- `image-migration/archive/final-20261017/final-plan.json`
- `image-migration/archive/final-20261017/manifest.json`
- `image-migration/archive/final-20261017/mapping.csv`
- `image-migration/archive/final-20261017/original-products.json`
- `image-migration/archive/final-20261017/REPORT.md`
