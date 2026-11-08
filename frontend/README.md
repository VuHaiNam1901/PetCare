# PetCare frontend

Frontend React + Vite, viết bằng JavaScript, đặt ngang hàng với backend hiện có.

## Chạy ứng dụng

Yêu cầu Node.js tương thích với Vite 8 (20.19+ hoặc 22.12+). Máy triển khai đã có Node 24.
Tham khảo: https://vite.dev/guide/

1. Nếu backend chưa chạy, mở terminal tại thư mục backend và chạy `node server.js`.
2. Mở terminal tại frontend, chạy `npm.cmd install` nếu chưa cài thư viện.
3. Chạy `npm.cmd run dev`.
4. Truy cập http://localhost:5173 (Vite bind 127.0.0.1, cổng cố định 5173).

Trang chủ ở `/`; Danh sách sản phẩm ở `/products`; Chi tiết sản phẩm ở `/products/:id` (ví dụ `http://localhost:5173/products/21`).
Giỏ hàng ở `http://localhost:5173/cart`; đặt hàng ở `/checkout`; đăng nhập ở `/login`; đăng ký ở `/register`. Checkout tạo và lưu đơn qua API, trả mã đơn thật; COD chưa thu tiền và ONLINE chờ Admin duyệt trước khi mô phỏng thanh toán. Xem [CHECKOUT.md](CHECKOUT.md), chạy migration backend `npm.cmd run migrate:checkout` trước khi dùng API mới.
`App.jsx` chọn nội dung theo pathname; các liên kết dùng điều hướng trình duyệt thông thường, không thêm thư viện routing. Vite phục vụ entry React khi mở trực tiếp hoặc tải lại các URL này.

Đơn hàng của tôi ở `/my-orders`, truy cập từ tài khoản trên Header sau đăng nhập. Danh sách dùng đơn thật qua API, có lọc trạng thái và phân trang; `/my-orders/:orderId` hiển thị chi tiết, thông tin nhận hàng, giá lịch sử và theo dõi trạng thái chỉ đọc. Xem [MY_ORDERS.md](MY_ORDERS.md) và [ORDER_DETAIL.md](ORDER_DETAIL.md).

Trên Windows dùng npm.cmd nếu PowerShell chặn npm.ps1. Không cần đổi Execution Policy.

## Dữ liệu

- GET http://localhost:3000/api/products → { success, total, products: [...] }
- GET http://localhost:3000/api/categories → { success, total, categories: [...] }
- Giỏ khách dùng `POST /api/cart/preview` để lấy giá, ảnh, trạng thái và tồn kho hiện tại. Đây là thao tác đọc, không tạo giỏ MySQL hoặc thay đổi tồn kho.
- Giỏ tài khoản dùng các API `/api/cart` được bảo vệ bằng JWT và lưu vào bảng `carts`, `cart_items` hiện có. Đăng nhập/đăng ký dùng API thật `/api/auth/*`.
- Địa chỉ API lấy từ `VITE_API_ORIGIN` trong môi trường build/dev (mẫu `.env.example`), mặc định `http://localhost:3000`; chuỗi rỗng dùng cùng origin.
- Tất cả sản phẩm, danh mục, giá và ảnh sản phẩm lấy từ API. Không có dữ liệu sản phẩm mẫu.
- Chuỗi giá được định dạng bằng Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).
- Với ảnh Hstatic dạng pico/small/compact, frontend ưu tiên bản large của cùng ảnh để tránh bị mờ; nếu lỗi, thử lại URL gốc trước khi hiện placeholder. Không ghi lại URL vào database.
- URL ảnh tương đối được phân giải theo origin backend. Ảnh thiếu, sai URL hoặc tải lỗi có placeholder trung tính, không dùng ảnh sản phẩm khác thay thế.
- Hai API có trạng thái tải, lỗi và nút thử lại riêng. Request bị hủy khi component unmount, timeout sau 12 giây.
- Nếu MySQL/backend không hoạt động, giao diện vẫn mở và thông báo không tải được dữ liệu. Frontend không kết nối trực tiếp MySQL.

## Cấu trúc

