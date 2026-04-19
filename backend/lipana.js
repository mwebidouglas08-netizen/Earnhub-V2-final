'use strict';

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const APP_URL           = process.env.APP_URL || '';

if (!LIPANA_SECRET_KEY) {
  console.warn('⚠️  LIPANA_SECRET_KEY not set — payments will not work.');
}

// Lazy-load the SDK so a missing key never crashes the server on startup
let _client = null;
function getClient() {
  if (_client) return _client;
  if (!LIPANA_SECRET_KEY) {
    throw new Error('LIPANA_SECRET_KEY is not set in Railway environment variables.');
  }
  try {
    const { Lipana } = require('@lipana/sdk');
    _client = new Lipana({
      apiKey:      LIPANA_SECRET_KEY,
      environment: 'production'
    });
    console.log('✅ Lipana client initialised');
    return _client;
  } catch (e) {
    throw new Error('Failed to load @lipana/sdk: ' + e.message);
  }
}

// Format phone → +254XXXXXXXXX
function formatPhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0'))    p = '254' + p.slice(1);
  if (p.startsWith('+'))    p = p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return '+' + p;
}

async function stkPush({ phone, amount, accountRef, description }) {
  const client         = getClient();
  const formattedPhone = formatPhone(phone);

  console.log(`📲 STK push → ${formattedPhone}  KES ${Math.ceil(amount)}`);

  const response = await client.transactions.initiateStkPush({
    phone:  formattedPhone,
    amount: Math.ceil(amount)
  });

  console.log('✅ Lipana response:', JSON.stringify(response));
  return response;
}

module.exports = { stkPush, formatPhone };
