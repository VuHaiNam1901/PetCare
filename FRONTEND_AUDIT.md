# FRONTEND AUDIT — PetCareShop

Ngày kiểm tra: **27/10/2026**. Workspace: `D:\petcare-website\PetCare`.

## 1. Kết luận chính và phạm vi

Frontend hiện là **một trang landing/catalog React**, không phải ứng dụng bán hàng nhiều trang. Trong 16 giao diện được yêu cầu, đã có Trang chủ và phần Danh sách sản phẩm nằm ngay trên Trang chủ; **14 giao diện còn lại chưa có**, kể cả giao diện tĩnh cho các luồng đó.

Hai API đã tích hợp thực tế là **GET `/api/products` và GET `/api/categories`**. Sản phẩm, danh mục, giá và ảnh lấy qua Backend; không thấy danh sách sản phẩm mock dùng thay thế trong source chạy thật. Tìm kiếm/lọc/sắp xếp/tải thêm xử lý tại trình duyệt trên dữ liệu đã tải.

**Build production thành công; 14/14 test Playwright hiện có đạt.** Điều này xác nhận phạm vi landing/catalog đang hoạt động, không xác nhận các chức năng đăng nhập, mua hàng, Admin hay AI đã được tích hợp.

Đã đọc 16 file `frontend/src`, package/config/README/HTML/gitignore, cả hai file test; kiểm kê `public` và kiểm tra 21 ảnh qua test có sẵn. Có xem ảnh chụp desktop/mobile do test sinh. Không đọc nội dung `node_modules` để coi là source dự án. `dist` và `test-results` là đầu ra sinh tự động.

Không tìm thấy file Figma `.fig`/`.figma` hoặc file mockup được cung cấp trong các file dự án đã kiểm tra. Bảng dưới **chỉ đối chiếu danh sách 16 màn hình**, không kết luận màu sắc/bố cục hiện tại khớp Figma.

Chỉ tạo báo cáo này; không sửa source, cấu hình, Backend hoặc database, không cài package và không commit. Build cập nhật `frontend/dist`; test ghi artifact vào `frontend/test-results` theo cấu hình hiện có.

## 2. Cấu trúc Frontend thực tế

```text
frontend/
├── package.json / package-lock.json
├── index.html                  # lang=vi, viewport, metadata, favicon
├── vite.config.js              # React plugin, dev5173 / preview4173
├── playwright.config.js        # Chrome, dev server, 1 worker
├── README.md / .gitignore
├── public/
│   ├── favicon.svg
│   └── images/
│       ├── hero-dog.jpg
│       └── products/           # 21 file WebP
├── src/
│   ├── main.jsx                # React.StrictMode + createRoot
│   ├── App.jsx                 # một trang, tải hai collection
│   ├── styles.css              # CSS thuần + responsive
│   ├── components/
│   │   ├── Header.jsx / Brand.jsx / Hero.jsx
│   │   ├── CareHighlights.jsx / CategorySection.jsx
│   │   ├── ProductSection.jsx / ProductCard.jsx
│   │   └── AboutSection.jsx / Feedback.jsx / Footer.jsx
│   ├── hooks/useApiList.js
│   ├── services/api.js
│   └── utils/catalog.js
├── tests/catalog.spec.js        # 10 test
├── tests/product-images.spec.js # 4 test
├── dist/                       # generated, gitignored
├── test-results/               # generated, gitignored
└── node_modules/                # dependency đã có
```

Không có thư mục `pages`, router, auth store/context, cart store hay Admin layout trong source hiện tại.

Phiên bản cài thực tế, đối chiếu `npm.cmd ls --depth=0` và lockfile:

| Thành phần | Phiên bản |
|---|---|
| React / React DOM | 19.3.1 / 19.3.1 |
| Vite / plugin React | 8.3.4 / 6.1.2 |
| lucide-react | 1.58.0 |
| @playwright/test | 1.64.1 |

Scripts: `dev`, `build`, `preview`, `test:e2e`. Không có script lint, typecheck hoặc unit test. Không có dependency React Router, Axios, Redux/Zustand hay framework UI; Fetch và state/hooks React được dùng trực tiếp. Đây là mô tả hiện trạng, không phải đề xuất cài tất cả các thư viện này.

## 3. Đối chiếu 16 giao diện

“Chưa có” nghĩa là không tìm thấy component/page/route thực hiện màn hình, không phải chỉ thiếu kết nối API.

