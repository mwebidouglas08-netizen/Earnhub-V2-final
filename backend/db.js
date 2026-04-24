'use strict';
const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
              || process.env.DATA_DIR
              || path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE  = path.join(DATA_DIR, 'db.json');
const TMP_FILE = DB_FILE + '.tmp';

console.log(`📂 Data directory : ${DATA_DIR}`);
console.log(`📄 Database file  : ${DB_FILE}`);

const DEFAULT_DB = {
  settings: { activation_fee:'300', site_name:'EarnHub', referral_bonus:'100', min_withdrawal:'500', welcome_bonus:'0', maintenance_mode:'false' },
  users:[], admins:[], notifications:[], withdrawals:[], payments:[],
  _nextId: { users:1, admins:1, notifications:1, withdrawals:1, payments:1 }
};

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw    = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);

      // Ensure all required top-level arrays exist (migrate old data)
      if (!Array.isArray(parsed.users))         parsed.users         = [];
      if (!Array.isArray(parsed.admins))        parsed.admins        = [];
      if (!Array.isArray(parsed.notifications)) parsed.notifications = [];
      if (!Array.isArray(parsed.withdrawals))   parsed.withdrawals   = [];
      if (!Array.isArray(parsed.payments))      parsed.payments      = [];

      // Ensure _nextId block is complete
      if (!parsed._nextId) parsed._nextId = { ...DEFAULT_DB._nextId };
      for (const key of Object.keys(DEFAULT_DB._nextId)) {
        if (typeof parsed._nextId[key] !== 'number') {
          parsed._nextId[key] = DEFAULT_DB._nextId[key];
        }
      }

      // Ensure settings block is complete; merge defaults for any missing keys
      if (!parsed.settings) parsed.settings = { ...DEFAULT_DB.settings };
      for (const [k, v] of Object.entries(DEFAULT_DB.settings)) {
        if (parsed.settings[k] === undefined) parsed.settings[k] = v;
      }
      parsed.settings.referral_bonus = '100';

      console.log(`✅ Loaded db.json — ${parsed.users.length} user(s) found`);
      return parsed;
    }
  } catch (e) {
    console.error('❌ DB load error:', e.message);
  }
  console.log('📋 No existing db.json — starting with empty database');
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function saveDb(data) {
  try {
    // Atomic write: write to .tmp then rename to avoid corruption on crash
    fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP_FILE, DB_FILE);
  } catch (e) {
    console.error('❌ DB save error:', e.message);
    // Fallback: direct write if rename fails (e.g. cross-device)
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8'); }
    catch (e2) { console.error('❌ DB save fallback error:', e2.message); }
  }
}

let _db = loadDb();

// Force admin credentials every startup
const ADMIN_USER = process.env.ADMIN_USERNAME || 'earnhub_admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'EarnHub@2024!';
const freshHash  = bcrypt.hashSync(ADMIN_PASS, 10);
_db.admins = [{ id:1, username:ADMIN_USER, password:freshHash, created_at:new Date().toISOString() }];
_db._nextId.admins = 2;
saveDb(_db);
console.log(`✅ Admin → username:"${ADMIN_USER}" password:"${ADMIN_PASS}"`);
console.log(`✅ DB at: ${DB_FILE}`);

