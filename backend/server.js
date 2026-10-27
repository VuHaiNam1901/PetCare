
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
const { createChatRouter } = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/api', authRoutes);
app.use('/api', reviewRoutes);
app.use('/api/chat', createChatRouter());
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin/orders', adminOrderRoutes);
app.use('/api/admin/users', adminUserRoutes);
app.use('/api/admin', adminCatalogRoutes);

// API kiểm tra máy chủ
app.get('/', (req, res) => {
    res.json({
        message: 'PetCare API is running!'
    });
});

// API kiểm tra kết nối MySQL
app.get('/api/health/db', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT DATABASE() AS databaseName'
        );

        res.json({
            success: true,
            message: 'Connected to MySQL successfully',
            database: rows[0].databaseName
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
        const [rows] = await pool.query(
            'SHOW TABLES'
        );

        res.json({
            success: true,
            database: process.env.DB_NAME,
            totalTables: rows.length,
            tables: rows.map(row => Object.values(row)[0])
        });
    } catch (error) {
        console.error('Error listing tables:', error.message);

        res.status(500).json({
            success: false,
            message: 'Cannot retrieve database tables'
        });
    }
});



app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                p.product_id,
                p.category_id,
                c.name AS category_name,
                p.name,
                p.description,
                p.price,
                p.stock_quantity,
                p.image_url,
                p.status,
                p.created_at
            FROM products p
            INNER JOIN categories c
                ON p.category_id = c.category_id
            WHERE p.status = ?
            ORDER BY p.product_id DESC
        `, ['Đang bán']);

        res.json({
            success: true,
            total: rows.length,
            products: rows
        });
    } catch (error) {
        console.error('Error fetching products:', error.message);

        res.status(500).json({
            success: false,
            message: 'Cannot retrieve products'
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

if (require.main === module) app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
module.exports = app;
