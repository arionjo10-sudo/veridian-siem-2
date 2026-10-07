'use strict';
// Read models for the dashboard pages. These combine the SQL-style tables with the search index.
const U = require('./util');
const { db, search, eventsPerSecond, stats } = require('./db');
const L = require('./logic');
const { ruleMeta } = require('./detection');

const HOUR = 3600e3;
const DAY = 864e5;
const SEVS = ['critical', 'high', 'medium', 'low'];
const OPEN = new Set(['open', 'acknowledged', 'escalated']);

const lim = (v, d, max) => Math.min(Math.max(parseInt(v, 10) || d, 1), max);
const hits = (r) => r.hits.map((h) => h._source);

function dashboard() {
  const now = Date.now();
  const start = Math.floor((now - 23 * HOUR) / HOUR) * HOUR;
  const hours = Array.from({ length: 24 }, (_, i) => start + i * HOUR);

  const pay = search.search({
    index: 'payment_events', q: `ts:>=${start}`, size: 0,
    aggs: { per_hour: { date_histogram: { field: 'ts', interval_ms: HOUR, sub_sum: 'amount' } }, countries: { terms: { field: 'country', size: 6 } } },
  });
  const byHour = new Map(pay.aggregations.per_hour.buckets.map((b) => [b.key, b]));
  const payments_series = hours.map((h) => ({ ts: h, count: (byHour.get(h) || {}).doc_count || 0, volume: Math.round((byHour.get(h) || {}).sum || 0) }));

  const alertsAll = db.alerts.rows;
  const alerts24 = alertsAll.filter((a) => a.ts >= start);
  const alerts_series = hours.map((h) => ({ ts: h, count: alerts24.filter((a) => a.ts >= h && a.ts < h + HOUR).length }));
  const open = alertsAll.filter((a) => OPEN.has(a.status));
  const sev = Object.fromEntries(SEVS.map((s) => [s, open.filter((a) => a.severity === s).length]));

  const pays = db.payment_events.rows.filter((p) => p.ts >= now - DAY);
  const volume = pays.filter((p) => p.status === 'approved' || p.status === 'settled').reduce((s, p) => s + p.amount, 0);
  const prevented = pays.filter((p) => ['declined', 'held', 'review'].includes(p.status) && p.risk_score >= 45).reduce((s, p) => s + p.amount, 0);
  const failedLogins = db.login_events.rows.filter((e) => !e.success && e.ts >= now - DAY).length;

  const ruleCounts = {};
  for (const a of open) ruleCounts[a.rule_name] = (ruleCounts[a.rule_name] || 0) + 1;
  const top_rules = Object.entries(ruleCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 6);

  const cMap = {};
  for (const p of pays) {
    const c = (cMap[p.country] = cMap[p.country] || { country: p.country, count: 0, volume: 0, flagged: 0 });
    c.count++;
    c.volume += p.amount;
    if (p.risk_score >= 45) c.flagged++;
  }
  const countries = Object.values(cMap).sort((a, b) => b.volume - a.volume).slice(0, 6).map((c) => ({ ...c, volume: Math.round(c.volume) }));

  const recent_alerts = [...alertsAll].sort((a, b) => b.ts - a.ts).slice(0, 8)
    .map((a) => ({ id: a.id, ts: a.ts, severity: a.severity, status: a.status, title: a.title, rule_name: a.rule_name }));

  return {
    now,
    kpis: {
      open_alerts: open.length, critical_open: sev.critical, high_open: sev.high,
      payments_24h: pays.length, volume_24h: Math.round(volume), fraud_prevented: Math.round(prevented),
      failed_logins_24h: failedLogins,
      avg_risk: pays.length ? Math.round(pays.reduce((s, p) => s + p.risk_score, 0) / pays.length) : 0,
      review_queue: db.payment_events.rows.filter((p) => p.status === 'review' || p.status === 'held').length,
    },
    payments_series, alerts_series, severity: sev, top_rules, countries, recent_alerts,
    system: system(),
  };
}

