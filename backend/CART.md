Cart API (UC07 / UC08)
=====================

All four endpoints require Authorization: Bearer <JWT>, an active account and
role exactly `user`. The account ID comes exclusively from authentication.

- GET /api/cart: returns {success, cart: {cart_id, items, total_quantity, subtotal}}.
  A never-created cart returns cart_id=null and an empty list without inserting data.
- POST /api/cart/items: JSON {product_id: positive integer, quantity: positive integer}.
  Adds quantity to an existing item, or inserts a new item. Returns the updated cart.
- PUT /api/cart/items/:id: JSON {quantity: positive integer}; replaces quantity.
- DELETE /api/cart/items/:id: deletes the cart_item_id and returns the updated cart.

Unknown body fields/query parameters are rejected, including user_id, price and
selected. IDs and quantities must fit positive signed MySQL INT. Foreign/missing
item IDs return 404. Invalid input returns 400, JWT errors 401, non-user roles 403,
unavailable products/insufficient stock/concurrent lock conflicts 409.
Product status for sale is the existing database value `Đang bán`.
Price, line_total and subtotal are decimal strings calculated from current DB
prices. Existing items remain visible if stock/status changes; every addition or
quantity update revalidates stock/status. No stock is reserved or deducted.
Order creation must validate stock, price and selected products again.

Schema finding / proposal (NOT executed)
---------------------------------------
The existing InnoDB carts table has UNIQUE(user_id). cart_items has foreign keys
and indexes but lacks UNIQUE(cart_id, product_id). Recommended follow-up:

    SELECT cart_id, product_id, COUNT(*) AS count
    FROM cart_items GROUP BY cart_id, product_id HAVING COUNT(*) > 1;

After review and resolving duplicates with an approved data plan:

    ALTER TABLE cart_items ADD CONSTRAINT uq_cart_product UNIQUE (cart_id, product_id);

No schema changes are performed by the application or tests. Transactions lock
the owning user row before reading/creating the cart or changing items. This
serializes this API's concurrent requests across server instances, including the
first addition. Product rows are read with shared locks for stock validation.
Other writers must follow the same locking protocol until the UNIQUE is added;
direct SQL writers otherwise can create duplicates. Additions encountering
pre-existing duplicate product rows fail with 409 rather than silently deleting
or rewriting data. Deadlocks/timeouts return 409 for client retry.

Run `npm test` in backend. The runner uses a separate disposable database with
synthetic data; it never writes the configured application database. Direct
`node --test` without the isolation guard is rejected. Cart tests use two unique temporary accounts, exercise
simultaneous additions and access isolation, and remove their carts/items/users
in finally. Full product/category snapshots verify that catalog data and stock
remain unchanged. Existing unavailable-product status is tested only when such
data exists; no product fixture is inserted or altered.
