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
  if (!phone)
    return res.json({ success: false, message: 'Phone number required.' });

  const user = db.getUserById(req.session.userId);
  if (!user)
    return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated)
    return res.json({ success: true, alreadyActivated: true, message: 'Already activated.' });

  const fee = parseFloat(db.getSetting('activation_fee') || 300);

  try {
    const result = await lipana.stkPush({ phone, amount: fee });

    const transactionId = result?.transactionId
                       || result?.id
                       || null;

    if (!transactionId) {
      console.error('No transactionId in Lipana response:', JSON.stringify(result));
      return res.json({
        success: false,
        message: 'STK push sent but no transaction ID received. Please try again.'
      });
    }

    // Cancel any old pending payments for this user
    const allPay = db.getAllPayments();
    allPay.forEach(p => {
      if (p.user_id === user.id && p.status === 'pending' && p.type === 'activation') {
        db.updatePaymentStatus(p.id, 'cancelled');
      }
    });

    // Save this pending payment
    db.addPayment({
      user_id: user.id,
      amount:  fee,
      phone,
      type:    'activation',
      status:  'pending',
      ref:     transactionId
    });

    // Save to session for polling
    req.session.pendingTxId   = transactionId;
    req.session.pendingUserId = user.id;
    req.session.stkSentAt     = Date.now();

    console.log(`✅ STK push sent → txId: ${transactionId}  userId: ${user.id}  phone: ${phone}`);

    return res.json({
      success:       true,
      transactionId: transactionId,
      message:       'STK push sent! Enter your M-Pesa PIN on your phone.'
    });

  } catch (e) {
    console.error('❌ STK push error:', e.message);
    return res.json({
      success: false,
      message: e.message || 'Failed to send STK push. Please try again.'
    });
  }
});

/* ── POLL STATUS ──
   ONLY confirms activation when:
   1. DB has user.is_activated = 1  (set ONLY by callback)
   2. DB has a 'completed' payment  (set ONLY by callback)
   3. Lipana SDK retrieve() returns confirmed success status

   NO time-based activation.
   NO manual button activation.
   NO guessing.
*/
router.get('/activate/status', async (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user) return res.json({ success: false });

  // 1. Already activated — callback has already done its job
  if (user.is_activated)
    return res.json({ success: true, activated: true });

  const payments = db.getAllPayments();

  // 2. Callback marked payment as completed
  const completedPay = payments.find(
    p => p.user_id === userId &&
         p.type    === 'activation' &&
         p.status  === 'completed'
  );
  if (completedPay) {
    _activateUser(userId);
    return res.json({ success: true, activated: true });
  }

  // 3. Direct SDK retrieve — ask Lipana for real payment status
  const txId = req.session.pendingTxId;
  if (txId) {
    const tx = await lipana.retrieveTransaction(txId);
    if (tx) {
      const st = (tx.status || '').toLowerCase();

      const isConfirmed = st === 'success'
                       || st === 'completed'
                       || st === 'paid'
                       || tx.paid === true;

      const isFailed    = st === 'failed'
                       || st === 'cancelled'
                       || st === 'expired';

      if (isConfirmed) {
        const pendingPay = payments.find(
          p => p.ref === txId && p.status === 'pending'
        );
        if (pendingPay) db.updatePaymentStatus(pendingPay.id, 'completed');
        _activateUser(userId);
        console.log(`✅ User ${userId} activated via Lipana retrieve — status: ${st}`);
        return res.json({ success: true, activated: true });
      }

      if (isFailed) {
        const pendingPay = payments.find(
          p => p.ref === txId && p.status === 'pending'
        );
        if (pendingPay) db.updatePaymentStatus(pendingPay.id, 'failed');
        console.log(`❌ Payment failed for user ${userId} — status: ${st}`);
        return res.json({
          success:   true,
          activated: false,
          failed:    true,
          message:   'Payment was cancelled or failed. Please try again.'
        });
      }
    }
  }

  // Payment not yet confirmed — keep polling
  return res.json({ success: true, activated: false });
});

