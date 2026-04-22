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
  if (user.is_activated) return res.json({ success: true,  message: 'Already activated.', alreadyDone: true });

  const fee = parseFloat(db.getSetting('activation_fee') || 300);

  try {
    const result = await lipana.stkPush({ phone, amount: fee });

    // transactionId is the primary ID from Lipana SDK
    const transactionId = result?.transactionId
                       || result?.id
                       || result?.CheckoutRequestID
                       || ('TX' + Date.now());

    // Remove any previous pending payment for this user
    const existing = db.getAllPayments().find(
      p => p.user_id === user.id && p.status === 'pending' && p.type === 'activation'
    );
    if (existing) db.updatePaymentStatus(existing.id, 'cancelled');

    // Save new pending payment
    db.addPayment({
      user_id: user.id,
      amount:  fee,
      phone,
      type:    'activation',
      status:  'pending',
      ref:     transactionId
    });

    // Store in session for polling
    req.session.pendingTxId  = transactionId;
    req.session.pendingUserId = user.id;
    req.session.stkSentAt    = Date.now();

    console.log(`✅ STK sent → txId: ${transactionId}  user: ${user.id}`);
    return res.json({
      success:       true,
      transactionId: transactionId,
      message:       'STK push sent! Enter your M-Pesa PIN on your phone.'
    });

  } catch (e) {
    console.error('STK error:', e.message);
    return res.json({ success: false, message: e.message || 'Failed to send STK push. Try again.' });
  }
});

/* ── POLL PAYMENT STATUS ──
   Called every 3s by frontend.
   Uses Lipana SDK retrieve() to directly check transaction status.
   Only activates when confirmed paid — no premature activation.
*/
router.get('/activate/status', async (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const userId = req.session.userId;

  // 1. Already activated in DB
  const user = db.getUserById(userId);
  if (!user) return res.json({ success: false });
  if (user.is_activated) return res.json({ success: true, activated: true });

  const payments = db.getAllPayments();

  // 2. Check if callback already marked payment completed
  const completedPayment = payments.find(
    p => p.user_id === userId && p.type === 'activation' && p.status === 'completed'
  );
  if (completedPayment) {
    _activateUser(userId);
    return res.json({ success: true, activated: true });
  }

  // 3. Poll Lipana directly using transactionId
  const txId = req.session.pendingTxId;
  if (txId) {
    try {
      const tx = await lipana.retrieveTransaction(txId);
      if (tx) {
        // Check all possible success status values Lipana may return
        const paid = tx.status === 'success'
                  || tx.status === 'completed'
                  || tx.status === 'paid'
                  || tx.paid   === true
                  || tx.ResultCode === 0
                  || tx.ResultCode === '0';

        if (paid) {
          // Mark payment completed
          const pending = payments.find(p => p.ref === txId && p.status === 'pending');
          if (pending) db.updatePaymentStatus(pending.id, 'completed');
          _activateUser(userId);
          console.log(`✅ User ${userId} activated via Lipana retrieve — txId: ${txId}`);
          return res.json({ success: true, activated: true });
        }

        // Check for explicit failure
        const failed = tx.status === 'failed'
                    || tx.status === 'cancelled'
                    || tx.status === 'expired'
                    || (tx.ResultCode && tx.ResultCode !== 0 && tx.ResultCode !== '0');
        if (failed) {
          const pending = payments.find(p => p.ref === txId && p.status === 'pending');
          if (pending) db.updatePaymentStatus(pending.id, 'failed');
          return res.json({ success: true, activated: false, failed: true, message: 'Payment was cancelled or failed. Please try again.' });
        }
      }
    } catch (e) {
      console.log(`Retrieve check for ${txId}:`, e.message);
    }
  }

  return res.json({ success: true, activated: false });
});

