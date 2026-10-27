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
npm test runs serial MySQL integration tests. Temporary accounts include one
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
