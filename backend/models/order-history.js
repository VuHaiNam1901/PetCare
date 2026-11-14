// Every caller appends while holding the order lock, in the same transaction
// as the business change. Existing orders never receive invented old events.
const { normalizeLegacyClock } = require('./order-time');
exports.append = async (db, { orderId, fromStatus, toStatus, action, actorId = null, actorName = null, reason = null, eventKey = null }) => {
    if (eventKey !== null) {
        await db.execute(`INSERT INTO order_status_history
            (order_id, from_status, to_status, action, actor_id, actor_name, reason, created_at, event_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3), ?)`,
        [orderId, fromStatus, toStatus, action, actorId, actorName, reason, eventKey]);
        return;
    }
    await db.execute(`INSERT INTO order_status_history
        (order_id, from_status, to_status, action, actor_id, actor_name, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))`,
    [orderId, fromStatus, toStatus, action, actorId, actorName, reason]);
};

exports.read = async (db, orderId) => {
    const [rows] = await db.execute(`SELECT history_id, from_status, to_status, action,
        actor_id, actor_name, created_at, reason, UNIX_TIMESTAMP(created_at) AS __clock_created_at FROM order_status_history
        WHERE order_id = ? ORDER BY history_id`, [orderId]);
    return rows.map(row => normalizeLegacyClock(row, ['created_at']));
};

// History is also the cancellation record for baseline 005 orders, which do
// not have the newer lifecycle columns. Keep customer reasons out of the
// Admin rejection field and expose the same shape for both schemas.
exports.withCancellation = (order, events) => {
    if (order.status !== 'Đã hủy' || order.rejection_reason) return order;
    const cancelled = events.find(event => event.action === 'cancel' && event.to_status === 'Đã hủy');
    if (!cancelled) return order;
    return { ...order, cancellation_reason_code: 'customer_cancelled',
        cancellation_reason: cancelled.reason, cancelled_at: order.cancelled_at || cancelled.created_at };
};
