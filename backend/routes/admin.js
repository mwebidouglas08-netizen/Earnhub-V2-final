'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { requireAdmin } = require('../middleware/auth');

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  console.log(`Admin login attempt — username: "${username}"`);

  if (!username || !password) {
    return res.json({ success: false, message: 'Enter username and password.' });
  }

  const admin = db.getAdminByUsername(username);

  if (!admin) {
    console.log(`Admin not found for username: "${username}"`);
    return res.json({ success: false, message: 'Invalid admin credentials.' });
  }

  console.log(`Admin found: "${admin.username}" — checking password…`);

  const match = bcrypt.compareSync(password, admin.password);
  console.log(`Password match: ${match}`);

  if (!match) {
    return res.json({ success: false, message: 'Invalid admin credentials.' });
  }

  req.session.adminId       = admin.id;
  req.session.adminUsername = admin.username;
  console.log(`Admin "${admin.username}" logged in successfully.`);
  return res.json({ success: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.get('/me', requireAdmin, (req, res) => {
  return res.json({ success: true, username: req.session.adminUsername });
});

router.get('/stats', requireAdmin, (req, res) => {
  const stats       = db.getStats();
  const recentUsers = db.getAllUsers().slice(-10).reverse();
  const settings    = db.getAllSettings();
  return res.json({ success: true, stats, recentUsers, settings });
});

router.get('/users', requireAdmin, (req, res) => {
  const users = db.getAllUsers(req.query.search || '');
  return res.json({ success: true, users });
});

router.get('/users/:id', requireAdmin, (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  const { password, ...safeUser } = user;
  return res.json({ success: true, user: safeUser });
});

router.put('/users/:id', requireAdmin, (req, res) => {
  const {
    is_activated, is_banned, balance, total_earnings,
    ads_earnings, tiktok_earnings, youtube_earnings,
    trivia_earnings, articles_earnings, affiliate_earnings, agent_bonus
  } = req.body;
  db.updateUser(req.params.id, {
    is_activated:      is_activated ? 1 : 0,
    is_banned:         is_banned    ? 1 : 0,
    balance:            parseFloat(balance)            || 0,
    total_earnings:     parseFloat(total_earnings)     || 0,
    ads_earnings:       parseFloat(ads_earnings)       || 0,
    tiktok_earnings:    parseFloat(tiktok_earnings)    || 0,
    youtube_earnings:   parseFloat(youtube_earnings)   || 0,
    trivia_earnings:    parseFloat(trivia_earnings)    || 0,
    articles_earnings:  parseFloat(articles_earnings)  || 0,
    affiliate_earnings: parseFloat(affiliate_earnings) || 0,
    agent_bonus:        parseFloat(agent_bonus)        || 0
  });
  return res.json({ success: true, message: 'User updated successfully.' });
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  db.deleteUser(req.params.id);
  return res.json({ success: true, message: 'User deleted.' });
});

router.post('/notify', requireAdmin, (req, res) => {
  const { user_id, title, message, type, is_global } = req.body;
  if (!title || !message)
    return res.json({ success: false, message: 'Title and message required.' });
  if (!is_global && !user_id)
    return res.json({ success: false, message: 'User ID required.' });
  db.addNotification({ user_id: user_id || null, title, message, type, is_global });
  return res.json({ success: true, message: 'Notification sent!' });
});

router.put('/settings', requireAdmin, (req, res) => {
  db.setAllSettings(req.body);
  return res.json({ success: true, message: 'Settings saved successfully.' });
});

router.get('/withdrawals', requireAdmin, (req, res) => {
  return res.json({ success: true, withdrawals: db.getAllWithdrawals() });
});

router.put('/withdrawals/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  const w = db.getWithdrawal(req.params.id);
  if (!w) return res.json({ success: false, message: 'Not found.' });
  db.updateWithdrawal(req.params.id, status);
  if (status === 'approved') {
    const user = db.getUserById(w.user_id);
    if (user) db.updateUser(w.user_id, { total_withdrawn: user.total_withdrawn + w.amount });
  } else if (status === 'rejected') {
    const user = db.getUserById(w.user_id);
    if (user) db.updateUser(w.user_id, { balance: user.balance + w.amount });
  }
  return res.json({ success: true, message: `Withdrawal ${status}.` });
});

router.get('/payments', requireAdmin, (req, res) => {
  return res.json({ success: true, payments: db.getAllPayments() });
});

module.exports = router;
