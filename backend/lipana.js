'use strict';

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const APP_URL           = (process.env.APP_URL || '').replace(/\/+$/, '');

console.log('=== Lipana Config ===');
console.log('SECRET KEY SET:', !!LIPANA_SECRET_KEY);
console.log('SECRET KEY PREFIX:', LIPANA_SECRET_KEY ? LIPANA_SECRET_KEY.substring(0, 20) + '...' : 'MISSING');
console.log('APP_URL:', APP_URL || 'NOT SET');
console.log('====================');

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!LIPANA_SECRET_KEY) {
    throw new Error('LIPANA_SECRET_KEY is not set in Railway environment variables.');
  }
  const { Lipana } = require('@lipana/sdk');
  _client = new Lipana({
    apiKey:      LIPANA_SECRET_KEY,
    environment: 'production'
  });

  // Register webhook URL with Lipana on startup
  if (APP_URL) {
    const webhookUrl = `${APP_URL}/api/auth/activate/callback`;
    _client.webhooks.updateSettings({ webhookUrl })
      .then(() => console.log('✅ Lipana webhook URL registered:', webhookUrl))
      .catch(e  => console.warn('⚠️  Webhook register failed (non-fatal):', e.message));
  } else {
    console.warn('⚠️  APP_URL not set — Lipana callback will not work. Set APP_URL in Railway variables.');
  }

  console.log('✅ Lipana client initialised');
  return _client;
}

function formatPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))    p = '254' + p.slice(1);
  if (p.startsWith('+'))    p = p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return '+' + p;
}

async function stkPush({ phone, amount }) {
  const formattedPhone = formatPhone(phone);
  console.log(`📲 Initiating STK push → ${formattedPhone}  KES ${Math.ceil(amount)}`);

  let client;
  try {
    client = getClient();
  } catch (e) {
    throw new Error('Payment system not configured: ' + e.message);
  }

  const result = await client.transactions.initiateStkPush({
    phone:  formattedPhone,
    amount: Math.ceil(amount)
  });

  console.log('✅ STK push success. Response:', JSON.stringify(result));

  if (!result || (!result.transactionId && !result.id)) {
    console.error('⚠️  Lipana returned unexpected response:', JSON.stringify(result));
    throw new Error('STK push sent but no transaction ID returned. Check Lipana dashboard.');
  }

  return result;
}

async function retrieveTransaction(transactionId) {
  if (!transactionId) return null;
  try {
    const client = getClient();
    const tx     = await client.transactions.retrieve(transactionId);
    console.log(`🔍 Transaction ${transactionId} status:`, JSON.stringify(tx));
    return tx;
  } catch (e) {
    console.log(`ℹ️  Retrieve ${transactionId}:`, e.message);
    return null;
  }
}

module.exports = { stkPush, retrieveTransaction, formatPhone };