| # | Giao diện dự kiến | Hiện trạng source | Kết nối API |
|---:|---|---|---|
|1|Trang chủ|Có; ghép Header, Hero, highlights, danh mục, catalog, About, Footer|Có: hai collection phục vụ các section động|
|2|Danh sách sản phẩm|Có tại `#san-pham` trên Trang chủ; chưa có trang/route riêng|Có: GET `/api/products`, danh mục từ GET `/api/categories`|
|3|Chi tiết sản phẩm|Chưa có; card không có link/onClick tới chi tiết|Chưa|
|4|Đăng nhập|Chưa có form/trang/nút đăng nhập|Chưa|
|5|Đăng ký|Chưa có|Chưa|
|6|Giỏ hàng|Chưa có; chưa có nút thêm vào giỏ|Chưa|
|7|Đặt hàng|Chưa có|Chưa|
|8|Thông tin cá nhân|Chưa có|Chưa|
|9|Đơn hàng của tôi|Chưa có|Chưa|
|10|Chi tiết đơn/theo dõi|Chưa có|Chưa|
|11|Đánh giá sản phẩm|Chưa có danh sách/form/sao đánh giá|Chưa|
|12|Admin quản lý sản phẩm|Chưa có|Chưa|
|13|Admin quản lý danh mục|Chưa có|Chưa|
|14|Admin quản lý đơn hàng|Chưa có|Chưa|
|15|Admin quản lý người dùng|Chưa có|Chưa|
|16|AI Chatbot popup|Chưa có popup/tin nhắn/trạng thái phiên|Chưa|

Nguồn: `src/App.jsx:12–27`, `src/main.jsx:6–9`, toàn bộ `src/components`; `ProductCard.jsx:17–27` chỉ render article/ảnh/danh mục/tên/giá.

## 4. Những gì đã hoạt động và nguồn dữ liệu

### 4.1. Đã hoạt động

- Header/Footer/CTA điều hướng bằng hash tới `#trang-chu`, `#danh-muc`, `#san-pham`, `#ve-petcare`; mobile menu mở/đóng và đóng khi chọn link (`Header.jsx:5–10,30–39`). Đây là điều hướng section, không phải React Router.
- Chọn danh mục và cuộn tới catalog; số sản phẩm theo danh mục được tính từ collection (`CategorySection.jsx:16–18,40–51`).
- Tìm chuỗi trong tên sản phẩm và tên danh mục, chuẩn hóa dấu và đ/Đ; chưa tìm trong mô tả hoặc gọi API tìm kiếm (`ProductSection.jsx:18–29`, `utils/catalog.js:15–22`).
- Sắp xếp giá tăng/giảm; “Mới nhất” thực tế là `product_id` giảm dần, không phải sort `created_at` (`ProductSection.jsx:25–27`).
- Hiển thị 8 sản phẩm đầu, tải thêm từng 8; thay bộ lọc làm giới hạn quay lại 8. Không phải phân trang server (`ProductSection.jsx:7,13–15,79–81`).
- Định dạng VNĐ; ảnh lazy-load, retry URL gốc khi CDN large lỗi, rồi placeholder trung tính. Đổi URL nguồn reset trạng thái lỗi ảnh (`ProductCard.jsx:5–19`, `utils/catalog.js`).
- Skeleton/loading, empty, không tìm thấy, lỗi HTTP/network/JSON/schema, retry riêng cho sản phẩm và danh mục. Có abort/timeout12 giây và cleanup khi unmount (`useApiList.js:4–43`).
- Badge “Tạm hết hàng” khi `stock_quantity` bằng0; chưa có hành động mua để disable (`ProductCard.jsx:20`).

### 4.2. Phần tĩnh/hardcode

- Hero, giới thiệu PetCare, ba nội dung chăm sóc trong CareHighlights, footer, slogan và CTA là nội dung trình bày tĩnh. CTA vẫn có hành vi cuộn thật.
- Icon danh mục được chọn bằng tên danh mục đã normalize; màu dựa trên thứ tự. Đây là mapping UI, không phải danh mục giả.
- API origin, kích thước trang8, tên các chế độ sort và breakpoint CSS là cấu hình hardcode.
- Ảnh hero và 21 ảnh sản phẩm là asset tĩnh. Việc asset nằm trong `public` không có nghĩa sản phẩm/giá/tồn kho đang là mock: URL và dữ liệu catalog vẫn lấy từ API.
- Không thấy mock catalog được dùng khi API lỗi; giao diện báo lỗi/rỗng thay vì bịa sản phẩm.
- Các test có mock request cho loading/error/empty/ảnh lỗi/CDN cũ. Đây là fixture **kiểm thử**, không phải nguồn dữ liệu production.

