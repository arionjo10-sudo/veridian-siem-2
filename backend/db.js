'use strict';
// Shared data layer: relational tables (SQL-style) + search index (Elastic-style),
// plus the static reference data: roles, permissions, employees, customers, merchants, config.
const { Database } = require('./sqlstore');
const { SearchIndex } = require('./search');
const U = require('./util');
const { DEFAULT_CONFIG, CONFIG_DESCRIPTIONS } = require('./risk');

const db = new Database();
const search = new SearchIndex();

const TABLES = {
  employees: 'id',
  roles: 'id',
  permissions: 'id',
  role_permissions: null,
  customers: 'id',
  merchants: 'id',
  config: 'key',
  alerts: 'id',
  login_events: 'id',
  payment_events: 'id',
  network_events: 'id',
  api_events: 'id',
  security_events: 'id',
  audit_events: 'id',
};
for (const [n, pk] of Object.entries(TABLES)) db.create(n, pk);

const INDEXED = new Set(['alerts', 'login_events', 'payment_events', 'network_events', 'api_events', 'security_events', 'audit_events']);
const counters = { P: 10000, AL: 1000, AU: 50000, L: 20000, N: 30000, A: 40000, S: 60000 };
const nextId = (p) => `${p}-${++counters[p]}`;

const stats = { ingested: 0, times: [] };
function emit(table, doc) {
  db.table(table).insert(doc);
  if (INDEXED.has(table)) search.index(table, doc);
  stats.ingested++;
  const now = Date.now();
  stats.times.push(now);
  while (stats.times.length && now - stats.times[0] > 60e3) stats.times.shift();
  return doc;
}
function eventsPerSecond() {
  const now = Date.now();
  return Math.round((stats.times.filter((t) => now - t <= 60e3).length / 60) * 10) / 10;
}

db.sessions = new Map(); // session id -> {employee_id, exp, ip}
db.payHist = new Map(); // customer id -> [{ts, amount}]
db.alertKeys = new Set();

// ---------------------------------------------------------------- reference data
const DOMAIN = 'veridianpay.example';
const PERMS = [
  ['dashboard:read', 'View the operations dashboard'],
  ['alerts:read', 'View security alerts'],
  ['alerts:write', 'Acknowledge, escalate and resolve alerts'],
  ['payments:read', 'View payment events'],
  ['payments:action', 'Hold, approve or decline payments'],
  ['fraud:read', 'View fraud cases and risk analytics'],
  ['fraud:write', 'Block and unblock customers'],
  ['employees:read', 'View employee directory'],
  ['employees:write', 'Suspend or reactivate employees'],
  ['admins:manage', 'Open administration and change roles'],
  ['config:write', 'Change risk and detection configuration'],
  ['audit:read', 'View audit logs'],
  ['query:run', 'Run queries in the data explorer'],
  ['demo:control', 'Fire demo incidents and use presenter tools'],
];
for (const [id, description] of PERMS) db.permissions.insert({ id, description });

const EXEC = ['dashboard:read', 'alerts:read', 'payments:read', 'fraud:read', 'employees:read', 'audit:read'];
const ROLES = [
  ['super_admin', 'Super Administrator', 'Full platform access', PERMS.map((p) => p[0])],
  ['chairman', 'Chairman', 'Executive oversight (read only)', EXEC],
  ['deputy_chairman', 'Deputy Chairman', 'Executive oversight (read only)', EXEC],
  ['director', 'Director', 'Board oversight (read only)', EXEC],
  ['security_admin', 'Security Administrator', 'Manages staff access and security alerts',
    ['dashboard:read', 'alerts:read', 'alerts:write', 'employees:read', 'employees:write', 'audit:read', 'admins:manage', 'query:run']],
  ['fraud_analyst', 'Fraud Analyst', 'Investigates risky payments and customers',
    ['dashboard:read', 'alerts:read', 'payments:read', 'payments:action', 'fraud:read', 'fraud:write']],
  ['soc_analyst', 'SOC Analyst', 'Triages and resolves security alerts',
    ['dashboard:read', 'alerts:read', 'alerts:write', 'audit:read', 'query:run']],
  ['payments_ops', 'Payments Operations', 'Operates the payment pipeline',
    ['dashboard:read', 'payments:read', 'payments:action', 'fraud:read']],
  ['auditor', 'Internal Auditor', 'Independent review (read only)',
    ['dashboard:read', 'alerts:read', 'payments:read', 'employees:read', 'audit:read', 'fraud:read']],
];
for (const [id, name, description, perms] of ROLES) {
  db.roles.insert({ id, name, description });
  for (const p of perms) db.role_permissions.insert({ role_id: id, permission_id: p });
}

