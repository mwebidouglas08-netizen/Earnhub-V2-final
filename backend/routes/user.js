'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireActivated } = require('../middleware/auth');

/* ── WITHDRAW ── */
router.post('/withdraw', requireActivated, (req, res) => {
  const { amount, mobile } = req.body;
  if (!amount || !mobile) return res.json({ success: false, message: 'Amount and phone required.' });
  const minW = parseFloat(db.getSetting('min_withdrawal') || 500);
  const user = db.getUserById(req.session.userId);
  const amt = parseFloat(amount);
  if (!user || user.balance < amt) return res.json({ success: false, message: 'Insufficient balance.' });
  if (amt < minW) return res.json({ success: false, message: `Minimum withdrawal is KES ${minW}.` });
  db.updateUser(req.session.userId, { balance: user.balance - amt });
  db.addWithdrawal({ user_id: req.session.userId, amount: amt, mobile });
  return res.json({ success: true, message: 'Withdrawal request submitted! Processed within 24hrs.' });
});

/* ── VOUCHER ── */
router.post('/voucher', requireActivated, (req, res) => {
  return res.json({ success: false, message: 'Invalid or expired voucher code.' });
});

/* ── DOWNLINES ── */
router.get('/downlines', requireActivated, (req, res) => {
  const user = db.getUserById(req.session.userId);
  const allUsers = db.getAllUsers();
  const downlines = allUsers
    .filter(u => u.referred_by === (user?.referral_code || ''))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(({ username, country, created_at }) => ({ username, country, created_at }));
  return res.json({ success: true, downlines });
});

/* ── SPIN ── */
router.post('/spin', requireActivated, (req, res) => {
  const prizes = [0, 0, 0, 5, 0, 10, 0, 20, 0, 5];
  const prize = prizes[Math.floor(Math.random() * prizes.length)];
  if (prize > 0) {
    const user = db.getUserById(req.session.userId);
    if (user) {
      db.updateUser(req.session.userId, {
        balance: user.balance + prize,
        total_earnings: user.total_earnings + prize
      });
    }
  }
  return res.json({ success: true, prize, message: prize > 0 ? `🎉 You won KES ${prize}!` : 'Better luck next time!' });
});

module.exports = router;