### 4.3. API đã tích hợp chính xác

| API | Cách gọi/contract Frontend | Dữ liệu từ Backend |
|---|---|---|
|GET `/api/products`|`App.jsx:12`; `fetchCollection`, `{success:true,products:[...]}`|Backend JOIN MySQL products/categories; chỉ trạng thái `Đang bán`; ID, tên, danh mục, giá, tồn, ảnh, mô tả, ngày tạo|
|GET `/api/categories`|`App.jsx:13`; `{success:true,categories:[...]}`|Danh mục MySQL: ID, tên, mô tả, ngày tạo|

`src/services/api.js:28–35` kiểm tra success, array, ID và name tối thiểu. Không xác thực toàn bộ kiểu price/stock/image. Không kết nối MySQL trực tiếp từ trình duyệt.

### 4.4. API Backend đã có nhưng Frontend chưa dùng

Đã đối chiếu khai báo route, không chạy POST/PUT/PATCH/DELETE:

| Nhóm | API hiện có để tích hợp sau |
|---|---|
|Auth/profile|POST `/api/auth/register`, POST `/api/auth/login`, GET `/api/auth/me`, PUT `/api/users/me`|
|Giỏ|GET `/api/cart`, POST `/api/cart/items`, PUT/DELETE `/api/cart/items/:id`|
|Đặt/lịch sử/theo dõi|POST/GET `/api/orders`, GET `/api/orders/:id`|
|Thanh toán|GET `/api/orders/:id/payment`, POST `/api/orders/:id/payment/simulate`|
|Đánh giá|GET/POST `/api/products/:id/reviews`, GET `/api/users/me/reviews`|
|Admin catalog|GET/POST `/api/admin/products`, PUT/DELETE `/api/admin/products/:id`; tương tự `/api/admin/categories`|
|Admin đơn|GET `/api/admin/orders`, GET `/:id`, PATCH `/:id/approve`, PATCH `/:id/status`|
|Admin khách hàng|GET `/api/admin/users`, GET `/:id`, PATCH `/:id/status`|
|Chat|POST `/api/chat`: message, UUID request_id, optional signed session_id; JWT tùy chọn cho khách/User|

Nguồn: `backend/server.js:21–28`, `backend/routes/*`.

**Khoảng trống contract:** chưa có public GET `/api/products/:id`. Trang chi tiết cần thống nhất dùng lookup từ collection hiện tại hay đề xuất endpoint riêng ở một công việc Backend khác. Không tự tạo endpoint trong lần audit này. Thanh toán hiện là **ONLINE mô phỏng**, không phải gateway thật; Frontend phải thể hiện đúng phạm vi đồ án.

## 5. Router, đăng nhập/JWT và trạng thái

- Không có React Router, BrowserRouter, Routes, route guard hoặc nested Admin layout. Chỉ `createRoot(<StrictMode><App/></StrictMode>)`.
- Không thấy auth context/provider, token/JWT decode/refresh, Authorization header, localStorage/sessionStorage, trạng thái đăng nhập hay vai trò.
- Không có service gửi mutation, xử lý401/403, session chat, request_id hoặc Idempotency-Key. `fetchCollection` chỉ GET.
- State hiện tại là danh mục đang chọn, query/sort/giới hạn hiển thị, menu mobile, trạng thái fetch và lỗi ảnh; không có trạng thái nghiệp vụ dùng chung.
- Không có lưu bộ lọc trong URL hoặc persist khi refresh. Không có trang404 và cơ chế deep-link nhiều trang.

## 6. Responsive và accessibility

### Bằng chứng source

`styles.css:192–197` có breakpoint ≥1600, ≤1100, ≤820, ≤620 và ≤359px:

| Kích thước | Hành vi |
|---|---|
|Desktop mặc định|Grid sản phẩm4 cột, danh mục5 cột; hero/about hai cột|
|≤820px|Grid sản phẩm3 cột, giảm khoảng cách/cỡ chữ|
|≤620px|Grid sản phẩm2 cột, danh mục3 cột; hamburger; hero/about xếp dọc; footer đổi bố cục|
|≤359px|Danh mục2 cột; chỉnh cỡ chữ/khoảng cách|