// Entirely fictional staff.
const STAFF = [
  ['Dr. Adrian Whitlock', 'Chairman', 'chairman', 'Executive', 'Board'],
  ['Ms. Marisol Quintero', 'Deputy Chairman', 'deputy_chairman', 'Executive', 'Board'],
  ['Mr. Callum Eastwood', 'Director, Risk', 'director', 'Board', 'Board'],
  ['Ms. Tamsin Okoro', 'Director, Technology', 'director', 'Board', 'Board'],
  ['Mr. Leopold Vance', 'Director, Finance', 'director', 'Board', 'Board'],
  ['Ms. Ingrid Salvatore', 'Director, Compliance', 'director', 'Board', 'Board'],
  ['Mr. Rohan Deshmukh', 'Director, Strategy', 'director', 'Board', 'Board'],
  ['Ms. Naomi Fairweather', 'Director, Operations', 'director', 'Board', 'Board'],
  ['Ms. Odette Marchand', 'Head of Platform', 'super_admin', 'Technology', 'HQ'],
  ['Mr. Idris Calloway', 'Security Administrator', 'security_admin', 'Security', 'HQ'],
  ['Ms. Lena Hartwell', 'Senior Fraud Analyst', 'fraud_analyst', 'Fraud', 'HQ'],
  ['Mr. Tobias Nkemelu', 'SOC Analyst', 'soc_analyst', 'Security', 'HQ'],
  ['Ms. Rosalind Teague', 'Payments Operations Lead', 'payments_ops', 'Operations', 'HQ'],
  ['Mr. Felix Armitage', 'Internal Auditor', 'auditor', 'Compliance', 'HQ'],
  ['Mr. Gordon Pell', 'Former contractor', 'soc_analyst', 'Security', 'HQ'],
];
const NOW0 = Date.now();
STAFF.forEach(([name, title, role_id, department, location], i) => {
  const email = name.replace(/^(Dr|Mr|Ms)\.\s+/, '').toLowerCase().replace(/\s+/g, '.') + '@' + DOMAIN;
  db.employees.insert({
    id: `E-${1001 + i}`, name, title, email, role_id, department, location,
    status: name === 'Mr. Gordon Pell' ? 'suspended' : 'active',
    mfa_enabled: true, last_login: null, created: NOW0 - U.int(200, 1400) * 864e5,
  });
});

const FIRST = ['Amara', 'Bruno', 'Celia', 'Darius', 'Elena', 'Farid', 'Grace', 'Hugo', 'Iris', 'Jamal', 'Kira', 'Liam', 'Maya', 'Nico', 'Opal', 'Priya', 'Quinn', 'Rafael', 'Sofia', 'Theo'];
const LAST = ['Abara', 'Brennan', 'Castillo', 'Dunmore', 'Esposito', 'Fontaine', 'Gallagher', 'Hollis', 'Ibarra', 'Jansen', 'Kowalski', 'Lindqvist', 'Moreau', 'Novak', 'Okafor', 'Petrov', 'Quispe', 'Rinaldi', 'Sandoval', 'Tanaka'];
const COUNTRIES = ['US', 'CA', 'GB', 'DE', 'BR', 'IN', 'SG', 'AU', 'NG', 'JM'];
const WEIGHTED = ['US', 'US', 'US', 'US', 'CA', 'CA', 'GB', 'GB', 'DE', 'BR', 'IN', 'SG', 'AU', 'NG', 'JM'];
for (let i = 0; i < 80; i++) {
  const first = FIRST[i % FIRST.length];
  const last = LAST[(i * 7 + 3) % LAST.length];
  const tier = U.chance(0.08) ? 'high' : U.chance(0.25) ? 'medium' : 'low';
  db.customers.insert({
    id: `C-${1001 + i}`, name: `${first} ${last}`,
    email: `${first}.${last}${i}@mail.example`.toLowerCase(),
    country: U.pick(WEIGHTED),
    avg_ticket: U.round2(15 + Math.pow(U.rand(), 2) * 400),
    risk_tier: tier, status: 'active', kyc_level: U.pick(['basic', 'standard', 'enhanced']),
    created: NOW0 - U.int(30, 1500) * 864e5,
  });
}
for (const id of ['C-1012', 'C-1047', 'C-1068']) db.customers.update(id, { status: 'blocked', risk_tier: 'high' });

const MERCH = [
  ['Fresh Basket Grocers', 'grocery', 'low'], ['Northwind Electronics', 'electronics', 'medium'],
  ['SkyBridge Travel', 'travel', 'medium'], ['PixelPlay Gaming', 'gaming', 'high'],
  ['CoinHarbor Exchange', 'crypto', 'high'], ['GiftNest Cards', 'gift_cards', 'high'],
  ['Saffron Table', 'restaurants', 'low'], ['BrightGrid Utilities', 'utilities', 'low'],
  ['Lumen Fashion', 'fashion', 'low'], ['CareWell Pharmacy', 'pharmacy', 'low'],
  ['Atlas Airlines', 'travel', 'medium'], ['VoltRide Mobility', 'transport', 'low'],
  ['Orbit Streaming', 'digital', 'low'], ['BetSphere', 'gambling', 'high'],
  ['Hearth Home Goods', 'home', 'low'], ['Meridian Hotels', 'travel', 'medium'],
  ['Quill Books', 'retail', 'low'], ['ByteForge Software', 'digital', 'medium'],
  ['Greenleaf Garden', 'retail', 'low'], ['Vaultline Jewelers', 'luxury', 'high'],
  ['Pulse Fitness', 'services', 'low'], ['Tidal Telecom', 'telecom', 'low'],
  ['Kiwi Kids Toys', 'retail', 'low'], ['Ironclad Hardware', 'retail', 'low'],
  ['NovaPay Remit', 'remittance', 'high'], ['Aurora Cinemas', 'entertainment', 'low'],
  ['Summit Outdoors', 'retail', 'low'], ['Cobalt Cloud', 'digital', 'medium'],
];
MERCH.forEach(([name, category, risk], i) => {
  db.merchants.insert({
    id: `M-${201 + i}`, name, category, risk, country: U.pick(['US', 'US', 'CA', 'GB', 'DE']),
    api_key: 'vp_live_' + U.sha256(name).slice(0, 8), status: 'active',
  });
});

for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
  db.config.insert({ key, value, description: CONFIG_DESCRIPTIONS[key], updated_by: 'system', updated_at: NOW0 });
}

function getCfg() {
  const o = {};
  for (const r of db.config.rows) o[r.key] = r.value;
  return o;
}

module.exports = { db, search, emit, nextId, getCfg, eventsPerSecond, stats, DOMAIN, COUNTRIES, PERMS };