- `src/components/Logo.jsx`: component logo dùng chung; Header và Footer đều dùng component này. `Brand.jsx` chỉ chuyển tiếp để tương thích import cũ.
- `src/assets/logo.jpg`: ảnh logo duy nhất đang sử dụng, sao chép từ `D:\petcare-website\logoweb.jpg`. Thay nội dung file này để cập nhật mọi logo và favicon; nếu đổi tên/định dạng ảnh, chỉ sửa import tại `src/config/branding.js`.
- Trang chủ, danh sách, chi tiết, giỏ hàng và đăng nhập/đăng ký cùng dùng Header/Footer/Logo. Chưa có giao diện quản trị riêng; khi bổ sung, dùng lại `Logo`, không khai báo nguồn ảnh riêng.
- src/App.jsx: ghép các phần của trang, quản lý danh mục đang chọn.
- `src/pages/ProductsPage.jsx`: trang `/products`, dùng chung Header/Footer/Logo của App và ProductSection/ProductCard với trang chủ.
- `src/pages/ProductDetailPage.jsx`: trang `/products/:id`, đọc sản phẩm và sản phẩm cùng danh mục từ API danh sách hiện có; dùng cùng Header/Footer/Logo, ProductImage và ProductCard.
- `src/pages/CartPage.jsx`: giỏ khách/giỏ tài khoản, chọn hàng, chỉnh số lượng, xóa và tóm tắt các dòng hợp lệ được chọn.
- `src/pages/AuthPage.jsx`: form đăng nhập dùng chung User/Admin và form đăng ký tài khoản User.
- `src/context/CommerceContext.jsx`: quản lý phiên, giỏ khách, giỏ tài khoản, hợp nhất giỏ và ý định đặt hàng/Mua ngay.
- `src/services/commerce.js`: gọi các API xác thực/giỏ hàng và chuyển lỗi thành thông báo.
- `src/commerce.css`: bố cục giỏ hàng/xác thực; dùng cùng màu và font của `src/styles.css`.
- src/components/: Header, Hero, CareHighlights, CategorySection, ProductSection, ProductCard, AboutSection, Footer và component dùng chung.
- src/hooks/useApiList.js: tải dữ liệu, xử lý lỗi, retry, timeout và cleanup.
- src/services/api.js: giao tiếp REST API bằng Fetch.
- src/utils/catalog.js: định dạng giá, tìm kiếm không dấu và xử lý URL ảnh.
- src/styles.css: giao diện responsive và trạng thái focus/reduced motion.
- public/images/hero-dog.jpg: ảnh minh họa trang chủ, không phải sản phẩm.
- tests/catalog.spec.js: kiểm thử trình duyệt với dữ liệu API thực.

Có tìm kiếm không dấu, lọc danh mục, sắp xếp giá và tải thêm sản phẩm ở frontend.
Trang `/products` kết hợp tìm kiếm ở Header, danh mục và sắp xếp; hiển thị số kết quả (kể cả 0), tải thêm từng 8 sản phẩm và đặt lại giới hạn khi đổi bộ lọc. Sản phẩm/danh mục có trạng thái tải và lỗi với nút Thử lại độc lập; sản phẩm vẫn đọc được khi API danh mục lỗi.
Menu Sản phẩm trên desktop/mobile, Xem tất cả ở khu vực sản phẩm trang chủ và liên kết Tất cả sản phẩm ở Footer đều mở `/products`. Trang chủ giữ nguyên bố cục và các thao tác lọc tại chỗ.
Ảnh và tên trên các thẻ mở đúng `/products/:id`; nút mua hàng/yêu thích nằm ngoài liên kết. Trang chi tiết hiển thị thông tin thật, số lượng nguyên từ 1 tới tồn kho, mô tả (hoặc nhãn đang cập nhật nếu trống), và tối đa 5 sản phẩm cùng danh mục, loại trừ sản phẩm hiện tại. Trạng thái đang tải, lỗi/Thử lại và không tìm thấy được phân biệt; sản phẩm ngừng bán không nằm trong API công khai nên không hiển thị chi tiết.
Tìm kiếm từ Header ở trang chi tiết dẫn tới `/products?q=...`; danh mục dẫn tới `/products?category=...`. Trang danh sách khởi tạo bộ lọc từ các tham số này.
Icon giỏ trên Header mở `/cart` và hiển thị tổng số món. Khách chưa đăng nhập vẫn thêm/sửa/xóa/chọn hàng; giỏ và lựa chọn được lưu trong localStorage. Sau đăng nhập, giỏ khách được hợp nhất với giỏ tài khoản bằng transaction có khóa chống lặp, giữ lựa chọn của khách và chỉ xóa bản khách sau xác nhận thành công.
Phiên JWT nằm trong sessionStorage; backend kiểm tra tài khoản, vai trò và chủ giỏ trên mỗi API bảo vệ. Đăng ký công khai chỉ tạo User. Admin dùng cùng form đăng nhập nhưng không được thao tác giỏ khách hàng.
Bấm Đặt hàng giữ đúng lựa chọn/số lượng, yêu cầu xác thực nếu cần rồi mở `/checkout`. Xác nhận gửi yêu cầu tạo đơn có khóa chống lặp; chỉ báo thành công khi nhận mã đơn đã commit từ MySQL. Thông tin và key được giữ qua đăng nhập lại hoặc retry khi mất phản hồi.
Backend được bổ sung API đọc giỏ khách, lựa chọn và hợp nhất. Migration `003-cart-merge.js` chỉ thêm bảng metadata chống lặp; không reset hoặc sửa nội dung các bảng cũ. Xem [hướng dẫn giỏ hàng và xác thực](CART_AUTH.md) để biết API, lưu trữ, backup và kiểm thử.

