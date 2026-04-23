'use strict';
const router = require('express').Router();
const db     = require('../db');
const { requireActivated } = require('../middleware/auth');

// ── Withdraw main balance (min KES 500) ──
router.post('/withdraw', requireActivated, (req, res) => {
  const { amount, mobile } = req.body;
  if (!amount || !mobile) return res.json({ success: false, message: 'Amount and phone required.' });
  const minW = parseFloat(db.getSetting('min_withdrawal') || 500);
  const user = db.getUserById(req.session.userId);
  const amt  = parseFloat(amount);
  if (!user || user.balance < amt)
    return res.json({ success: false, message: 'Insufficient balance.' });
  if (amt < minW)
    return res.json({ success: false, message: `Minimum withdrawal is KES ${minW}.` });
  db.updateUser(req.session.userId, { balance: user.balance - amt });
  db.addWithdrawal({ user_id: req.session.userId, amount: amt, mobile, type: 'earnings' });
  return res.json({ success: true, message: `Withdrawal of KES ${amt} submitted! Processed within 24hrs.` });
});

// ── Withdraw affiliate earnings separately (min KES 100) ──
router.post('/withdraw-affiliate', requireActivated, (req, res) => {
  const { amount, mobile } = req.body;
  if (!amount || !mobile) return res.json({ success: false, message: 'Amount and phone required.' });
  const minW = 100; // minimum KES 100 for affiliate
  const user = db.getUserById(req.session.userId);
  const amt  = parseFloat(amount);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  if ((user.affiliate_earnings || 0) < amt)
    return res.json({ success: false, message: `Insufficient affiliate earnings. You have KES ${user.affiliate_earnings || 0}.` });
  if (amt < minW)
    return res.json({ success: false, message: `Minimum affiliate withdrawal is KES ${minW}.` });
  db.updateUser(req.session.userId, {
    affiliate_earnings: (user.affiliate_earnings || 0) - amt,
    total_withdrawn:    (user.total_withdrawn    || 0) + amt
  });
  db.addWithdrawal({ user_id: req.session.userId, amount: amt, mobile, type: 'affiliate' });
  return res.json({ success: true, message: `Affiliate withdrawal of KES ${amt} submitted! Processed within 24hrs.` });
});

router.post('/voucher', requireActivated, (req, res) => {
  return res.json({ success: false, message: 'Invalid or expired voucher code.' });
});

router.get('/downlines', requireActivated, (req, res) => {
  const user      = db.getUserById(req.session.userId);
  const all       = db.getAllUsers();
  const downlines = all
    .filter(u => u.referred_by === user?.referral_code)
    .map(u => ({ username: u.username, country: u.country, created_at: u.created_at, is_activated: u.is_activated }));
  return res.json({ success: true, downlines, total: downlines.length, activated: downlines.filter(d => d.is_activated).length });
});

router.post('/spin', requireActivated, (req, res) => {
  const prizes = [0, 0, 0, 5, 0, 10, 0, 20, 0, 5];
  const prize  = prizes[Math.floor(Math.random() * prizes.length)];
  if (prize > 0) {
    const user = db.getUserById(req.session.userId);
    db.updateUser(req.session.userId, {
      balance:        (user.balance        || 0) + prize,
      total_earnings: (user.total_earnings || 0) + prize
    });
  }
  return res.json({ success: true, prize, message: prize > 0 ? `🎉 You won KES ${prize}!` : 'Better luck next time!' });
});

// ── Trivia earnings ──
router.post('/trivia-earn', requireActivated, (req, res) => {
  const { amount } = req.body;
  const amt = Math.min(parseFloat(amount) || 0, 100);
  if (amt <= 0) return res.json({ success: false, message: 'No earnings.' });
  const user = db.getUserById(req.session.userId);
  db.updateUser(req.session.userId, {
    balance:         (user.balance         || 0) + amt,
    total_earnings:  (user.total_earnings  || 0) + amt,
    trivia_earnings: (user.trivia_earnings || 0) + amt
  });
  return res.json({ success: true, message: `KES ${amt} added to your balance!` });
});

// ── Ads earnings ──
router.post('/ads-earn', requireActivated, (req, res) => {
  const { amount, task } = req.body;
  const amt = Math.min(parseFloat(amount) || 0, 50); // max KES 50 per ad task
  if (amt <= 0) return res.json({ success: false, message: 'Invalid amount.' });
  const user = db.getUserById(req.session.userId);
  db.updateUser(req.session.userId, {
    balance:        (user.balance        || 0) + amt,
    total_earnings: (user.total_earnings || 0) + amt,
    ads_earnings:   (user.ads_earnings   || 0) + amt
  });
  console.log(`📣 Ads earn: user ${req.session.userId} earned KES ${amt} from task: ${task || 'ad'}`);
  return res.json({ success: true, earned: amt, message: `KES ${amt} earned from ads and added to your balance!` });
});

// ── YouTube earnings ──
router.post('/youtube-earn', requireActivated, (req, res) => {
  const { amount } = req.body;
  const amt = Math.min(parseFloat(amount) || 0, 25);
  if (amt <= 0) return res.json({ success: false, message: 'Invalid amount.' });
  const user = db.getUserById(req.session.userId);
  db.updateUser(req.session.userId, {
    balance:          (user.balance          || 0) + amt,
    total_earnings:   (user.total_earnings   || 0) + amt,
    youtube_earnings: (user.youtube_earnings || 0) + amt
  });
  return res.json({ success: true, earned: amt, message: `KES ${amt} earned from YouTube and added to your balance!` });
});

// ── TikTok earnings ──
router.post('/tiktok-earn', requireActivated, (req, res) => {
  const { amount } = req.body;
  const amt = Math.min(parseFloat(amount) || 0, 20);
  if (amt <= 0) return res.json({ success: false, message: 'Invalid amount.' });
  const user = db.getUserById(req.session.userId);
  db.updateUser(req.session.userId, {
    balance:         (user.balance         || 0) + amt,
    total_earnings:  (user.total_earnings  || 0) + amt,
    tiktok_earnings: (user.tiktok_earnings || 0) + amt
  });
  return res.json({ success: true, earned: amt, message: `KES ${amt} earned from TikTok and added to your balance!` });
});

// ── Articles earnings ──
router.post('/articles-earn', requireActivated, (req, res) => {
  const { amount } = req.body;
  const amt = Math.min(parseFloat(amount) || 0, 200);
  if (amt <= 0) return res.json({ success: false, message: 'Invalid amount.' });
  const user = db.getUserById(req.session.userId);
  db.updateUser(req.session.userId, {
    balance:           (user.balance           || 0) + amt,
    total_earnings:    (user.total_earnings    || 0) + amt,
    articles_earnings: (user.articles_earnings || 0) + amt
  });
  return res.json({ success: true, earned: amt, message: `KES ${amt} earned from articles and added to your balance!` });
});

module.exports = router;
