'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db     = require('../db');
const lipana = require('../lipana');

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
      username:     username.trim(),
      email:        email.trim().toLowerCase(),
      country:      country || 'Kenya',
      mobile,
      password:     hash,
      referral_code:refCode,
      referred_by:  referral || null
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

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── INITIATE STK PUSH ──
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
      amount:    fee,
      accountRef: `EARNHUB-${user.id}`,
      description:`EarnHub Activation - ${user.username}`
    });

    // Save pending payment with lipana transaction ref
    db.addPayment({
      user_id:  user.id,
      amount:   fee,
      phone,
      type:     'activation',
      status:   'pending',
      ref:      result.CheckoutRequestID || result.checkoutRequestId || result.ref || ''
    });

    return res.json({
      success:    true,
      message:    'STK push sent! Enter your M-Pesa PIN on your phone.',
      checkoutId: result.CheckoutRequestID || result.checkoutRequestId || result.ref || ''
    });
  } catch (e) {
    console.error('STK push error:', e.message);
    return res.json({ success: false, message: e.message || 'Failed to send STK push. Try again.' });
  }
});

// ── POLL PAYMENT STATUS (frontend polls this every 3s) ──
router.get('/activate/status', (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const user = db.getUserById(req.session.userId);
  if (!user) return res.json({ success: false });

  if (user.is_activated)
    return res.json({ success: true, activated: true });

  // Check if any completed payment exists for this user
  const payments  = db.getAllPayments();
  const completed = payments.find(
    p => p.user_id === user.id && p.status === 'completed' && p.type === 'activation'
  );
  if (completed) {
    db.updateUser(user.id, { is_activated: 1 });
    return res.json({ success: true, activated: true });
  }

  return res.json({ success: true, activated: false });
});

// ── LIPANA CALLBACK (Lipana posts here when payment completes) ──
router.post('/activate/callback', (req, res) => {
  console.log('Lipana callback received:', JSON.stringify(req.body));
  try {
    const body = req.body;

    // Lipana callback structure (adjust field names to match their actual API)
    const resultCode   = body.ResultCode
                      ?? body.result_code
                      ?? body.Body?.stkCallback?.ResultCode
                      ?? -1;

    const checkoutId   = body.CheckoutRequestID
                      ?? body.checkout_request_id
                      ?? body.Body?.stkCallback?.CheckoutRequestID
                      ?? '';

    const accountRef   = body.AccountReference
                      ?? body.account_reference
                      ?? body.Body?.stkCallback?.CallbackMetadata?.Item?.find?.(
                           i => i.Name === 'AccountReference'
                         )?.Value
                      ?? '';

    if (parseInt(resultCode) === 0) {
      // Payment successful — find payment by checkoutId or accountRef
      const payments = db.getAllPayments();
      let payment = payments.find(p => p.ref === checkoutId);

      // Fallback: match by account ref (EARNHUB-{userId})
      if (!payment && accountRef) {
        const userId = parseInt(accountRef.replace('EARNHUB-', ''));
        payment = payments.find(p => p.user_id === userId && p.status === 'pending');
      }

      if (payment) {
        db.updatePaymentStatus(payment.id, 'completed');
        db.updateUser(payment.user_id, { is_activated: 1 });
        console.log(`✅ User ${payment.user_id} activated via Lipana callback`);
      } else {
        console.log('⚠️ Payment record not found for checkoutId:', checkoutId);
      }
    } else {
      // Payment failed — mark as failed
      if (checkoutId) {
        const payments = db.getAllPayments();
        const payment  = payments.find(p => p.ref === checkoutId);
        if (payment) db.updatePaymentStatus(payment.id, 'failed');
      }
      console.log('❌ Payment failed, ResultCode:', resultCode);
    }
  } catch (e) {
    console.error('Callback processing error:', e.message);
  }

  // Always return 200 to Lipana so they stop retrying
  return res.status(200).json({ success: true });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ success: false });
  const user = db.getUserById(req.session.userId);
  if (!user) return res.json({ success: false });
  const { password, ...safeUser } = user;
  const notifications = db.getNotificationsForUser(req.session.userId);
  const settings      = db.getAllSettings();
  return res.json({ success: true, user: safeUser, notifications, settings });
});

router.post('/notification/read/:id', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ success: false });
  db.markNotificationRead(req.params.id);
  return res.json({ success: true });
});

module.exports = router;
