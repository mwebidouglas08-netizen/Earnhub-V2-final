'use strict';

const LIPANA_SECRET_KEY    = process.env.LIPANA_SECRET_KEY    || '';
const LIPANA_WEBHOOK_SECRET = process.env.LIPANA_WEBHOOK_SECRET || '';
const APP_URL               = (process.env.APP_URL || '').replace(/\/+$/, '');

console.log('=== Lipana Init ===');
console.log('SECRET KEY SET   :', !!LIPANA_SECRET_KEY);
console.log('WEBHOOK SECRET   :', !!LIPANA_WEBHOOK_SECRET);
console.log('APP_URL          :', APP_URL || 'NOT SET — callbacks will not work!');
console.log('==================');

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!LIPANA_SECRET_KEY)
    throw new Error('LIPANA_SECRET_KEY not set in Railway environment variables.');

  const { Lipana } = require('@lipana/sdk');
  _client = new Lipana({
    apiKey:      LIPANA_SECRET_KEY,
    environment: 'production'
  });

  // Register & enable webhook on startup so Lipana knows where to POST
  if (APP_URL) {
    const webhookUrl = `${APP_URL}/api/auth/activate/callback`;
    _client.webhooks.updateSettings({
      webhookUrl: webhookUrl,
      enabled:    true         // CRITICAL — must be true or callbacks are never sent
    })
    .then(r  => console.log('✅ Lipana webhook registered & enabled:', webhookUrl, r))
    .catch(e => console.error('❌ Lipana webhook registration failed:', e.message));
  } else {
    console.error('❌ APP_URL not set — Lipana cannot send callbacks. Set APP_URL in Railway!');
  }

  console.log('✅ Lipana client ready');
  return _client;
}

// Format phone → +254XXXXXXXXX
function formatPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))    p = '254' + p.slice(1);
  if (p.startsWith('+'))    p = p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return '+' + p;
}

// Initiate STK push
async function stkPush({ phone, amount }) {
  const client = getClient();
  const fmt    = formatPhone(phone);
  console.log(`📲 STK push → ${fmt}  KES ${Math.ceil(amount)}`);

  const resp = await client.transactions.initiateStkPush({
    phone:  fmt,
    amount: Math.ceil(amount)
  });

  console.log('✅ Lipana STK response:', JSON.stringify(resp));

  if (!resp || !resp.transactionId) {
    throw new Error(
      'STK push sent but no transactionId returned. Response: ' +
      JSON.stringify(resp)
    );
  }

  return resp;
}

// Retrieve transaction status directly from Lipana
async function retrieveTransaction(transactionId) {
  if (!transactionId) return null;
  try {
    const client = getClient();
    const tx     = await client.transactions.retrieve(transactionId);
    console.log(`🔍 Retrieve [${transactionId}]:`, JSON.stringify(tx));
    return tx;
  } catch (e) {
    console.log(`ℹ️  Retrieve [${transactionId}] error:`, e.message);
    return null;
  }
}

// Verify Lipana webhook signature
function verifyWebhookSignature(body, signature) {
  if (!LIPANA_WEBHOOK_SECRET) {
    console.warn('⚠️  LIPANA_WEBHOOK_SECRET not set — skipping signature verification');
    return true; // allow if no secret configured
  }
  if (!signature) {
    console.warn('⚠️  No x-lipana-signature header — skipping signature verification');
    return true; // allow if no header sent
  }
  try {
    const client = getClient();
    const valid  = client.webhooks.verify(body, signature, LIPANA_WEBHOOK_SECRET);
    console.log(`🔐 Webhook signature valid: ${valid}`);
    return valid;
  } catch (e) {
    console.error('❌ Webhook signature verification error:', e.message);
    return true; // allow on error to avoid blocking legitimate callbacks
  }
}

module.exports = { stkPush, retrieveTransaction, verifyWebhookSignature, formatPhone };
