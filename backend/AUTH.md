Authentication setup
====================

Run `npm install` in backend. Configure the database variables and JWT_SECRET
in backend/.env (see .env.example). Use a long, randomly generated secret.
Start from backend with `npm start`. Missing/blank JWT_SECRET stops startup.
No default administrator or secret is created.

POST /api/auth/register accepts full_name, email, password (8 characters minimum,
72 UTF-8 bytes maximum), optional phone/address. Creates role=user, status=active.
POST /api/auth/login accepts email/password and returns token, expires_in (3600
seconds), token_type and safe user information.
GET /api/auth/me and PUT /api/users/me require Authorization: Bearer <token>.
Updates accept full_name, email, phone, address only; password/role/status and
other unknown fields are rejected. Optional phone/address can be null.

Account status must be exactly `active`; all other statuses are denied. Roles
use lowercase `user` / `admin`. Existing passwords must be bcrypt hashes.
Authentication reloads current account role/status from MySQL on every request.
For future admin routes, use authenticate followed by authorize('admin') from
middleware/auth; authorize('user', 'admin') allows both roles.

Run `npm test` through the isolated database runner. It reads only schema metadata
from the configured database, creates a disposable `petcare_test_<uuid>` database
with synthetic data, and never writes application rows. The integration test creates
a uniquely named temporary account, temporarily changes only its role/status to
exercise authorization, and deletes it in finally. It never creates a default
admin. Product/category content is hashed before and after to verify no changes.
The five existing GET endpoints remain public.

Before exposing authentication publicly, add login/registration rate limiting.
Tokens expire after one hour; refresh/logout revocation is not implemented.
