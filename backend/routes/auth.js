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
    if (referral) {
      const referrer = db.getUserByReferralCode(referral);
      if (referrer) {
        const bonus = parseFloat(db.getSetting('referral_bonus') || 50);
        db.updateUser(referrer.id, {
          affiliate_earnings: referrer.affiliate_earnings + bonus,
          balance:            referrer.balance + bonus
        });
      }
    }
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
    return res.json({ success: false, message: 'Account already activated.' });

  const fee = parseFloat(db.getSetting('activation_fee') || 300);

  try {
    const result = await lipana.stkPush({
      phone,
      amount:      fee,
      accountRef:  `EARNHUB-${user.id}`,
      description: `EarnHub Activation - ${user.username}`
    });

    // Extract transaction/checkout ID from response
    const ref = result?.transactionId
             || result?.CheckoutRequestID
             || result?.checkoutRequestId
             || result?.id
             || '';

    db.addPayment({
      user_id: user.id,
      amount:  fee,
      phone,
      type:    'activation',
      status:  'pending',
      ref
    });

    return res.json({
      success:    true,
      message:    'STK push sent! Enter your M-Pesa PIN on your phone.',
      checkoutId: ref
    });

  } catch (e) {
    console.error('STK push error:', e.message);
    return res.json({
      success: false,
      message: e.message || 'Failed to send STK push. Try again.'
    });
  }
});

/* ── POLL PAYMENT STATUS ── */
router.get('/activate/status', (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const user = db.getUserById(req.session.userId);
  if (!user) return res.json({ success: false });

  // Already activated
  if (user.is_activated)
    return res.json({ success: true, activated: true });

  // Check payments for completed
  const payments  = db.getAllPayments();
  const completed = payments.find(
    p => p.user_id === user.id &&
         p.type   === 'activation' &&
         p.status === 'completed'
  );
  if (completed) {
    db.updateUser(user.id, { is_activated: 1 });
    return res.json({ success: true, activated: true });
  }

  return res.json({ success: true, activated: false });
});

/* ── LIPANA WEBHOOK CALLBACK ── */
router.post('/activate/callback', (req, res) => {
  console.log('📩 Lipana callback:', JSON.stringify(req.body));

  try {
    const body = req.body;

    // Lipana SDK webhook payload
    const resultCode = body?.ResultCode
                    ?? body?.result_code
                    ?? body?.Body?.stkCallback?.ResultCode
                    ?? body?.status   // some providers use "status"
                    ?? -1;

    const isSuccess = resultCode === 0
                   || resultCode === '0'
                   || body?.status === 'success'
                   || body?.status === 'completed';

    const txRef = body?.transactionId
               || body?.CheckoutRequestID
               || body?.checkoutRequestId
               || body?.checkout_request_id
               || body?.id
               || '';

    const accountRef = body?.AccountReference
                    || body?.account_reference
                    || body?.accountReference
                    || '';

    if (isSuccess) {
      const payments = db.getAllPayments();

      // Try match by transaction ref first
      let payment = txRef
        ? payments.find(p => p.ref === txRef)
        : null;

      // Fallback: match by account reference EARNHUB-{userId}
      if (!payment && accountRef && accountRef.startsWith('EARNHUB-')) {
        const userId = parseInt(accountRef.replace('EARNHUB-', ''));
        payment = payments.find(
          p => p.user_id === userId && p.status === 'pending' && p.type === 'activation'
        );
      }

      if (payment) {
        db.updatePaymentStatus(payment.id, 'completed');
        db.updateUser(payment.user_id, { is_activated: 1 });
        console.log(`✅ User ${payment.user_id} activated via callback`);
      } else {
        console.warn('⚠️  No matching pending payment found for callback');
      }

    } else {
      console.log('❌ Payment failed/cancelled, code:', resultCode);
      if (txRef) {
        const payments = db.getAllPayments();
        const payment  = payments.find(p => p.ref === txRef);
        if (payment) db.updatePaymentStatus(payment.id, 'failed');
      }
    }
  } catch (e) {
    console.error('Callback error:', e.message);
  }

  // Always 200 so Lipana stops retrying
  return res.status(200).json({ success: true });
});

/* ── ME ── */
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ success: false });
  const user = db.getUserById(req.session.userId);
  if (!user) return res.json({ success: false });
  const { password, ...safeUser } = user;
  const notifications = db.getNotificationsForUser(req.session.userId);
  const settings      = db.getAllSettings();
  return res.json({ success: true, user: safeUser, notifications, settings });
});

/* ── MARK NOTIFICATION READ ── */
router.post('/notification/read/:id', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ success: false });
  db.markNotificationRead(req.params.id);
  return res.json({ success: true });
});

module.exports = router;
