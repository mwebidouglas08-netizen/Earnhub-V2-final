'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db     = require('../db');

// Lazy-load lipana so SDK crash never kills server startup
function getLipana() { return require('../lipana'); }

router.post('/register', (req, res) => {
  const { username, email, country, mobile, password, confirm_password, referral } = req.body;
  if (!username || !email || !password || !mobile)
    return res.json({ success: false, message: 'All fields are required.' });
  if (password !== confirm_password)
    return res.json({ success: false, message: 'Passwords do not match.' });
  if (password.length < 6)
    return res.json({ success: false, message: 'Password must be at least 6 characters.' });
  try {
    const hash    = bcrypt.hashSync(password, 10);
    const refCode = uuidv4().slice(0, 8).toUpperCase();
    db.createUser({ username: username.trim(), email: email.trim().toLowerCase(), country: country || 'Kenya', mobile, password: hash, referral_code: refCode, referred_by: referral || null });
    return res.json({ success: true, message: 'Account created! Please sign in.' });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE'))
      return res.json({ success: false, message: 'Username or email already taken.' });
    console.error('Register error:', e.message);
    return res.json({ success: false, message: 'Registration failed. Try again.' });
  }
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'Enter username and password.' });
  const user = db.getUserByUsernameOrEmail(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.json({ success: false, message: 'Invalid credentials.' });
  if (user.is_banned) return res.json({ success: false, message: 'Your account has been suspended.' });
  req.session.userId   = user.id;
  req.session.username = user.username;
  return res.json({ success: true, activated: !!user.is_activated });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.post('/activate/stk', async (req, res) => {
  if (!req.session?.userId) return res.json({ success: false, message: 'Not logged in.' });
  const { phone } = req.body;
  if (!phone) return res.json({ success: false, message: 'Phone number required.' });
  const user = db.getUserById(req.session.userId);
  if (!user)             return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated) return res.json({ success: true, alreadyActivated: true });
  const fee = parseFloat(db.getSetting('activation_fee') || 300);
  try {
    const lipana = getLipana();
    const result = await lipana.stkPush({ phone, amount: fee });
    const txId   = result.transactionId;
    // Cancel old pending payments
    db.getAllPayments().forEach(p => {
      if (p.user_id === user.id && p.status === 'pending' && p.type === 'activation')
        db.updatePaymentStatus(p.id, 'cancelled');
    });
    db.addPayment({ user_id: user.id, amount: fee, phone, type: 'activation', status: 'pending', ref: txId });
    req.session.pendingTxId  = txId;
    req.session.stkSentAt    = Date.now();
    console.log(`✅ STK sent → txId:${txId} userId:${user.id}`);
    return res.json({ success: true, transactionId: txId, message: 'STK push sent! Enter your M-Pesa PIN.' });
  } catch (e) {
    console.error('❌ STK error:', e.message);
    return res.json({ success: false, message: e.message || 'STK push failed. Please try again.' });
  }
});

router.get('/activate/status', async (req, res) => {
  if (!req.session?.userId) return res.json({ success: false });
  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user) return res.json({ success: false });
  if (user.is_activated) return res.json({ success: true, activated: true });
  const payments = db.getAllPayments();
  // Check if callback already completed payment
  const completed = payments.find(p => p.user_id === userId && p.type === 'activation' && p.status === 'completed');
  if (completed) { _activateUser(userId); return res.json({ success: true, activated: true }); }
  // Ask Lipana directly
  const txId = req.session.pendingTxId;
  if (txId) {
    try {
      const lipana = getLipana();
      const tx     = await lipana.retrieveTransaction(txId);
      if (tx) {
        const st      = (tx.status || '').toLowerCase();
        const success = st === 'success' || st === 'completed' || st === 'paid' || tx.paid === true;
        const failed  = st === 'failed'  || st === 'cancelled' || st === 'expired';
        if (success) {
          const p = payments.find(q => q.ref === txId && q.status === 'pending');
          if (p) db.updatePaymentStatus(p.id, 'completed');
          _activateUser(userId);
          return res.json({ success: true, activated: true });
        }
        if (failed) {
          const p = payments.find(q => q.ref === txId && q.status === 'pending');
          if (p) db.updatePaymentStatus(p.id, 'failed');
          return res.json({ success: true, activated: false, failed: true, message: 'Payment failed or was cancelled.' });
        }
      }
    } catch (e) { console.log('Retrieve error:', e.message); }
  }
  return res.json({ success: true, activated: false });
});

