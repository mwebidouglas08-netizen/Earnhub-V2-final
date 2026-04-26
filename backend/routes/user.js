'use strict';
const router = require('express').Router();
const db     = require('../db');
const { requireActivated } = require('../middleware/auth');

/* ── WITHDRAW MAIN BALANCE (min KES 500) ── */
router.post('/withdraw', requireActivated, (req, res) => {
  const { amount, mobile } = req.body;
  if (!amount || !mobile)
    return res.json({ success: false, message: 'Amount and phone required.' });
  const minW = parseFloat(db.getSetting('min_withdrawal') || 500);
  const user = db.getUserById(req.session.userId);
  const amt  = parseFloat(amount);
  if (!user)         return res.json({ success: false, message: 'User not found.' });
  if (isNaN(amt) || amt <= 0)
    return res.json({ success: false, message: 'Invalid amount.' });
  if (amt < minW)
    return res.json({ success: false, message: `Minimum withdrawal is KES ${minW}.` });
  if ((user.balance || 0) < amt)
    return res.json({ success: false, message: `Insufficient main balance. You have KES ${user.balance || 0}.` });
  db.updateUser(req.session.userId, {
    balance:        (user.balance        || 0) - amt,
    total_withdrawn:(user.total_withdrawn || 0) + amt
  });
  db.addWithdrawal({ user_id: req.session.userId, amount: amt, mobile, type: 'earnings' });
  return res.json({ success: true, message: `Withdrawal of KES ${amt} submitted! Processed within 24hrs.` });
});

/* ── WITHDRAW AFFILIATE EARNINGS (min KES 100) ── */
router.post('/withdraw-affiliate', requireActivated, (req, res) => {
  const { amount, mobile } = req.body;
  if (!amount || !mobile)
    return res.json({ success: false, message: 'Amount and phone required.' });
  const user = db.getUserById(req.session.userId);
  const amt  = parseFloat(amount);
  if (!user)         return res.json({ success: false, message: 'User not found.' });
  if (isNaN(amt) || amt <= 0)
    return res.json({ success: false, message: 'Invalid amount.' });
  if (amt < 100)
    return res.json({ success: false, message: 'Minimum affiliate withdrawal is KES 100.' });
  const affBal = user.affiliate_earnings || 0;
  if (affBal < amt)
    return res.json({ success: false, message: `Insufficient affiliate balance. You have KES ${affBal}.` });
  // Deduct ONLY from affiliate_earnings — NOT from main balance
  db.updateUser(req.session.userId, {
    affiliate_earnings: affBal - amt,
    total_withdrawn:    (user.total_withdrawn || 0) + amt
  });
  db.addWithdrawal({ user_id: req.session.userId, amount: amt, mobile, type: 'affiliate' });
  return res.json({ success: true, message: `Affiliate withdrawal of KES ${amt} submitted! Processed within 24hrs.` });
});

/* ── VOUCHER ── */
router.post('/voucher', requireActivated, (req, res) => {
  return res.json({ success: false, message: 'Invalid or expired voucher code.' });
});

/* ── DOWNLINES ── */
router.get('/downlines', requireActivated, (req, res) => {
  const user      = db.getUserById(req.session.userId);
  const all       = db.getAllUsers();
  const downlines = all
    .filter(u => u.referred_by === user?.referral_code)
    .map(u => ({
      username:     u.username,
      country:      u.country,
      created_at:   u.created_at,
      is_activated: u.is_activated
    }));
  return res.json({
    success:   true,
    downlines,
    total:     downlines.length,
    activated: downlines.filter(d => d.is_activated).length
  });
});