const db = {
  getSetting(key) { return _db.settings[key] !== undefined ? _db.settings[key] : null; },
  setSetting(key, value) { _db.settings[key] = String(value); saveDb(_db); },
  getAllSettings() { return { ..._db.settings }; },
  setAllSettings(obj) { for (const [k,v] of Object.entries(obj)) _db.settings[k] = String(v); saveDb(_db); },

  getUserById(id) { return _db.users.find(u => u.id === parseInt(id)) || null; },
  getUserByUsernameOrEmail(val) {
    const v = val.toLowerCase().trim();
    return _db.users.find(u => u.username.toLowerCase()===v || u.email.toLowerCase()===v) || null;
  },
  getUserByReferralCode(code) { return _db.users.find(u => u.referral_code===code) || null; },
  createUser(data) {
    const exists = _db.users.find(u => u.username.toLowerCase()===data.username.toLowerCase() || u.email.toLowerCase()===data.email.toLowerCase());
    if (exists) throw new Error('UNIQUE constraint failed');
    const user = {
      id:_db._nextId.users++, username:data.username, email:data.email,
      country:data.country||'Kenya', mobile:data.mobile||'', password:data.password,
      referral_code:data.referral_code, referred_by:data.referred_by||null,
      is_activated:0, is_banned:0, balance:0, total_earnings:0,
      ads_earnings:0, tiktok_earnings:0, youtube_earnings:0, trivia_earnings:0,
      articles_earnings:0, affiliate_earnings:0, agent_bonus:100, total_withdrawn:0,
      _referrer_credited:false, created_at:new Date().toISOString()
    };
    _db.users.push(user); saveDb(_db); return user;
  },
  updateUser(id, fields) {
    const idx = _db.users.findIndex(u => u.id===parseInt(id));
    if (idx===-1) return false;
    Object.assign(_db.users[idx], fields);
    saveDb(_db); return true;
  },
  deleteUser(id) { _db.users=_db.users.filter(u=>u.id!==parseInt(id)); saveDb(_db); },
  getAllUsers(search='') {
    const q=search.toLowerCase().trim();
    if(!q) return [..._db.users];
    return _db.users.filter(u=>u.username.toLowerCase().includes(q)||u.email.toLowerCase().includes(q));
  },

  getAdminByUsername(username) {
    if(!username) return null;
    return _db.admins.find(a=>a.username.toLowerCase()===username.toLowerCase().trim()) || null;
  },

  getNotificationsForUser(userId) {
    return _db.notifications
      .filter(n=>!n.is_read&&(n.is_global||n.user_id===parseInt(userId)))
      .slice(-15).reverse();
  },
  addNotification(data) {
    _db.notifications.push({
      id:_db._nextId.notifications++, user_id:data.user_id||null,
      title:data.title, message:data.message, type:data.type||'info',
      is_read:0, is_global:data.is_global?1:0, created_at:new Date().toISOString()
    });
    saveDb(_db);
  },
  markNotificationRead(id) {
    const n=_db.notifications.find(n=>n.id===parseInt(id));
    if(n){n.is_read=1;saveDb(_db);}
  },

  addWithdrawal(data) {
    const w={id:_db._nextId.withdrawals++,user_id:data.user_id,amount:data.amount,mobile:data.mobile,type:data.type||'earnings',status:'pending',created_at:new Date().toISOString()};
    _db.withdrawals.push(w);saveDb(_db);return w;
  },
  getWithdrawal(id) { return _db.withdrawals.find(w=>w.id===parseInt(id))||null; },
  getAllWithdrawals() {
    return [..._db.withdrawals].reverse().map(w=>({
      ...w,
      username:(_db.users.find(u=>u.id===w.user_id)||{}).username||'?',
      mobile_user:(_db.users.find(u=>u.id===w.user_id)||{}).mobile||w.mobile||'?'
    }));
  },
  updateWithdrawal(id,status) {
    const w=_db.withdrawals.find(w=>w.id===parseInt(id));
    if(w){w.status=status;saveDb(_db);}return w;
  },

  addPayment(data) {
    _db.payments.push({id:_db._nextId.payments++,user_id:data.user_id,amount:data.amount,phone:data.phone,type:data.type||'activation',status:data.status||'pending',ref:data.ref||'',created_at:new Date().toISOString()});
    saveDb(_db);
  },
  getAllPayments() {
    return [..._db.payments].reverse().map(p=>({...p,username:(_db.users.find(u=>u.id===p.user_id)||{}).username||'?'}));
  },
  updatePaymentStatus(id,status) {
    const p=_db.payments.find(p=>p.id===parseInt(id));
    if(p){p.status=status;saveDb(_db);}
  },

  getStats() {
    const totalRevenue=_db.payments.filter(p=>p.status==='completed').reduce((s,p)=>s+p.amount,0);
    const totalWdPaid=_db.withdrawals.filter(w=>w.status==='approved').reduce((s,w)=>s+w.amount,0);
    return {
      totalUsers:_db.users.length, activeUsers:_db.users.filter(u=>u.is_activated).length,
      bannedUsers:_db.users.filter(u=>u.is_banned).length,
      pendingWd:_db.withdrawals.filter(w=>w.status==='pending').length,
      totalWdPaid, totalRevenue
    };
  }
};

module.exports = db;