function system() {
  const ss = search.stats();
  const rows = db.list();
  const sessions = [...db.sessions.values()].filter((s) => s.exp > Date.now()).length;
  const rules = ruleMeta();
  return {
    eps: eventsPerSecond(),
    engines: [
      { name: 'Authentication', status: 'operational', detail: `${sessions} active session${sessions === 1 ? '' : 's'}` },
      { name: 'Authorization (RBAC)', status: 'operational', detail: `${db.roles.rows.length} roles, ${db.permissions.rows.length} permissions` },
      { name: 'Risk engine', status: 'operational', detail: `${db.payment_events.rows.length.toLocaleString('en-US')} payments scored` },
      { name: 'Detection engine', status: 'operational', detail: `${rules.length} rules, ${db.alerts.rows.length} alerts raised` },
      { name: 'SQL store', status: 'operational', detail: `${rows.length} tables, ${rows.reduce((s, t) => s + t.rows, 0).toLocaleString('en-US')} rows` },
      { name: 'Search index', status: 'operational', detail: `${ss.docs.toLocaleString('en-US')} documents, ${ss.terms.toLocaleString('en-US')} terms` },
    ],
  };
}

function alerts(q) {
  const size = lim(q.size, 50, 500);
  const r = search.search({
    index: 'alerts', q: q.q || '', size,
    filters: { severity: q.severity, status: q.status },
    aggs: { severity: { terms: { field: 'severity' } }, status: { terms: { field: 'status' } } },
  });
  const all = db.alerts.rows;
  return {
    total: r.total, rows: hits(r).map((a) => ({ ...a, evidence: undefined })),
    facets: {
      severity: Object.fromEntries(SEVS.map((s) => [s, all.filter((a) => a.severity === s).length])),
      status: Object.fromEntries(['open', 'acknowledged', 'escalated', 'resolved', 'false_positive'].map((s) => [s, all.filter((a) => a.status === s).length])),
    },
    took_ms: r.took_ms,
  };
}

function alertDetail(id) {
  const a = db.alerts.get(id);
  if (!a) throw new U.HttpError(404, 'Alert not found');
  const evidence = a.evidence.map((e) => ({ type: e.type, doc: db.table(e.type).get(e.id) })).filter((e) => e.doc);
  return { alert: a, evidence };
}

function payments(q) {
  const size = lim(q.size, 50, 500);
  let query = q.q || '';
  if (q.min_risk) query += ` risk_score:>=${Number(q.min_risk) || 0}`;
  const r = search.search({
    index: 'payment_events', q: query, size,
    filters: { status: q.status },
    aggs: { amount: { sum: 'amount' } },
  });
  const all = db.payment_events.rows;
  const counts = {};
  for (const p of all) counts[p.status] = (counts[p.status] || 0) + 1;
  return { total: r.total, rows: hits(r), volume: Math.round(r.aggregations.amount.value), status_counts: counts, took_ms: r.took_ms };
}

function paymentDetail(id) {
  const p = db.payment_events.get(id);
  if (!p) throw new U.HttpError(404, 'Payment not found');
  return {
    payment: p,
    customer: db.customers.get(p.customer_id),
    merchant: db.merchants.get(p.merchant_id),
    related_alerts: db.alerts.rows.filter((a) => a.evidence.some((e) => e.type === 'payment_events' && e.id === id)).map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status })),
    history: db.payment_events.rows.filter((x) => x.customer_id === p.customer_id && x.id !== id).sort((a, b) => b.ts - a.ts).slice(0, 8)
      .map((x) => ({ id: x.id, ts: x.ts, amount: x.amount, merchant_name: x.merchant_name, risk_score: x.risk_score, status: x.status })),
  };
}