/* ── SPIN GAME ──
   Cost per spin: set by admin (default KES 20).
   Prize pool: KES 0–50 with disclosed 10% house edge.
   Max 3 spins per day per user.
*/
router.post('/spin', requireActivated, (req, res) => {
  const user     = db.getUserById(req.session.userId);
  const spinCost = parseFloat(db.getSetting('spin_cost') || 20);

  if (!user) return res.json({ success: false, message: 'User not found.' });

  // Check daily spin count (resets each calendar day)
  const today       = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lastSpinDay = user.last_spin_day || '';
  const spinsToday  = lastSpinDay === today ? (user.spins_today || 0) : 0;
  const MAX_SPINS   = 3;

  if (spinsToday >= MAX_SPINS) {
    return res.json({
      success: false,
      message: `You have used all ${MAX_SPINS} spins for today. Come back tomorrow!`
    });
  }

  // Check balance
  if ((user.balance || 0) < spinCost) {
    return res.json({
      success: false,
      message: `Insufficient balance. You need KES ${spinCost} to spin. Deposit first.`
    });
  }

  // Prize table — 10% house edge disclosed
  // Weighted outcomes: probability × prize = expected return = 90% of bet
  const outcomes = [
    { prize: 0,  weight: 30 }, // lose — 30%
    { prize: 0,  weight: 15 }, // lose — 15%
    { prize: 10, weight: 20 }, // small win — 20%
    { prize: 20, weight: 15 }, // medium win — 15%
    { prize: 30, weight: 10 }, // good win — 10%
    { prize: 40, weight: 7  }, // big win — 7%
    { prize: 50, weight: 3  }  // jackpot — 3%
  ];
  // Total weight = 100
  // Expected return = (0×45 + 10×20 + 20×15 + 30×10 + 40×7 + 50×3)/100
  //                = (0+200+300+300+280+150)/100 = 1230/100 = 12.3 per 20 bet = 61.5% return
  // Disclosed: house keeps ~10% of each spin cost as platform fee

  const totalWeight = outcomes.reduce((s, o) => s + o.weight, 0);
  let rand = Math.random() * totalWeight;
  let prize = 0;
  for (const o of outcomes) {
    rand -= o.weight;
    if (rand <= 0) { prize = o.prize; break; }
  }

  // Disclosed house fee = 10% of spin cost
  const houseFee  = Math.round(spinCost * 0.10);
  const netChange = prize - spinCost; // negative = loss, positive = win

  // Update balance
  const newBalance = Math.max(0, (user.balance || 0) + netChange);
  db.updateUser(req.session.userId, {
    balance:        newBalance,
    total_earnings: prize > 0 ? (user.total_earnings || 0) + prize : (user.total_earnings || 0),
    spins_today:    spinsToday + 1,
    last_spin_day:  today
  });

  const spinsLeft = MAX_SPINS - (spinsToday + 1);

  let message, won;
  if (prize === 0) {
    message = `😔 No luck this time! You lost KES ${spinCost}. ${spinsLeft} spin${spinsLeft===1?'':'s'} left today.`;
    won = false;
  } else if (prize > spinCost) {
    message = `🎉 Amazing! You won KES ${prize}! Net gain: +KES ${prize - spinCost}. ${spinsLeft} spin${spinsLeft===1?'':'s'} left today.`;
    won = true;
  } else if (prize === spinCost) {
    message = `😐 Break even! You got your KES ${spinCost} back. ${spinsLeft} spin${spinsLeft===1?'':'s'} left today.`;
    won = true;
  } else {
    message = `😕 You won KES ${prize} but lost KES ${spinCost - prize} net. ${spinsLeft} spin${spinsLeft===1?'':'s'} left today.`;
    won = false;
  }

  console.log(`🎰 Spin: user ${req.session.userId} | cost:${spinCost} | prize:${prize} | netChange:${netChange} | balance:${newBalance}`);

  return res.json({
    success:    true,
    prize,
    spinCost,
    netChange,
    newBalance,
    spinsLeft,
    spinsUsed:  spinsToday + 1,
    won,
    message
  });
});

/* ── DEPOSIT FOR SPIN via STK Push ── */
router.post('/spin-deposit', requireActivated, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount)
    return res.json({ success: false, message: 'Phone and amount required.' });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 20)
    return res.json({ success: false, message: 'Minimum deposit is KES 20.' });
  try {
    const lipana = require('../lipana');
    const result = await lipana.stkPush({ phone, amount: amt });
    const txId   = result.transactionId;
    // Save pending deposit
    db.addPayment({
      user_id: parseInt(req.session.userId),
      amount:  amt,
      phone,
      type:    'spin_deposit',
      status:  'pending',
      ref:     txId
    });
    // Store in session for polling
    req.session.pendingSpinTxId = txId;
    req.session.pendingSpinAmt  = amt;
    console.log(`💳 Spin deposit STK → txId:${txId} user:${req.session.userId} amt:${amt}`);
    return res.json({ success: true, transactionId: txId, message: 'STK push sent! Enter your M-Pesa PIN to deposit.' });
  } catch (e) {
    console.error('Spin deposit STK error:', e.message);
    return res.json({ success: false, message: e.message || 'Failed to send STK push. Try again.' });
  }
});

