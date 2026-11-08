Stage 1 code-review addition: [STAGE1_ORDER_FOUNDATION.md](STAGE1_ORDER_FOUNDATION.md)
describes version 2 Online approval after payment and paid rejection with a
pending refund request. The workflow is disabled by default; the rules below
remain applicable to legacy orders and COD.

Admin order management — current implementation
==============================================

The website now uses the existing JWT login and current database role. Admin
list/detail/action pages call the endpoints below; the backend independently
checks active Admin access, including a role recheck inside each transaction.
No default Admin account or password is created.

Current API contract
--------------------
- GET /api/admin/orders?page=1&limit=20&q=...&status=...&approval=pending
  `q` searches an exact numeric order ID (optional #) or a literal phone substring.
  `%`, `_` and `=` in phone search are escaped, not interpreted as wildcards.
  `approval` optionally accepts pending, approved or rejected. Status filtering
  uses the existing six database values. Pagination count and rows use one
  transaction snapshot; limit is 1-100. Unknown query fields are rejected.
- GET /api/admin/orders/:id returns the saved recipient, address, note, historical
  detail quantities/prices/subtotals, payment, approval, rejection reason and
  recorded history. List rows use the same shape. No current product price is
  used to recalculate an order.
- PATCH /api/admin/orders/:id/approve with {} approves an unapproved pending
  order. COD becomes Chờ giao hàng; ONLINE remains Chờ thanh toán with
  approved_at set and payment still Chưa thanh toán.
- PATCH /api/admin/orders/:id/reject with {"reason":"..."} rejects ONLY an
  unapproved pending order. Reason is 1-500 valid Unicode scalar values after
  trimming, with newlines allowed. It is stored separately from the customer
  note, shown to the customer and recorded in history. The database status stays
  Đã hủy, mapped to the more precise Từ chối label when rejection_reason exists.
- PATCH /api/admin/orders/:id/status with {"status":"Đang giao hàng"} or
  {"status":"Đã giao hàng"} performs exactly one valid delivery step. For COD
  delivery, cod_payment_received:true is mandatory and cash payment is recorded
  in the same transaction. Admin cannot advance Online from Chờ thanh toán to
  Chờ giao hàng; only successful system payment confirmation can do that.

Every order includes approval_state (pending/approved/rejected/legacy),
allowed_actions (approve/reject/ship/deliver), review_required and review_reason.
The UI uses these server decisions; disabled/absent actions are not authorization.
Order/payment state inconsistencies fail closed with 409. Exact repeated
approvals, delivery steps and same-reason rejections are no-ops; no extra audit
event or inventory movement is generated. Conflicting rejection reasons fail.
Unapproved orders may not skip approval, reverse steps or change payment fields.
The earlier cancellation rules described below are superseded: approved orders
cannot be rejected/cancelled by these Admin endpoints, even if still unpaid.

Inventory and concurrency
-------------------------
Checkout already deducts the selected quantities when it commits a real order.
This is the reservation: approval MUST NOT deduct again or compare a zero free
balance with quantities already held by this order. New orders record the actual
stock_reserved_at and stock_reservation_source=checkout-v5 atomically with the
deduction. Approval locks the order/payment, all detail rows and product rows in
product-ID order, checks positive reserved quantities and valid nonnegative
available stock, and keeps the original receipt prices unchanged. Inventory
data requiring review returns 409 with product details where available.

Pending rejection restores the held quantities exactly once, records
stock_restored_at and rejection_reason, changes order/payment to Đã hủy and
appends history in ONE transaction. No cart recreation occurs. Approve/reject
races serialize on the order lock: exactly one outcome can win. An error after
any stock/payment/history write rolls the entire transaction back. Repeated
requests from another Admin use the same locked state, not local process memory.

Migration 005 and existing data
------------------------------
From backend, stop old backend writers and run:

    npm.cmd run migrate:order-management

Then start the updated backend. The additive rerunnable migration backs up ALL
base tables, verifies the backup SHA-256, adds nullable rejection_reason,
stock_reserved_at and stock_reservation_source, and creates order_status_history.
It never rewrites old order status, totals, prices, notes or inventory.

Existing pending orders are reconciled only when their canonical saved items,
recipient/address/phone/note and payment method exactly reproduce the SHA-256
request fingerprint of the Checkout v4 writer (and replay-key hash exists).
That writer reserved inventory atomically at creation, so proven rows receive
stock_reservation_source=checkout-v4-fingerprint. Their stock_reserved_at stays
NULL: no reservation time is invented. The migration reports the number proven
and the number still requiring inventory review. Unproven legacy rows remain
readable, but cannot be approved, restored or paid until an evidence-based
inventory audit is performed separately; there is no repair UI in this change.
Never populate a reservation marker merely to make the buttons available.

History contains history_id, from_status, to_status, action, actor_id,
actor_name (snapshot), created_at and reason. Events are created in the same
transaction for new Checkout creation, approval, rejection, delivery and the
existing payment confirmation mechanism. Actor names and reasons preserve
Unicode. Legacy transitions are not backfilled or assigned invented times.
Customers can read only their own order/history through the existing owner-
scoped API. GET payment also returns current approval_state/rejection_reason
and refuses eligibility when reservation/order/payment data needs review.
This change does not create a payment gateway or add simulation UI/actions.

Verification commands
---------------------
    npm.cmd run test:admin-orders
    npm.cmd test

The runner clones schema only into a random disposable database, seeds synthetic
rows, verifies migration preservation, fingerprint proof, unknown legacy behavior,
no manufactured history and stable reruns, then runs SQL tests. The configured
application database receives no test writes. Tests cover JWT/current-role
authorization, pending COD/Online, reserved free-stock zero, search/pagination,
cash confirmation, duplicate/two-Admin races, invalid transitions, pending-only
Unicode rejection, stock restoration, shortage/overselling and real SQL rollback.

Historical implementation notes (superseded where stated above)
==============================================================

UC18: Admin order management
===========================

Every endpoint requires Bearer JWT, active account and current role `admin`.
Mutations recheck the admin account inside the transaction. User tokens receive
403, missing/invalid/expired JWT receives 401. No default admin is created.

APIs
----
- GET /api/admin/orders?page=1&limit=20&status=Chờ xử lý
  Lists orders with totals, buyer ID/name, shipping information, products and
  payment information. Limit 1-100. Optional exact status filter, URL-encoded.
- GET /api/admin/orders/:id
  Detail with approved_at, stock_restored_at and current payment status.
- PATCH /api/admin/orders/:id/approve (empty body or {})
  COD: Chờ xử lý -> Chờ giao hàng, approved_at=NOW().
  ONLINE: stays Chờ thanh toán, approved_at=NOW(). Payment remains unpaid.
  Repeated approval of an approved nonterminal order is a no-op; it does not
  rewind the status or modify the approval time. Terminal orders return 409.
- PATCH /api/admin/orders/:id/status
  Body {"status":"Đang giao hàng"}, or {"status":"Đã hủy"}.
  To confirm COD delivery AND actual cash collection, explicitly send
  {"status":"Đã giao hàng","cod_payment_received":true}.
  Without explicit cash confirmation COD delivery returns 409. The flag is
  rejected for ONLINE orders or other target statuses. Direct payment fields,
  approval fields, ownership fields and unknown request fields are rejected.

Transition rules
----------------
COD: Chờ xử lý --approve--> Chờ giao hàng -> Đang giao hàng -> Đã giao hàng.
Payment stays Chưa thanh toán until the admin explicitly confirms COD cash
collection at delivery; only then is it Đã thanh toán with transaction_date.

ONLINE: Chờ thanh toán (approved_at=NULL) --approve-->
Chờ thanh toán (approved_at set). It cannot proceed to Chờ giao hàng until a
UC15 simulation succeeds. UC15 moves it to Chờ giao hàng; Admin can then proceed
Đang giao hàng -> Đã giao hàng. See PAYMENTS.md; approval never records payment.
Simulation locks order/payment and requires valid approved_at, order status
Chờ thanh toán and payment status Chưa thanh toán or Thất bại before payment.

Skipping states, going backwards and changing method or payment state directly
are forbidden. Repeating an existing valid status is a no-op. Errors use 400
for invalid input, 404 for missing orders, 409 for rejected transitions or data
requiring review. Unknown legacy/inconsistent payment/order states fail closed.

Cancellation is allowed only from Chờ xử lý, Chờ thanh toán or Chờ giao hàng,
and only while unpaid (including ONLINE payment status Thất bại). Paid orders
need a refund workflow and are rejected.
Đang giao hàng and Đã giao hàng cannot be cancelled here. Cancellation restores
saved detail quantities, sets order/payment to Đã hủy and stock_restored_at=NOW()
in ONE transaction. Repeating cancellation is a no-op. Order/payment row locks
serialize approval/cancellation across instances; product IDs are updated in
ascending order. Overflow/missing products/data errors roll everything back.
No cart items are recreated on cancellation. Automatic expiry/refunds are absent.

Migration and backup
--------------------
Stop all old backend instances before deploying this code. From backend run:

    npm run migrate:admin-orders

Then start the updated app. Do not run old note-envelope writers after migration.
The script obtains a named migration lock and WRITE locks on all base tables,
backs up schema and ALL table rows to backups/uc18-<timestamp>-<uuid>/database.sql,
writes a row-count/hash manifest, verifies the SQL SHA-256, and only then changes
orders. The backup contains private account/order data; backups/ is gitignored.
The current database has 10 InnoDB tables, no views/triggers/routines/events;
the script rejects unsupported stored objects rather than silently omitting them.

Additive schema changes only:
- approved_at DATETIME NULL: explicit ONLINE/COD approval marker.
- stock_restored_at DATETIME NULL: durable one-time stock restoration marker.
- idempotency_key_hash CHAR(64) ASCII binary NULL.
- request_fingerprint CHAR(64) ASCII binary NULL.
- UNIQUE uq_orders_user_idempotency (user_id,idempotency_key_hash).

Existing JSON metadata is validated for duplicate/conflicting keys BEFORE DDL,
then moved to the new columns in atomic per-row updates, retaining plain notes.
Existing orders without a key remain NULL. Audit is required if old progressed
orders have no approval marker or old cancelled orders have no stock marker:
the migration stops rather than guessing history or restoring stock again.
Order counts and existing fields are checked after migration. The script can
resume after interruption; another run backs up again and skips existing DDL.
Initial deployment found 0 orders/payments, so no business data needed backfill.

MySQL DDL implicitly commits. On failure, stop writes, inspect the saved backup,
correct the preflight issue and rerun the additive migration. Do not blindly
drop the new columns or revert to the old writer after new orders are accepted.
For disaster recovery, restore database.sql into a NEW EMPTY database using a
MySQL client, verify manifest counts/content and repoint DB_NAME while the app
is stopped. The dump omits CREATE DATABASE and never runs restoration itself.
Reconcile writes after the backup before switching. Backup files/checksums are
verified; a full disaster-recovery restore has not been executed here.

Verification
------------
npm test runs serial MySQL integration tests in a disposable test database with
synthetic rows. The configured application database is used only for schema
metadata, with no test writes. Temporary accounts include one
temporary role elevation for testing; all are deleted. Tests verify old API
behavior, same-user concurrent/repeated checkout, cross-user key reuse, the
database UNIQUE itself, legacy metadata migration and replay, JWT/admin guards,
COD/ONLINE approval, invalid transitions, cash confirmation, cancellation races
and a failure injected after stock restoration to prove rollback. A paid ONLINE
row is a test-only fixture for shipping transitions, not a payment API.
Cleanup restores only stock still held by test orders and removes test orders,
details, payments, carts and accounts. Migration backups containing fixtures
are also removed after checksum verification. Full hashes verify 21 products
and 5 categories match the pre-test data including stock after cleanup.
