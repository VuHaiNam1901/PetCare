Stage 1 code-review addition: the versioned Online workflow, migrations 006-008,
default-disabled activation and safe test runner are documented in
[STAGE1_ORDER_FOUNDATION.md](STAGE1_ORDER_FOUNDATION.md). The approval-first rules
below continue to describe legacy orders. No application migration is automatic.

Orders: UC09, UC10, UC11
=======================

All endpoints require an active account, JWT Bearer authentication and role user.
Existing API paths remain unchanged. Apply the UC18 migration and then
`npm run migrate:checkout` with application writers stopped before starting the
updated backend. No default admin is created. Checkout migration 004 takes a
verified orders backup, adds/backfills the recipient snapshot, and widens only
delivery address/note character sets to utf8mb4 without shrinking either column.
It verifies that every previous order field and row is preserved. It can safely
be run again; no product, cart, payment, or account data is changed.

Admin order management also requires `npm.cmd run migrate:order-management`
(migration 005). It adds explicit reservation evidence, rejection reasons and
real status history without remapping old states. See ADMIN_ORDERS.md for the
evidence-based reconciliation of existing Checkout v4 reservations.

POST /api/orders
---------------
Required header: Idempotency-Key (16-128 ASCII letters/digits/underscores/hyphens;
a fresh UUID per checkout is recommended, reused for retries).

Example body:

    {"source":"cart","items":[{"product_id":12,"quantity":3}],
     "recipient_name":"Nguyễn Văn A","shipping_address":"123 Example Street",
     "phone":"0123456789","payment_method":"COD","note":"Call on arrival"}

`source` is `cart` or `buy-now`. Select 1-100 distinct products with integer IDs
and quantities from 1 to 2147483647. Buy now accepts exactly one product.
Quantities come from the explicit Checkout snapshot. Prices/totals are calculated
from locked MySQL product rows; client prices, totals, user IDs, status, legacy
cart_item_ids and every other unknown field are rejected.

Cart checkout requires each product to exist in the authenticated owner's cart
with at least the requested quantity. It subtracts exactly that quantity,
deleting the row only when it reaches zero. Other products, remaining quantities
and selection flags are preserved. For example, Checkout quantity 3 against a
merged cart quantity 5 purchases 3 and leaves 2. Buy now never reads or mutates
the cart, even when the product already exists there.

Recipient name is required (1-100); address is 5-255; optional note is at most
200 characters. Phone allows optional +, digits, spaces, parentheses and hyphens,
6-20 characters with at least 6 digits. Strings are trimmed; lengths use UTF-16
units, matching frontend maxLength. Full Unicode is supported. Address/note may
contain CR/LF; other controls and unpaired surrogate characters are rejected.
The note column contains only the user's note. Recipient name, address and phone
are snapshots, so later account changes do not rename prior orders. Legacy names
are backfilled from the account by migration 004. Product names/images continue
to use the current product; order unit prices/subtotals remain snapshots.

Returns 201 {success, order, replayed:false}. Identical key/input returns the
same order with 200 and replayed:true, even after items leave the cart or the
server restarts. Same key with changed normalized input returns 409. Once an
cart quantity is exhausted, a different key for the same cart request returns
409; a new buy-now key represents a deliberate new purchase.

Stock is deducted at creation, under product row FOR UPDATE locks, in the same
transaction as orders/details/payment and exact cart quantity reduction. Buy now
leaves the cart unchanged. Unpaid orders therefore hold stock. New orders record
stock_reserved_at and stock_reservation_source in this transaction. Admin can
reject only an unapproved pending order, with a saved reason; that transaction
restores stock exactly once. Approved orders cannot be cancelled through these
Admin endpoints. Automatic expiry and refunds are not implemented.
All failures before commit roll back stock, cart and the entire order. Retry
lock conflicts with the same key. `ORDER_RETRY` includes `retryable:true`;
`CART_CHANGED`, `PRODUCT_UNAVAILABLE`, `OUT_OF_STOCK` and
`ORDER_TOTAL_TOO_LARGE` are uncommitted validation conflicts.
`IDEMPOTENCY_CONFLICT` means that a key was reused with different normalized data.
An ambiguous network/500 response must be retried with the original key/payload,
because the original COMMIT may already have succeeded. No payment occurs when
an order is created. The HTTP response is sent only after the transaction commits.

GET /api/orders?page=1&limit=20
-----------------------------
Returns {success,page,limit,total,orders}, newest first. Limit max 100. Every
order includes products, quantities, saved prices/totals, method and current
order/payment statuses, approval_state, rejection_reason and recorded history.
GET /api/orders/:id returns {success,order}. Foreign or
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
My Orders reuses `GET /api/orders?page=1&limit=10&status=...`. The optional status
must exactly match the existing order states exported by the admin model. The
response also includes `statuses`; the owner-scoped SQL count and page both use
the filter. `user_id` and other unsupported query parameters are rejected. The
existing `GET /api/orders/:id` returns 404 for another customer's order.
Run `npm run test:my-orders` for status/pagination and cross-account access tests
on the disposable test database; reads are checked to leave order/payment/stock
and cart snapshots unchanged. No schema or write-path changes are required.

Run `npm test` from backend through the isolated test-database runner. Tests must
never target the application database: the runner creates a separate random
test schema from metadata, seeds synthetic products/accounts, applies migrations
there, and drops only that generated test schema. Tests exercise exact cart
quantities after merge, buy now without cart changes, concurrent/later replay,
ownership, strict validation, JWT expiry, and unpaid COD/ONLINE states. Failure
injection after real order/detail/stock writes verifies transaction rollback.
The source database is used only for schema metadata, never test writes.
