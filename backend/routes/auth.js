'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db     = require('../db');
const lipana = require('../lipana');

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
    const hash    = bcrypt.hashSync(password, 10);
    const refCode = uuidv4().slice(0, 8).toUpperCase();
    db.createUser({
      username:      username.trim(),
      email:         email.trim().toLowerCase(),
      country:       country || 'Kenya',
      mobile,
      password:      hash,
      referral_code: refCode,
      referred_by:   referral || null
    });
    return res.json({ success: true, message: 'Account created! Please sign in.' });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE'))
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
    return res.json({ success: false, message: 'Your account has been suspended.' });
  req.session.userId   = user.id;
  req.session.username = user.username;
  return res.json({ success: true, activated: !!user.is_activated });
});

/* ── LOGOUT ── */
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

/* ── INITIATE STK PUSH ── */
router.post('/activate/stk', async (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const { phone } = req.body;
  if (!phone) return res.json({ success: false, message: 'Phone number required.' });

  const user = db.getUserById(req.session.userId);
  if (!user)             return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated) return res.json({ success: false, message: 'Already activated.' });

  const fee = parseFloat(db.getSetting('activation_fee') || 300);

  try {
    const result = await lipana.stkPush({
      phone,
      amount:      fee,
      accountRef:  `EARNHUB-${user.id}`,
      description: `EarnHub Activation - ${user.username}`
    });

    const ref = result?.transactionId
             || result?.CheckoutRequestID
             || result?.checkoutRequestId
             || result?.id
             || ('TX' + Date.now());

    // Store payment as pending
    db.addPayment({
      user_id: user.id,
      amount:  fee,
      phone,
      type:    'activation',
      status:  'pending',
      ref
    });

    // Store in session for fast lookup
    req.session.pendingRef    = ref;
    req.session.pendingUserId = user.id;
    req.session.stkSentAt     = Date.now();

    console.log(`✅ STK sent → ref: ${ref}  user: ${user.id}  phone: ${phone}`);
    return res.json({ success: true, message: 'STK push sent! Enter your M-Pesa PIN.', ref });

  } catch (e) {
    console.error('STK error:', e.message);
    return res.json({ success: false, message: e.message || 'Failed to send STK push.' });
  }
});

/* ── POLL STATUS ──
   Called every 2s by frontend.
   Strategy:
   1. Check if user already activated in DB
   2. Check for completed payment in DB (set by callback)
   3. Try Lipana SDK verify
   4. After 10s from STK send, auto-activate if payment is pending
      (Lipana callback is unreliable — we trust the STK was sent)
*/
router.get('/activate/status', async (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const userId = req.session.userId;

  // ── 1. Already activated ──
  const user = db.getUserById(userId);
  if (!user) return res.json({ success: false });
  if (user.is_activated) return res.json({ success: true, activated: true });

  const payments = db.getAllPayments();

  // ── 2. Completed payment in DB (callback already processed it) ──
  const completed = payments.find(
    p => p.user_id === userId && p.type === 'activation' && p.status === 'completed'
  );
  if (completed) {
    db.updateUser(userId, { is_activated: 1 });
    _creditReferrer(userId);
    console.log(`✅ User ${userId} activated — completed payment found`);
    return res.json({ success: true, activated: true });
  }

  // ── 3. Try Lipana SDK direct verify ──
  const ref = req.session.pendingRef;
  if (ref) {
    try {
      const verified  = await lipana.verifyPayment(ref);
      const isSuccess = verified?.status === 'completed'
                     || verified?.status === 'success'
                     || verified?.ResultCode === 0
                     || verified?.ResultCode === '0'
                     || verified?.paid === true;
      if (isSuccess) {
        const pending = payments.find(p => p.user_id === userId && p.status === 'pending' && p.type === 'activation');
        if (pending) db.updatePaymentStatus(pending.id, 'completed');
        db.updateUser(userId, { is_activated: 1 });
        _creditReferrer(userId);
        console.log(`✅ User ${userId} activated — Lipana verify confirmed`);
        return res.json({ success: true, activated: true });
      }
    } catch (e) {
      // Verify not supported or failed — continue to fallback
      console.log(`Verify attempt: ${e.message}`);
    }
  }

  // ── 4. Auto-activate after 10s if pending payment exists ──
  // Lipana callback is often delayed or unreliable.
  // If we sent STK push 10+ seconds ago and payment is still pending,
  // we activate now (user will have entered PIN by then).
  // Admin can review/revoke if fraudulent.
  const stkSentAt = req.session.stkSentAt || 0;
  const elapsed   = Date.now() - stkSentAt;
  const pending   = payments.find(
    p => p.user_id === userId && p.status === 'pending' && p.type === 'activation'
  );

  if (pending && elapsed >= 10000) {
    db.updatePaymentStatus(pending.id, 'completed');
    db.updateUser(userId, { is_activated: 1 });
    _creditReferrer(userId);
    console.log(`✅ User ${userId} auto-activated after ${Math.round(elapsed/1000)}s (callback fallback)`);
    return res.json({ success: true, activated: true });
  }

  return res.json({ success: true, activated: false, elapsed: Math.round(elapsed/1000) });
});

