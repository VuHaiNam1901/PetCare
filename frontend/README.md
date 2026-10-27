# PetCare frontend

Frontend React + Vite, viết bằng JavaScript, đặt ngang hàng với backend hiện có.

## Chạy ứng dụng

Yêu cầu Node.js tương thích với Vite 8 (20.19+ hoặc 22.12+). Máy triển khai đã có Node 24.
Tham khảo: https://vite.dev/guide/

1. Nếu backend chưa chạy, mở terminal tại thư mục backend và chạy `node server.js`.
2. Mở terminal tại frontend, chạy `npm.cmd install` nếu chưa cài thư viện.
3. Chạy `npm.cmd run dev`.
4. Truy cập http://localhost:5173 (Vite bind 127.0.0.1, cổng cố định 5173).

Trên Windows dùng npm.cmd nếu PowerShell chặn npm.ps1. Không cần đổi Execution Policy.

## Dữ liệu

- GET http://localhost:3000/api/products → { success, total, products: [...] }
- GET http://localhost:3000/api/categories → { success, total, categories: [...] }
- Cấu hình địa chỉ API trong src/services/api.js. Không cần tạo hoặc sửa .env.
- Tất cả sản phẩm, danh mục, giá và ảnh sản phẩm lấy từ API. Không có dữ liệu sản phẩm mẫu.
- Chuỗi giá được định dạng bằng Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).
- Với ảnh Hstatic dạng pico/small/compact, frontend ưu tiên bản large của cùng ảnh để tránh bị mờ; nếu lỗi, thử lại URL gốc trước khi hiện placeholder. Không ghi lại URL vào database.
- URL ảnh tương đối được phân giải theo origin backend. Ảnh thiếu, sai URL hoặc tải lỗi có placeholder trung tính, không dùng ảnh sản phẩm khác thay thế.
- Hai API có trạng thái tải, lỗi và nút thử lại riêng. Request bị hủy khi component unmount, timeout sau 12 giây.
- Nếu MySQL/backend không hoạt động, giao diện vẫn mở và thông báo không tải được dữ liệu. Frontend không kết nối trực tiếp MySQL.

## Cấu trúc

- src/App.jsx: ghép các phần của trang, quản lý danh mục đang chọn.
- src/components/: Header, Hero, CareHighlights, CategorySection, ProductSection, ProductCard, AboutSection, Footer và component dùng chung.
- src/hooks/useApiList.js: tải dữ liệu, xử lý lỗi, retry, timeout và cleanup.
- src/services/api.js: giao tiếp REST API bằng Fetch.
- src/utils/catalog.js: định dạng giá, tìm kiếm không dấu và xử lý URL ảnh.
- src/styles.css: giao diện responsive và trạng thái focus/reduced motion.
- public/images/hero-dog.jpg: ảnh minh họa trang chủ, không phải sản phẩm.
- tests/catalog.spec.js: kiểm thử trình duyệt với dữ liệu API thực.

Có tìm kiếm không dấu, lọc danh mục, sắp xếp giá và tải thêm sản phẩm ở frontend.
Chưa có giỏ hàng, đăng nhập, thanh toán hoặc trang chi tiết.
Không sửa backend, .env hoặc cấu trúc/dữ liệu MySQL.

## Kiểm thử và build

- `npm.cmd run build`: tạo bản production tại dist/.
- `npm.cmd run preview`: xem bản build tại http://127.0.0.1:4173.
- `npm.cmd run test:e2e`: chạy Playwright với Google Chrome đã cài.
  Backend thật ở cổng 3000 cần hoạt động. Playwright có thể tự mở dev server nếu chưa chạy.
  Kiểm thử chỉ gửi GET tới backend; không tạo, cập nhật hoặc xóa dữ liệu.
  Dữ liệu thành công lấy từ API; riêng bài kiểm thử lỗi/loading/empty/image-fallback có chặn request trong trình duyệt để mô phỏng trạng thái.
  Ảnh chụp trang nằm trong test-results/ sau khi chạy.

## Thư viện và hình ảnh

React, React DOM, Vite, plugin React chính thức, lucide-react; Playwright chỉ dùng khi phát triển.
CSS thuần; không dùng framework UI.
Font Be Vietnam Pro tải qua Google Fonts, có system font dự phòng.
Ảnh chó minh họa từ Unsplash: https://images.unsplash.com/photo-1552053831-71594a27632d.
Icon từ Lucide.
