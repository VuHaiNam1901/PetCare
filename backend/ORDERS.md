Orders: UC09, UC10, UC11
=======================

All endpoints require an active account, JWT Bearer authentication and role user.
Existing API paths remain unchanged. Run the UC18 migration before starting the
updated backend (see ADMIN_ORDERS.md). No default admin is created.

POST /api/orders
---------------
Required header: Idempotency-Key (16-128 ASCII letters/digits/underscores/hyphens;
a fresh UUID per checkout is recommended, reused for retries).

Example body:

    {"cart_item_ids":[12,14],"shipping_address":"123 Example Street",
     "phone":"0123456789","payment_method":"COD","note":"Call on arrival"}

Select 1-100 distinct owned cart_item_ids. Quantities come from the selected cart
rows; prices come from locked product rows, not client values. Unknown fields
(including user_id, totals, prices, status) are rejected. Note is optional, max
200 characters. The note column contains only the user's note.
Address length is 5-255; phone allows optional +, digits, spaces, parentheses and
hyphens, 6-20 characters with at least 6 digits. utf8mb3-incompatible characters
and control characters are rejected. Recipient name uses the current account
full_name, as orders has no recipient column. Product names/images also use the
current product; unit_price/subtotal and shipping address/phone are snapshots.

Returns 201 {success, order, replayed:false}. Identical key/input returns the
same order with 200 and replayed:true, even after items leave the cart or the
server restarts. Same key with changed normalized input returns 409. Once an
item is checked out, a different key with the old item ID also returns 409.

Stock is deducted at creation, under product row FOR UPDATE locks, in the same
transaction as orders/details/payment/cart removal. Only selected rows are
removed. Unpaid orders therefore hold stock. UC18 admin cancellation restores
stock exactly once before shipment. Automatic expiry and refunds are not implemented.
All failures before commit roll back stock, cart and the entire order. Retry
lock conflicts with the same key. No automatic retry or duplicate payment occurs.

GET /api/orders?page=1&limit=20
-----------------------------
Returns {success,page,limit,total,orders}, newest first. Limit max 100. Every
order includes products, quantities, saved prices/totals, method and current
order/payment statuses. GET /api/orders/:id returns {success,order}. Foreign or
missing order IDs return 404. Users cannot mutate status or payment.
order_id is the order code in the existing schema. Money is decimal strings.

Status contract
---------------
Schema status columns are VARCHAR; no enum/schema change is necessary.
Initial COD: `Chờ xử lý`. Initial ONLINE: `Chờ thanh toán`.
Initial payment for BOTH: `Chưa thanh toán`; transaction_date=NULL.
Additional order values: `Chờ giao hàng`, `Đang giao hàng`, `Đã giao hàng`,
`Đã hủy`. Additional payment values: `Đã thanh toán`, `Thất bại`, `Đã hủy`.
COD moves to Chờ giao hàng only after admin confirmation. ONLINE must not be
payable until admin approval. UC18 adds approved_at and admin approval APIs;
UC15 now provides simulated ONLINE payment only (see PAYMENTS.md). See
ADMIN_ORDERS.md for transitions and COD cash collection confirmation on delivery.

Schema findings and durable idempotency
--------------------------------------
InnoDB tables and FKs permit atomic checkout. payments.order_id and carts.user_id
are UNIQUE; cart_items has UNIQUE(cart_id,product_id). UC18 adds dedicated
idempotency_key_hash and request_fingerprint columns, with a database UNIQUE on
(user_id,idempotency_key_hash). The migration moves legacy JSON note envelopes
to those columns and restores note to plain user text. Hashes/fingerprints are
not returned by the API. Matching uses the unique index and the same owner-row
lock used by cart operations across application instances. Older orders without
a replay key retain NULL keys. Cancellation retains the original key: a new
purchase needs a new key.

Tests
-----
Run npm test from backend. Files run sequentially so catalog snapshot checks do
not overlap temporary order stock deductions. Tests create unique accounts,
exercise real SQL checkout/partial checkout/multi-item purchase, concurrent and
later replay, ownership, validation, JWT, and unpaid COD/ONLINE states. A payment
insert failure is injected after real stock/detail writes to verify rollback.
Unavailable/out-of-stock reads are simulated inside the test process, avoiding
changes to product status. Cleanup restores only stock used by test orders and
deletes only their records, in a transaction. Full catalog hashes before/after
verify all 21 products and 5 categories are unchanged after cleanup.