Có viewport meta, `min-width:320px`, ảnh co giãn, skip link, landmark main, focus-visible, nhãn search/sort, aria-pressed danh mục, aria-expanded menu, alert/status và reduced-motion CSS.

### Bằng chứng chạy thật

- Test Chrome tại1440px,390px và768px đều xác nhận không tràn ngang; menu390px mở/đóng đúng.
- Đã xem screenshot desktop1440×3037 và mobile390×4023: có thay đổi bố cục tương ứng, sản phẩm/ảnh xuất hiện trong lưới. Đây không phải so khớp pixel với Figma.
- Chưa đánh giá đầy đủ320px, landscape, zoom200%, font scaling, Safari/Firefox, screen reader hoặc toàn bộ luồng bàn phím. Các màn hình chưa có không thể đánh giá responsive.

### Điểm cần cải thiện

- Font metadata trên mobile có chỗ7–10px (`styles.css:195–196`): cần đánh giá khả năng đọc và vùng bấm. Không kết luận vi phạm WCAG chỉ từ audit này.
- `CategorySection.jsx:18` bắt buộc JS smooth scroll; reduced-motion CSS không tự ghi đè tùy chọn JS này.
- Header luôn đánh dấu “Trang chủ” bằng `nav-home`, không phản ánh section hiện tại (`Header.jsx:23`).

## 7. Cấu hình triển khai online

| Hạng mục | Hiện trạng | Ảnh hưởng/việc cần làm sau |
|---|---|---|
|API base URL|`API_ORIGIN='http://localhost:3000'` tại `src/services/api.js:2`|**Chặn triển khai public**: browser người truy cập gọi localhost của chính họ. Cần biến Vite public API URL hoặc reverse proxy cùng origin; chưa chỉnh ở audit này|
|Vite env|Không có file env Frontend hay `import.meta.env`/`VITE_*` trong source|Cần cấu hình dev/staging/production. Không đưa JWT_SECRET, DB password hoặc GEMINI_API_KEY vào biến Vite vì chúng nằm trong bundle công khai|
|Dev/proxy|Bind127.0.0.1:5173 strictPort; preview4173; không proxy|Dev chỉ truy cập loopback trực tiếp; `preview` dùng kiểm tra build, chưa thấy cấu hình hosting/deploy production|
|HTTPS|API hardcodeHTTP|Nếu deploy trangHTTPS sẽ phát sinh mixed-content và/hoặc chặn truy cập; cần APIHTTPS/same-origin|
|CORS|Backend `app.use(cors())` cho mọi origin; không bật credentials cookie|Phù hợp GET công khai hiện tại. Cần chốt allowlist production và Bearer transport. CORS không thay thế phân quyền Backend; không kết luận đây tự thân là lỗ hổng|
|Ảnh sản phẩm|`/images/products/*` giữ URL tương đối **theo origin Frontend**, có đủ21 file local|Phải deploy nguyên public asset tương ứng. Đường dẫn này không đi qua Backend|
|Ảnh khác/legacy|Relative path khác resolve theo API_ORIGIN; Backend không có express.static|Ví dụ `/uploads/*` cần dịch vụ host riêng hoặc contract khác; không thể mặc định Backend đã phục vụ ảnh|
|CDN|Ưu tiên Hstatic large rồi URLgốc/placeholder|Đã có test; có phụ thuộc mạng ngoài nếu dữ liệu sau này dùng CDN|
|Base path|Hero/favicon/products dùng `/...`, Vite chưa cấu hình base|Deploy tại root domain là giả định hiện tại; deploy dưới `/petcare/` cần thiết kế lại URL/base/routing|
|Font|Google Fonts qua CSS import, có system-font fallback|Có phụ thuộc mạng/font ngoài; chưa kiểm tra offline/performance ngân sách|
|SPA rewrite|Chưa có router, chưa có config hosting rewrite|Khi thêm Router, cần xử lý refresh/deep-link về index và trang404|

README Frontend nói ảnh tương đối resolve theo Backend nhưng chưa nêu ngoại lệ `/images/products/*`; source/test hiện tại đã xác nhận ngoại lệ này. Cần cập nhật tài liệu khi bước tích hợp được cho phép.

