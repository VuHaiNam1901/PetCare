# Cập nhật Trang chủ PetCareShop — 28/10/2026

Frontend thực tế của repository nằm tại `D:\petcare-website\PetCare\frontend`.
Đường dẫn `D:\petcare-website\frontend` trong yêu cầu không tồn tại trên máy.
Đã sửa trực tiếp React/CSS trong frontend hiện có, không tạo dự án mới hoặc file Figma.

## Giao diện đã triển khai

- Header ba tầng: thông tin liên hệ; logo, tìm kiếm, tài khoản/yêu thích/giỏ hàng; thanh điều hướng.
- Hero xanh sáng với tiêu đề theo yêu cầu, nút Mua ngay và ảnh chó Golden/mèo con độc lập.
- Năm danh mục từ API, hình minh họa theo ảnh mẫu, banner chó Corgi bên phải.
- Catalog năm cột ở desktop 1440px, dải lọc danh mục, sắp xếp, trạng thái kết quả và khối thông tin bên phải.
- Thanh Messenger/Zalo/Hotline/Email bên trái và AI Chatbot ở góc dưới bên phải.
- Font Be Vietnam Pro; bảng màu yêu cầu; nút bo 4px, card bo 8px; responsive tablet/mobile.
- Banner không hiển thị giảm 30% vì API hiện tại chưa cung cấp khuyến mãi được xác nhận. Không thêm sao, đánh giá hoặc lượt mua giả.

## File đã sửa hoặc thêm

File hiện có đã sửa:

- `index.html`: metadata, tên PetCareShop và màu theme.
- `src/App.jsx`: chia sẻ tìm kiếm giữa Header/catalog, gắn liên hệ/chatbot và thông báo chức năng chưa kết nối.
- `src/styles.css`: bố cục theo mẫu, màu sắc, typography, widget và responsive.
- `src/components/Header.jsx`, `Brand.jsx`, `Hero.jsx`: header và hero mới.
- `src/components/CategorySection.jsx`: danh mục API và banner bên phải.
- `src/components/ProductSection.jsx`, `ProductCard.jsx`: trình bày catalog, giữ dữ liệu và logic lọc/sắp xếp/tải thêm.
- `src/components/CareHighlights.jsx`: khối thông tin bên phải catalog.
- `src/components/Footer.jsx`: footer và liên hệ đồng bộ giao diện.

File mới:

- `src/components/CategoryCard.jsx`.
- `src/components/FloatingContact.jsx`.
- `src/components/ChatbotWidget.jsx`.
- `tests/homepage-widgets.spec.js`: 4 bài kiểm thử mới.
- `scripts/optimize-home-images.mjs`: nén ảnh bằng Playwright/Chrome sẵn có, không thêm dependency.
- `public/images/home/`: 7 ảnh WebP sử dụng trên website, tổng 186.564 byte.
- `design-assets/home/`: 7 PNG nguồn, README và prompt tạo ảnh nguyên văn.
- `HOMEPAGE_UPDATE.md`: báo cáo này.

Ảnh mới được tạo riêng bằng công cụ imagegen tích hợp. Không cắt ảnh giao diện mẫu làm trang web.
Xem [nguồn ảnh](design-assets/home/README.md) và [prompt nguyên văn](design-assets/home/prompts.md).

## Chức năng được giữ nguyên

- GET `/api/products` và GET `/api/categories` qua service/hook hiện có.
- Tên, giá, thông tin, ảnh sản phẩm và thứ tự mặc định theo ID giảm dần từ dữ liệu thật.
- Tìm kiếm không dấu, bao gồm đ/Đ, trong tên sản phẩm và danh mục. Ô tìm kiếm được đưa lên Header.
- Lọc danh mục, sắp xếp giá tăng/giảm, 8 sản phẩm ban đầu, tải thêm từng 8; đổi bộ lọc sẽ reset giới hạn.
- Loading skeleton, trạng thái rỗng, không tìm thấy, lỗi độc lập, Thử lại, timeout và abort request.
- Fallback ảnh CDN về ảnh gốc, placeholder khi ảnh lỗi, ảnh local từ frontend.
- Mobile menu, điều hướng section và khả năng dùng bàn phím.

Không sửa backend, database, service API, hook tải dữ liệu, helper catalog, dữ liệu sản phẩm,
dependency hoặc các bài kiểm thử cũ. Chưa có trang khác trong frontend hiện tại để bị ảnh hưởng.

## Chức năng còn chờ tích hợp

- Frontend ban đầu chưa có luồng tài khoản, yêu thích hoặc giỏ hàng. Các nút mới có trạng thái chưa kết nối và thông báo rõ; không báo thêm giỏ thành công hoặc tạo số đếm giả.
- Backend có route chatbot nhưng lần sửa này chỉ triển khai UI theo phạm vi yêu cầu, không gọi API chat/Gemini. Tin người dùng nhập chỉ là bản nháp có nhãn **Chưa gửi**, không có phản hồi AI giả.
- Chatbot có nút đóng, Escape, quản lý focus, vùng hội thoại cuộn và ô nhập; bản nháp chỉ tồn tại trong bộ nhớ phiên trang.
- Chưa có URL/ID liên hệ Messenger/Zalo được cung cấp nên hai nút ghi rõ chưa cấu hình. Không tự tạo đường dẫn đến tài khoản bên ngoài.
- Hotline/email dùng thông tin trong ảnh mẫu: `0987 654 321`, `petcare@gmail.com`, với liên kết `tel:`/`mailto:`.

## Kết quả kiểm tra

- `npm.cmd run build`: **PASS**, trên phiên bản cuối.
- `npm.cmd run test:e2e`: **18/18 PASS** gồm 14 bài cũ và 4 bài mới, với API/catalog thật tại localhost:3000. Các bài kiểm tra lỗi vẫn dùng fixture có kiểm soát như trước.
- Sau chỉnh sửa cuối về hòa nền ảnh hero, chạy lại `npm.cmd run test:e2e -- tests/homepage-widgets.spec.js --output=test-results/final`: **4/4 PASS**.
- Chrome headless: kiểm tra dữ liệu/giá API, 21 ảnh sản phẩm, tìm kiếm/lọc/sắp xếp/tải thêm, loading/error/retry, menu mobile, widget, bàn phím/focus và xác nhận không gửi request chatbot.
- Không tràn ngang tại 320, 390, 768, 1024 và 1440px. Popup chatbot nằm trong viewport ở desktop/tablet/mobile.
- Đã xem ảnh chụp desktop 1440px và mobile 390px, sửa các vấn đề quan sát được về tỷ lệ ảnh, đường nối nền và cỡ chữ.
- `git diff --check`: **PASS**.
- Không có script lint/unit-test trong package hiện tại; không chạy test backend có thao tác database ngoài phạm vi sửa giao diện.

Ảnh kiểm tra (output local, được Git ignore):

- [Trang chủ desktop 1440px](test-results/homepage-1440.png).
- [Trang chủ mobile 390px](test-results/homepage-mobile.png).

Độ giống được đối chiếu trực quan với ảnh đính kèm, không có phép đo pixel tự động. Khác biệt có chủ đích gồm ảnh tạo mới,
sản phẩm thật theo thứ tự hiện có, phần sắp xếp/trạng thái kết quả, và các nội dung chưa đủ dữ liệu để xác nhận.
