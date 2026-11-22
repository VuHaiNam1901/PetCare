
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./config/db');
const authRoutes = require('./routes/auth');
const cartRoutes = require('./routes/cart');
const orderRoutes = require('./routes/orders');
const adminOrderRoutes = require('./routes/admin-orders');
const adminCatalogRoutes = require('./routes/admin-catalog');
const adminUserRoutes = require('./routes/admin-users');
const reviewRoutes = require('./routes/reviews');
const catalogRoutes = require('./routes/catalog');
const { createChatRouter } = require('./routes/chat');

const { createCorsOptions } = require('./config/cors');
const { securityHeaders } = require('./middleware/security-headers');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(securityHeaders());
app.use(require('./routes/sepay').createSePayWebhookRouter({ pool }));
app.use(cors(createCorsOptions()));
app.use(express.json({ limit: '64kb' }));
app.use('/api', authRoutes);
app.use('/api', reviewRoutes);
app.use('/api', catalogRoutes);
app.use('/api/chat', createChatRouter());
app.use('/api/cart', cartRoutes);
app.use('/api/wishlist', require('./routes/wishlist'));
app.use('/api/pets', require('./routes/pets'));
app.use('/api/orders', orderRoutes);
app.use('/api/admin/orders', adminOrderRoutes);
app.use('/api/admin/vouchers', require('./routes/admin-vouchers'));
app.use('/api/vouchers', require('./routes/vouchers'));
app.use('/api/admin/users', adminUserRoutes);
app.use('/api/admin', adminCatalogRoutes);

// API kiểm tra máy chủ
app.get('/', (req, res) => {
    res.json({
        message: 'PetCare API is running!'
    });
});

// API kiểm tra kết nối MySQL (không công khai tên database hay danh sách bảng)
app.get('/api/health/db', async (req, res) => {
    try {
        await pool.query('SELECT 1');

        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            status: 'ok',
            message: 'Connected to MySQL successfully'
        });
    } catch (error) {
        console.error('MySQL connection error:', error.message);

        res.status(500).json({
            success: false,
            message: 'Cannot connect to MySQL'
        });
    }
});


app.get('/api/health/tables', async (req, res) => {
    try {
        await pool.query('SELECT 1');

        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            status: 'ok',
            message: 'Database health check passed'
        });
    } catch (error) {
        console.error('Error checking database health:', error.message);

        res.status(500).json({
            success: false,
            message: 'Cannot retrieve database tables'
        });
    }
});



app.get('/api/categories', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT category_id, name, description, created_at FROM categories ORDER BY category_id'
        );

        res.json({
            success: true,
            total: rows.length,
            categories: rows
        });
    } catch (error) {
        console.error('Error fetching categories:', error.message);

        res.status(500).json({
            success: false,
            message: 'Cannot retrieve categories'
        });
    }
});


app.use((error, req, res, next) => {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Email already registered' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Invalid JSON' });
    if (error.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'Request body too large' });
    res.status(500).json({ success: false, message: 'Internal server error' });
});

async function start() {
    const sepay = require('./config/sepay');
    if (sepay.enabled()) {
        sepay.settings();
        sepay.writesEnabled();
        const db = await pool.getConnection();
        try { await sepay.assertDatabase(db); }
        finally { db.release(); }
    }
    const workflow = require('./config/order-workflow');
    const config = workflow.settings();
    if (config.enabled) workflow.assertWorkflowCreationAllowed();
    if (config.enabled || config.expiryEnabled) {
        // Readiness only: startup never applies migrations or repairs data.
        await require('./services/online-orders').assertReady(pool);
    }
    if (require('./config/vouchers').enabled()) await require('./models/voucher').assertReady(pool);
    const lifecycle = require('./server-lifecycle');
    // Bind errors reject before an expiry worker is allowed to run.
    const server = await lifecycle.listen(app, PORT);
    console.log(`Server is running at http://localhost:${PORT}`);
    const worker = config.expiryEnabled
        ? require('./workers/order-expiry').startOrderExpiryWorker({ service: require('./services/online-orders'), logger: console }) : null;
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        lifecycle.close(server, worker, pool).catch(error => {
            console.error('[ORDER WORKFLOW SHUTDOWN]', error.code || 'SHUTDOWN_FAILED');
            process.exitCode = 1;
        });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    return server;
}
if (require.main === module) start().catch(error => {
    console.error('[ORDER WORKFLOW STARTUP]', error.code || 'READINESS_FAILED');
    process.exitCode = 1;
    pool.end();
});
app.start = start;
module.exports = app;
