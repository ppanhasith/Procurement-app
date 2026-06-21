require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
}));

// Home page
app.get('/', async (req, res) => {
    try {
    const result = await pool.query(
      `SELECT * FROM deals WHERE status = 'open' ORDER BY created_at DESC`
    );
    res.render('home', { user: req.session.user, deals: result.rows });
    } catch (err) {
    console.error(err);
    res.render('home', { user: req.session.user, deals: [] });
    }   
});

// Show signup form
app.get('/signup', (req, res) => {
    res.render('signup', { error: null });
});

// Handle signup form submission
app.post('/signup', async (req, res) => {
    const { name, email, password, telegram_handle } = req.body;

    try {
    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
        `INSERT INTO users (name, email, password_hash, telegram_handle)
        VALUES ($1, $2, $3, $4) RETURNING id, name, email, is_admin`,
        [name, email, password_hash, telegram_handle]
    );

    req.session.user = result.rows[0];
    res.redirect('/');
    } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      // Postgres error code for unique constraint violation
        res.render('signup', { error: 'That email is already registered.' });
    } else {
        res.render('signup', { error: 'Something went wrong. Try again.' });
    }
    }
});
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

        if (result.rows.length === 0) {
            return res.render('login', { error: 'Invalid email or password.' });
        }
        const user = result.rows[0];
        const passwordMatches = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            return res.render('login', { error: 'Invalid email or password.' });
        }
        req.session.user = {
            id: user.id,
            name: user.name,
            email: user.email,
            is_admin: user.is_admin,
        };
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.render('login', { error: 'Something went wrong. Try again.' });
    }
});
app.get('/logout', (req,res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    if(!req.session.user || !req.session.user.is_admin) {
        return res.status(403).send('Access denied. Admins only.')
    }
    next();
}

app.get('/deals/new', requireAdmin, (req, res) => {
    res.render('new-deal', { error: null});
});

app.post('/deals/new', requireAdmin, async (req, res) => {
    const { title, description, source_price, sell_price, deposit_amount, slots_total, estimated_wait_days } = req.body;

    try {
        await pool.query(
            `INSERT INTO deals (title, description, source_price, sell_price, deposit_amount, slots_total, slots_remaining, estimated_wait_days)
            VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
            [title, description, source_price, sell_price, deposit_amount, slots_total, estimated_wait_days]
        );
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.render('new-deal', { error: 'Something went wrong creatinf the deal.'});
    }
});

app.post('/deals/:id/reserve', requireLogin, async (req, res) => {
    const dealId = req.params.id;
    
    try {
        const dealResult = await pool.query('SELECT * FROM deals WHERE id = $1', [dealId]);
        if (dealResult.rows.length === 0) {
            return res.status(404).send('Deal not found.');
        }
        const deal = dealResult.rows[0];
        if (deal.slots_remaining <= 0) {
            return res.status(400).send('Sorry, this deal is fully booked.');
        }
        await pool.query('BEGIN');
        await pool.query(
            'INSERT INTO orders (user_id, deal_id) VALUES ($1, $2)',
            [req.session.user.id, dealId]
        );
        await pool.query(
            'UPDATE deals SET slots_remaining = slots_remaining - 1 WHERE id = $1',
            [dealId]
        );
        await pool.query('COMMIT');

        res.redirect('/my-orders');
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).send('Something went wrong reserving this deal.');
    }
});
app.get('/my-orders' , requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT orders.*, deals.title, deals.sell_price, deals.deposit_amount
            FROM orders
            JOIN deals ON orders.deal_id = deals.id
            WHERE orders.user_id = $1
            ORDER BY orders.created_at DESC`,
            [req.session.user.id]
        );
        res.render('my-orders', { orders: result.rows, user: req.session.user });
    } catch(err) {
        console.error(err);
        res.render('my-orders', { orders: [], user: req.session.user });
    }
});
app.get('/admin/orders', requireAdmin, async (req, res) => {
    try {
    const result = await pool.query(
        `SELECT orders.*, users.name AS customer_name, users.email AS customer_email, users.telegram_handle,
            deals.title, deals.sell_price, deals.deposit_amount
        FROM orders
        JOIN users ON orders.user_id = users.id
        JOIN deals ON orders.deal_id = deals.id
        ORDER BY orders.created_at DESC`
    );
    res.render('admin-orders', { orders: result.rows, user: req.session.user });
    } catch (err) {
    console.error(err);
    res.render('admin-orders', { orders: [], user: req.session.user });
    }
});
app.post('/admin/orders/:id/status', requireAdmin, async (req, res) => {
    const { status } = req.body;
    const orderId = req.params.id;

    const validStatuses = ['pending_contact', 'deposit_confirmed', 'ordered', 'shipped', 'customs', 'delivered'];
    if (!validStatuses.includes(status)) {
    return res.status(400).send('Invalid status.');
    }

    try {
    await pool.query(
        'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
        [status, orderId]
    );
    res.redirect('/admin/orders');
    } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong updating the order.');
    }
});
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});