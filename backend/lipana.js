'use strict';

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';

if (!LIPANA_SECRET_KEY) {
  console.error('❌ LIPANA_SECRET_KEY not set in environment variables!');
} else {
  console.log('✅ Lipana secret key loaded:', LIPANA_SECRET_KEY.substring(0, 20) + '...');
}

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!LIPANA_SECRET_KEY)
    throw new Error('LIPANA_SECRET_KEY is missing. Add it to Railway environment variables.');
  const { Lipana } = require('@lipana/sdk');
  _client = new Lipana({ apiKey: LIPANA_SECRET_KEY, environment: 'production' });
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
  const client = getClient();
  const fmt    = formatPhone(phone);
  console.log(`📲 STK push → ${fmt}  KES ${Math.ceil(amount)}`);
  const resp = await client.transactions.initiateStkPush({
    phone:  fmt,
    amount: Math.ceil(amount)
  });
  console.log('✅ STK response:', JSON.stringify(resp));
  if (!resp || !resp.transactionId)
    throw new Error('No transactionId in Lipana response: ' + JSON.stringify(resp));
  return resp;
}

async function retrieveTransaction(txId) {
  if (!txId) return null;
  try {
    const client = getClient();
    const tx     = await client.transactions.retrieve(txId);
    const st     = (tx?.status || '').toLowerCase();
    const paid   = tx?.paid === true;
    console.log(`🔍 Retrieve [${txId}]: status="${st}" paid=${paid} full=${JSON.stringify(tx)}`);
    return tx;
  } catch (e) {
    console.log(`ℹ️  Retrieve [${txId}] error:`, e.message);
    return null;
  }
}

module.exports = { stkPush, retrieveTransaction, formatPhone };
