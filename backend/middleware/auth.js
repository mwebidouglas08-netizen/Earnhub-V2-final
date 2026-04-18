'use strict';
const db = require('../db');

function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login');
}

function requireActivated(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  const user = db.getUserById(req.session.userId);
  if (!user) return res.redirect('/login');
  if (user.is_banned) { req.session.destroy(); return res.redirect('/login?banned=1'); }
  if (!user.is_activated) return res.redirect('/activate');
  return next();
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.redirect('/admin/login');
}

module.exports = { requireUser, requireActivated, requireAdmin };
