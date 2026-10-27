UC16 / UC17: Admin catalog
=========================

All eight endpoints require an active Admin Bearer JWT. Mutations recheck role
inside the transaction. User tokens return 403; missing/invalid/expired JWT 401.
No schema, frontend or image files are changed. Existing public GET /api/products
and /api/categories retain their original response shapes. Public products now
always include only Đang bán; query parameters cannot override that predicate,
even with an Admin token. Admin routes continue to list both product statuses.

Products
--------
- GET /api/admin/products?page=1&limit=20&q=food&category_id=1&status=Đang bán
  Optional min_price/max_price filters; name search treats %, _ and = literally.
  Fixed newest-ID-first ordering. Limit 1-100. Returns success,page,limit,total,
  products (including category_name). Unknown/invalid filters return 400.
- POST /api/admin/products: required name,category_id,price,stock_quantity,image_url;
  optional description (default null), status (default Đang bán). Returns 201.
- PUT /api/admin/products/:id: updates one or more of the same fields. Unknown
  fields/empty body rejected. IDs and created_at cannot be overwritten.
- DELETE /api/admin/products/:id: ALWAYS soft-stops as Ngừng bán, returns
  {success:true,action:"discontinued",product:...}. Repeat is safe. Never deletes
  the product, any order detail/cart item/review, or an image file. PUT status
  Đang bán may reactivate a product. Missing product returns 404.

Validation: name trimmed/nonempty max150; description nullable and within MySQL
TEXT UTF-8 byte capacity. Price accepts JSON number or decimal string, 0 through
9999999999.99, max two decimal places; responses use decimal strings. Stock is a
JSON integer 0..2147483647. Category ID is a positive JSON integer and must exist.
Status accepts the existing Đang bán and the stop value Ngừng bán. utf8mb3-
unsupported characters and inappropriate controls are rejected.
image_url must be an internal /images/products/... path, max500, ASCII safe path
segments and webp/png/jpg/jpeg/gif/avif extension; external URLs, traversal,
percent encoding, queries, fragments and backslashes are rejected. Validation
checks the stored path, not file existence; there is no upload/delete/file edit.

Categories
----------
- GET /api/admin/categories -> {success,total,categories}, ordered by category_id.
- POST /api/admin/categories -> 201 {success,category}. Required name (max100),
  optional nullable description (max255).
- PUT /api/admin/categories/:id -> {success,category}; partial name/description.
- DELETE /api/admin/categories/:id -> {success,category_id,deleted:true}, only if
  no products refer to it, INCLUDING discontinued products. Otherwise 409.
  Missing ID returns 404. Database UNIQUE name conflicts return 409.

Safety and compatibility
------------------------
All values use parameterized SQL. Updates lock product/category rows; category
validation uses shared parent locks, coordinating with category deletion and
foreign keys. Product soft-stop serializes with checkout product locks. Lock
timeouts/deadlocks return 409 for retry. No schema modification is necessary.
Order headers, saved unit prices/subtotals, payments and stock reservations are
not rewritten by catalog changes. Existing order detail APIs still display the
current product name/image because the schema does not snapshot those fields.
Public products exclude stopped products; cart add/update and checkout reject
them, including items added before discontinuation (409 with an availability
message). Existing cart rows and order history remain readable and intact.
Admins may edit stock as an absolute inventory value under a row lock.

Tests
-----
npm test creates temporary categories/products/accounts. It checks all eight
Admin guards, add/edit/list/search/filter/pagination, zero/invalid prices and
stock, invalid categories/status/image paths, duplicate names, stop/reactivate,
order/cart/review reference retention, unchanged saved order/payment records,
used-category rejection and concurrent product-create/category-delete safety.
Cleanup deletes ONLY test records; full catalog hashes verify original 21
products and 5 categories are identical, including stock. Image files are never
opened for writing or deletion. No default Admin account is created.
