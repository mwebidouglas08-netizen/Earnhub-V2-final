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

/* ── STK PUSH ── */
router.post('/activate/stk', async (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const { phone } = req.body;
  if (!phone) return res.json({ success: false, message: 'Phone number required.' });

  const user = db.getUserById(req.session.userId);
  if (!user)             return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated) return res.json({ success: true, alreadyActivated: true });

  const fee = parseFloat(db.getSetting('activation_fee') || 300);

  try {
    const result = await lipana.stkPush({ phone, amount: fee });
    const txId   = result.transactionId;

    // Cancel any old pending payments for this user
    db.getAllPayments().forEach(p => {
      if (p.user_id === user.id && p.status === 'pending' && p.type === 'activation') {
        db.updatePaymentStatus(p.id, 'cancelled');
      }
    });

    // Save pending payment
    db.addPayment({ user_id: user.id, amount: fee, phone, type: 'activation', status: 'pending', ref: txId });

    // Store in session
    req.session.pendingTxId  = txId;
    req.session.pendingUserId = user.id;
    req.session.stkSentAt    = Date.now();

    console.log(`✅ STK saved → txId:${txId} userId:${user.id}`);
    return res.json({ success: true, transactionId: txId, message: 'STK push sent! Enter your M-Pesa PIN.' });

  } catch (e) {
    console.error('❌ STK error:', e.message);
    return res.json({ success: false, message: e.message || 'STK push failed. Please try again.' });
  }
});

/* ── POLL STATUS ──
   Called every 3s by frontend.
   Checks in order:
   1. DB: user already activated (callback fired)
   2. DB: payment marked completed (callback fired)
   3. Lipana retrieve() — direct API status check
*/
router.get('/activate/status', async (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false });

  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user) return res.json({ success: false });

  // 1. Already activated
  if (user.is_activated)
    return res.json({ success: true, activated: true });

  const payments = db.getAllPayments();

  // 2. Callback already marked payment completed
  const completedPay = payments.find(
    p => p.user_id === userId && p.type === 'activation' && p.status === 'completed'
  );
  if (completedPay) {
    _activateUser(userId);
    return res.json({ success: true, activated: true });
  }

  // 3. Ask Lipana directly
  const txId = req.session.pendingTxId;
  if (txId) {
    const tx = await lipana.retrieveTransaction(txId);
    if (tx) {
      const st      = (tx.status || '').toLowerCase();
      const success = st === 'success' || st === 'completed' || st === 'paid' || tx.paid === true;
      const failed  = st === 'failed'  || st === 'cancelled' || st === 'expired';

      if (success) {
        const p = payments.find(q => q.ref === txId && q.status === 'pending');
        if (p) db.updatePaymentStatus(p.id, 'completed');
        _activateUser(userId);
        console.log(`✅ Poll activated user ${userId} via retrieve — status:${st}`);
        return res.json({ success: true, activated: true });
      }
      if (failed) {
        const p = payments.find(q => q.ref === txId && q.status === 'pending');
        if (p) db.updatePaymentStatus(p.id, 'failed');
        return res.json({ success: true, activated: false, failed: true, message: 'Payment failed or was cancelled.' });
      }
    }
  }

  return res.json({ success: true, activated: false });
});

/* ── LIPANA CALLBACK ──
   Lipana POSTs here when payment is confirmed.
   Set this URL manually in your Lipana Dashboard → Webhooks.
   No signature verification — keep it simple and reliable.
*/
router.post('/activate/callback', (req, res) => {
  console.log('═══ LIPANA CALLBACK ═══');
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('═══════════════════════');

  try {
    const body = req.body;

    // Extract transaction ID — every possible field name
    const txId = body?.transactionId
              || body?.transaction_id
              || body?.id
              || body?.CheckoutRequestID
              || body?.checkout_request_id
              || '';

    // Determine outcome — check every possible success/fail indicator
    const rawStatus = (body?.status || '').toLowerCase();
    const isSuccess = rawStatus === 'success'
                   || rawStatus === 'completed'
                   || rawStatus === 'paid'
                   || body?.paid === true
                   || body?.ResultCode === 0
                   || body?.ResultCode === '0'
                   || body?.Body?.stkCallback?.ResultCode === 0
                   || String(body?.Body?.stkCallback?.ResultCode) === '0';

    const isFailed  = rawStatus === 'failed'
                   || rawStatus === 'cancelled'
                   || rawStatus === 'expired'
                   || (body?.ResultCode !== undefined
                       && body?.ResultCode !== 0
                       && body?.ResultCode !== '0'
                       && body?.Body === undefined);

    console.log(`txId:"${txId}" isSuccess:${isSuccess} isFailed:${isFailed} status:"${rawStatus}"`);

    const payments = db.getAllPayments();

    if (isSuccess) {
      // Find by txId first
      let payment = txId ? payments.find(p => p.ref === txId && p.status === 'pending') : null;

      // Fallback: most recent pending activation
      if (!payment) {
        payment = [...payments].reverse().find(p => p.status === 'pending' && p.type === 'activation');
        if (payment) console.log(`⚠️  Fallback match: payment #${payment.id} userId:${payment.user_id}`);
      }

      if (payment) {
        db.updatePaymentStatus(payment.id, 'completed');
        _activateUser(payment.user_id);
        console.log(`✅ CALLBACK: User ${payment.user_id} ACTIVATED`);
      } else {
        console.warn('⚠️  No pending payment found for callback');
      }

    } else if (isFailed) {
      if (txId) {
        const p = payments.find(q => q.ref === txId && q.status === 'pending');
        if (p) { db.updatePaymentStatus(p.id, 'failed'); console.log(`❌ Payment #${p.id} failed`); }
      }
    } else {
      console.log('ℹ️  Callback status unclear — body logged above');
    }

  } catch (e) {
    console.error('❌ Callback error:', e.message);
  }

  // Always 200 — stops Lipana retrying
  return res.status(200).json({ success: true });
});

/* ── ACTIVATE USER + CREDIT REFERRER ── */
function _activateUser(userId) {
  try {
    const user = db.getUserById(userId);
    if (!user || user.is_activated) return;
    db.updateUser(userId, { is_activated: 1 });
    console.log(`✅ User ${userId} (${user.username}) ACTIVATED`);
    if (user.referred_by && !user._referrer_credited) {
      const ref   = db.getUserByReferralCode(user.referred_by);
      if (ref) {
        const bonus = parseFloat(db.getSetting('referral_bonus') || 100);
        db.updateUser(ref.id, {
          affiliate_earnings: (ref.affiliate_earnings || 0) + bonus,
          balance:            (ref.balance            || 0) + bonus,
          total_earnings:     (ref.total_earnings     || 0) + bonus
        });
        db.updateUser(userId, { _referrer_credited: true });
        console.log(`💰 Referrer "${ref.username}" +KES ${bonus}`);
      }
    }
  } catch (e) { console.error('_activateUser error:', e.message); }
}

/* ── ME ── */
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ success: false });
  const user = db.getUserById(req.session.userId);
  if (!user) return res.json({ success: false });
  const { password, ...safe } = user;
  return res.json({ success: true, user: safe, notifications: db.getNotificationsForUser(req.session.userId), settings: db.getAllSettings() });
});

router.post('/notification/read/:id', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ success: false });
  db.markNotificationRead(req.params.id);
  return res.json({ success: true });
});

module.exports = router;
