'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

function getLipana() { return require('../lipana'); }

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
      username: username.trim(), email: email.trim().toLowerCase(),
      country: country || 'Kenya', mobile, password: hash,
      referral_code: refCode, referred_by: referral || null
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
  if (!req.session?.userId)
    return res.json({ success: false, message: 'Not logged in.' });
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
    // Cancel old pending
    db.getAllPayments().forEach(p => {
      if (p.user_id === user.id && p.status === 'pending' && p.type === 'activation')
        db.updatePaymentStatus(p.id, 'cancelled');
    });
    db.addPayment({
      user_id: user.id, amount: fee, phone,
      type: 'activation', status: 'pending', ref: txId
    });
    req.session.pendingTxId  = txId;
    req.session.stkSentAt    = Date.now();
    console.log(`✅ STK sent → txId:${txId} userId:${user.id}`);
    return res.json({ success: true, transactionId: txId, message: 'STK push sent! Enter your M-Pesa PIN.' });
  } catch (e) {
    console.error('❌ STK error:', e.message);
    return res.json({ success: false, message: e.message || 'STK push failed. Try again.' });
  }
});

/* ── POLL STATUS ──
   Checks in strict order:
   1. DB: user already activated (callback already fired)
   2. DB: payment already completed (callback already fired)
   3. Lipana retrieve() — direct live status check
*/
router.get('/activate/status', async (req, res) => {
  if (!req.session?.userId) return res.json({ success: false });
  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user) return res.json({ success: false });

  // 1. Already activated — fastest path
  if (user.is_activated) return res.json({ success: true, activated: true });

  const payments = db.getAllPayments();

  // 2. Callback marked payment completed
  const completed = payments.find(
    p => p.user_id === userId && p.type === 'activation' && p.status === 'completed'
  );
  if (completed) {
    _activateUser(userId);
    return res.json({ success: true, activated: true });
  }

  // 3. Ask Lipana directly via SDK retrieve()
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
          console.log(`✅ Poll: user ${userId} activated via retrieve — status:${st}`);
          return res.json({ success: true, activated: true });
        }
        if (failed) {
          const p = payments.find(q => q.ref === txId && q.status === 'pending');
          if (p) db.updatePaymentStatus(p.id, 'failed');
          return res.json({ success: true, activated: false, failed: true, message: 'Payment failed or was cancelled. Please try again.' });
        }
      }
    } catch (e) {
      console.log('Retrieve error (non-fatal):', e.message);
    }
  }

  return res.json({ success: true, activated: false });
});

/* ── LIPANA WEBHOOK CALLBACK ──
   Lipana POSTs here when payment is confirmed on their end.
   This is the primary activation trigger.
   Set this URL in Lipana dashboard → Webhooks:
   https://your-app.railway.app/api/auth/activate/callback
*/
router.post('/activate/callback', (req, res) => {
  console.log('═══════════════════════════════');
  console.log('📩 LIPANA CALLBACK RECEIVED');
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('═══════════════════════════════');

  try {
    const body = req.body;

    // Extract transaction ID — every possible field name Lipana may use
    const txId = body?.transactionId
              || body?.transaction_id
              || body?.TransactionId
              || body?.id
              || body?.CheckoutRequestID
              || body?.checkout_request_id
              || body?.Body?.stkCallback?.CheckoutRequestID
              || '';

    // Detect success — every format Lipana may send
    const rawStatus = (body?.status || '').toLowerCase();
    const isSuccess  = rawStatus === 'success'
                    || rawStatus === 'completed'
                    || rawStatus === 'paid'
                    || body?.paid === true
                    || body?.ResultCode === 0
                    || body?.ResultCode === '0'
                    || String(body?.ResultCode) === '0'
                    || body?.Body?.stkCallback?.ResultCode === 0
                    || String(body?.Body?.stkCallback?.ResultCode) === '0';

    const isFailed   = rawStatus === 'failed'
                    || rawStatus === 'cancelled'
                    || rawStatus === 'expired'
                    || (
                         body?.ResultCode !== undefined &&
                         body?.ResultCode !== 0 &&
                         body?.ResultCode !== '0' &&
                         !body?.Body
                       );

    console.log(`→ txId:"${txId}" isSuccess:${isSuccess} isFailed:${isFailed} rawStatus:"${rawStatus}"`);

    const allPayments = db.getAllPayments();

    if (isSuccess) {
      // Try to match by txId
      let payment = txId
        ? allPayments.find(p => p.ref === txId && p.status === 'pending')
        : null;

      // Fallback: most recent pending activation
      if (!payment) {
        payment = [...allPayments]
          .reverse()
          .find(p => p.status === 'pending' && p.type === 'activation');
        if (payment) console.log(`⚠️  Fallback match: payment #${payment.id} user:${payment.user_id}`);
      }

      if (payment) {
        db.updatePaymentStatus(payment.id, 'completed');
        _activateUser(payment.user_id);
        console.log(`✅ CALLBACK SUCCESS: User ${payment.user_id} ACTIVATED`);
      } else {
        console.warn('⚠️  No pending payment found to match callback');
      }

    } else if (isFailed) {
      if (txId) {
        const p = allPayments.find(q => q.ref === txId && q.status === 'pending');
        if (p) {
          db.updatePaymentStatus(p.id, 'failed');
          console.log(`❌ Payment #${p.id} marked failed`);
        }
      }
    } else {
      console.log('ℹ️  Callback status unclear — logged above for debugging');
    }

  } catch (e) {
    console.error('❌ Callback processing error:', e.message);
  }

  // ALWAYS return 200 — stops Lipana retrying
  return res.status(200).json({ success: true });
});

