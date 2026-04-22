'use strict';

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const APP_URL           = (process.env.APP_URL || '').replace(/\/+$/, '');

console.log('=== Lipana Config ===');
console.log('SECRET KEY SET:', !!LIPANA_SECRET_KEY);
console.log('SECRET KEY PREFIX:', LIPANA_SECRET_KEY ? LIPANA_SECRET_KEY.substring(0, 20) + '...' : 'MISSING');
console.log('APP_URL:', APP_URL || 'NOT SET — callback will NOT work!');
console.log('CALLBACK URL:', APP_URL ? `${APP_URL}/api/auth/activate/callback` : 'CANNOT BE BUILT — APP_URL missing');
console.log('====================');

let _client = null;

async function _registerWebhookWithRetry(client, webhookUrl, attempts = 3, delayMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await client.webhooks.updateSettings({ webhookUrl });
      console.log(`✅ Lipana webhook registered (attempt ${i}):`, webhookUrl);
      return;
    } catch (e) {
      console.warn(`⚠️  Webhook register attempt ${i}/${attempts} failed:`, e.message);
      if (i < attempts) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  console.error('❌ All webhook registration attempts failed. Lipana callback may not arrive.');
}

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

  // Register webhook URL with Lipana on startup (with retry)
  if (APP_URL) {
    const webhookUrl = `${APP_URL}/api/auth/activate/callback`;
    console.log('📡 Registering Lipana webhook URL:', webhookUrl);
    _registerWebhookWithRetry(_client, webhookUrl);
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
