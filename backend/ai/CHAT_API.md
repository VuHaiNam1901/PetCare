# Chat API and conversation storage

`POST /api/chat` accepts guests and active accounts whose current role is `user`.
When an `Authorization` header is supplied, the existing authentication middleware
validates the bearer JWT and reads the account's current status and role. Invalid,
expired, inactive, and disallowed credentials never fall back to guest access.

```http
POST /api/chat
Content-Type: application/json
Authorization: Bearer <optional account JWT>

{
  "message": "Tôi muốn tìm thức ăn cho chó",
  "request_id": "4e55c407-9b05-4d61-83b2-dc5902fabdc9"
}
```

Only `message`, `request_id`, and optional `session_id` are accepted. `message`
must contain 1–2000 Unicode characters and cannot consist only of whitespace.
Unsafe ASCII control characters are rejected; tabs and line breaks are allowed.
`request_id` must be a UUID. Clients generate a new UUID for each new turn and
retain the same UUID, exact message, and session token when retrying that turn.
Clients cannot supply account IDs, prior history, model options, modes, or filters.
Idempotency is scoped to a conversation. If the first HTTP response is lost
before the client receives its session token, retrying without that token creates
a new conversation; a UUID alone cannot safely identify an anonymous caller.

A successful response has this shape, with the assistant's documented optional
fields such as `warnings`, `intent`, `mode`, `model`, and `care_advice` included
when present:

```json
{
  "success": true,
  "session_id": "<opaque conversation capability>",
  "request_id": "4e55c407-9b05-4d61-83b2-dc5902fabdc9",
  "message": "...",
  "products": [],
  "follow_up": "...",
  "code": "OK",
  "replayed": false
}
```

Send the returned `session_id` with subsequent turns. It is an 87-character token
containing 32 random bytes and an HMAC-SHA256 signature using the application's
existing JWT secret with a separate chat-specific signing domain. It encodes no
account identifier. A guest token is a bearer capability for that conversation;
an account token additionally requires the same authenticated account. Changing
between guest and account use requires a new conversation. Do not log session
tokens, JWTs, model requests, or secrets. Rotating the JWT secret invalidates
existing session capabilities as well as account tokens.

| Status | Meaning |
| --- | --- |
| 400 | Invalid fields, message, or UUID |
| 401 | Missing/invalid bearer credentials when an authorization header was supplied |
| 403 | Inactive/disallowed account, forged token, or conversation ownership mismatch |
| 409 | Session lock is busy, or this request UUID was used with a different message |
| 429 | IP or session request quota exceeded; honor `Retry-After` |
| 503 | Chat capacity exhausted (`CHAT_BUSY`), catalog/model unavailable, or response could not be atomically saved |
| 504 | Model request timed out |

Errors contain `success: false`, a safe `message`, and a `code` when the error is
emitted by this router. After a session has been issued, retryable route errors
include `session_id` and `request_id`; preserve them for retries. No partial
response is reported as successful when persistence fails. Model generation may
already have consumed provider quota even when persistence fails. Transient
catalog and Gemini errors are not stored as completed turns, so the same request
can be retried. A completed grounding fallback is stored and can be replayed.

## Persistence and ordering

`createChatStore` uses the existing `chat_histories` table without a migration.
Its `session_id` column stores `SHA256(public session token)`, rather than the
capability itself. `sessionStorageId(token)` is exported for narrowly scoped
fixture cleanup; never issue a broad history deletion during tests.

A dedicated pooled connection takes a MySQL `GET_LOCK` lock named from the
session digest. This serializes turns for that conversation across application
processes while different conversations can proceed independently. A lock that
cannot be acquired within five seconds returns `409 SESSION_BUSY`. Ownership is
checked against any existing rows after acquiring the lock.

The store first checks the completed assistant envelope for `request_id`. A retry
with the same message hash returns the stored response without another model
call or pair of inserts. A different message with that UUID returns `409`.
Only the most recent eight stored messages are passed as history, in time order,
using `{role, text, product_ids?, search?}`. Product IDs and grounded search state
support follow-up turns. Storage metadata, capabilities, account IDs, and bearer
JWTs are never added to that history. The assistant additionally sanitizes user
text before building the model request.

