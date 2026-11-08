# Giỏ hàng và xác thực PetCareShop

## Các trang và thành phần dùng chung

- `/cart`: giỏ hàng cho khách hoặc tài khoản User.
- `/checkout`: thông tin nhận hàng, phương thức thanh toán, kiểm tra sản phẩm và tạo đơn qua API; ONLINE vẫn chờ Admin duyệt trước khi thanh toán mô phỏng.
- `/login`: đăng nhập thật, dùng chung cho User và Admin.
- `/register`: đăng ký công khai, chỉ tạo tài khoản User. Đăng ký thành công chuyển về đăng nhập; giỏ khách và ý định mua được giữ lại.

Đăng nhập thông thường từ Header đưa User về `/`; Admin cũng về `/` vì chưa có trang quản trị frontend. Đồng bộ/hợp nhất giỏ không quyết định URL sau đăng nhập. Chỉ luồng Đặt hàng/Mua ngay đang thực hiện, hoặc `returnTo` nội bộ hợp lệ được yêu cầu rõ ràng, mới thay đổi đích đến.

Các trang dùng Header, Footer, Logo, màu xanh biển và font hiện có. `CommerceProvider` trong `src/context/CommerceContext.jsx` quản lý trạng thái dùng chung; `src/services/commerce.js` gọi backend. `CartPage.jsx`, `AuthPage.jsx` và `commerce.css` chỉ phụ trách giao diện.

Chưa triển khai giao diện quản trị riêng. Backend vẫn quyết định vai trò và chủ giỏ từ tài khoản của JWT; Admin không được gọi API giỏ User hoặc đặt hàng với vai trò khách hàng.

## Giỏ khách và dữ liệu giá

Khách được thêm, sửa số lượng, xóa và chọn sản phẩm trước khi đăng nhập. Badge giỏ hàng ở Header hiển thị số sản phẩm khác nhau trong toàn bộ giỏ, không cộng số lượng và không phụ thuộc checkbox; giỏ trống thì ẩn badge. Quy tắc này áp dụng cho cả giỏ khách và giỏ tài khoản sau tải lại, đăng nhập hoặc hợp nhất. Thẻ sản phẩm thêm 1; trang chi tiết thêm số lượng đang chọn. Sản phẩm trùng cộng số lượng và được kiểm tra lại với tồn kho hiện tại.

Giỏ khách chỉ lưu `product_id`, `quantity` và `selected`. Tên, ảnh, giá, trạng thái và tồn kho được lấy lại bằng `POST /api/cart/preview`; giá lưu trong trình duyệt không được dùng để tính tiền. Endpoint này chỉ đọc catalog theo các ID được gửi, không truy cập giỏ tài khoản, không tạo đơn và không trừ tồn kho.

Sản phẩm ngừng bán, hết hàng, không còn tồn tại hoặc có số lượng vượt tồn kho vẫn được hiển thị trong giỏ với lý do. Các dòng không hợp lệ không được chọn đặt hàng. Người dùng có thể xóa; dòng vẫn đang bán và còn tồn kho có thể sửa số lượng về giới hạn hợp lệ. Không tự giảm số lượng hoặc bỏ sản phẩm khi hợp nhất thất bại.

Checkbox Chọn tất cả chỉ áp dụng cho các dòng hợp lệ. Tóm tắt “Đã chọn X sản phẩm (Y món)” dùng X là số dòng, Y là tổng số lượng của các dòng được chọn. Tạm tính chỉ gồm các dòng đó; phí vận chuyển hiển thị “Tính ở bước đặt hàng”. Nút Đặt hàng bị khóa khi chưa có lựa chọn hợp lệ hoặc giỏ còn chờ đồng bộ.

## Lưu trữ trong trình duyệt

| Nơi lưu | Khóa | Nội dung |
| --- | --- | --- |
| localStorage | `petcare.guest-cart.v1` | `{version:1,items:[{product_id,quantity,selected}]}`; giỏ khách và lựa chọn qua tải lại trang. |
| localStorage | `petcare.guest-merge.v1` | Khóa UUID, tài khoản đích và bản items của lần hợp nhất chưa được xác nhận. Giữ nguyên yêu cầu khi retry. |
| localStorage | `petcare.checkout-intent.v1` | Ý định `cart` hoặc `buy-now`, các ID/số lượng, trạng thái đã xác thực và thời điểm lưu. Mua ngay có sản phẩm/số lượng riêng. |
| sessionStorage | `petcare.auth.token.v1` | JWT do API đăng nhập thật cấp; không chứa mật khẩu. |
| sessionStorage | `petcare.auth-redirect.v1` | Ngữ cảnh điều hướng một lần cho Đặt hàng/Mua ngay, gắn với ID ý định mua và tham số `flow` trên URL. |
| sessionStorage | `petcare.checkout-draft.v1` | Snapshot ID/số lượng của lần mua, chủ tài khoản, thông tin nhận hàng, phương thức thanh toán và giá API tham chiếu để báo thay đổi. |
| sessionStorage | `petcare.flash.v1` | Thông báo cần hiển thị sau điều hướng tài liệu. |

