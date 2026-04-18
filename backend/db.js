'use strict';
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'earnhub.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_FILE);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _initSchema(_db);
  return _db;
}

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      username          TEXT UNIQUE NOT NULL,
      email             TEXT UNIQUE NOT NULL,
      password          TEXT NOT NULL,
      country           TEXT DEFAULT 'Kenya',
      mobile            TEXT,
      referral_code     TEXT UNIQUE,
      referred_by       TEXT,
      is_activated      INTEGER DEFAULT 0,
      is_banned         INTEGER DEFAULT 0,
      balance           REAL DEFAULT 0,
      total_earnings    REAL DEFAULT 0,
      ads_earnings      REAL DEFAULT 0,
      tiktok_earnings   REAL DEFAULT 0,
      youtube_earnings  REAL DEFAULT 0,
      trivia_earnings   REAL DEFAULT 0,
      articles_earnings REAL DEFAULT 0,
      affiliate_earnings REAL DEFAULT 0,
      agent_bonus       REAL DEFAULT 100,
      total_withdrawn   REAL DEFAULT 0,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admins (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      title      TEXT NOT NULL,
      message    TEXT NOT NULL,
      type       TEXT DEFAULT 'info',
      is_read    INTEGER DEFAULT 0,
      is_global  INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      amount     REAL NOT NULL,
      mobile     TEXT NOT NULL,
      status     TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      amount     REAL NOT NULL,
      phone      TEXT NOT NULL,
      type       TEXT DEFAULT 'activation',
      status     TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default settings
  const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  const defaults = {
    activation_fee: '300',
    site_name: 'EarnHub',
    referral_bonus: '50',
    min_withdrawal: '500',
    welcome_bonus: '0',
    maintenance_mode: 'false'
  };
  for (const [k, v] of Object.entries(defaults)) insertSetting.run(k, v);

  // Seed default admin
  if (!db.prepare(`SELECT id FROM admins WHERE username = ?`).get('admin')) {
    const hash = bcrypt.hashSync('Admin@2024', 10);
    db.prepare(`INSERT INTO admins (username, password) VALUES (?, ?)`).run('admin', hash);
    console.log('✅ Default admin: admin / Admin@2024');
  }
}

module.exports = { getDb };
