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
  if (user.is_activated) return res.json({ success: true, alreadyActivated: true, message: 'Already activated.' });

  const fee = parseFloat(db.getSetting('activation_fee') || 300);

  try {
    // Send STK push
    const result = await lipana.stkPush({ phone, amount: fee });

    const transactionId = result?.transactionId || result?.id || null;
    if (!transactionId) {
      return res.json({ success: false, message: 'STK push sent but no transaction ID returned. Try again.' });
    }

    // Cancel any existing pending payment for this user
    const allPay = db.getAllPayments();
    const oldPending = allPay.find(
      p => p.user_id === user.id && p.status === 'pending' && p.type === 'activation'
    );
    if (oldPending) db.updatePaymentStatus(oldPending.id, 'cancelled');

    // Record new pending payment
    db.addPayment({
      user_id: user.id,
      amount:  fee,
      phone,
      type:    'activation',
      status:  'pending',
      ref:     transactionId
    });

    // Save to session
    req.session.pendingTxId   = transactionId;
    req.session.pendingUserId = user.id;
    req.session.stkSentAt     = Date.now();

    console.log(`✅ STK push sent. txId: ${transactionId}  userId: ${user.id}  phone: ${phone}`);
    return res.json({
      success:       true,
      transactionId: transactionId,
      message:       'STK push sent! Check your phone and enter your M-Pesa PIN.'
    });

  } catch (e) {
    console.error('❌ STK push failed:', e.message);
    return res.json({
      success: false,
      message: e.message || 'Failed to send STK push. Please try again.'
    });
  }
});

/* ── POLL STATUS ──
   STRICT: Only returns activated=true when:
   1. DB already has user.is_activated = 1  (set by callback)
   2. DB has a 'completed' payment for this user (set by callback)
   3. Lipana SDK retrieve() returns a success status

   NEVER activates based on time elapsed or guessing.
*/
router.get('/activate/status', async (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user) return res.json({ success: false });

  // 1. Already activated in DB — callback already did its job
  if (user.is_activated) {
    return res.json({ success: true, activated: true });
  }

  const payments = db.getAllPayments();

  // 2. Payment marked completed by callback
  const completedPay = payments.find(
    p => p.user_id === userId && p.type === 'activation' && p.status === 'completed'
  );
  if (completedPay) {
    _activateUser(userId);
    return res.json({ success: true, activated: true });
  }

  // 3. Ask Lipana directly about the transaction
  const txId = req.session.pendingTxId;
  if (txId) {
    const tx = await lipana.retrieveTransaction(txId);
    if (tx) {
      const txStatus = (tx.status || '').toLowerCase();
      const isSuccess = txStatus === 'success'
                     || txStatus === 'completed'
                     || txStatus === 'paid'
                     || tx.paid === true;

      const isFailed  = txStatus === 'failed'
                     || txStatus === 'cancelled'
                     || txStatus === 'expired';

      if (isSuccess) {
        // Mark payment completed in DB
        const pendingPay = payments.find(p => p.ref === txId && p.status === 'pending');
        if (pendingPay) db.updatePaymentStatus(pendingPay.id, 'completed');
        _activateUser(userId);
        console.log(`✅ User ${userId} activated via retrieve — txId: ${txId} status: ${txStatus}`);
        return res.json({ success: true, activated: true });
      }

      if (isFailed) {
        const pendingPay = payments.find(p => p.ref === txId && p.status === 'pending');
        if (pendingPay) db.updatePaymentStatus(pendingPay.id, 'failed');
        console.log(`❌ Payment failed for user ${userId} — txId: ${txId} status: ${txStatus}`);
        return res.json({
          success: true,
          activated: false,
          failed: true,
          message: 'Payment was cancelled or failed. Please try again.'
        });
      }
    }
  }

  // Not confirmed yet — keep polling
  return res.json({ success: true, activated: false });
});

/* ── MANUAL CONFIRM ──
   ONLY activates if:
   - STK was sent (pending payment exists in DB)
   - Admin can audit via payments table
*/
router.post('/activate/manual', (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user)             return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated) return res.json({ success: true, activated: true });

  // Must have a pending payment (STK was sent)
  const payments = db.getAllPayments();
  const pending  = payments.find(
    p => p.user_id === userId &&
         p.type   === 'activation' &&
         (p.status === 'pending' || p.status === 'completed')
  );

  if (!pending) {
    return res.json({
      success: false,
      message: 'No payment found. Please initiate the STK push payment first.'
    });
  }

  // Mark completed and activate
  if (pending.status !== 'completed') db.updatePaymentStatus(pending.id, 'completed');
  _activateUser(userId);
  console.log(`✅ User ${userId} manually confirmed — pending payment existed`);
  return res.json({ success: true, activated: true, message: 'Account activated!' });
});

/* ── LIPANA WEBHOOK CALLBACK ── */
router.post('/activate/callback', (req, res) => {
  console.log('📩 Lipana callback received:', JSON.stringify(req.body, null, 2));
  try {
    const body = req.body;

    // Extract transaction ID
    const transactionId = body?.transactionId
                       || body?.id
                       || body?.CheckoutRequestID
                       || body?.checkout_request_id
                       || '';

    // Determine success/failure
    const rawStatus = (body?.status || '').toLowerCase();
    const isSuccess  = rawStatus === 'success'
                    || rawStatus === 'completed'
                    || rawStatus === 'paid'
                    || body?.paid === true
                    || body?.ResultCode === 0
                    || body?.ResultCode === '0'
                    || body?.Body?.stkCallback?.ResultCode === 0
                    || String(body?.Body?.stkCallback?.ResultCode) === '0';

    const isFailed   = rawStatus === 'failed'
                    || rawStatus === 'cancelled'
                    || rawStatus === 'expired'
                    || (body?.ResultCode !== undefined && body?.ResultCode !== 0 && body?.ResultCode !== '0');

    console.log(`Callback → txId: "${transactionId}" | isSuccess: ${isSuccess} | isFailed: ${isFailed}`);

    const payments = db.getAllPayments();

    if (isSuccess) {
      // Find payment by transactionId
      let payment = transactionId
        ? payments.find(p => p.ref === transactionId && p.status === 'pending')
        : null;

      // Fallback: latest pending activation
      if (!payment) {
        payment = [...payments]
          .reverse()
          .find(p => p.status === 'pending' && p.type === 'activation');
        if (payment) {
          console.log(`⚠️  Used fallback matching — found payment id ${payment.id} for user ${payment.user_id}`);
        }
      }

      if (payment) {
        db.updatePaymentStatus(payment.id, 'completed');
        _activateUser(payment.user_id);
        console.log(`✅ Callback: User ${payment.user_id} activated`);
      } else {
        console.warn('⚠️  Callback: No matching pending payment found');
      }

    } else if (isFailed) {
      if (transactionId) {
        const p = payments.find(q => q.ref === transactionId && q.status === 'pending');
        if (p) {
          db.updatePaymentStatus(p.id, 'failed');
          console.log(`❌ Callback: Payment ${transactionId} marked failed`);
        }
      }
    }

  } catch (e) {
    console.error('❌ Callback error:', e.message);
  }

  // Always 200 — stop Lipana from retrying
  return res.status(200).json({ success: true });
});

/* ── CREDIT REFERRER ── */
function _activateUser(userId) {
  try {
    const user = db.getUserById(userId);
    if (!user || user.is_activated) return; // already done

    db.updateUser(userId, { is_activated: 1 });

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
        console.log(`💰 Referrer "${referrer.username}" credited KES ${bonus}`);
      }
    }
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
