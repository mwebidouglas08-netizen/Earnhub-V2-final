'use strict';
const router = require('express').Router();
const db     = require('../db');
const { requireActivated } = require('../middleware/auth');

router.post('/withdraw', requireActivated, (req, res) => {
  const { amount, mobile } = req.body;
  if (!amount || !mobile) return res.json({ success: false, message: 'Amount and phone required.' });
  const minW = parseFloat(db.getSetting('min_withdrawal') || 500);
  const user = db.getUserById(req.session.userId);
  const amt  = parseFloat(amount);
  if (!user || user.balance < amt) return res.json({ success: false, message: 'Insufficient balance.' });
  if (amt < minW) return res.json({ success: false, message: `Minimum withdrawal is KES ${minW}.` });
  db.updateUser(req.session.userId, { balance: user.balance - amt });
  db.addWithdrawal({ user_id: req.session.userId, amount: amt, mobile });
  return res.json({ success: true, message: 'Withdrawal request submitted! Processed within 24hrs.' });
});

router.post('/voucher', requireActivated, (req, res) => {
  return res.json({ success: false, message: 'Invalid or expired voucher code.' });
});

router.get('/downlines', requireActivated, (req, res) => {
  const user      = db.getUserById(req.session.userId);
  const all       = db.getAllUsers();
  const downlines = all.filter(u => u.referred_by === user?.referral_code).map(u => ({ username: u.username, country: u.country, created_at: u.created_at }));
  return res.json({ success: true, downlines });
});

router.post('/spin', requireActivated, (req, res) => {
  const prizes = [0, 0, 0, 5, 0, 10, 0, 20, 0, 5];
  const prize  = prizes[Math.floor(Math.random() * prizes.length)];
  if (prize > 0) {
    const user = db.getUserById(req.session.userId);
    db.updateUser(req.session.userId, { balance: (user.balance||0)+prize, total_earnings: (user.total_earnings||0)+prize });
  }
  return res.json({ success: true, prize, message: prize > 0 ? `🎉 You won KES ${prize}!` : 'Better luck next time!' });
});

router.post('/trivia-earn', requireActivated, (req, res) => {
  const { amount } = req.body;
  const amt = Math.min(parseFloat(amount) || 0, 100);
  if (amt <= 0) return res.json({ success: false, message: 'No earnings.' });
  const user = db.getUserById(req.session.userId);
  db.updateUser(req.session.userId, { balance: (user.balance||0)+amt, total_earnings: (user.total_earnings||0)+amt, trivia_earnings: (user.trivia_earnings||0)+amt });
  console.log(`💰 Trivia: user ${req.session.userId} earned KES ${amt}`);
  return res.json({ success: true, message: `KES ${amt} added to your balance!` });
});

module.exports = router;
