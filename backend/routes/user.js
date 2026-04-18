'use strict';
const router = require('express').Router();
const { getDb } = require('../db');
const { requireActivated } = require('../middleware/auth');

/* ── WITHDRAW ── */
router.post('/withdraw', requireActivated, (req, res) => {
  const { amount, mobile } = req.body;
  if (!amount || !mobile) return res.json({ success: false, message: 'Amount and phone required.' });
  const db = getDb();
  const minW = parseFloat(db.prepare("SELECT value FROM settings WHERE key='min_withdrawal'").get()?.value || 500);
  const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.session.userId);
  const amt = parseFloat(amount);
  if (!user || user.balance < amt) return res.json({ success: false, message: 'Insufficient balance.' });
  if (amt < minW) return res.json({ success: false, message: `Minimum withdrawal is KES ${minW}.` });
  db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(amt, req.session.userId);
  db.prepare('INSERT INTO withdrawals (user_id,amount,mobile) VALUES (?,?,?)').run(req.session.userId, amt, mobile);
  return res.json({ success: true, message: 'Withdrawal request submitted! Processed within 24hrs.' });
});

/* ── VOUCHER ── */
router.post('/voucher', requireActivated, (req, res) => {
  return res.json({ success: false, message: 'Invalid or expired voucher code.' });
});

/* ── DOWNLINES ── */
router.get('/downlines', requireActivated, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT referral_code FROM users WHERE id=?').get(req.session.userId);
  const downlines = db.prepare('SELECT username,country,created_at FROM users WHERE referred_by=? ORDER BY created_at DESC').all(user?.referral_code || '');
  return res.json({ success: true, downlines });
});

/* ── SPIN ── */
router.post('/spin', requireActivated, (req, res) => {
  const prizes = [0, 0, 0, 5, 0, 10, 0, 20, 0, 5];
  const prize = prizes[Math.floor(Math.random() * prizes.length)];
  if (prize > 0) {
    const db = getDb();
    db.prepare('UPDATE users SET balance=balance+?,total_earnings=total_earnings+? WHERE id=?').run(prize, prize, req.session.userId);
  }
  return res.json({ success: true, prize, message: prize > 0 ? `🎉 You won KES ${prize}!` : 'Better luck next time!' });
});

module.exports = router;
