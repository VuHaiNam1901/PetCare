# Order foundation, Stage 1

This release is code for review. No application migration or activation is part
of its test commands. All four switches in `.env.example` default to `0`; the
real `.env` is not edited. Frontend and VNPAY integration are outside this release.

## Compatibility and activation

Only newly created ONLINE orders can have `workflow_version=2`. Creation needs
all of `PETCARE_ORDER_WORKFLOW_ENABLED`, `PETCARE_ORDER_FRONTEND_READY` and
`PETCARE_ORDER_EXPIRY_ENABLED` set to `1`, plus verified schema 006/007 readiness.
Inconsistent activation fails closed. Default-disabled checkout still uses the
existing workflow and does not reference undeployed columns. COD stays legacy
with a NULL version/deadline. Existing order fingerprints and replay keys keep
their canonical payload; Voucher is not added to checkout input.

Migration does not backfill any legacy row. This includes orders 173/174 and
their payment, recipient, inventory markers and history. Worker selection uses
the version/deadline, never a hardcoded list of exempt order IDs. Legacy policy
and Admin transitions are retained. The simulation endpoint now additionally
requires explicit test isolation so it cannot manufacture receipts on real data.

The frontend still requires approval before Online payment. Do not enable v2
creation for that frontend. Backend API paths/envelopes and the existing payment
summary remain; v2 adds deadline/version/refund information, `awaiting_payment`
and `cancelled` approval states, and updated server `allowed_actions`.

## Migration sequence

1. `006-order-payment-lifecycle.js`: nullable order workflow version, UTC creation
   and payment deadline, cancellation metadata; nullable history event key and
   unique `(order_id,event_key)`; checksummed migration ledger.
2. `007-payment-attempts-refunds.js`: `payment_attempts`, verified `payment_events`,
   `refund_requests`, `refund_events`. Keep `payments.order_id` UNIQUE. Record
   expected and actually captured amounts separately, provider time versus
   receipt time, captured-but-unapplied disposition, per-receipt refund business
   keys, provider refund references and confirmation evidence. Finance FKs
   restrict deletion.
3. `008-voucher-foundation.js`: `vouchers`, `voucher_redemptions`, nullable order
   subtotal/discount/code snapshots. No vouchers seeded, API or redemption
   writer. Quota consumption semantics belong to a later feature.

Each module exports `migrate(pool, options)`, `verify(db)` and `plan`. Loading a
module has no DB side effects. `migrate(pool)` is inspection only, and direct CLI
accepts only `--dry-run`. Never replay 001-005 for this release.

Apply to generated test schemas requires `apply:true`, exact `expectedDatabase`,
`isolatedTest:true` and the matching test environment guard. Application apply
requires a separately authorized operational caller with
`allowApplicationDatabase:true`, exact target, `assertWritersStopped` and
`verifyBackup` callbacks. These callbacks are not supplied by an automatic
production command. No automatic restore, session termination or destructive
down migration is provided.

The helper validates MySQL version, engine, stored objects, column definitions,
indexes, FK rules, enforced CHECK expressions and completed dependency checksums.
Progress is journaled before each additive DDL step. An interrupted ALTER resumes
only missing expected steps; drift or a malformed existing table stops for review.
Existing table values are hashed before/after apply; old fields must not change.
DDL has implicit commits, so failure leaves a documented phase, not an assertion
that the entire migration was transactionally rolled back.

## Payment, inventory and refunds

Checkout deducts available stock once and records real reservation evidence.
For v2, one SQL INSERT sets UTC creation and creation+24h deadline. Payment
attempts/retries never extend it. Success changes Online to `Chờ xử lý`, keeps
`approved_at=NULL`, and waits for Admin. Approval changes to `Chờ giao hàng`
without another inventory deduction. COD cash confirmation remains on delivery.

