UC19: customer account management
================================

GET /api/admin/users?page=1&limit=20&q=search&status=active
  Returns {success,page,limit,total,users}, newest ID first. Limit 1-100. q
  searches name OR email; %, _ and = are literal search characters. Optional
  status is exactly active/inactive. Only role=user accounts are included.
GET /api/admin/users/:id
  Returns {success,user}, with name,email,phone,address,role,status,created_at,
  user_id. Missing accounts and Admin accounts both return 404.
PATCH /api/admin/users/:id/status
  Accepts ONLY {"status":"inactive"} (lock) or {"status":"active"} (unlock).
  Repeating the same status is safe. Unknown fields, including role/password,
  are rejected with 400. Admin accounts cannot be targeted, including self.

Every route requires valid Bearer JWT and an active Admin. JWT errors -> 401,
non-admin/locked accounts -> 403, malformed input -> 400, lock conflicts -> 409.
All SELECTs explicitly exclude password; neither hashes nor passwords are
returned. Updates change only status, under a target-row lock, and revalidate
the acting Admin inside the transaction. SQL values are parameterized.
No account deletion, role/password update or schema change is provided.

Inspection found the user table empty and role/status are VARCHAR, not ENUM.
This uses the EXISTING backend/test contract user/admin and active/inactive;
it does not introduce additional values. Registration already creates active
users, and existing middleware rejects any account not active on every
authenticated request. Old JWTs therefore fail while locked, including profile,
cart, order, payment and admin routes. Unlock allows an unexpired old JWT again;
there is no separate permanent token revocation in UC19. Requests already
authenticated before a lock may complete; transactional business mutations
recheck the account while holding the appropriate user lock.

Status updates never delete or change carts, orders/details, payments, reviews,
products or categories. Tests create temporary customers/Admin and related
history fixtures, verify preservation/guards/search/filters/pagination, and
delete only their own fixtures. Catalog rows are never updated by these tests.
