// Read-only catalog projection. Each order_details row is summed once; payment
// eligibility is an EXISTS check so additional payment rows cannot multiply it.
exports.attachSoldQuantities = async (db, products) => {
    if (!products.length) return products;
    const ids = [...new Set(products.map(product => product.product_id))];
    const [rows] = await db.execute(`SELECT d.product_id, SUM(d.quantity) AS sold_quantity
        FROM order_details d JOIN orders o ON o.order_id = d.order_id
        WHERE d.product_id IN (${ids.map(() => '?').join(',')}) AND d.quantity > 0
        AND o.status = ? AND o.approved_at IS NOT NULL
        AND o.stock_restored_at IS NULL AND o.rejection_reason IS NULL
        AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.order_id
            AND p.payment_method IN ('COD','ONLINE') AND p.payment_status = ?
            AND p.transaction_date IS NOT NULL AND p.amount = o.total_amount)
        GROUP BY d.product_id`, [...ids, 'Đã giao hàng', 'Đã thanh toán']);
    const totals = new Map(rows.map(row => [String(row.product_id), Number(row.sold_quantity)]));
    return products.map(product => {
        const sold_quantity = totals.get(String(product.product_id)) ?? 0;
        if (!Number.isSafeInteger(sold_quantity) || sold_quantity < 0) throw new Error('Invalid sold quantity aggregate');
        return { ...product, sold_quantity };
    });
};