function fraud() {
  const now = Date.now();
  const pays = db.payment_events.rows.filter((p) => p.ts >= now - DAY);
  const flagged = pays.filter((p) => p.risk_score >= 45);

  const queue = db.payment_events.rows.filter((p) => p.status === 'review' || p.status === 'held')
    .sort((a, b) => b.risk_score - a.risk_score).slice(0, 25);

  const buckets = Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10}-${i * 10 + 9}`, count: 0 }));
  for (const p of pays) buckets[Math.min(9, Math.floor(p.risk_score / 10))].count++;

  const reasonMap = {};
  for (const p of flagged) for (const c of p.risk_codes) reasonMap[c] = (reasonMap[c] || 0) + 1;
  const reasons = Object.entries(reasonMap).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 8);

  const cust = {};
  for (const p of flagged) {
    const c = (cust[p.customer_id] = cust[p.customer_id] || { id: p.customer_id, name: p.customer_name, flagged: 0, amount: 0, max_risk: 0 });
    c.flagged++;
    c.amount += p.amount;
    c.max_risk = Math.max(c.max_risk, p.risk_score);
  }
  const customers = Object.values(cust).sort((a, b) => b.max_risk - a.max_risk || b.flagged - a.flagged).slice(0, 8)
    .map((c) => ({ ...c, amount: Math.round(c.amount), status: db.customers.get(c.id).status, country: db.customers.get(c.id).country }));

  const mer = {};
  for (const p of pays) {
    const m = (mer[p.merchant_id] = mer[p.merchant_id] || { id: p.merchant_id, name: p.merchant_name, category: p.merchant_category, count: 0, declined: 0, risk_sum: 0 });
    m.count++;
    if (p.status === 'declined') m.declined++;
    m.risk_sum += p.risk_score;
  }
  const merchants = Object.values(mer).filter((m) => m.count >= 5)
    .map((m) => ({ id: m.id, name: m.name, category: m.category, count: m.count, decline_rate: Math.round((m.declined / m.count) * 100), avg_risk: Math.round(m.risk_sum / m.count) }))
    .sort((a, b) => b.avg_risk - a.avg_risk).slice(0, 8);

  const stopped = pays.filter((p) => ['declined', 'held', 'review'].includes(p.status));
  return {
    kpis: {
      flagged: flagged.length,
      declined: pays.filter((p) => p.status === 'declined').length,
      in_review: db.payment_events.rows.filter((p) => p.status === 'review' || p.status === 'held').length,
      amount_stopped: Math.round(stopped.reduce((s, p) => s + p.amount, 0)),
      blocked_customers: db.customers.rows.filter((c) => c.status === 'blocked').length,
    },
    queue, distribution: buckets, reasons, customers, merchants,
  };
}

function employees() {
  const now = Date.now();
  const rows = db.employees.rows.map((e) => ({
    ...e, role_name: L.roleName(e.role_id),
    failed_24h: db.login_events.rows.filter((l) => l.user === e.email && !l.success && l.ts >= now - DAY).length,
  }));
  return {
    rows,
    kpis: {
      total: rows.length, active: rows.filter((e) => e.status === 'active').length,
      suspended: rows.filter((e) => e.status === 'suspended').length, mfa: rows.filter((e) => e.mfa_enabled).length,
    },
    roles: db.roles.rows,
  };
}

function employeeDetail(id) {
  const e = db.employees.get(id);
  if (!e) throw new U.HttpError(404, 'Employee not found');
  const perms = db.role_permissions.rows.filter((r) => r.role_id === e.role_id).map((r) => r.permission_id);
  return {
    employee: { ...e, role_name: L.roleName(e.role_id) },
    permissions: perms,
    logins: db.login_events.rows.filter((l) => l.user === e.email).sort((a, b) => b.ts - a.ts).slice(0, 8),
    activity: db.audit_events.rows.filter((a) => a.actor_id === e.id).sort((a, b) => b.ts - a.ts).slice(0, 8),
  };
}

function admins() {
  const matrix = db.roles.rows.map((r) => ({
    ...r,
    members: db.employees.rows.filter((e) => e.role_id === r.id).length,
    permissions: db.role_permissions.rows.filter((x) => x.role_id === r.id).map((x) => x.permission_id),
  }));
  const privileged = new Set(['super_admin', 'security_admin']);
  return {
    admins: db.employees.rows.filter((e) => privileged.has(e.role_id)).map((e) => ({ ...e, role_name: L.roleName(e.role_id) })),
    roles: matrix,
    permissions: db.permissions.rows,
    config: db.config.rows,
    rules: ruleMeta(),
    tables: db.list(),
    search: search.stats(),
    system: system(),
  };
}

function audit(q) {
  const size = lim(q.size, 50, 1000);
  const r = search.search({
    index: 'audit_events', q: q.q || '', size,
    filters: { action: q.action, actor_id: q.actor },
    aggs: { actions: { terms: { field: 'action', size: 12 } } },
  });
  return { total: r.total, rows: hits(r), facets: { actions: r.aggregations.actions.buckets }, took_ms: r.took_ms };
}

function auditCsv(q) {
  const r = search.search({ index: 'audit_events', q: q.q || '', filters: { action: q.action }, size: 5000 });
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['id', 'time_utc', 'actor', 'role', 'action', 'target', 'detail', 'ip', 'result'];
  const lines = [head.join(',')];
  for (const a of hits(r)) {
    lines.push([a.id, new Date(a.ts).toISOString(), a.actor_name, a.actor_role, a.action, a.target, a.detail, a.ip, a.result].map(esc).join(','));
  }
  return lines.join('\n');
}

function runQuery(body) {
  if (body.mode === 'sql') {
    try {
      return { mode: 'sql', ...db.query(String(body.query || '')) };
    } catch (e) {
      throw new U.HttpError(400, e.message);
    }
  }
  const r = search.search({ index: body.index || undefined, q: String(body.query || ''), size: lim(body.size, 50, 200) });
  const rows = r.hits.map((h) => ({ _index: h._index, ...h._source }));
  const columns = [...new Set(rows.flatMap((x) => Object.keys(x)))].slice(0, 12);
  return { mode: 'search', columns, rows, total: r.total, took_ms: Math.round(r.took_ms * 100) / 100 };
}


// Lightweight feed for the live ticker and alert pop-ups.
function live(since) {
  const now = Date.now();
  const s = Number(since) || now;
  const recent = db.payment_events.rows.slice(-250).sort((a, b) => b.ts - a.ts).slice(0, 10)
    .map((p) => ({ id: p.id, ts: p.ts, amount: p.amount, merchant_name: p.merchant_name, customer_name: p.customer_name, country: p.country, risk_score: p.risk_score, status: p.status }));
  const alerts = db.alerts.rows.filter((a) => a.created_at > s)
    .map((a) => ({ id: a.id, severity: a.severity, title: a.title, rule_name: a.rule_name, ts: a.ts }));
  return { now, payments: recent, alerts, open_alerts: db.alerts.rows.filter((a) => OPEN.has(a.status)).length };
}

// Numbers for the business-impact page. Everything here is computed from the live data.
function impact() {
  const now = Date.now();
  const pays = db.payment_events.rows.filter((p) => p.ts >= now - DAY);
  const stopped = pays.filter((p) => ['declined', 'held', 'review'].includes(p.status));
  const auto = pays.filter((p) => !p.reviewed_by && p.status !== 'review' && p.status !== 'held').length;
  return {
    payments_24h: pays.length,
    volume_24h: Math.round(pays.filter((p) => p.status === 'approved' || p.status === 'settled').reduce((s, p) => s + p.amount, 0)),
    stopped_amount: Math.round(stopped.reduce((s, p) => s + p.amount, 0)),
    stopped_count: stopped.length,
    auto_rate: pays.length ? Math.round((auto / pays.length) * 100) : 0,
    events_monitored: search.stats().docs,
    alerts_total: db.alerts.rows.length,
    critical: db.alerts.rows.filter((a) => a.severity === 'critical').length,
    rules: ruleMeta().length,
  };
}

module.exports = { live, impact, dashboard, system, alerts, alertDetail, payments, paymentDetail, fraud, employees, employeeDetail, admins, audit, auditCsv, runQuery };