Mỗi lần khởi tạo trang có token, frontend gọi `/api/auth/me` để kiểm tra phiên và lấy vai trò hiện tại. Token hết hạn hoặc tài khoản không còn hợp lệ làm xóa trạng thái tài khoản trên frontend; dữ liệu giỏ MySQL được giữ nguyên. Bản guest/merge chưa được xác nhận vẫn được giữ để đăng nhập và thử lại.

Đăng xuất xóa token, trạng thái giỏ tài khoản, ý định mua, bản nháp checkout và ngữ cảnh điều hướng ở frontend, rồi chuyển đến `/login`. Giỏ tài khoản không được sao chép thành giỏ khách; dữ liệu tài khoản vẫn nằm trong MySQL. Lần đăng nhập thường tiếp theo về trang chủ. Phiên hiện tại dùng JWT có thời hạn của API hiện có, không có luồng refresh token trong frontend.

Luồng mua đang thực hiện giữ cùng `flow` khi chuyển qua lại giữa đăng nhập/đăng ký hoặc đăng ký thành công. Sau xác thực và đồng bộ thành công, frontend khôi phục lựa chọn rồi xóa `petcare.auth-redirect.v1`; dữ liệu ý định mua được giữ riêng với `authenticated: true` và không kích hoạt redirect nữa. Khi hợp nhất chưa được xác nhận, `flow` còn trên `/cart` để tải lại/thử lại tiếp tục đúng yêu cầu. Ngữ cảnh không khớp ý định mua hoặc quá 30 phút không được tiếp tục. Bấm đăng nhập từ Header bắt đầu luồng thường và bỏ ngữ cảnh mua cũ, vẫn giữ giỏ khách.

`returnTo` chỉ chấp nhận đường dẫn nội bộ của các trang đã có (`/`, `/products`, `/products/:id`, `/cart`, `/checkout`, kèm query/hash). URL ngoài, URL dạng `//`, dấu gạch chéo ngược, đường dẫn mã hóa dấu gạch chéo, trang đăng nhập/đăng ký và đường dẫn chưa có đều bị bỏ qua.

## API được sử dụng

Origin backend được dùng chung từ `src/services/api.js`.

| API | Xác thực | Vai trò và tác dụng |
| --- | --- | --- |
| `POST /api/auth/register` | Công khai | Nhận `full_name`, `email`, `password` và các trường tùy chọn API hiện có; backend kiểm tra dữ liệu, băm mật khẩu và tạo User. Không tự đăng nhập. |
| `POST /api/auth/login` | Công khai | Kiểm tra mật khẩu thật; trả JWT và thông tin tài khoản an toàn. |
| `GET /api/auth/me` | Bearer JWT | Đọc tài khoản/vai trò còn hoạt động từ MySQL. |
| `POST /api/cart/preview` | Công khai | `{items:[{product_id,quantity,selected}]}`; chỉ phân giải dữ liệu catalog mới nhất cho giỏ khách. |
| `GET /api/cart` | User JWT | Đọc giỏ của tài khoản đã xác thực, bao gồm trạng thái chọn và tính hợp lệ của từng dòng. |
| `POST /api/cart/items` | User JWT | `{product_id,quantity}`; thêm hoặc cộng số lượng với kiểm tra tồn kho/trạng thái. |
| `PUT /api/cart/items/:id` | User JWT | `{quantity}`; thay số lượng của dòng thuộc chính giỏ tài khoản. |
| `DELETE /api/cart/items/:id` | User JWT | Xóa dòng thuộc chính giỏ, kể cả khi sản phẩm không còn hợp lệ để mua. |
| `PUT /api/cart/selection` | User JWT | `{product_ids:[...]}`; thay lựa chọn bằng các sản phẩm hợp lệ thuộc giỏ. |
| `POST /api/cart/merge` | User JWT | Body items của giỏ khách, header `Idempotency-Key` là UUID; hợp nhất bằng transaction. |

Frontend không gửi `user_id`, giá hoặc tổng tiền để backend tin làm dữ liệu giỏ. API xác thực xác định tài khoản; các endpoint bảo vệ từ chối thiếu/sai token, vai trò không phù hợp, dòng giỏ người khác và số lượng không hợp lệ. Chi tiết kiểm tra đầu vào nằm trong [AUTH.md](../backend/AUTH.md) và [CART.md](../backend/CART.md).

## Hợp nhất sau đăng nhập

1. Frontend giữ bản guest cùng lựa chọn và lưu marker với UUID trước khi gửi hợp nhất.
2. Backend khóa tài khoản/giỏ trong transaction, lấy trạng thái và tồn kho từ MySQL, kiểm tra toàn bộ số lượng sau khi cộng trùng.
3. Nếu có xung đột, transaction không ghi một phần. API trả danh sách sản phẩm/lý do và số lượng/tồn kho để người dùng điều chỉnh. Giỏ khách vẫn còn, Đặt hàng chưa được phép tiếp tục.
4. Nếu hợp lệ, backend giữ sản phẩm của cả hai giỏ, cộng dòng trùng và chỉ áp dụng lựa chọn từ bản guest; không tự chọn thêm sản phẩm khác trong giỏ tài khoản.
5. Metadata gồm hash khóa và fingerprint yêu cầu được commit cùng thay đổi giỏ. Retry cùng tài khoản/khóa/nội dung đọc lại kết quả mà không cộng thêm. Dùng cùng khóa với nội dung khác bị từ chối.
6. Frontend chỉ xóa guest/marker sau khi server xác nhận và dữ liệu lưu tại trình duyệt còn phù hợp với bản đã gửi. Khi mất phản hồi, marker và payload được giữ nguyên; thao tác sửa/đặt hàng được khóa cho tới khi retry xác nhận kết quả. Xung đột đã xác định cho phép điều chỉnh và gửi một lần hợp nhất mới.

