'use strict';

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';

console.log('=== Lipana Init ===');
console.log('SECRET KEY SET:', !!LIPANA_SECRET_KEY, LIPANA_SECRET_KEY ? LIPANA_SECRET_KEY.slice(0,20)+'...' : 'MISSING!');
console.log('==================');

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!LIPANA_SECRET_KEY)
    throw new Error('LIPANA_SECRET_KEY not set in Railway environment variables.');
  // Lazy require so crash on import doesn't kill server startup
  const { Lipana } = require('@lipana/sdk');
  _client = new Lipana({
    apiKey:      LIPANA_SECRET_KEY,
    environment: 'production'
  });
  console.log('✅ Lipana SDK client ready');
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
  const client = getClient();
  const fmt    = formatPhone(phone);
  console.log(`📲 STK push → ${fmt}  KES ${Math.ceil(amount)}`);
  // Official SDK method — handles correct endpoint internally
  const resp = await client.transactions.initiateStkPush({
    phone:  fmt,
    amount: Math.ceil(amount)
  });
  console.log('✅ Lipana STK response:', JSON.stringify(resp));
  if (!resp || !resp.transactionId)
    throw new Error('STK push sent but no transactionId returned: ' + JSON.stringify(resp));
  return resp;
}

async function retrieveTransaction(txId) {
  if (!txId) return null;
  try {
    const client = getClient();
    const tx     = await client.transactions.retrieve(txId);
    console.log(`🔍 Transaction ${txId}:`, JSON.stringify(tx));
    return tx;
  } catch (e) {
    console.log(`Retrieve ${txId}: ${e.message}`);
    return null;
  }
}

module.exports = { stkPush, retrieveTransaction, formatPhone };