**Timeout tích hợp chat:** hook hiện tại chỉ dành cho GET collection và timeout12giây. Backend Gemini có timeout45giây; không nên dùng nguyên hook này cho chat, mutation hoặc retry có idempotency. Chat cần giữ session_id/request_id; đặt hàng cần giữ Idempotency-Key theo contract Backend.

## 8. Build và test đã thực sự chạy

Môi trường Node v24.14.1, npm11.11.0. Dependency đã cài sẵn; không chạy install.

| Lệnh/thao tác | Kết quả |
|---|---|
|`npm.cmd ls --depth=0` tại frontend|Đúng6 dependency trực tiếp nêu ở phần2, không báo thiếu|
|`npm.cmd run build`|**Đạt**: Vite8.3.4,1934 modules; build1.71giây; tạo dist|
|`npm.cmd run test:e2e`|**14/14 đạt**,28.6giây;1worker,Chrome headless|
|GET Backend để kiểm tra tiền đề|Server ban đầu chưa chạy; đã mở tạm server hiện có ở3000 để test GET thật; không sửa code Backend|

Sau kiểm thử đã dừng Backend mở tạm; Vite do Playwright quản lý cũng đã dừng.
Đã kiểm tra lại cổng3000/5173 không còn phục vụ, khôi phục trạng thái trước audit.

Lần chạy build/test đầu trong sandbox Windows bị `spawn EPERM`. Chạy lại ngoài sandbox theo quyền được cấp thì đạt; đây là hạn chế môi trường chạy, không phải bằng chứng source build lỗi.

Artifact build:

- `dist/index.html`:0.72kB, gzip0.47kB.
- CSS:22.97kB, gzip5.19kB.
- JS:247.10kB, gzip77.90kB.

10 test catalog kiểm tra: dữ liệu API thật/VNĐ/danh mục/không pageerror; lọc+tìm không dấu+reset; sort+tải thêm; skeleton; lỗi sản phẩm/retry; lỗi danh mục/retry; empty không mock; ảnh lỗi; responsive/menu; CDN fallback.

4 test ảnh kiểm tra:21 ảnh API khớp manifest hiện có và WebP/hash; helper URL; ảnh local lỗi/recover theo source;21 ảnh thực tải không fallback/không gọi Backend để lấy ảnh. Manifest được test đọc là `image-migration/archive/final-20261017/manifest.json`.

Giới hạn kiểm thử hiện tại:

- Đây là E2E **Vite dev server**, không phải E2E chạy trên dist. Một số test import `/src/*` và `/node_modules/.vite/deps/*` nên không dùng nguyên cấu hình để test production bundle.
- Playwright tự start Vite, **không start Backend/MySQL**; cần Backend thật sẵn sàng ở3000 và Chrome đã cài.
- `npm.cmd run dev` trong config là lệnh Windows, cần điều chỉnh nếu CI Linux. Không có Firefox/WebKit matrix, unit/lint/typecheck hiện hữu để chạy.
- Các test ảnh khóa đúng21 sản phẩm, tên/mô tả và hash snapshot migration. Khi Admin đổi tên/ảnh/ngừng bán hợp lệ, test có thể fail do fixture cũ, không nhất thiết do UI lỗi. Nên tách test migration cố định khỏi test UI tổng quát ở giai đoạn sau.
- Không có test commerce/auth/admin/chat Frontend vì các chức năng đó chưa tồn tại. Chỉ test lỗi/loading có interception; các ca thành công/catalog/ảnh dùng API thật.

## 9. Danh sách vấn đề theo ưu tiên

