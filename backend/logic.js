'use strict';
// Business logic: event creation, payment decisions, alert workflow, customer blocking,
// staff management and configuration changes. Every state change writes an audit event.
const U = require('./util');
const { db, search, emit, nextId, getCfg } = require('./db');
const { scorePayment } = require('./risk');

const SYSTEM = { id: 'SYSTEM', name: 'System', role_id: 'system' };

function roleName(id) {
  const r = db.roles.get(id);
  return r ? r.name : id;
}

function audit(actor, action, target, detail, opts = {}) {
  const a = actor || SYSTEM;
  return emit('audit_events', {
    id: nextId('AU'),
    ts: opts.ts || Date.now(),
    actor_id: a.id,
    actor_name: a.name,
    actor_role: a.role_id === 'system' ? 'system' : roleName(a.role_id),
    action,
    target: target || '',
    detail: detail || '',
    ip: opts.ip || '10.20.1.5',
    result: opts.result || 'success',
  });
}

// ------------------------------------------------------------------ event creation
function createPayment(a) {
  const cfg = getCfg();
  const hist = db.payHist.get(a.customer.id) || [];
  const recent = hist.filter((h) => h.ts < a.ts && a.ts - h.ts <= 3600e3);
  const r = scorePayment(
    { amount: a.amount, country: a.country, device_new: a.device_new, ts: a.ts },
    { customer: a.customer, merchant: a.merchant, recent, cfg }
  );
  const status = a.customer.status === 'blocked' ? 'declined' : r.decision === 'approve' ? 'approved' : r.decision === 'review' ? 'review' : 'declined';
  hist.push({ ts: a.ts, amount: a.amount });
  db.payHist.set(a.customer.id, hist);
  return emit('payment_events', {
    id: nextId('P'),
    ts: a.ts,
    customer_id: a.customer.id,
    customer_name: a.customer.name,
    merchant_id: a.merchant.id,
    merchant_name: a.merchant.name,
    merchant_category: a.merchant.category,
    amount: a.amount,
    currency: 'USD',
    method: a.method || 'card',
    ip: a.ip || U.extIp(),
    country: a.country,
    device_new: !!a.device_new,
    status,
    decision: r.decision,
    risk_score: r.score,
    risk_reasons: r.reasons,
    risk_codes: r.codes,
    reviewed_by: null,
    notes: [],
  });
}

function createLogin(a) {
  return emit('login_events', {
    id: nextId('L'),
    ts: a.ts || Date.now(),
    actor_type: a.actor_type || 'customer',
    user: a.user,
    ip: a.ip,
    country: a.country || 'US',
    success: !!a.success,
    reason: a.reason || '',
    mfa: !!a.mfa,
    user_agent: a.user_agent || 'Mozilla/5.0',
  });
}

function createNetwork(a) {
  return emit('network_events', {
    id: nextId('N'),
    ts: a.ts || Date.now(),
    sensor: a.sensor || 'fw-edge-01',
    src_ip: a.src_ip,
    dst_ip: a.dst_ip,
    dst_port: a.dst_port,
    proto: a.proto || 'tcp',
    bytes_out: a.bytes_out || 0,
    action: a.action || 'allow',
  });
}

function createApi(a) {
  return emit('api_events', {
    id: nextId('A'),
    ts: a.ts || Date.now(),
    api_key: a.api_key,
    merchant_id: a.merchant_id,
    endpoint: a.endpoint,
    method: a.method || 'POST',
    status: a.status || 200,
    latency_ms: a.latency_ms || 90,
    ip: a.ip,
  });
}

function createSecurity(a) {
  return emit('security_events', {
    id: nextId('S'),
    ts: a.ts || Date.now(),
    sensor: a.sensor,
    signature: a.signature,
    severity: a.severity,
    host: a.host,
    user: a.user || '',
    detail: a.detail || '',
  });
}

// ------------------------------------------------------------------ actions
function note(doc, actor, text) {
  if (!text) return;
  doc.notes = doc.notes || [];
  doc.notes.push({ ts: Date.now(), by: actor.name, text: String(text).slice(0, 500) });
}