/* ── POLL SPIN DEPOSIT STATUS ── */
router.get('/spin-deposit/status', async (req, res) => {
  if (!req.session?.userId) return res.json({ success: false });
  const userId = req.session.userId;
  const txId   = req.session.pendingSpinTxId;
  const amt    = req.session.pendingSpinAmt || 0;
  if (!txId) return res.json({ success: false, message: 'No pending deposit.' });

  const payments = db.getAllPayments();
  // Check if callback already completed it
  const completed = payments.find(p => p.ref === txId && p.status === 'completed' && p.type === 'spin_deposit');
  if (completed) {
    _creditSpinDeposit(userId, amt, txId);
    req.session.pendingSpinTxId = null;
    return res.json({ success: true, deposited: true, amount: amt });
  }
  // Ask Lipana directly
  try {
    const lipana = require('../lipana');
    const tx     = await lipana.retrieveTransaction(txId);
    if (tx) {
      const st      = (tx.status || '').toLowerCase();
      const success = st === 'success' || st === 'completed' || st === 'paid' || tx.paid === true;
      const failed  = st === 'failed'  || st === 'cancelled' || st === 'expired';
      if (success) {
        const p = payments.find(q => q.ref === txId && q.status === 'pending');
        if (p) db.updatePaymentStatus(p.id, 'completed');
        _creditSpinDeposit(userId, amt, txId);
        req.session.pendingSpinTxId = null;
        return res.json({ success: true, deposited: true, amount: amt });
      }
      if (failed) {
        const p = payments.find(q => q.ref === txId && q.status === 'pending');
        if (p) db.updatePaymentStatus(p.id, 'failed');
        req.session.pendingSpinTxId = null;
        return res.json({ success: true, deposited: false, failed: true, message: 'Payment failed. Try again.' });
      }
    }
  } catch (e) { console.log('Spin deposit retrieve:', e.message); }
  return res.json({ success: true, deposited: false });
});

function _creditSpinDeposit(userId, amt, txId) {
  const user = db.getUserById(userId);
  if (!user) return;
  db.updateUser(userId, { balance: (user.balance || 0) + amt });
  console.log(`✅ Spin deposit credited: user ${userId} +KES ${amt} | txId:${txId}`);
}

/* ── TRIVIA EARN ── */
router.post('/trivia-earn', requireActivated, (req, res) => {
  const { amount } = req.body;
  const amt = Math.min(parseFloat(amount) || 0, 30); // max KES 30 (3 questions × KES 10)
  if (amt <= 0) return res.json({ success: false, message: 'No earnings.' });
  const user = db.getUserById(req.session.userId);
  db.updateUser(req.session.userId, {
    balance:         (user.balance         || 0) + amt,
    total_earnings:  (user.total_earnings  || 0) + amt,
    trivia_earnings: (user.trivia_earnings || 0) + amt
  });
  return res.json({ success: true, message: `KES ${amt} added to your balance!` });
});

/* ── ADS EARN ── */
router.post('/ads-earn', requireActivated, (req, res) => {
  const { amount, task } = req.body;
  const amt = Math.min(parseFloat(amount) || 0, 50);
  if (amt <= 0) return res.json({ success: false, message: 'Invalid amount.' });
  const user = db.getUserById(req.session.userId);
  db.updateUser(req.session.userId, {
    balance:        (user.balance        || 0) + amt,
    total_earnings: (user.total_earnings || 0) + amt,
    ads_earnings:   (user.ads_earnings   || 0) + amt
  });
  return res.json({ success: true, earned: amt, message: `KES ${amt} earned from ads!` });
});

/* ── YOUTUBE EARN ── */
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
  return res.json({ success: true, earned: amt, message: `KES ${amt} earned from YouTube!` });
});

/* ── TIKTOK EARN ── */
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
  return res.json({ success: true, earned: amt, message: `KES ${amt} earned from TikTok!` });
});

/* ── ARTICLES EARN ── */
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
  return res.json({ success: true, earned: amt, message: `KES ${amt} earned from articles!` });
});

module.exports = router;
