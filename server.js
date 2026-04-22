'use strict';
const express      = require('express');
const session      = require('express-session');
const cookieParser = require('cookie-parser');
const path         = require('path');

const PORT  = parseInt(process.env.PORT || '3000', 10);
const PAGES = path.join(__dirname, 'public', 'pages');

const app = express();

/* ── Health check — FIRST, no deps ── */
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', app: 'EarnHub', ts: Date.now() });
});

/* ── Core middleware ── */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret:            process.env.SESSION_SECRET || 'earnhub_s3cr3t_2024_xK9mPqRt',
  resave:            false,
  saveUninitialized: false,
  rolling:           true,
  cookie: { secure: false, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

/* ── Static ── */
app.use('/static', express.static(path.join(__dirname, 'public')));

/* ── Init DB ── */
try {
  require('./backend/db');
  console.log('✅ DB initialised');
} catch (e) {
  console.error('❌ DB init error:', e.message);
}

/* ── API Routes ── */
app.use('/api/auth',  require('./backend/routes/auth'));
app.use('/api/admin', require('./backend/routes/admin'));
app.use('/api/user',  require('./backend/routes/user'));

/* ── Helpers ── */
const send   = (f)   => (_req, res) => res.sendFile(path.join(PAGES, f));
const getUser = (req) => {
  try {
    if (!req.session || !req.session.userId) return null;
    return require('./backend/db').getUserById(req.session.userId);
  } catch { return null; }
};

/* ── Public pages ── */
app.get('/',         send('index.html'));
app.get('/login',    send('login.html'));
app.get('/register', send('register.html'));

/* ── Activate page ── */
app.get('/activate', (req, res) => {
  const user = getUser(req);
  if (!user)             return res.redirect('/login');
  if (user.is_banned)    { req.session.destroy(); return res.redirect('/login'); }
  // If already paid — skip straight to dashboard
  if (user.is_activated) return res.redirect('/dashboard');
  return res.sendFile(path.join(PAGES, 'activate.html'));
});

/* ── Dashboard — HARD GATE ──
   This is the server-side wall.
   is_activated must be 1 in the DB.
   No exceptions, no bypasses.
*/
app.get('/dashboard', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  const user = getUser(req);
  if (!user) {
    req.session.destroy();
    return res.redirect('/login');
  }
  if (user.is_banned) {
    req.session.destroy();
    return res.redirect('/login');
  }
  if (!user.is_activated) {
    // User tried to access dashboard without paying — block & redirect
    console.log(`🚫 BLOCKED: User ${user.id} (${user.username}) tried /dashboard without activation`);
    return res.redirect('/activate');
  }
  // All checks passed — serve dashboard
  return res.sendFile(path.join(PAGES, 'dashboard.html'));
});

/* ── Admin (hidden, not linked from frontend) ── */
app.get('/admin',           (_req, res) => res.redirect('/admin/login'));
app.get('/admin/login',     send('admin-login.html'));
app.get('/admin/dashboard', (req, res) => {
  if (!req.session || !req.session.adminId) return res.redirect('/admin/login');
  return res.sendFile(path.join(PAGES, 'admin-dashboard.html'));
});

/* ── 404 ── */
app.use((_req, res) => {
  res.status(404).sendFile(path.join(PAGES, '404.html'));
});

/* ── Global error handler ── */
app.use((err, _req, res, _next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ success: false, message: 'Server error.' });
});

/* ── Start — must be 0.0.0.0 for Railway ── */
app.listen(PORT, '0.0.0.0', () => {
  console.log('=====================================');
  console.log(`🚀 EarnHub running on port ${PORT}`);
  console.log(`💚 Health:  http://localhost:${PORT}/health`);
  console.log(`🌐 App:     http://localhost:${PORT}`);
  console.log(`🔐 Admin:   http://localhost:${PORT}/admin/login`);
  console.log('=====================================');
});

process.on('uncaughtException',  e => console.error('Uncaught:', e.message));
process.on('unhandledRejection', r => console.error('Rejection:', r));