function paymentAction(id, action, actor, text) {
  const p = db.payment_events.get(id);
  if (!p) throw new U.HttpError(404, 'Payment not found');
  const rules = {
    hold: { from: ['review', 'approved'], to: 'held' },
    approve: { from: ['review', 'held'], to: 'approved' },
    decline: { from: ['review', 'held', 'approved'], to: 'declined' },
  };
  const r = rules[action];
  if (!r) throw new U.HttpError(400, 'Unknown action');
  if (!r.from.includes(p.status)) throw new U.HttpError(409, `Cannot ${action} a payment that is ${p.status}`);
  const prev = p.status;
  p.status = r.to;
  p.reviewed_by = actor.name;
  p.reviewed_at = Date.now();
  note(p, actor, text);
  search.refresh(p);
  audit(actor, `payment.${action}`, p.id, `${prev} -> ${p.status}; ${p.merchant_name} $${p.amount}`);
  return p;
}

function alertAction(id, action, actor, text) {
  const a = db.alerts.get(id);
  if (!a) throw new U.HttpError(404, 'Alert not found');
  const map = {
    acknowledge: { from: ['open'], to: 'acknowledged' },
    escalate: { from: ['open', 'acknowledged'], to: 'escalated' },
    resolve: { from: ['open', 'acknowledged', 'escalated'], to: 'resolved' },
    false_positive: { from: ['open', 'acknowledged', 'escalated'], to: 'false_positive' },
    reopen: { from: ['resolved', 'false_positive', 'acknowledged'], to: 'open' },
  };
  const r = map[action];
  if (!r) throw new U.HttpError(400, 'Unknown action');
  if (!r.from.includes(a.status)) throw new U.HttpError(409, `Cannot ${action} an alert that is ${a.status}`);
  const prev = a.status;
  a.status = r.to;
  a.assignee = a.assignee || actor.name;
  a.updated = Date.now();
  note(a, actor, text);
  search.refresh(a);
  audit(actor, `alert.${action}`, a.id, `${prev} -> ${a.status}; ${a.title}`);
  return a;
}

function blockCustomer(id, block, actor, reason) {
  const c = db.customers.get(id);
  if (!c) throw new U.HttpError(404, 'Customer not found');
  c.status = block ? 'blocked' : 'active';
  if (block) c.risk_tier = 'high';
  audit(actor, block ? 'customer.block' : 'customer.unblock', c.id, reason || `${c.name}`);
  return c;
}

function setEmployeeStatus(id, status, actor) {
  const e = db.employees.get(id);
  if (!e) throw new U.HttpError(404, 'Employee not found');
  if (!['active', 'suspended'].includes(status)) throw new U.HttpError(400, 'Invalid status');
  if (e.id === actor.id) throw new U.HttpError(400, 'You cannot change your own status');
  if (e.role_id === 'super_admin' && actor.role_id !== 'super_admin') throw new U.HttpError(403, 'Only a super administrator can change this account');
  e.status = status;
  if (status === 'suspended') for (const [sid, s] of db.sessions) if (s.employee_id === e.id) db.sessions.delete(sid);
  audit(actor, status === 'suspended' ? 'employee.suspend' : 'employee.activate', e.id, e.name);
  return e;
}

function setEmployeeRole(id, roleId, actor) {
  const e = db.employees.get(id);
  if (!e) throw new U.HttpError(404, 'Employee not found');
  if (!db.roles.get(roleId)) throw new U.HttpError(400, 'Unknown role');
  if ((roleId === 'super_admin' || e.role_id === 'super_admin') && actor.role_id !== 'super_admin') {
    throw new U.HttpError(403, 'Only a super administrator can grant or change the super administrator role');
  }
  if (e.id === actor.id) throw new U.HttpError(400, 'You cannot change your own role');
  const prev = e.role_id;
  e.role_id = roleId;
  audit(actor, 'role.update', e.id, `${e.name}: ${prev} -> ${roleId}`);
  return e;
}

function updateConfig(key, value, actor) {
  const row = db.config.get(key);
  if (!row) throw new U.HttpError(404, 'Unknown setting');
  const n = Number(value);
  if (!isFinite(n) || n < 0) throw new U.HttpError(400, 'Value must be a non-negative number');
  const prev = row.value;
  row.value = n;
  row.updated_by = actor.name;
  row.updated_at = Date.now();
  audit(actor, 'config.update', key, `${prev} -> ${n}`);
  return row;
}

module.exports = {
  SYSTEM, roleName, audit,
  createPayment, createLogin, createNetwork, createApi, createSecurity,
  paymentAction, alertAction, blockCustomer, setEmployeeStatus, setEmployeeRole, updateConfig,
};
