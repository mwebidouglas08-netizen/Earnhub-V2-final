'use strict';
const fs   = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// ── Persistent storage path ──
// Railway: set RAILWAY_VOLUME_MOUNT_PATH env var and attach a volume
// Local:   falls back to ./data directory
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
              || process.env.DATA_DIR
              || path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('✅ Created data directory:', DATA_DIR);
}

const DB_FILE = path.join(DATA_DIR, 'db.json');
console.log('✅ DB file path:', DB_FILE);

const DEFAULT_DB = {
  settings: {
    activation_fee:   '300',
    site_name:        'EarnHub',
    referral_bonus:   '100',
    min_withdrawal:   '500',
    spin_cost:        '20',
    welcome_bonus:    '0',
    maintenance_mode: 'false'
  },
  users:         [],
  admins:        [],
  notifications: [],
  withdrawals:   [],
  payments:      [],
  _nextId: { users:1, admins:1, notifications:1, withdrawals:1, payments:1 }
};

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw    = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge missing keys without destroying existing data
      if (!parsed._nextId) parsed._nextId = { ...DEFAULT_DB._nextId };
      if (!parsed.settings) parsed.settings = { ...DEFAULT_DB.settings };
      // Add new settings keys if missing
      for (const [k, v] of Object.entries(DEFAULT_DB.settings)) {
        if (parsed.settings[k] === undefined) parsed.settings[k] = v;
      }
      if (!parsed.payments)      parsed.payments      = [];
      if (!parsed.withdrawals)   parsed.withdrawals   = [];
      if (!parsed.notifications) parsed.notifications = [];
      console.log(`✅ DB loaded: ${parsed.users.length} users, ${parsed.payments.length} payments`);
      return parsed;
    }
  } catch (e) {
    console.error('DB load error:', e.message, '— starting fresh');
  }
  console.log('✅ DB: starting with fresh database');
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function saveDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('❌ DB save error:', e.message);
  }
}

let _db = loadDb();

// ── Force admin account every startup (does NOT overwrite user data) ──
const ADMIN_USER = process.env.ADMIN_USERNAME || 'earnhub_admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'EarnHub@2024!';
_db.admins = [{
  id:         1,
  username:   ADMIN_USER,
  password:   bcrypt.hashSync(ADMIN_PASS, 10),
  created_at: new Date().toISOString()
}];
_db._nextId.admins = 2;
saveDb(_db);
console.log(`✅ Admin ready → "${ADMIN_USER}"`);

