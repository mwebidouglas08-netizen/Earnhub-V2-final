'use strict';
const https = require('https');
const http  = require('http');
const url   = require('url');

const LIPANA_API_KEY  = process.env.LIPANA_API_KEY  || '';
const LIPANA_SHORTCODE= process.env.LIPANA_SHORTCODE || '';
const LIPANA_BASE_URL = process.env.LIPANA_BASE_URL  || 'https://api.lipanatechnologies.com/v1';
const APP_URL         = process.env.APP_URL          || 'https://your-app.railway.app';

// ── Generic HTTP request helper ──
function request(options, body) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(options.url);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.path,
      method:   options.method || 'GET',
      headers:  options.headers || {}
    };

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      reqOptions.headers['Content-Type']   = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Format phone to 254XXXXXXXXX ──
function formatPhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0'))   p = '254' + p.slice(1);
  if (p.startsWith('+'))   p = p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return p;
}

// ── STK Push ──
async function stkPush({ phone, amount, accountRef, description }) {
  if (!LIPANA_API_KEY) throw new Error('LIPANA_API_KEY not set in environment variables.');
  if (!LIPANA_SHORTCODE) throw new Error('LIPANA_SHORTCODE not set in environment variables.');

  const formattedPhone = formatPhone(phone);
  const callbackUrl    = `${APP_URL}/api/auth/activate/callback`;

  console.log(`Initiating STK push → phone: ${formattedPhone}, amount: ${amount}`);
  console.log(`Callback URL: ${callbackUrl}`);

  const payload = {
    // Standard Lipana fields — adjust if their docs use different names
    api_key:           LIPANA_API_KEY,
    shortcode:         LIPANA_SHORTCODE,
    phone:             formattedPhone,
    amount:            Math.ceil(amount),
    account_reference: accountRef,
    transaction_desc:  description,
    callback_url:      callbackUrl
  };

  const response = await request({
    url:    `${LIPANA_BASE_URL}/mpesa/stkpush`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LIPANA_API_KEY}`,
      'Accept':        'application/json'
    }
  }, payload);

  console.log('Lipana STK response:', JSON.stringify(response.body));

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(
      response.body?.message ||
      response.body?.error   ||
      `Lipana API error: HTTP ${response.status}`
    );
  }

  const respBody = response.body;

  // Check for error in response body
  if (respBody.success === false || respBody.ResponseCode === '1') {
    throw new Error(respBody.message || respBody.errorMessage || 'STK push failed.');
  }

  return respBody;
}

module.exports = { stkPush, formatPhone };
