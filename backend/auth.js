'use strict';
// Demo authentication (password + MFA step), signed session tokens, lockout, and RBAC checks.
const crypto = require('crypto');
const U = require('./util');
const { db } = require('./db');
const L = require('./logic');

const DEMO_PASSWORD = 'Demo#2026!';
const DEMO_MFA_CODE = '246810';
const SECRET = crypto.randomBytes(32);
const SESSION_MS = 8 * 3600e3;

const creds = new Map(); // email -> {salt, hash}
for (const e of db.employees.rows) {
  const salt = crypto.randomBytes(8).toString('hex');
  creds.set(e.email, { salt, hash: U.sha256(salt + DEMO_PASSWORD) });
}
const challenges = new Map(); // token -> {employee_id, exp}
const failures = new Map(); // email -> [ts]

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function permsOf(roleId) {
  return db.role_permissions.rows.filter((r) => r.role_id === roleId).map((r) => r.permission_id);
}

function profile(user) {
  const e = user.employee;
  return {
    employee: { id: e.id, name: e.name, title: e.title, email: e.email, role_id: e.role_id, role_name: L.roleName(e.role_id), department: e.department },
    permissions: [...user.perms],
  };
}

function demoAccounts() {
  return {
    password: DEMO_PASSWORD,
    mfa_code: DEMO_MFA_CODE,
    accounts: db.employees.rows.map((e) => ({
      name: e.name, title: e.title, email: e.email, role: L.roleName(e.role_id), status: e.status,
    })),
  };
}

function fail(email, ip, reason, message, status = 401) {
  const list = failures.get(email) || [];
  list.push(Date.now());
  failures.set(email, list);
  L.createLogin({ actor_type: 'employee', user: email || 'unknown', ip, country: 'US', success: false, reason });
  throw new U.HttpError(status, message);
}

function login(email, password, ip) {
  email = String(email || '').trim().toLowerCase();
  const emp = db.employees.rows.find((e) => e.email === email);
  const recent = (failures.get(email) || []).filter((t) => Date.now() - t < 15 * 60e3);
  failures.set(email, recent);
  if (!emp) return fail(email, ip, 'unknown_user', 'Invalid email or password');
  if (recent.length >= 5) return fail(email, ip, 'account_locked', 'Account temporarily locked after repeated failures. Try again in 15 minutes.', 423);
  const c = creds.get(email);
  if (!c || U.sha256(c.salt + String(password || '')) !== c.hash) return fail(email, ip, 'bad_password', 'Invalid email or password');
  if (emp.status !== 'active') return fail(email, ip, 'account_suspended', 'This account is suspended. Contact the security team.', 403);
  const challenge = crypto.randomBytes(16).toString('hex');
  challenges.set(challenge, { employee_id: emp.id, exp: Date.now() + 5 * 60e3 });
  return { mfa_required: true, challenge };
}

function mfa(challenge, code, ip) {
  const ch = challenges.get(challenge);
  if (!ch || ch.exp < Date.now()) throw new U.HttpError(401, 'Sign-in expired. Start again.');
  const emp = db.employees.get(ch.employee_id);
  if (String(code || '').trim() !== DEMO_MFA_CODE) {
    L.createLogin({ actor_type: 'employee', user: emp.email, ip, country: 'US', success: false, reason: 'mfa_failed', mfa: true });
    throw new U.HttpError(401, 'Invalid verification code');
  }
  challenges.delete(challenge);
  failures.delete(emp.email);
  const sid = crypto.randomBytes(12).toString('hex');
  const exp = Date.now() + SESSION_MS;
  db.sessions.set(sid, { employee_id: emp.id, exp, ip });
  const body = b64({ sid, sub: emp.id, exp });
  const token = `${body}.${sign(body)}`;
  emp.last_login = Date.now();
  L.createLogin({ actor_type: 'employee', user: emp.email, ip, country: 'US', success: true, mfa: true });
  L.audit(emp, 'auth.login', emp.id, 'Signed in with MFA', { ip });
  const user = { employee: emp, perms: new Set(permsOf(emp.role_id)), sid };
  return { token, ...profile(user) };
}

function authenticate(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = sign(body);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
  const s = db.sessions.get(payload.sid);
  if (!s || payload.exp < Date.now() || s.exp < Date.now()) return null;
  const emp = db.employees.get(s.employee_id);
  if (!emp || emp.status !== 'active') return null;
  return { employee: emp, perms: new Set(permsOf(emp.role_id)), sid: payload.sid };
}

function logout(user, ip) {
  db.sessions.delete(user.sid);
  L.audit(user.employee, 'auth.logout', user.employee.id, '', { ip });
  return { ok: true };
}

module.exports = { login, mfa, authenticate, logout, profile, demoAccounts, permsOf, DEMO_PASSWORD, DEMO_MFA_CODE };
