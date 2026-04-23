/* ── MANUAL ACCESS after 5 minutes ──
   Only activates if STK was actually sent (pending payment exists).
   This is the fallback for when Lipana callback is delayed.
*/
router.post('/activate/manual', (req, res) => {
  if (!req.session || !req.session.userId)
    return res.json({ success: false, message: 'Not logged in.' });

  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  if (!user)             return res.json({ success: false, message: 'User not found.' });
  if (user.is_activated) return res.json({ success: true, activated: true });

  // MUST have a pending or completed payment — STK was actually sent
  const payments = db.getAllPayments();
  const hasPaid  = payments.find(
    p => p.user_id === userId &&
         p.type   === 'activation' &&
         (p.status === 'pending' || p.status === 'completed')
  );

  if (!hasPaid) {
    return res.json({
      success: false,
      message: 'No payment record found. Please initiate the STK push payment first.'
    });
  }

  // Activate — payment was sent, user just wasn't redirected
  if (hasPaid.status !== 'completed') db.updatePaymentStatus(hasPaid.id, 'completed');
  _activateUser(userId);
  console.log(`✅ Manual access granted to user ${userId} after 5-min wait`);
  return res.json({ success: true, activated: true, message: 'Account activated!' });
});
