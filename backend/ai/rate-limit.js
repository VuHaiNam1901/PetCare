function setting(value, fallback, max = 1000000) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number <= max ? number : fallback;
}

function createChatLimiter({
    clock = Date.now,
    windowMs = setting(process.env.CHAT_RATE_WINDOW_MS, 60000, 3600000),
    sessionLimit = setting(process.env.CHAT_SESSION_LIMIT, 10),
    ipLimit = setting(process.env.CHAT_IP_LIMIT, 30),
    maxKeys = setting(process.env.CHAT_RATE_MAX_KEYS, 10000)
} = {}) {
    const sessions = new Map();
    const ips = new Map();
    let nextSweep = 0;
    function prune(map, now) {
        for (const [key, entry] of map) if (entry.resetAt <= now) map.delete(key);
    }
    function consume(map, key, limit) {
        const now = clock();
        if (now >= nextSweep) {
            prune(sessions, now);
            prune(ips, now);
            nextSweep = now + Math.min(windowMs, 1000);
        }
        let entry = map.get(key);
        if (entry && entry.resetAt <= now) { map.delete(key); entry = null; }
        if (!entry) {
            if (map.size >= maxKeys) prune(map, now);
            // Fail closed at capacity: evicting active entries would let callers
            // bypass the quota by rotating session capabilities or source IPs.
            if (map.size >= maxKeys) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)) };
            entry = { count: 0, resetAt: now + windowMs };
            map.set(key, entry);
        }
        if (entry.count >= limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
        entry.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
        consumeIp: ip => consume(ips, String(ip), ipLimit),
        consumeSession: sessionId => consume(sessions, sessionId, sessionLimit)
    };
}

module.exports = { createChatLimiter };