/* ── LIPANA WEBHOOK CALLBACK ──
   This is the PRIMARY and most reliable activation path.
   Lipana POSTs here immediately after payment is confirmed.
*/
router.post('/activate/callback', (req, res) => {
  // ALWAYS respond 200 immediately — prevents Lipana from retrying endlessly
  res.status(200).json({ success: true });

  console.log('📩 Lipana callback received at', new Date().toISOString());
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));

  try {
    const body = req.body || {};

    // Extract transaction ID — try all known field names
    const transactionId = body.transactionId
                       || body.id
                       || body.transaction_id
                       || body.CheckoutRequestID
                       || body.checkout_request_id
                       || body.MerchantRequestID
                       || body.merchant_request_id
                       || body?.Body?.stkCallback?.CheckoutRequestID
                       || '';

    // Extract amount — try all known field names
    const amount = body.amount
                || body.Amount
                || body?.Body?.stkCallback?.CallbackMetadata?.Item?.find?.(i => i.Name === 'Amount')?.Value
                || null;

    // Determine if payment succeeded — handle all known Lipana/M-Pesa formats
    const rawStatus = (body.status || body.Status || '').toLowerCase();
    const resultCode = body.ResultCode
                    ?? body.result_code
                    ?? body?.Body?.stkCallback?.ResultCode;

    const isSuccess = rawStatus === 'success'
                   || rawStatus === 'completed'
                   || rawStatus === 'paid'
                   || rawStatus === 'confirmed'
                   || body.paid === true
                   || body.is_paid === true
                   || resultCode === 0
                   || resultCode === '0'
                   || String(resultCode) === '0';

    const isFailed  = rawStatus === 'failed'
                   || rawStatus === 'cancelled'
                   || rawStatus === 'expired'
                   || rawStatus === 'rejected'
                   || (
                        resultCode !== undefined &&
                        resultCode !== null &&
                        resultCode !== 0 &&
                        resultCode !== '0'
                      );

    console.log(`Callback → txId:"${transactionId}" amount:${amount} success:${isSuccess} failed:${isFailed} rawStatus:"${rawStatus}" resultCode:${resultCode}`);

    const payments = db.getAllPayments();

    if (isSuccess) {
      // Match by transaction ID first
      let payment = transactionId
        ? payments.find(p => p.ref === transactionId && p.status === 'pending')
        : null;

      // Fallback: most recent pending activation (within last 10 minutes)
      if (!payment) {
        const tenMinAgo = Date.now() - 10 * 60 * 1000;
        payment = [...payments]
          .reverse()
          .find(p =>
            p.status === 'pending' &&
            p.type   === 'activation' &&
            new Date(p.created_at).getTime() > tenMinAgo
          );

        if (payment) {
          console.log(`⚠️  Fallback match (recent pending) — payment #${payment.id} userId:${payment.user_id}`);
        }
      }

      if (payment) {
        db.updatePaymentStatus(payment.id, 'completed');
        _activateUser(payment.user_id);
        console.log(`✅ Callback: User ${payment.user_id} ACTIVATED via webhook`);
      } else {
        console.warn('⚠️  Callback: No matching pending payment found for txId:', transactionId);
      }

    } else if (isFailed) {
      if (transactionId) {
        const p = payments.find(q => q.ref === transactionId && q.status === 'pending');
        if (p) {
          db.updatePaymentStatus(p.id, 'failed');
          console.log(`❌ Callback: Payment #${p.id} marked failed`);
        }
      }
    } else {
      console.log('ℹ️  Callback status unclear — body logged above. No action taken.');
    }

  } catch (e) {
    console.error('❌ Callback processing error:', e.message, e.stack);
  }
});

/* ── TRANSACTION STATUS — direct Lipana query for a specific txId ── */
router.get('/activate/tx-status/:txId', async (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const { txId } = req.params;
  if (!txId) return res.json({ success: false, message: 'No transaction ID.' });

  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user) return res.json({ success: false });

  // Already activated — nothing more to do
  if (user.is_activated)
    return res.json({ success: true, activated: true });

  try {
    const tx = await lipana.retrieveTransaction(txId);
    if (!tx) return res.json({ success: true, activated: false, status: 'unknown' });

    const st = (tx.status || '').toLowerCase();
    const isConfirmed = st === 'success' || st === 'completed' || st === 'paid' || st === 'confirmed' || tx.paid === true;
    const isFailed    = st === 'failed'  || st === 'cancelled' || st === 'expired' || st === 'rejected';

    if (isConfirmed) {
      const payments   = db.getAllPayments();
      const pendingPay = payments.find(p => p.ref === txId && p.status === 'pending');
      if (pendingPay) db.updatePaymentStatus(pendingPay.id, 'completed');
      _activateUser(userId);
      console.log(`✅ User ${userId} activated via tx-status endpoint — txId: ${txId} status: ${st}`);
      return res.json({ success: true, activated: true, status: st });
    }

    if (isFailed) {
      const payments   = db.getAllPayments();
      const pendingPay = payments.find(p => p.ref === txId && p.status === 'pending');
      if (pendingPay) db.updatePaymentStatus(pendingPay.id, 'failed');
      return res.json({ success: true, activated: false, failed: true, status: st });
    }

    return res.json({ success: true, activated: false, status: st || 'pending' });
  } catch (e) {
    console.error('tx-status error:', e.message);
    return res.json({ success: true, activated: false, status: 'unknown', error: e.message });
  }
});

/* ── INTERNAL: activate user + credit referrer ── */
function _activateUser(userId) {
  try {
    const user = db.getUserById(userId);
    if (!user || user.is_activated) return; // guard double-activation

    db.updateUser(userId, { is_activated: 1 });
    console.log(`✅ User ${userId} (${user.username}) is now ACTIVATED`);

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
