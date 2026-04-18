'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

/* ── REGISTER ── */
router.post('/register', (req, res) => {
  const { username, email, country, mobile, password, confirm_password, referral } = req.body;
  if (!username || !email || !password || !mobile)
    return res.json({ success: false, message: 'All fields are required.' });
  if (password !== confirm_password)
    return res.json({ success: false, message: 'Passwords do not match.' });
  if (password.length < 6)
    return res.json({ success: false, message: 'Password must be at least 6 characters.' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const ref_code = uuidv4().slice(0, 8).toUpperCase();
    db.createUser({
      username: username.trim(),
      email: email.trim().toLowerCase(),
      country: country || 'Kenya',
      mobile,
      password: hash,
      referral_code: ref_code,
      referred_by: referral || null
    });

    // Credit referrer if valid
    if (referral) {
      const referrer = db.getUserByReferralCode(referral);
      if (referrer) {
        const bonus = parseFloat(db.getSetting('referral_bonus') || 50);
        db.updateUser(referrer.id, {
          affiliate_earnings: referrer.affiliate_earnings + bonus,
          balance: referrer.balance + bonus
        });
      }
    }
    return res.json({ success: true, message: 'Account created! Please sign in.' });
  } catch (e) {
    if (e.message.includes('UNIQUE'))
      return res.json({ success: false, message: 'Username or email already taken.' });
    console.error('Register error:', e.message);
    return res.json({ success: false, message: 'Registration failed. Try again.' });
  }
});

/* ── LOGIN ── */
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, message: 'Enter username and password.' });
  const user = db.getUserByUsernameOrEmail(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.json({ success: false, message: 'Invalid credentials.' });
  if (user.is_banned)
    return res.json({ success: false, message: 'Your account has been suspended. Contact support.' });
  req.session.userId = user.id;
  req.session.username = user.username;
  return res.json({ success: true, activated: !!user.is_activated });
});

/* ── LOGOUT ── */
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

/* ── ACTIVATE ── */
router.post('/activate', (req, res) => {
  if (!req.session.userId) return res.json({ success: false, message: 'Not logged in.' });
  const { phone } = req.body;
  if (!phone) return res.json({ success: false, message: 'Phone number required.' });
  const fee = parseFloat(db.getSetting('activation_fee') || 300);
  db.addPayment({ user_id: req.session.userId, amount: fee, phone, type: 'activation', status: 'completed' });
  db.updateUser(req.session.userId, { is_activated: 1 });
  return res.json({ success: true, message: 'Account activated successfully!' });
});

/* ── ME (current user) ── */
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.json({ success: false });
  const user = db.getUserById(req.session.userId);
  if (!user) return res.json({ success: false });
  const { password: _pw, ...safeUser } = user;
  const notifications = db.getNotificationsForUser(req.session.userId);
  const settings = db.getAllSettings();
  return res.json({ success: true, user: safeUser, notifications, settings });
});

/* ── MARK NOTIFICATION READ ── */
router.post('/notification/read/:id', (req, res) => {
  if (!req.session.userId) return res.json({ success: false });
  db.markNotificationRead(req.params.id);
  return res.json({ success: true });
});

module.exports = router;