/* ── MANUAL ACCESS ── shown after 3-minute delay in UI */
router.post('/activate/manual', (req, res) => {
  if (!req.session?.userId)
    return res.json({ success: false, message: 'Not logged in.' });
  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user)             return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated) return res.json({ success: true, activated: true });
  // Only allow if STK was actually sent
  const hasPaid = db.getAllPayments().find(
    p => p.user_id === userId && p.type === 'activation' &&
        (p.status === 'pending' || p.status === 'completed')
  );
  if (!hasPaid)
    return res.json({ success: false, message: 'No payment found. Please initiate payment first.' });
  if (hasPaid.status !== 'completed') db.updatePaymentStatus(hasPaid.id, 'completed');
  _activateUser(userId);
  console.log(`✅ Manual access granted: user ${userId}`);
  return res.json({ success: true, activated: true, message: 'Account activated!' });
});

/* ── ACTIVATE USER + CREDIT REFERRER ── */
function _activateUser(userId) {
  try {
    const user = db.getUserById(userId);
    if (!user || user.is_activated) return;
    db.updateUser(userId, { is_activated: 1 });
    console.log(`✅ User ${userId} (${user.username}) ACTIVATED`);
    // Credit referrer KES 100
    if (user.referred_by && !user._referrer_credited) {
      const ref = db.getUserByReferralCode(user.referred_by);
      if (ref) {
        const bonus = parseFloat(db.getSetting('referral_bonus') || 100);
        const fresh = db.getUserById(ref.id);
        db.updateUser(ref.id, {
          affiliate_earnings: (fresh.affiliate_earnings || 0) + bonus,
          balance:            (fresh.balance            || 0) + bonus,
          total_earnings:     (fresh.total_earnings     || 0) + bonus
        });
        db.updateUser(userId, { _referrer_credited: true });
        db.addNotification({
          user_id: ref.id,
          title:   '💰 Referral Commission Earned!',
          message: `${user.username} activated using your referral link. KES ${bonus} added to your balance!`,
          type:    'success',
          is_global: false
        });
        console.log(`💰 Referrer "${ref.username}" credited KES ${bonus}`);
      }
    }
  } catch (e) {
    console.error('_activateUser error:', e.message);
  }
}

/* ── ME ── */
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

/* ── MARK NOTIFICATION READ ── */
router.post('/notification/read/:id', (req, res) => {
  if (!req.session?.userId) return res.json({ success: false });
  db.markNotificationRead(req.params.id);
  return res.json({ success: true });
});

module.exports = router;
