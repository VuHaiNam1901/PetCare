UC14: product reviews
====================

GET /api/products/:id/reviews?page=1&limit=20
Public, returns {success,page,limit,total,reviews}. Limit 1-100, newest date/ID
first. Public fields: review_id,rating,comment,created_at,reviewer_name. No email,
phone,address,user_id,password or private order data is selected. Product must
exist but need not be for sale; no hidden product information is returned.

POST /api/products/:id/reviews
Requires active User Bearer JWT. Only {"rating":5,"comment":"Good product"}
is accepted. Reviewer identity comes from authentication. Integer rating 1-5,
nonempty text 1-2000 characters. No upload/image/video fields. HTML markup is
rejected, unsafe control/bidi characters are removed, text normalized to NFC.
Unsupported utf8mb3 characters are rejected. Response text is HTML-escaped,
including legacy comments/author names, and should be rendered as plain text.
The database stores normalized plain text, not escaped text. No moderation,
review editing or deletion endpoints are included.

Eligibility requires a positive-quantity order_detail for that product in the
same User's order with status exactly Đã giao hàng. Product being Ngừng bán does
not invalidate a prior delivered purchase or hide published reviews. Locked
authors' existing reviews stay visible. The active User row is locked, purchase
eligibility rechecked and review inserted in one transaction. UNIQUE at DB level
enforces one review per (user_id,product_id), including concurrent requests.

GET /api/users/me/reviews?page=1&limit=20
Requires active User JWT. Same pagination. Returns only their own reviews with
product_id,product_name,image_url,product_status. Ownership cannot be overridden.

Errors: 400 malformed input/query; 401 JWT; 403 role/locked/not delivered purchase;
404 missing product; 409 duplicate review or lock conflict. Existing APIs and
order/payment workflows are unchanged.

Migration
---------
Inspection found reviews had FK indexes but NO UNIQUE(user_id,product_id), and
no duplicate pairs. Run `npm run migrate:reviews` before deploying elsewhere.
002-reviews-unique.js locks reviews, backs up its schema/data with SHA-256
manifest under gitignored backups/uc14-*/, aborts rather than deleting duplicate
rows, then adds uq_reviews_user_product. Re-running with the UNIQUE is a no-op.
MySQL DDL commits implicitly. Stop old writers before migration; on errors keep
the backup and resolve duplicates through a separately approved plan. Backup SQL
can restore reviews into a separate empty recovery database with its FK parents;
never blindly overwrite live data. No existing review data is deleted/modified.
001-admin-orders exports its existing backup helper for this migration; its
default backup prefix and migration behavior remain unchanged.

Tests
-----
Run `node --test --test-isolation=none tests/reviews.test.js` in a restricted
environment, or npm test normally. Temporary Users/Admin/products/category and
synthetic order fixtures test delivered eligibility, pending/foreign rejection,
duplicate/concurrent submission, UNIQUE enforcement, invalid rating/comment/
impersonation, JWT/locked/roles, discontinued products, public privacy and own
review isolation. Tests do not change real orders/payment or original products.
Cleanup removes only fixtures; full catalog hashes verify 21 products and 5
categories remain identical. No default Admin is created.
