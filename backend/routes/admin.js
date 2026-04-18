'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { requireAdmin } = require('../middleware/auth');

/* ── LOGIN ── */
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const admin = db.prepare('SELECT * FROM admins WHERE username=?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password))
    return res.json({ success: false, message: 'Invalid admin credentials.' });
  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  return res.json({ success: true });
});

/* ── LOGOUT ── */
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

/* ── CHECK SESSION ── */
router.get('/me', requireAdmin, (req, res) => {
  return res.json({ success: true, username: req.session.adminUsername });
});

/* ── STATS ── */
router.get('/stats', requireAdmin, (req, res) => {
  const db = getDb();
  const totalUsers      = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const activeUsers     = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_activated=1').get().c;
  const bannedUsers     = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_banned=1').get().c;
  const pendingWd       = db.prepare("SELECT COUNT(*) AS c FROM withdrawals WHERE status='pending'").get().c;
  const totalWdPaid     = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status='approved'").get().s;
  const totalRevenue    = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='completed'").get().s;
  const recentUsers     = db.prepare('SELECT id,username,email,country,mobile,is_activated,is_banned,balance,created_at FROM users ORDER BY created_at DESC LIMIT 10').all();
  const settingsRows    = db.prepare('SELECT key,value FROM settings').all();
  const settings = {};
  settingsRows.forEach(r => { settings[r.key] = r.value; });
  return res.json({ success: true, stats: { totalUsers, activeUsers, bannedUsers, pendingWd, totalWdPaid, totalRevenue }, recentUsers, settings });
});

/* ── ALL USERS ── */
router.get('/users', requireAdmin, (req, res) => {
  const search = (req.query.search || '').trim();
  const db = getDb();
  const rows = db.prepare(`SELECT id,username,email,country,mobile,is_activated,is_banned,balance,total_earnings,affiliate_earnings,total_withdrawn,created_at
    FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY created_at DESC`).all(`%${search}%`, `%${search}%`);
  return res.json({ success: true, users: rows });
});

/* ── SINGLE USER ── */
router.get('/users/:id', requireAdmin, (req, res) => {
  const user = getDb().prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  return res.json({ success: true, user });
});

/* ── UPDATE USER ── */
router.put('/users/:id', requireAdmin, (req, res) => {
  const { is_activated, is_banned, balance, total_earnings, ads_earnings, tiktok_earnings,
          youtube_earnings, trivia_earnings, articles_earnings, affiliate_earnings, agent_bonus } = req.body;
  getDb().prepare(`UPDATE users SET is_activated=?,is_banned=?,balance=?,total_earnings=?,
    ads_earnings=?,tiktok_earnings=?,youtube_earnings=?,trivia_earnings=?,
    articles_earnings=?,affiliate_earnings=?,agent_bonus=? WHERE id=?`).run(
    is_activated ? 1 : 0, is_banned ? 1 : 0,
    balance, total_earnings, ads_earnings, tiktok_earnings, youtube_earnings,
    trivia_earnings, articles_earnings, affiliate_earnings, agent_bonus,
    req.params.id
  );
  return res.json({ success: true, message: 'User updated successfully.' });
});

/* ── DELETE USER ── */
router.delete('/users/:id', requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  return res.json({ success: true, message: 'User deleted.' });
});

/* ── SEND NOTIFICATION ── */
router.post('/notify', requireAdmin, (req, res) => {
  const { user_id, title, message, type, is_global } = req.body;
  if (!title || !message) return res.json({ success: false, message: 'Title and message required.' });
  const db = getDb();
  if (is_global) {
    db.prepare('INSERT INTO notifications (title,message,type,is_global) VALUES (?,?,?,1)').run(title, message, type || 'info');
  } else {
    if (!user_id) return res.json({ success: false, message: 'User ID required for targeted notification.' });
    db.prepare('INSERT INTO notifications (user_id,title,message,type,is_global) VALUES (?,?,?,?,0)').run(user_id, title, message, type || 'info');
  }
  return res.json({ success: true, message: 'Notification sent!' });
});

/* ── UPDATE SETTINGS ── */
router.put('/settings', requireAdmin, (req, res) => {
  const db = getDb();
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  const updateMany = db.transaction((obj) => {
    for (const [k, v] of Object.entries(obj)) upsert.run(k, String(v));
  });
  updateMany(req.body);
  return res.json({ success: true, message: 'Settings saved successfully.' });
});

/* ── WITHDRAWALS ── */
router.get('/withdrawals', requireAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT w.*,u.username FROM withdrawals w JOIN users u ON w.user_id=u.id ORDER BY w.created_at DESC`).all();
  return res.json({ success: true, withdrawals: rows });
});

router.put('/withdrawals/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  const db = getDb();
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w) return res.json({ success: false, message: 'Not found.' });
  db.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(status, req.params.id);
  if (status === 'approved') {
    db.prepare('UPDATE users SET total_withdrawn=total_withdrawn+? WHERE id=?').run(w.amount, w.user_id);
  } else if (status === 'rejected') {
    db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(w.amount, w.user_id);
  }
  return res.json({ success: true, message: `Withdrawal ${status}.` });
});

/* ── PAYMENTS ── */
router.get('/payments', requireAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT p.*,u.username FROM payments p JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC`).all();
  return res.json({ success: true, payments: rows });
});

module.exports = router;