Trường hợp bản guest bị thay đổi từ cửa sổ khác trong lúc đang hợp nhất được chặn để giữ dữ liệu và tránh cộng lặp; chưa có giao diện hòa giải hai phiên bản giỏ khác nhau. Không tự bỏ bản guest mới hoặc tạo khóa mới để cộng lại bản cũ đã được server nhận.

## Đặt hàng và Mua ngay trong phạm vi hiện tại

Trang `/checkout` tạo đơn qua API bằng đúng snapshot sản phẩm/số lượng, lưu mã đơn sau commit và giữ key khi retry/đăng nhập lại. Không tự gọi thanh toán mô phỏng. Chi tiết trong [CHECKOUT.md](CHECKOUT.md).

- Đặt hàng chụp lại chính xác các dòng được tích chọn và số lượng rồi mở `/checkout`. Khách được yêu cầu đăng nhập/đăng ký, chờ hợp nhất được xác nhận mới tiếp tục checkout. Nếu giỏ khách A×3 hợp nhất với tài khoản A×2 thì giỏ vẫn A×5, còn checkout giữ ý định mua A×3.
- Mua ngay lưu ý định riêng cho một sản phẩm, số lượng 1 trên thẻ hoặc số lượng đã chọn ở chi tiết. Không thêm sản phẩm đó vào giỏ, không xóa giỏ hoặc lấy các dòng khác làm đơn. Nếu cần đăng nhập, ý định riêng vẫn được giữ qua đăng ký/đăng nhập. Hợp nhất giỏ khách hiện có vẫn là bước đồng bộ tài khoản chung, không biến toàn bộ giỏ thành nội dung Mua ngay.
- Checkout gọi API preview khi tải và trước lần tạo đơn mới; giữ cả dòng hết hàng, thiếu kho, ngừng bán hoặc mất sản phẩm để hướng dẫn sửa. Xác nhận tạo đơn lưu MySQL và chỉ giảm đúng số lượng đã mua; retry yêu cầu đang chờ kết quả dùng lại key/payload, không bị preview chặn. Phí vận chuyển chưa có quy tắc nên hiển thị “Chưa xác định”, tổng chưa gồm vận chuyển.

## Migration và backup

Giỏ tài khoản tái sử dụng `carts`, `cart_items` và cột `selected` hiện có. Migration bổ sung [003-cart-merge.js](../backend/migrations/003-cart-merge.js) chỉ tạo bảng `cart_merge_requests` để lưu hash khóa/fingerprint, với unique index theo tài khoản và khóa. Migration không reset database, không ALTER/backfill các bảng cũ và không tự dọn dữ liệu trùng.

Lệnh chạy từ thư mục backend:

```powershell
npm.cmd run migrate:cart-merge
```

Trước khi chạy trên database khác, cần sao lưu schema và dữ liệu hiện có. Ở workspace này, snapshot trước migration đã được lưu tại [cart-feature-before-1793329765737.json](../backend/backups/cart-feature-before-1793329765737.json), gồm schema, rows và SHA-256. File backup thuộc thư mục local bị Git ignore; tài liệu không nhúng nội dung dữ liệu hoặc thông tin đăng nhập. Migration đã được áp dụng trong workspace hiện tại; không cần reset database để dùng chức năng mới.

## Kiểm tra

Frontend:

```powershell
npm.cmd run build
npm.cmd run test:checkout
```

`tests/cart-auth.spec.js` dùng API fixture có kiểm soát để kiểm tra chuyển trạng thái trình duyệt: guest CRUD/lựa chọn/tải lại, giá mới, dòng không hợp lệ, đăng ký/đăng nhập giữ ý định, hợp nhất/lỗi/retry, đăng xuất, Mua ngay và Admin. Fixture UI không chứng minh được transaction hoặc quyền truy cập MySQL thật.

Integration test backend:

```powershell
npm.cmd test -- tests/cart-merge.test.js
```

Test backend dùng MySQL trong database `petcare_test_<uuid>` riêng, chỉ sao chép schema và tạo dữ liệu tổng hợp. Runner kiểm tra định danh trước khi tạo/xóa database test, không ghi tài khoản/đơn/tồn kho vào database ứng dụng. Chạy test trực tiếp ngoài runner sẽ bị chặn. Các bài catalog/chi tiết trong bộ frontend mặc định vẫn đọc dữ liệu sản phẩm thật; bộ `test:checkout` dùng catalog tổng hợp và không cần MySQL.

