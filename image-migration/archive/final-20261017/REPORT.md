Đã dọn ảnh và dữ liệu migration ngày 17/10/2026 trong D:\petcare-website.

Đối chiếu trước khi xóa:

- Đọc toàn bộ 21 dòng products từ petcare_db qua cấu hình backend; tất cả image_url đang trỏ đúng 21 WebP có product_id trong frontend/public/images/products/.
- Tìm tham chiếu trong mã nguồn, cấu hình, test và script (kể cả file ẩn; bỏ node_modules, dist, kết quả test sinh tự động và thông tin môi trường). Không có tham chiếu đến 10 tên ảnh WebP cũ trong phần giữ lại.
- Các tham chiếu ảnh ứng viên/staging/evidence cũ chỉ thuộc các script đã hoàn thành hoặc báo cáo cũ. Test và script khôi phục đã chuyển sang archive cuối này.
- Fallback sản phẩm dùng ImageOff và CSS trong ProductCard.jsx, không phụ thuộc 10 ảnh bị xóa. Hero /images/hero-dog.jpg được giữ nguyên.

Đã xóa thật:

| Nhóm | Số file | Byte |
| --- | ---: | ---: |
| Ảnh WebP cũ trong public và .gitkeep rỗng | 11 (10 ảnh + .gitkeep) | 802490 |
| Ảnh ứng viên/reference cũ (candidates) | 34 | 2494984 |
| HTML nguồn tải về (source-pages) | 23 | 10223356 |
| Staging, ảnh public backup cũ, metadata/evidence các vòng duyệt (manual-20261017-01) | 96 | 2776717 |
| Script, snapshot và evidence của lần đổi giá đã hoàn thành | 7 | 519718 |
| File ở gốc migration: script dùng một lần, map/manifest/plan/report/evidence cũ | 25 | 210317 |
| Tổng file bị xóa | 196 | 17027582 |

Bản original-products.json đã được di chuyển, không bị xóa hay tạo thêm bản sao. Các snapshot trước migration trùng hash đã được loại bỏ. Dung lượng giải phóng ròng sau khi tính metadata cuối: PENDING.

Phần giữ lại:

- 21 ảnh public đang được MySQL sử dụng; toàn bộ byte và SHA-256 giống trước khi dọn. Không còn ảnh public chưa xác định mục đích.
- Thư mục này chỉ có 5 file: mapping.csv (đối chiếu 21 sản phẩm cuối), manifest.json (nguồn ảnh, hash/kích thước, duyệt nội dung của người dùng, crop SHED-X), final-plan.json (phạm vi khôi phục và hash), original-products.json (một bản sao lưu gốc), REPORT.md.
- Các đường dẫn staging/ứng viên đã bỏ khỏi manifest để không còn phụ thuộc file đã xóa.
- Nguồn duyệt nội dung vẫn là người dùng, không đổi thành xác minh từ hãng. Quyết định chấp nhận watermark được giữ trong mapping/manifest.
- Cả 21 file nguồn trong D:\AnhSanPham còn nguyên tên, dung lượng và SHA-256.
- Không sửa mã nguồn ứng dụng/API/bố cục và không thực hiện UPDATE/DELETE MySQL trong lần dọn này. Chỉ điều chỉnh test ảnh và tiện ích khôi phục.

Kiểm tra thực tế sau khi xóa:

- npm.cmd run build: PASS, Vite build thành công.
- npm.cmd run test:e2e: 14/14 PASS (21,2 giây); không bỏ test để đạt.
- Đọc API thật tại http://localhost:3000/api/products, đối chiếu từng trường của từng product_id với MySQL; API có thêm category_name và thứ tự giảm dần như hợp đồng hiện có.
- 21/21 ảnh từ dữ liệu API thật tải HTTP 200 từ frontend, RIFF/WEBP hợp lệ, byte/hash khớp manifest; browser naturalWidth và naturalHeight đều dương và khớp kích thước cuối.
- Browser không mock image_url, không xuất hiện fallback trên 21 sản phẩm, không có request /images/products/ sang backend cổng 3000.
- Tìm kiếm không dấu, lọc danh mục, xóa bộ lọc, sắp xếp giá, tải thêm đủ sản phẩm, fallback/phục hồi khi nguồn thay đổi và CDN cũ: PASS.
- product-images.spec.js đọc manifest trong archive, không còn nhánh mock pre-migration hay ghi evidence vào migration. Thông tin chạy mới dùng Playwright attachments; kết quả/screenshot được Playwright quản lý trong frontend/test-results.
- SHA-256 JSON toàn bộ 21 dòng MySQL trước và sau dọn giống nhau: a626bf3f1367a295d68ad3bf0292142689dd673684c0b7dbc0e9978a05496932.
- ID 3 vẫn có price = 18000.00; ID 13 giữ tên AFP PUPS Candy Chew – Đồ chơi cắn gặm kẹo xoắn cho chó.

Khôi phục khi cần (không chạy restore trong lần dọn này):

Bản sao lưu gốc: original-products.json.
SHA-256: f4e910dbb9ad80904e3d42289f7bed0d661c187d86eaf954021be71a2f4a6548.
Bản sao này giữ byte gốc, gồm dữ liệu trước lần thay ảnh thành công; giá ID 3 trong lịch sử là 956000.00. Tiện ích chỉ đọc URL và tên/mô tả thuộc phạm vi khôi phục, không lấy giá lịch sử để ghi đè.

Tại D:\petcare-website\backend, chạy:

```powershell
node scripts/product-images.cjs audit-applied
node scripts/product-images.cjs restore-dry-run
node scripts/product-images.cjs restore
```

Hai lệnh đầu chỉ SELECT, không ghi dữ liệu; cả hai đã PASS sau khi dọn. Lệnh restore (chỉ chạy khi muốn hoàn tác) dùng transaction và khóa dòng, kiểm tra đúng 21 product_id cùng giá trị image_url hiện tại; kiểm tra thêm name/description ID 3 và 13. Sau đó khôi phục 21 URL cũ và riêng name/description ID 3,13; giữ giá hiện tại 18000 của ID 3 và tất cả trường khác. Dữ liệu lệch hoặc số dòng cập nhật sai sẽ rollback.

Đã kiểm tra hàm khôi phục bằng dữ liệu thật và dữ liệu mô phỏng trong bộ nhớ: giữ các thay đổi ngoài migration; chặn URL/tên bị đổi, ID thiếu và ID trùng. Chưa thực thi ghi khôi phục lên database. Toàn bộ 21 URL cũ là URL Hstatic bên ngoài; khôi phục không cần ảnh ứng viên, staging hoặc ảnh public cũ đã xóa. Khả năng phục vụ các URL ngoài đó sau này phụ thuộc nguồn bên ngoài.

Không có file trong phạm vi dọn còn chưa xác định được tình trạng sử dụng. Hai server local hiện có được giữ chạy.
