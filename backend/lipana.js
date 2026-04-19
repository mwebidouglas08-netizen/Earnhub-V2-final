'use strict';
const https = require('https');
const http  = require('http');

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const APP_URL           = process.env.APP_URL || '';

if (!LIPANA_SECRET_KEY) {
  console.warn('⚠️  LIPANA_SECRET_KEY not set in environment variables.');
}

// ── Format phone to 254XXXXXXXXX (no + prefix) ──
function formatPhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0'))    p = '254' + p.slice(1);
  if (p.startsWith('+'))    p = p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return p;
}

// ── Generic HTTPS POST helper (no axios, no fetch, pure Node) ──
function post(urlStr, payload, headers) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(payload);
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const lib    = isHttps ? https : http;

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
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: { raw: data } });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timed out after 30s'));
    });
    req.write(body);
    req.end();
  });
}

// ── STK Push ──
async function stkPush({ phone, amount, accountRef, description }) {
  if (!LIPANA_SECRET_KEY) {
    throw new Error('LIPANA_SECRET_KEY is not set. Add it in Railway → Variables.');
  }

  const formattedPhone = formatPhone(phone);
  const callbackUrl    = APP_URL
    ? `${APP_URL}/api/auth/activate/callback`
    : null;

  console.log(`📲 STK push → ${formattedPhone}  KES ${amount}`);
  if (callbackUrl) console.log(`📡 Callback URL: ${callbackUrl}`);

  const payload = {
    phone:              formattedPhone,
    amount:             Math.ceil(amount),
    account_reference:  accountRef  || 'EarnHub',
    transaction_desc:   description || 'EarnHub Activation'
  };

  if (callbackUrl) payload.callback_url = callbackUrl;

  // Lipana's correct STK push endpoint (from lipana.dev)
  const endpoint = 'https://api.lipana.dev/v1/transactions/stk-push';

  const response = await post(endpoint, payload, {
    'Authorization': `Bearer ${LIPANA_SECRET_KEY}`
  });

  console.log(`Lipana response [${response.status}]:`, JSON.stringify(response.body));

  if (response.status === 404) {
    throw new Error(
      'Lipana endpoint not found (404). ' +
      'Log into your Lipana dashboard and check the correct API base URL, ' +
      'then set LIPANA_BASE_URL in Railway variables.'
    );
  }

  if (response.status !== 200 && response.status !== 201) {
    const msg = response.body?.message
             || response.body?.error
             || `HTTP ${response.status}`;
    throw new Error(`Lipana API error: ${msg}`);
  }

  if (response.body?.success === false) {
    throw new Error(response.body?.message || 'STK push rejected by Lipana.');
  }

  return response.body;
}

module.exports = { stkPush, formatPhone };
