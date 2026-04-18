'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

/* ── REGISTER ── */
router.post('/register', (req, res) => {
  const { username, email, country, mobile, password, confirm_password, referral } = req.body;
  if (!username || !email || !password || !mobile)
    return res.json({ success: false, message: 'All fields are required.' });
  if (password !== confirm_password)
    return res.json({ success: false, message: 'Passwords do not match.' });
  if (password.length < 6)
    return res.json({ success: false, message: 'Password must be at least 6 characters.' });

  const db = getDb();
  try {
    const hash = bcrypt.hashSync(password, 10);
    const ref_code = uuidv4().slice(0, 8).toUpperCase();
    db.prepare(`INSERT INTO users (username,email,country,mobile,password,referral_code,referred_by)
      VALUES (?,?,?,?,?,?,?)`).run(username.trim(), email.trim().toLowerCase(), country || 'Kenya', mobile, hash, ref_code, referral || null);

    // Credit referrer if valid
    if (referral) {
      const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referral);
      if (referrer) {
        const bonus = parseFloat(db.prepare("SELECT value FROM settings WHERE key='referral_bonus'").get()?.value || 50);
        db.prepare('UPDATE users SET affiliate_earnings=affiliate_earnings+?, balance=balance+? WHERE id=?').run(bonus, bonus, referrer.id);
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
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(username.trim(), username.trim().toLowerCase());
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
  const db = getDb();
  const fee = parseFloat(db.prepare("SELECT value FROM settings WHERE key='activation_fee'").get()?.value || 300);
  db.prepare('INSERT INTO payments (user_id,amount,phone,type,status) VALUES (?,?,?,?,?)').run(req.session.userId, fee, phone, 'activation', 'completed');
  db.prepare('UPDATE users SET is_activated=1 WHERE id=?').run(req.session.userId);
  return res.json({ success: true, message: 'Account activated successfully!' });
});

/* ── ME (current user) ── */
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.json({ success: false });
  const db = getDb();
  const user = db.prepare(`SELECT id,username,email,country,mobile,referral_code,is_activated,
    balance,total_earnings,ads_earnings,tiktok_earnings,youtube_earnings,
    trivia_earnings,articles_earnings,affiliate_earnings,agent_bonus,total_withdrawn,created_at
    FROM users WHERE id=?`).get(req.session.userId);
  if (!user) return res.json({ success: false });
  const notifications = db.prepare(`SELECT * FROM notifications WHERE (user_id=? OR is_global=1) AND is_read=0 ORDER BY created_at DESC LIMIT 15`).all(req.session.userId);
  const settingsRows = db.prepare('SELECT key,value FROM settings').all();
  const settings = {};
  settingsRows.forEach(r => { settings[r.key] = r.value; });
  return res.json({ success: true, user, notifications, settings });
});

/* ── MARK NOTIFICATION READ ── */
router.post('/notification/read/:id', (req, res) => {
  if (!req.session.userId) return res.json({ success: false });
  getDb().prepare('UPDATE notifications SET is_read=1 WHERE id=?').run(req.params.id);
  return res.json({ success: true });
});

module.exports = router;