// ── DB API ──
const db = {

  /* SETTINGS */
  getSetting(key)     { return _db.settings[key] !== undefined ? _db.settings[key] : null; },
  setSetting(key, val){ _db.settings[key] = String(val); saveDb(_db); },
  getAllSettings()     { return { ..._db.settings }; },
  setAllSettings(obj) {
    for (const [k, v] of Object.entries(obj)) _db.settings[k] = String(v);
    saveDb(_db);
  },

  /* USERS */
  getUserById(id) {
    return _db.users.find(u => u.id === parseInt(id)) || null;
  },
  getUserByUsernameOrEmail(val) {
    const v = val.toLowerCase().trim();
    return _db.users.find(u =>
      u.username.toLowerCase() === v || u.email.toLowerCase() === v
    ) || null;
  },
  getUserByReferralCode(code) {
    return _db.users.find(u => u.referral_code === code) || null;
  },
  createUser(data) {
    const exists = _db.users.find(u =>
      u.username.toLowerCase() === data.username.toLowerCase() ||
      u.email.toLowerCase()    === data.email.toLowerCase()
    );
    if (exists) throw new Error('UNIQUE constraint failed');
    const user = {
      id:                  _db._nextId.users++,
      username:            data.username,
      email:               data.email,
      country:             data.country    || 'Kenya',
      mobile:              data.mobile     || '',
      password:            data.password,
      referral_code:       data.referral_code,
      referred_by:         data.referred_by || null,
      is_activated:        0,
      is_banned:           0,
      balance:             0,
      total_earnings:      0,
      ads_earnings:        0,
      tiktok_earnings:     0,
      youtube_earnings:    0,
      trivia_earnings:     0,
      articles_earnings:   0,
      affiliate_earnings:  0,
      agent_bonus:         100,
      total_withdrawn:     0,
      spins_today:         0,
      last_spin_day:       '',
      _referrer_credited:  false,
      created_at:          new Date().toISOString()
    };
    _db.users.push(user);
    saveDb(_db);
    return user;
  },
  updateUser(id, fields) {
    const idx = _db.users.findIndex(u => u.id === parseInt(id));
    if (idx === -1) return false;
    Object.assign(_db.users[idx], fields);
    saveDb(_db);
    return true;
  },
  deleteUser(id) {
    _db.users = _db.users.filter(u => u.id !== parseInt(id));
    saveDb(_db);
  },
  getAllUsers(search = '') {
    const q = search.toLowerCase().trim();
    if (!q) return [..._db.users];
    return _db.users.filter(u =>
      u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    );
  },

  /* ADMINS */
  getAdminByUsername(username) {
    if (!username) return null;
    return _db.admins.find(a =>
      a.username.toLowerCase() === username.toLowerCase().trim()
    ) || null;
  },

  /* NOTIFICATIONS */
  getNotificationsForUser(userId) {
    return _db.notifications
      .filter(n => !n.is_read && (n.is_global || n.user_id === parseInt(userId)))
      .slice(-20)
      .reverse();
  },
  addNotification(data) {
    _db.notifications.push({
      id:         _db._nextId.notifications++,
      user_id:    data.user_id  || null,
      title:      data.title,
      message:    data.message,
      type:       data.type     || 'info',
      is_read:    0,
      is_global:  data.is_global ? 1 : 0,
      created_at: new Date().toISOString()
    });
    saveDb(_db);
  },
  markNotificationRead(id) {
    const n = _db.notifications.find(n => n.id === parseInt(id));
    if (n) { n.is_read = 1; saveDb(_db); }
  },

  /* WITHDRAWALS */
  addWithdrawal(data) {
    const w = {
      id:         _db._nextId.withdrawals++,
      user_id:    data.user_id,
      amount:     data.amount,
      mobile:     data.mobile,
      type:       data.type   || 'earnings',
      status:     'pending',
      created_at: new Date().toISOString()
    };
    _db.withdrawals.push(w);
    saveDb(_db);
    return w;
  },
  getWithdrawal(id) {
    return _db.withdrawals.find(w => w.id === parseInt(id)) || null;
  },
  getAllWithdrawals() {
    return [..._db.withdrawals].reverse().map(w => ({
      ...w,
      username:    (_db.users.find(u => u.id === w.user_id) || {}).username || '?',
      mobile_user: (_db.users.find(u => u.id === w.user_id) || {}).mobile   || w.mobile || '?'
    }));
  },
  updateWithdrawal(id, status) {
    const w = _db.withdrawals.find(w => w.id === parseInt(id));
    if (w) { w.status = status; saveDb(_db); }
    return w;
  },

  /* PAYMENTS */
  addPayment(data) {
    _db.payments.push({
      id:         _db._nextId.payments++,
      user_id:    data.user_id,
      amount:     data.amount,
      phone:      data.phone,
      type:       data.type   || 'activation',
      status:     data.status || 'pending',
      ref:        data.ref    || '',
      created_at: new Date().toISOString()
    });
    saveDb(_db);
  },
  getAllPayments() {
    return [..._db.payments].reverse().map(p => ({
      ...p,
      username: (_db.users.find(u => u.id === p.user_id) || {}).username || '?'
    }));
  },
  updatePaymentStatus(id, status) {
    const p = _db.payments.find(p => p.id === parseInt(id));
    if (p) { p.status = status; saveDb(_db); }
  },

  /* STATS */
  getStats() {
    const totalRevenue = _db.payments
      .filter(p => p.status === 'completed')
      .reduce((s, p) => s + p.amount, 0);
    const totalWdPaid  = _db.withdrawals
      .filter(w => w.status === 'approved')
      .reduce((s, w) => s + w.amount, 0);
    return {
      totalUsers:  _db.users.length,
      activeUsers: _db.users.filter(u => u.is_activated).length,
      bannedUsers: _db.users.filter(u => u.is_banned).length,
      pendingWd:   _db.withdrawals.filter(w => w.status === 'pending').length,
      totalWdPaid,
      totalRevenue
    };
  }
};

module.exports = db;