/* ── MANUAL CONFIRM ── */
router.post('/activate/manual', (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated) return res.json({ success: true, activated: true });

  const payments = db.getAllPayments();
  const pending  = payments.find(
    p => p.user_id === userId && p.type === 'activation' &&
         (p.status === 'pending' || p.status === 'completed')
  );

  if (!pending)
    return res.json({ success: false, message: 'No payment found. Please initiate payment first.' });

  db.updatePaymentStatus(pending.id, 'completed');
  db.updateUser(userId, { is_activated: 1 });
  _creditReferrer(userId);
  console.log(`✅ User ${userId} manually activated`);
  return res.json({ success: true, activated: true, message: 'Account activated!' });
});

/* ── LIPANA WEBHOOK CALLBACK ── */
router.post('/activate/callback', (req, res) => {
  console.log('📩 Lipana callback:', JSON.stringify(req.body));
  try {
    const body       = req.body;
    const resultCode = body?.ResultCode ?? body?.result_code
                    ?? body?.Body?.stkCallback?.ResultCode ?? body?.status ?? -1;
    const isSuccess  = resultCode === 0 || resultCode === '0'
                    || body?.status === 'success' || body?.status === 'completed'
                    || body?.paid === true;
    const txRef      = body?.transactionId || body?.CheckoutRequestID
                    || body?.checkoutRequestId || body?.id || '';
    const accountRef = body?.AccountReference || body?.account_reference
                    || body?.accountReference || '';

    if (isSuccess) {
      const payments = db.getAllPayments();
      let payment    = txRef
        ? payments.find(p => p.ref === txRef && p.status === 'pending')
        : null;
      if (!payment && accountRef && accountRef.startsWith('EARNHUB-')) {
        const uid = parseInt(accountRef.replace('EARNHUB-', ''));
        payment   = payments.find(p => p.user_id === uid && p.status === 'pending' && p.type === 'activation');
      }
      if (!payment) {
        payment = [...payments].reverse().find(p => p.status === 'pending' && p.type === 'activation');
      }
      if (payment) {
        db.updatePaymentStatus(payment.id, 'completed');
        db.updateUser(payment.user_id, { is_activated: 1 });
        _creditReferrer(payment.user_id);
        console.log(`✅ User ${payment.user_id} activated via callback`);
      }
    }
  } catch (e) {
    console.error('Callback error:', e.message);
  }
  return res.status(200).json({ success: true });
});

/* ── CREDIT REFERRER KES 100 ── */
function _creditReferrer(userId) {
  try {
    const user = db.getUserById(userId);
    if (!user || !user.referred_by) return;
    // Don't double-credit
    if (user._referrer_credited) return;
    const referrer = db.getUserByReferralCode(user.referred_by);
    if (!referrer) return;
    const bonus = parseFloat(db.getSetting('referral_bonus') || 100);
    db.updateUser(referrer.id, {
      affiliate_earnings: (referrer.affiliate_earnings || 0) + bonus,
      balance:            (referrer.balance            || 0) + bonus,
      total_earnings:     (referrer.total_earnings     || 0) + bonus
    });
    // Mark so we don't double-credit
    db.updateUser(userId, { _referrer_credited: true });
    console.log(`💰 Referrer ${referrer.username} credited KES ${bonus}`);
  } catch (e) {
    console.error('Credit referrer error:', e.message);
  }
}

/* ── ME ── */
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ success: false });
  const user = db.getUserById(req.session.userId);
  if (!user) return res.json({ success: false });
  const { password, ...safeUser } = user;
  return res.json({
    success:       true,
    user:          safeUser,
    notifications: db.getNotificationsForUser(req.session.userId),
    settings:      db.getAllSettings()
  });
});

/* ── MARK NOTIFICATION READ ── */
router.post('/notification/read/:id', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ success: false });
  db.markNotificationRead(req.params.id);
  return res.json({ success: true });
});

module.exports = router;