Every settlement/rejection/expiry serializes on the order, then payment and
attempt/refund rows, then inventory lines/products in ascending ID order.
Cancellation, conditional `stock_restored_at`, stock additions and audit history
commit together. Repeat actions are no-ops or conflicts, never a second release.

Provider evidence is verified inside the backend adapter. Caller fields such as
`verified:true` are not trusted. Stage 1 supplies only a WeakSet-branded in-process
SIMULATOR, gated by explicit opt-in AND `NODE_ENV=test` AND the selected random
isolated schema matching all `PETCARE_TEST_*` identity checks. There is no VNPAY
adapter, callback URL or external gateway call. The HTTP simulation endpoint
still accepts only the two fixed test cases; timestamps/amount/status cannot be
asserted by its caller. No simulator receipt or refund can be minted on real data.

A verified provider payment must match amount/currency/reference and have a
plausible UTC timestamp at/after attempt creation, before the fixed deadline,
and no later than backend DB time. An on-time provider receipt can apply after
callback delay only while the order remains unpaid, active and stock-held.
At exactly the deadline provider payment is late. Expiry and settlement share
locks: if cancellation already won, even an on-time provider receipt cannot
resurrect the order. It is retained for reconciliation/refund. Unknown/future
timestamps fail closed. Verified amount mismatches retain the actual amount.

Deduplication precedes deadline decisions. Replays after 24h retain an earlier
accepted result; failures do not downgrade success. Multiple successful captures
apply at most once; excess receipts are tracked separately for refund. Additional
transactions on one attempt retain their own payment-event/refund relationship.

Paid rejection retains the original paid summary and transaction date, releases
stock once and creates `requested`. A request or gateway timeout is not refund
success. Only verified matching provider refund evidence may mark `succeeded`;
replayed/conflicting provider event IDs and reused provider refund references
are rejected/deduplicated. No public endpoint accepts a refund-success flag.

## Worker and operations

The HTTP entry point starts the worker only with explicit expiry activation,
after schema readiness checks. Importing the app in tests never starts a worker.
An immediate startup sweep catches downtime; further sweeps run every 30 seconds.
Local overlap is suppressed; row locks/SKIP LOCKED and durable markers protect
multiple instances. Cursor-based catch-up prevents early damaged/locked orders
from starving later batches. Logs report counts and sanitized per-order errors.

The deadline is fixed at 24h; physical release may lag by a scan or backend
downtime. Monitor worker errors, overdue backlog and last successful execution.
Calls to an eventual gateway must happen outside held database transactions.

## Safe verification

Use `npm run test:stage1` or `npm run test:stage1:regression` for this release.
The old `npm test` runner is not used here: it invokes historical migrations.

The Stage 1 runner reads source schema metadata in a READ ONLY transaction,
copies no source rows, creates a fresh `petcare_test_<32 hex>` schema, seeds
invented fixtures (including synthetic IDs 173/174) and applies only 006-008.
It deliberately interrupts an additive DDL in the test schema, resumes it, reruns
migrations and compares all pre-existing synthetic values. Regression mode runs
an explicit legacy test allowlist with v2 disabled, followed by v2 tests. The old
test that invokes migration 001 is excluded. Generated schemas are retained for
review; no database DROP/restore is performed by this runner.

## Before any real migration

Obtain explicit approval of code, schema diff, exact database and deployment
window. Stop/verify all writers and workers. Create a fresh complete backup and
verify a restore in a separately approved empty recovery environment; do not
automatically restore any database. Capture all old business-field hashes and
separate snapshots of orders 173/174. Review preflight output and apply 006,007,008
in order through the guarded operational API, then compare hashes and run reads.
Leave workflow/frontend/simulator activation off until separately approved.

On failure keep writers stopped, inspect ledger/actual schema and resume only
reviewed additive steps. Prefer disabling new entry/worker and deploying a
compatible fix, retaining financial audit tables. Once v2 orders exist, the old
binary cannot safely interpret them; do not blindly revert binaries, drop audit
tables or restore an old backup over newer financial transactions.
