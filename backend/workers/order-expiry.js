const { settings } = require('../config/order-workflow');

// No timer or database access at import time. The HTTP entry point opts in.
function startOrderExpiryWorker({ service = require('../services/online-orders'), logger = console, intervalMs = 30000 } = {}) {
    if (intervalMs !== 30000) throw new Error('The order expiration interval must be 30 seconds');
    let stopped = !settings().expiryEnabled, running = null, timer;
    async function runOnce() {
        if (stopped) return { disabled: true };
        if (running) return running;
        running = (async () => {
            try {
                const total = { scanned: 0, expired: 0, skipped: 0, errors: [] };
                let afterOrderId = 0;
                do {
                    const result = await service.expireBatch({ limit: 100, afterOrderId });
                    total.scanned += result.scanned; total.expired += result.expired; total.skipped += result.skipped;
                    total.errors.push(...result.errors);
                    for (const error of result.errors) logger.error('[ORDER_EXPIRY_ITEM]', error);
                    // A cursor prevents corrupt or temporarily locked early rows
                    // from starving later overdue orders during catch-up.
                    if (result.scanned < 100 || !result.nextCursor || result.nextCursor <= afterOrderId) break;
                    afterOrderId = result.nextCursor;
                } while (!stopped);
                logger.info('[ORDER_EXPIRY]', { scanned: total.scanned, expired: total.expired, skipped: total.skipped, failed: total.errors.length });
                return total;
            } catch (error) {
                logger.error('[ORDER_EXPIRY_ERROR]', { code: error.code || 'EXPIRY_FAILED' });
                return { failed: true };
            } finally { running = null; }
        })();
        return running;
    }
    if (!stopped) {
        // The immediate pass catches deadlines missed while the process was down.
        void runOnce();
        timer = setInterval(() => { void runOnce(); }, 30000);
        timer.unref?.();
    }
    return { runOnce, async stop() { stopped = true; if (timer) clearInterval(timer); if (running) await running; } };
}
module.exports = { startOrderExpiryWorker };
