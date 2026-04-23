'use strict';
const https = require('https');
const http  = require('http');

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const APP_URL           = (process.env.APP_URL || '').replace(/\/+$/, '');

console.log('=== Lipana Config ===');
console.log('SECRET KEY SET:', !!LIPANA_SECRET_KEY, LIPANA_SECRET_KEY ? LIPANA_SECRET_KEY.slice(0,18)+'...' : 'MISSING');
console.log('APP_URL:', APP_URL || 'NOT SET');
console.log('====================');

function formatPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))    p = '254' + p.slice(1);
  if (p.startsWith('+'))    p = p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return '+' + p;
}

function httpPost(urlStr, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    let parsed;
    try { parsed = new URL(urlStr); } catch(e) { return reject(new Error('Invalid URL: ' + urlStr)); }
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'application/json',
        ...headers
      }
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

function httpGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch(e) { return reject(new Error('Invalid URL: ' + urlStr)); }
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'GET',
      headers:  { 'Accept': 'application/json', ...headers }
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

async function stkPush({ phone, amount }) {
  if (!LIPANA_SECRET_KEY) throw new Error('LIPANA_SECRET_KEY not set in Railway environment variables.');
  const fmt = formatPhone(phone);
  console.log(`📲 STK push → ${fmt}  KES ${Math.ceil(amount)}`);
  const callbackUrl = APP_URL ? `${APP_URL}/api/auth/activate/callback` : null;
  const payload = {
    phone:  fmt,
    amount: Math.ceil(amount),
    ...(callbackUrl && { callback_url: callbackUrl })
  };
  const authHeader = { 'Authorization': `Bearer ${LIPANA_SECRET_KEY}` };
  // Try multiple known Lipana endpoint patterns
  const endpoints = [
    'https://api.lipana.dev/v1/transactions/stk-push',
    'https://api.lipana.dev/v1/mpesa/stk',
    'https://lipana.dev/api/v1/stk-push',
    'https://api.lipana.dev/api/v1/transactions/stk-push'
  ];
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      console.log(`Trying endpoint: ${endpoint}`);
      const resp = await httpPost(endpoint, payload, authHeader);
      console.log(`Response [${resp.status}]:`, JSON.stringify(resp.body));
      if (resp.status === 404) { lastError = new Error(`404 at ${endpoint}`); continue; }
      if (resp.status === 200 || resp.status === 201) {
        const txId = resp.body?.transactionId || resp.body?.transaction_id || resp.body?.id || resp.body?.checkoutRequestId;
        if (!txId) throw new Error('No transactionId in response: ' + JSON.stringify(resp.body));
        return { ...resp.body, transactionId: txId };
      }
      const msg = resp.body?.message || resp.body?.error || `HTTP ${resp.status}`;
      throw new Error(`Lipana error: ${msg}`);
    } catch(e) {
      if (e.message.includes('404')) { lastError = e; continue; }
      throw e;
    }
  }
  throw lastError || new Error('All Lipana endpoints failed. Check your LIPANA_SECRET_KEY and APP_URL.');
}

async function retrieveTransaction(txId) {
  if (!txId || !LIPANA_SECRET_KEY) return null;
  try {
    const authHeader = { 'Authorization': `Bearer ${LIPANA_SECRET_KEY}` };
    const endpoints = [
      `https://api.lipana.dev/v1/transactions/${txId}`,
      `https://lipana.dev/api/v1/transactions/${txId}`
    ];
    for (const endpoint of endpoints) {
      try {
        const resp = await httpGet(endpoint, authHeader);
        if (resp.status === 200) {
          console.log(`🔍 Transaction ${txId}:`, JSON.stringify(resp.body));
          return resp.body;
        }
      } catch { continue; }
    }
  } catch(e) {
    console.log(`Retrieve ${txId}:`, e.message);
  }
  return null;
}

module.exports = { stkPush, retrieveTransaction, formatPhone };