## Thao tác trên thẻ sản phẩm

- `ProductCard.jsx` dùng một nhóm nút chung cho mọi thẻ: **Mua ngay** nền xanh, nút **Thêm vào giỏ hàng** chỉ có biểu tượng giỏ kèm dấu cộng, nền trắng/viền xanh. Hai nút cao bằng nhau; cả hai bị `disabled` khi tồn kho bằng 0 hoặc âm.
- Nút Thêm vào giỏ hàng thêm 1 món trên thẻ, giữ nguyên trang, cập nhật số món trên Header và chỉ thông báo thành công sau khi thao tác giỏ được xác nhận. Sản phẩm trùng cộng số lượng trong giới hạn tồn kho.
- Trang chủ và trang `/products` dùng cùng `ProductCard` và callback xử lý thao tác để giữ thống nhất bố cục và trạng thái.
- Trang chi tiết thêm đúng số lượng đang chọn. Bộ chọn số lượng và hai nút bị vô hiệu hóa khi hết hàng hoặc chưa có thông tin tồn kho hợp lệ.
- Mua ngay lưu riêng sản phẩm và số lượng định mua (thẻ mặc định 1), không thay đổi giỏ. Khách được chuyển tới đăng nhập rồi Checkout; đơn chỉ được tạo sau khi xác nhận.

## Kiểm thử và build

- `npm.cmd run build`: tạo bản production tại dist/.
- `npm.cmd run preview`: xem bản build tại http://127.0.0.1:4173.
- `npm.cmd run test:checkout`: kiểm tra Checkout/cart/auth với API tổng hợp và dữ liệu giả lập, không kết nối database thật. Tự chạy server ở cổng 3101/5174.
- `npm.cmd run test:my-orders`: kiểm tra Đơn hàng của tôi bằng API tổng hợp ở cổng 3102/5175, không kết nối database thật.
- `npm.cmd run test:order-detail`: chỉ chạy các tình huống Chi tiết đơn hàng bằng cùng API fixture, không kết nối database thật.
- `npm.cmd run test:e2e`: chạy Playwright với Google Chrome đã cài.
  Backend thật ở cổng 3000 cần hoạt động. Playwright có thể tự mở dev server nếu chưa chạy.
  Các bài catalog/chi tiết dùng dữ liệu sản phẩm thật; các tình huống lỗi/loading/empty/image-fallback dùng fixture có kiểm soát.
  `tests/cart-auth.spec.js` dùng API fixture cho các bước xác thực/hợp nhất trong trình duyệt. Transaction, JWT, quyền truy cập và chống lặp được kiểm tra riêng bằng integration test backend với MySQL thật; fixture UI không thay thế kiểm tra bảo mật backend.
  Ảnh chụp trang nằm trong test-results/ sau khi chạy.

## Thư viện và hình ảnh

React, React DOM, Vite, plugin React chính thức, lucide-react; Playwright chỉ dùng khi phát triển.
CSS thuần; không dùng framework UI.
Font Be Vietnam Pro tải qua Google Fonts, có system font dự phòng.
Ảnh chó minh họa từ Unsplash: https://images.unsplash.com/photo-1552053831-71594a27632d.
Icon từ Lucide.