No transaction is held while the model is generating. After a complete answer,
one transaction inserts the user and assistant rows together; any insert failure
rolls back both. The lock is released and the connection returned in all cases.
Versioned JSON envelopes preserve the user text and assistant response; the
assistant envelope also contains the request UUID and SHA256 message hash.
JSON is ASCII escaped so emoji round-trip through the existing `utf8mb3` schema.
Each serialized envelope is limited to 60,000 bytes, below MySQL `TEXT` capacity.
Internal `context_search` is stored for continuity and omitted from HTTP output.

## Quotas and testing

The IP limit is checked before authentication, database access, session creation,
or model generation. The session limit is checked before replay and generation.
An additional shared process-wide in-flight cap is acquired before getting the
dedicated session connection and released in `finally` after success or failure.
Excess work returns `503 CHAT_BUSY` with `Retry-After: 2`. The cap reserves at
least one connection in the default ten-connection MySQL pool for the assistant's
catalog queries, preventing all pool connections from waiting on their own
catalog searches. Keep this reserve when changing the pool size or deployment.
The application uses Express's default `req.ip`; this route changes no proxy
trust setting. Configure deployment proxy trust separately only when the proxy
topology is known.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHAT_IP_LIMIT` | 30 | Requests per IP per window |
| `CHAT_SESSION_LIMIT` | 10 | Requests per conversation per window |
| `CHAT_RATE_WINDOW_MS` | 60000 | Fixed window duration, up to 3600000 ms |
| `CHAT_RATE_MAX_KEYS` | 10000 | Maximum active entries in each limiter map |
| `CHAT_MAX_CONCURRENT` | 3 | In-flight conversations per process; valid range 1–9 |

Expired entries are pruned. Full maps reject new entries until capacity expires,
so rotating keys cannot evict active quota records. These quotas are process-local;
a multi-instance deployment needs a shared limiter such as Redis for aggregate
enforcement. MySQL session locking and replay protection already work across
processes connected to the same database server.

Run `node --test tests/chat-route.test.js` from `backend`. The isolated MySQL
protocol fixture exercises connection locking, atomic inserts, rollback,
concurrent replay, ownership, strict validation, Unicode, transient failures,
and bounded quota expiry. It calls no model API and modifies no catalog or real
account data.

## Stage timings

`CHAT_METRICS=1` enables one sanitized `chat_metrics` JSON event per completed
request. It is off by default. Events contain only a fixed outcome code, numeric
durations in milliseconds and stage invocation counts. No message, model draft,
prompt, identity, credentials or session capability is logged or returned as
public API timing data. Tests/evaluation can inject `onMetrics` instead of logging.

| Bucket | Meaning |
| --- | --- |
| `mysql_products_ms` | Catalog SELECT driver calls |
| `mysql_history_load_ms` | Ownership, replay and history SELECT driver calls |
| `context_history_ms` | Input/history preparation, context and request serialization CPU |
| `gemini_ms` | SDK generation call until response or error; includes client initialization on first use |
| `grounding_ms` | Response parsing, grounding checks and card rendering |
| `mysql_history_save_ms` | Pair transaction, inserts, commit/rollback driver calls |
| `mysql_session_ms` | Session lock release SQL |
| `session_wait_ms` | Connection acquisition and advisory lock acquisition |
| `mysql_ms` | Sum of the four SQL buckets |
| `processing_ms` | Total minus SQL, session wait and Gemini |
| `total_ms` | Route lifetime through response and store cleanup |

`context_history_ms` and `grounding_ms` are subcomponents of `processing_ms`;
do not add them again to the aggregate breakdown. HTTP client timing may also
include loopback overhead. Failed stages are timed too. Diagnostics cannot change
request success/failure. Gemini calls keep the existing model, 45-second timeout,
one SDK attempt and 1024 output tokens; there is no automatic model retry.
