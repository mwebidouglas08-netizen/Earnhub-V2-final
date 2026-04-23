'use strict';
const express      = require('express');
const session      = require('express-session');
const cookieParser = require('cookie-parser');
const path         = require('path');

const PORT  = parseInt(process.env.PORT || '3000', 10);
const PAGES = path.join(__dirname, 'public', 'pages');
const app   = express();

// ── Health check FIRST — before everything ──
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', app: 'EarnHub', ts: Date.now() });
});

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret:            process.env.SESSION_SECRET || 'earnhub_s3cr3t_2024',
  resave:            false,
  saveUninitialized: false,
  rolling:           true,
  cookie: { secure: false, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use('/static', express.static(path.join(__dirname, 'public')));

// ── DB ──
try { require('./backend/db'); console.log('✅ DB ready'); }
catch (e) { console.error('❌ DB error:', e.message); }

// ── API ──
app.use('/api/auth',  require('./backend/routes/auth'));
app.use('/api/admin', require('./backend/routes/admin'));
app.use('/api/user',  require('./backend/routes/user'));

// ── Pages ──
const page    = (f) => (_req, res) => res.sendFile(path.join(PAGES, f));
const getUser = (req) => {
  try {
    if (!req.session?.userId) return null;
    return require('./backend/db').getUserById(req.session.userId);
  } catch { return null; }
};

app.get('/',         page('index.html'));
app.get('/login',    page('login.html'));
app.get('/register', page('register.html'));

app.get('/activate', (req, res) => {
  const u = getUser(req);
  if (!u)             return res.redirect('/login');
  if (u.is_banned)    { req.session.destroy(); return res.redirect('/login'); }
  if (u.is_activated) return res.redirect('/dashboard');
  return res.sendFile(path.join(PAGES, 'activate.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session?.userId) return res.redirect('/login');
  const u = getUser(req);
  if (!u)             { req.session.destroy(); return res.redirect('/login'); }
  if (u.is_banned)    { req.session.destroy(); return res.redirect('/login'); }
  if (!u.is_activated) {
    console.log(`🚫 User ${u.id} blocked from /dashboard — not activated`);
    return res.redirect('/activate');
  }
  return res.sendFile(path.join(PAGES, 'dashboard.html'));
});

app.get('/admin',           (_req, res) => res.redirect('/admin/login'));
app.get('/admin/login',     page('admin-login.html'));
app.get('/admin/dashboard', (req, res) => {
  if (!req.session?.adminId) return res.redirect('/admin/login');
  return res.sendFile(path.join(PAGES, 'admin-dashboard.html'));
});

app.use((_req, res) => res.status(404).sendFile(path.join(PAGES, '404.html')));
app.use((err, _req, res, _next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ success: false, message: 'Server error.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('================================');
  console.log(`🚀 EarnHub on port ${PORT}`);
  console.log(`💚 Health: http://localhost:${PORT}/health`);
  console.log(`🔐 Admin:  http://localhost:${PORT}/admin/login`);
  console.log('================================');
});

process.on('uncaughtException',  e => console.error('Uncaught:', e.message));
process.on('unhandledRejection', r => console.error('Rejection:', r));