// Manual access after delay — only if STK was actually sent
router.post('/activate/manual', (req, res) => {
  if (!req.session?.userId) return res.json({ success: false, message: 'Not logged in.' });
  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user)             return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated) return res.json({ success: true, activated: true });
  const hasPaid = db.getAllPayments().find(p => p.user_id === userId && p.type === 'activation' && (p.status === 'pending' || p.status === 'completed'));
  if (!hasPaid) return res.json({ success: false, message: 'No payment found. Please initiate STK push first.' });
  if (hasPaid.status !== 'completed') db.updatePaymentStatus(hasPaid.id, 'completed');
  _activateUser(userId);
  return res.json({ success: true, activated: true, message: 'Account activated!' });
});

router.post('/activate/callback', (req, res) => {
  console.log('📩 Lipana callback:', JSON.stringify(req.body, null, 2));
  try {
    const body      = req.body;
    const txId      = body?.transactionId || body?.transaction_id || body?.id || body?.CheckoutRequestID || '';
    const rawStatus = (body?.status || '').toLowerCase();
    const isSuccess = rawStatus === 'success' || rawStatus === 'completed' || rawStatus === 'paid'
                   || body?.paid === true || body?.ResultCode === 0 || body?.ResultCode === '0'
                   || body?.Body?.stkCallback?.ResultCode === 0;
    const isFailed  = rawStatus === 'failed' || rawStatus === 'cancelled' || rawStatus === 'expired';
    const payments  = db.getAllPayments();
    if (isSuccess) {
      let payment = txId ? payments.find(p => p.ref === txId && p.status === 'pending') : null;
      if (!payment) payment = [...payments].reverse().find(p => p.status === 'pending' && p.type === 'activation');
      if (payment) {
        db.updatePaymentStatus(payment.id, 'completed');
        _activateUser(payment.user_id);
        console.log(`✅ Callback: User ${payment.user_id} ACTIVATED`);
      }
    } else if (isFailed && txId) {
      const p = payments.find(q => q.ref === txId && q.status === 'pending');
      if (p) db.updatePaymentStatus(p.id, 'failed');
    }
  } catch (e) { console.error('Callback error:', e.message); }
  return res.status(200).json({ success: true });
});

function _activateUser(userId) {
  try {
    const user = db.getUserById(userId);
    if (!user || user.is_activated) return;
    db.updateUser(userId, { is_activated: 1 });
    console.log(`✅ User ${userId} (${user.username}) ACTIVATED`);
    // Credit referrer KES 100 immediately
    if (user.referred_by && !user._referrer_credited) {
      const ref = db.getUserByReferralCode(user.referred_by);
      if (ref) {
        const bonus = parseFloat(db.getSetting('referral_bonus') || 100);
        db.updateUser(ref.id, {
          affiliate_earnings: (ref.affiliate_earnings || 0) + bonus,
          balance:            (ref.balance            || 0) + bonus,
          total_earnings:     (ref.total_earnings     || 0) + bonus
        });
        db.updateUser(userId, { _referrer_credited: true });
        console.log(`💰 Referrer "${ref.username}" credited KES ${bonus} — affiliate_earnings now ${(ref.affiliate_earnings||0)+bonus}`);
        // Send notification to referrer
        db.addNotification({
          user_id:   ref.id,
          title:     '💰 Referral Commission Earned!',
          message:   `${user.username} activated using your link. KES ${bonus} added to your affiliate earnings and balance!`,
          type:      'success',
          is_global: false
        });
      }
    }
  } catch (e) { console.error('_activateUser error:', e.message); }
}

router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.json({ success: false });
  const user = db.getUserById(req.session.userId);
  if (!user) return res.json({ success: false });
  const { password, ...safe } = user;
  return res.json({
    success:       true,
    user:          safe,
    notifications: db.getNotificationsForUser(req.session.userId),
    settings:      db.getAllSettings()
  });
});

router.post('/notification/read/:id', (req, res) => {
  if (!req.session?.userId) return res.json({ success: false });
  db.markNotificationRead(req.params.id);
  return res.json({ success: true });
});

module.exports = router;