| Ưu tiên | Vấn đề | Tác động và hướng xử lý đề xuất — chưa thực hiện |
|---|---|---|
|P0 trước deploy|API origin hardcode localhost, thiếu env/HTTPS/base-path contract|Chốt môi trường và asset host trước khi tích hợp thêm màn hình|
|P1|Chưa có router/page architecture và auth/JWT/role state|Xây public/auth/user/admin layout, route guard, load `/auth/me`, xử lý401/403 và logout phía client phù hợp contract|
|P1|14 màn hình còn thiếu; catalog chỉ là section|Tạo các luồng mua hàng, hồ sơ, Admin và chat; không coi landing là đã hoàn thành hệ thống bán hàng|
|P1|Service hiện chỉ GET, chưa có token/mutation/idempotency/error mapping|Tạo lớp API theo nhóm nghiệp vụ; không tự retry POST đặt hàng/thanh toán/chat mà làm mất key|
|P1 khi làm checkout|Chưa biểu diễn duyệt đơn và thanh toán mô phỏng|Đọc trạng thái thật, khóa thao tác khi chưa đủ điều kiện, không tự đặt payment_status từ UI|
|P2|Chưa có public detail endpoint và contract deeplink|Thống nhất nguồn dữ liệu chi tiết trước khi làm route sản phẩm, kể cả trường hợp sản phẩm ngừng bán trong đơn cũ|
|P2|Chat cần session và timeout khác collection|Thiết kế popup, history UI, bảo vệ token, UUID retry, quota/timeout theo API; không để Gemini key vào Frontend|
|P2|Test phụ thuộc dataset21/manifest và devserver Windows|Tách migration fixture/test UI, chuẩn bị kiểm thử build/CI phù hợp khi được phép|
|P2|Giá lỗi/missing có thể sort0/NaN, contract validation còn tối thiểu|Định nghĩa xử lý dữ liệu thiếu nhất quán; đây là rủi ro edge-case từ source, chưa thấy lỗi với21 dữ liệu thật|
|P2|Reduced motion/cỡ chữ nhỏ/cross-browser chưa đánh giá đủ|Kiểm tra accessibility và responsive các form/layout mới; sửa JS scroll khi làm UI|
|P3|Active navigation cố định, filter không nằm URL, tài liệu ảnh chưa khớp source|Hoàn thiện UX/deep-link/tài liệu sau khi chốt kiến trúc|

## 10. Thứ tự triển khai để hoàn thiện các Use Case

Không có tài liệu trong phần workspace đã kiểm tra xác định đủ tên và mã của cả19UC. Source/tài liệu Backend định danh rõ UC07–11 và UC13–19; **không tự gán tên cho UC01–06 hoặc UC12**. Các chức năng tài khoản/hồ sơ/catalog đã có API, nhưng cần đối chiếu mã chính thức với tài liệu đồ án trước khi chốt ma trận nghiệm thu19UC.

| Giai đoạn | Phạm vi Frontend đề xuất | Use Case/đầu ra cần đối chiếu |
|---|---|---|
|0|Chốt16 mockup/Figma thực tế, ma trận19UC, URL/env/asset, routing và contract API|Không suy đoán mã UC còn thiếu; thống nhất detail API và phạm vi thanh toán mô phỏng|
|1|Router/layout + API client; đăng ký/đăng nhập/logout phía client; JWT/me/role/khóa tài khoản; hồ sơ cá nhân|Nhóm tài khoản/hồ sơ, mã cần xác nhận từ tài liệu nghiệp vụ|
|2|Tách catalog thành trang, detail, tìm/lọc/sort và deep-link; giữ loading/error/ảnh hiện có|Nhóm xem/tìm sản phẩm; tái sử dụng phần đã hoạt động|
|3|Thêm vào giỏ, xem/sửa/xóa/chọn sản phẩm, xử lý hết hàng/ngừng bán|UC07–UC08|
|4|Checkout thông tin giao hàng, Idempotency-Key, lịch sử/chi tiết/theo dõi; payment mô phỏng theo duyệt|UC09–UC11, UC15; xử lý chờ duyệt/chưa thanh toán/thất bại/thử lại từ Backend|
|5|Admin layout + catalog/danh mục + duyệt/cập nhật/hủy đơn + khóa User|UC16–UC19; tách role, giữ luồng hoàn kho/thu COD do Backend quyết định|
|6|Đọc/gửi đánh giá khi đủ điều kiện; đánh giá của tôi|UC14; vẫn đọc đánh giá/sản phẩm lịch sử khi đã ngừng bán|
|7|AI popup cho guest/User, session/UUID, thẻ sản phẩm riêng, loading/quota/timeout và retry đúng phiên|UC13; không cần Frontend gọi Gemini trực tiếp|
|8|E2E xuyên luồng, responsive16 màn, keyboard/a11y, HTTPS/deep-link/CI và nghiệm thu19UC|Đối chiếu đầy đủ ma trận đã chốt ở bước0; không coi test landing là nghiệm thu toàn bộ|

Các giai đoạn trên là **đề xuất**, chưa triển khai hoặc sửa cấu hình trong lần audit này.
