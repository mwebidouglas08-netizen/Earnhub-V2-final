'use strict';
const express    = require('express');
const session    = require('express-session');
const cookieParser = require('cookie-parser');
const path       = require('path');
const fs         = require('fs');

/* ─── Init DB early so it doesn't fail mid-request ─── */
const db = require('./backend/db');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const PAGES = path.join(__dirname, 'public', 'pages');

/* ─── Session store ─── */
const SQLiteStore = require('connect-sqlite3')(session);

/* ─── Core middleware ─── */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname
  }),
  secret: process.env.SESSION_SECRET || 'earnhub_s3cr3t_k3y_2024_xK9mPqRt',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

/* ─── Static assets ─── */
app.use('/static', express.static(path.join(__dirname, 'public')));

/* ─── API routes ─── */
app.use('/api/auth',  require('./backend/routes/auth'));
app.use('/api/admin', require('./backend/routes/admin'));
app.use('/api/user',  require('./backend/routes/user'));

/* ─── Health check — MUST return 200 quickly for Railway ─── */
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', app: 'EarnHub', ts: Date.now() }));

/* ─── Frontend page helpers ─── */
const sendPage = (file) => (_req, res) => res.sendFile(path.join(PAGES, file));

/* ─── Public routes ─── */
app.get('/',          sendPage('index.html'));
app.get('/login',     sendPage('login.html'));
app.get('/register',  sendPage('register.html'));

/* ─── Protected user routes ─── */
app.get('/activate', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  return res.sendFile(path.join(PAGES, 'activate.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const user = db.getUserById(req.session.userId);
  if (!user || user.is_banned) { req.session.destroy(); return res.redirect('/login'); }
  if (!user.is_activated) return res.redirect('/activate');
  return res.sendFile(path.join(PAGES, 'dashboard.html'));
});

/* ─── Admin routes — hidden from frontend ─── */
app.get('/admin',           (_req, res) => res.redirect('/admin/login'));
app.get('/admin/login',     sendPage('admin-login.html'));
app.get('/admin/dashboard', (req, res) => {
  if (!req.session.adminId) return res.redirect('/admin/login');
  return res.sendFile(path.join(PAGES, 'admin-dashboard.html'));
});

/* ─── 404 ─── */
app.use((_req, res) => {
  res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404 - EarnHub</title>
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0A0F1E;color:#E8EAF0;font-family:sans-serif;
  display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
  h1{font-size:5rem;color:#F5C518;}p{color:#6B7280;margin:1rem 0;}a{color:#F5C518;}</style></head>
  <body><div><h1>404</h1><p>Page not found</p><a href="/">← Back to EarnHub</a></div></body></html>`);
});

/* ─── Global error handler ─── */
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.stack || err.message);
  res.status(500).json({ success: false, message: 'Server error. Please try again.' });
});

/* ─── Start server ─── */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 EarnHub is live on port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🔐 Admin: http://localhost:${PORT}/admin/login`);
});

/* ─── Handle uncaught errors gracefully ─── */
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err.message); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });
