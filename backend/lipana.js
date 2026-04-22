'use strict';

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const APP_URL           = (process.env.APP_URL || '').replace(/\/$/, '');

if (!LIPANA_SECRET_KEY) {
  console.warn('⚠️  LIPANA_SECRET_KEY not set.');
}

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!LIPANA_SECRET_KEY)
    throw new Error('LIPANA_SECRET_KEY not set in Railway environment variables.');
  const { Lipana } = require('@lipana/sdk');
  _client = new Lipana({ apiKey: LIPANA_SECRET_KEY, environment: 'production' });
  // Register webhook URL so Lipana knows where to POST payment results
  if (APP_URL) {
    const webhookUrl = `${APP_URL}/api/auth/activate/callback`;
    _client.webhooks.updateSettings({ webhookUrl })
      .then(() => console.log(`✅ Lipana webhook registered: ${webhookUrl}`))
      .catch(e => console.warn('Webhook register warning:', e.message));
  }
  console.log('✅ Lipana client ready');
  return _client;
}

function formatPhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0'))    p = '254' + p.slice(1);
  if (p.startsWith('+'))    p = p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return '+' + p;
}

async function stkPush({ phone, amount }) {
  const client         = getClient();
  const formattedPhone = formatPhone(phone);
  console.log(`📲 STK push → ${formattedPhone}  KES ${Math.ceil(amount)}`);
  const response = await client.transactions.initiateStkPush({
    phone:  formattedPhone,
    amount: Math.ceil(amount)
  });
  console.log('✅ Lipana STK response:', JSON.stringify(response));
  // response.transactionId is the key field per SDK docs
  return response;
}

// Retrieve a transaction by its transactionId to check status
async function retrieveTransaction(transactionId) {
  if (!transactionId) return null;
  try {
    const client = getClient();
    const tx     = await client.transactions.retrieve(transactionId);
    console.log(`🔍 Lipana retrieve [${transactionId}]:`, JSON.stringify(tx));
    return tx;
  } catch (e) {
    console.log(`Retrieve error for ${transactionId}:`, e.message);
    return null;
  }
}

module.exports = { stkPush, retrieveTransaction, formatPhone };