/* ── MANUAL CONFIRM (shown after 20s as fallback) ── */
router.post('/activate/manual', (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user)             return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated) return res.json({ success: true, activated: true });

  // Only allow manual confirm if STK was actually sent
  const payments = db.getAllPayments();
  const pending  = payments.find(
    p => p.user_id === userId && p.type === 'activation' &&
        (p.status === 'pending' || p.status === 'completed')
  );

  if (!pending)
    return res.json({ success: false, message: 'No payment initiated. Please start the payment first.' });

  db.updatePaymentStatus(pending.id, 'completed');
  _activateUser(userId);
  console.log(`✅ User ${userId} manually confirmed after STK push`);
  return res.json({ success: true, activated: true, message: 'Account activated!' });
});

/* ── LIPANA WEBHOOK CALLBACK ──
   Lipana POSTs here when payment is confirmed.
   This is the primary/fastest activation path.
*/
router.post('/activate/callback', (req, res) => {
  console.log('📩 Lipana callback body:', JSON.stringify(req.body, null, 2));

  try {
    const body = req.body;

    // Extract fields — Lipana SDK webhook format
    const transactionId = body?.transactionId
                       || body?.id
                       || body?.CheckoutRequestID
                       || body?.checkout_request_id
                       || '';

    const status = body?.status || '';
    const paid   = body?.paid;

    const isSuccess = status === 'success'
                   || status === 'completed'
                   || status === 'paid'
                   || paid   === true
                   || body?.ResultCode === 0
                   || body?.ResultCode === '0'
                   || body?.Body?.stkCallback?.ResultCode === 0
                   || String(body?.Body?.stkCallback?.ResultCode) === '0';

    const isFailed = status === 'failed'
                  || status === 'cancelled'
                  || status === 'expired'
                  || (body?.ResultCode && body.ResultCode !== 0 && body.ResultCode !== '0')
                  || (body?.Body?.stkCallback?.ResultCode && body.Body.stkCallback.ResultCode !== 0);

    console.log(`Callback — transactionId: ${transactionId} | isSuccess: ${isSuccess} | isFailed: ${isFailed}`);

    const payments = db.getAllPayments();

    if (isSuccess) {
      // Find matching payment by transactionId ref
      let payment = transactionId
        ? payments.find(p => p.ref === transactionId && p.status === 'pending')
        : null;

      // Fallback: most recent pending activation if no ref match
      if (!payment) {
        payment = [...payments]
          .reverse()
          .find(p => p.status === 'pending' && p.type === 'activation');
      }

      if (payment) {
        db.updatePaymentStatus(payment.id, 'completed');
        _activateUser(payment.user_id);
        console.log(`✅ User ${payment.user_id} activated via Lipana callback`);
      } else {
        console.warn('⚠️  No matching pending payment found in callback');
      }

    } else if (isFailed) {
      if (transactionId) {
        const p = payments.find(q => q.ref === transactionId && q.status === 'pending');
        if (p) db.updatePaymentStatus(p.id, 'failed');
      }
      console.log('❌ Callback: payment failed/cancelled');
    } else {
      console.log('ℹ️  Callback received but status unclear — ignoring:', status);
    }

  } catch (e) {
    console.error('Callback processing error:', e.message);
  }

  // ALWAYS return 200 — so Lipana stops retrying
  return res.status(200).json({ success: true });
});

/* ── ACTIVATE USER helper ── */
function _activateUser(userId) {
  try {
    const user = db.getUserById(userId);
    if (!user || user.is_activated) return;
    db.updateUser(userId, { is_activated: 1 });

    // Credit referrer KES 100
    if (user.referred_by && !user._referrer_credited) {
      const referrer = db.getUserByReferralCode(user.referred_by);
      if (referrer) {
        const bonus = parseFloat(db.getSetting('referral_bonus') || 100);
        db.updateUser(referrer.id, {
          affiliate_earnings: (referrer.affiliate_earnings || 0) + bonus,
          balance:            (referrer.balance            || 0) + bonus,
          total_earnings:     (referrer.total_earnings     || 0) + bonus
        });
        db.updateUser(userId, { _referrer_credited: true });
        console.log(`💰 Referrer ${referrer.username} credited KES ${bonus}`);
      }
    }
    console.log(`✅ User ${userId} activated`);
  } catch (e) {
    console.error('_activateUser error:', e.message);
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
