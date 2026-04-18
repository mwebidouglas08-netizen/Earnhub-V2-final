'use strict';

// ── Lipana official SDK ──
const { Lipana } = require('@lipana/sdk');

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || process.env.LIPANA_API_KEY || '';
const APP_URL           = process.env.APP_URL || 'https://your-app.railway.app';

if (!LIPANA_SECRET_KEY) {
  console.warn('⚠️  LIPANA_SECRET_KEY not set — payments will fail.');
}

// Initialise client once
const lipanaClient = LIPANA_SECRET_KEY
  ? new Lipana({
      apiKey:      LIPANA_SECRET_KEY,
      environment: process.env.LIPANA_ENV || 'production' // use 'sandbox' for testing
    })
  : null;

// ── Format phone to +254XXXXXXXXX ──
function formatPhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0'))    p = '254' + p.slice(1);
  if (p.startsWith('+'))    p = p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return '+' + p;
}

// ── STK Push via official SDK ──
async function stkPush({ phone, amount, accountRef, description }) {
  if (!lipanaClient) {
    throw new Error('LIPANA_SECRET_KEY is not configured. Add it to Railway environment variables.');
  }

  const formattedPhone = formatPhone(phone);
  console.log(`📲 Initiating STK push → ${formattedPhone}  KES ${amount}`);

  try {
    // Official SDK method — from lipana.dev/docs and npm package
    const response = await lipanaClient.transactions.initiateStkPush({
      phone:  formattedPhone,
      amount: Math.ceil(amount)
    });

    console.log('✅ Lipana STK response:', JSON.stringify(response));
    return response;

  } catch (err) {
    const msg = err?.message || err?.response?.data?.message || 'STK push failed';
    console.error('❌ Lipana STK error:', msg);
    throw new Error(msg);
  }
}

module.exports = { stkPush, formatPhone };
