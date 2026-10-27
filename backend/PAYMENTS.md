UC15: simulated ONLINE payment
==============================

No schema change or new dependency is needed. Existing UC18 migration columns
and VARCHAR statuses suffice. These routes inherit authenticate + authorize('user')
from routes/orders.js. Mutations recheck the active User role in the transaction.

GET /api/orders/:id/payment
--------------------------
Returns {success,payment} for an owned order. Payment includes payment_id,
order_id, method/status, saved amount (decimal string), transaction_date,
created_at, order_status, approved_at, can_simulate and simulation_only=true.
COD information is readable but cannot be simulated. This GET never mutates
state and uses one joined query for a consistent order/payment snapshot.

POST /api/orders/:id/payment/simulate
-----------------------------------
Accepts EXACTLY one synthetic test-case field:

    {"test_case":"ONLINE_SUCCESS"}
    {"test_case":"ONLINE_FAILURE"}

No card/OTP is required, stored or logged, and no external gateway is contacted.
Unknown fields, amount, payment_status, order_status, user_id, card and otp are
rejected. These fixed demo cases cannot confirm any real payment.

Eligibility: owned ONLINE order; approved_at is nonzero, valid and not later
than database NOW(); order status Chờ thanh toán; no stock restoration marker;
payment status Chưa thanh toán or Thất bại; transaction_date=NULL; saved payment
amount equals saved order total. Client prices/statuses are never used.

Both processed outcomes return HTTP 200 with
{success:true,simulated:true,outcome:"success"|"failure",payment:...}.
- ONLINE_SUCCESS: payment Đã thanh toán, date NOW(), order Chờ giao hàng.
- ONLINE_FAILURE: payment Thất bại, date NULL, order stays Chờ thanh toán.
success:true means the request was processed; outcome/payment_status indicate
the mock payment result. Failure can be retried while eligible. Success cannot
be repeated or overwritten. transaction_date records successful payment only;
the existing payment row stores the latest result, not an attempt history.

401: missing/invalid/expired JWT. 403: non-user role. 404: missing/foreign order.
400: invalid ID, query or body. 409: ineligible state, missing payment, data
inconsistency or lock conflict. can_simulate is advisory; POST rechecks all rules.

Transaction and UC18 integration
--------------------------------
Locks the owned order FOR UPDATE, then its UNIQUE payment row FOR UPDATE,
matching Admin's lock order. Updates commit or roll back together. Concurrent
success requests produce one success and 409 thereafter. Concurrent failures
may precede success but cannot overwrite success. Reload GET after an uncertain
response. No product, stock or cart rows are updated by payment.

Failed ONLINE payment is unpaid for Admin cancellation, and remains blocked
from shipping. Approval/COD behavior is unchanged. Payment and cancellation
serialize: cancellation restores stock once and prevents payment, or successful
payment prevents cancellation without a refund workflow. There is no real
payment, refund or attempt-history implementation in this release.

Verification
------------
npm test covers approval, success/failure/retry, concurrent success, JWT/roles/
ownership, forbidden fields, COD/cancelled/delivered/paid rejection, payment vs
cancellation, COD cash collection and rollback after a real payment write for
both outcomes. Temporary records are deleted; stock held by test orders is
restored. Catalog hashes verify payment itself never changes stock and the
21 products / 5 categories remain identical after cleanup.
