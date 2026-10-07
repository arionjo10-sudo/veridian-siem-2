'use strict';
// Seeds 24 hours of history: normal traffic plus a set of staged incidents,
// then runs the detection engine once so the alert queue is populated on first start.
const U = require('./util');
const { db, search, stats, COUNTRIES } = require('./db');
const L = require('./logic');
const S = require('./scenarios');
const { runDetection } = require('./detection');

const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 864e5;

function seed() {
  const NOW = Date.now();
  const customers = S.activeCustomers();
  const merchants = db.merchants.rows;
  const lowMerchants = merchants.filter((m) => m.risk === 'low');
  const emps = db.employees.rows;
  const emp = (name) => emps.find((e) => e.name.includes(name));

  // ---- payments (720 events across 24h)
  const times = Array.from({ length: 720 }, () => NOW - Math.floor(U.rand() * DAY)).sort((a, b) => a - b);
  for (const ts of times) {
    const c = U.pick(customers);
    const m = U.chance(0.8) ? U.pick(lowMerchants) : U.pick(merchants);
    let amount = U.round2(c.avg_ticket * (0.3 + U.rand() * 1.5));
    if (U.chance(0.015)) amount = U.round2(amount * U.int(4, 8));
    const foreign = U.chance(0.06);
    L.createPayment({
      ts, customer: c, merchant: m, amount,
      country: foreign ? U.pick(COUNTRIES.filter((x) => x !== c.country)) : c.country,
      device_new: U.chance(0.05), method: U.pick(['card', 'card', 'card', 'wallet', 'bank_transfer']),
      ip: U.extIp(),
    });
  }

  // ---- customer logins
  for (let i = 0; i < 300; i++) {
    const c = U.pick(customers);
    const ok = !U.chance(0.07);
    L.createLogin({ ts: NOW - Math.floor(U.rand() * DAY), actor_type: 'customer', user: c.email, ip: U.extIp(), country: c.country, success: ok, reason: ok ? '' : 'bad_password', mfa: U.chance(0.4), user_agent: U.pick(['VeridianPay-iOS/5.2', 'VeridianPay-Android/5.2', 'Mozilla/5.0 (Macintosh)', 'Mozilla/5.0 (Windows NT 10.0)']) });
  }

  // ---- staff logins
  for (const e of emps) {
    if (e.status !== 'active') continue;
    const n = U.int(1, 3);
    for (let i = 0; i < n; i++) {
      const ts = NOW - U.int(10, 20 * 60) * MIN;
      L.createLogin({ ts, actor_type: 'employee', user: e.email, ip: `10.20.1.${U.int(10, 200)}`, country: 'US', success: true, mfa: true, user_agent: 'Mozilla/5.0 (Macintosh)' });
      e.last_login = Math.max(e.last_login || 0, ts);
    }
  }
  const pell = emp('Gordon Pell');
  for (let i = 0; i < 2; i++) {
    L.createLogin({ ts: NOW - U.int(60, 600) * MIN, actor_type: 'employee', user: pell.email, ip: `10.20.1.${U.int(10, 200)}`, country: 'US', success: false, reason: 'account_suspended' });
  }

  // ---- network (360 normal events)
  for (let i = 0; i < 360; i++) {
    L.createNetwork({
      ts: NOW - Math.floor(U.rand() * DAY), sensor: U.pick(['fw-edge-01', 'fw-core-02']),
      src_ip: U.intIp(), dst_ip: U.extIp(), dst_port: U.pick([443, 443, 443, 80, 53, 22, 3306, 8443, 25]),
      proto: 'tcp', bytes_out: U.int(400, 4000000), action: U.chance(0.04) ? 'deny' : 'allow',
    });
  }

  // ---- API (450 normal events)
  for (let i = 0; i < 450; i++) {
    const m = U.pick(merchants);
    const r = U.rand();
    L.createApi({
      ts: NOW - Math.floor(U.rand() * DAY), api_key: m.api_key, merchant_id: m.id,
      endpoint: U.pick(['/v1/payments', '/v1/payments', '/v1/refunds', '/v1/customers', '/v1/payouts', '/v1/webhooks']),
      method: U.pick(['POST', 'POST', 'GET']), status: r < 0.9 ? 200 : r < 0.95 ? 201 : r < 0.98 ? 400 : 500,
      latency_ms: U.int(35, 420), ip: U.extIp(),
    });
  }

  // ---- sensor noise (55 low/medium events)
  const noise = [
    ['EDR', 'Suspicious PowerShell flag (allowed)', 'low'], ['WAF', 'Scanner user-agent blocked', 'medium'],
    ['IDS', 'Outdated TLS version negotiated', 'low'], ['DLP', 'Large email attachment sent', 'low'],
    ['EDR', 'Unsigned binary executed', 'medium'], ['WAF', 'Rate limit applied to client', 'low'],
  ];
  for (let i = 0; i < 55; i++) {
    const [sensor, signature, severity] = U.pick(noise);
    L.createSecurity({ ts: NOW - Math.floor(U.rand() * DAY), sensor, signature, severity, host: U.pick(['WS-FIN-014', 'WS-OPS-022', 'api-gw-01', 'db-core-03', 'WS-SEC-007']), detail: signature + '.' });
  }

  // ---- routine staff audit activity
  const actions = ['auth.login', 'alert.view', 'payment.view', 'customer.view', 'report.export', 'employee.view', 'query.run', 'dashboard.view'];
  const active = emps.filter((e) => e.status === 'active');
  for (let i = 0; i < 130; i++) {
    const a = U.pick(active);
    const act = U.pick(actions);
    L.audit(a, act, '', act === 'report.export' ? 'Exported daily summary' : '', { ts: NOW - Math.floor(U.rand() * DAY), ip: `10.20.1.${U.int(10, 200)}` });
  }
  // A few legitimate changes during working hours
  L.audit(emp('Idris'), 'employee.suspend', pell.id, `${pell.name}: contract ended`, { ts: NOW - 20 * HOUR });
  L.audit(emp('Odette'), 'config.update', 'review_score', '40 -> 45', { ts: NOW - 15 * HOUR });
  L.audit(emp('Lena'), 'customer.block', 'C-1068', 'Confirmed chargeback fraud', { ts: NOW - 9 * HOUR });

  // ---- staged incidents
  S.bruteForce(NOW - 95 * MIN, '198.51.100.23', emp('Odette').email, true);
  S.impossibleTravel(NOW - 3 * HOUR, emp('Idris'));
  S.cardTesting(NOW - 50 * MIN, db.customers.get('C-1017'));
  S.velocity(NOW - 30 * MIN, db.customers.get('C-1033'));
  S.largeTxn(NOW - 70 * MIN, db.customers.get('C-1005'));
  S.apiAbuse(NOW - 20 * MIN, S.merchantByName('NovaPay Remit'));
  S.portScan(NOW - 40 * MIN, '203.0.113.19');
  S.exfil(NOW - 15 * MIN, '10.0.7.31');
  S.sensors(NOW);
  const offTs = (() => {
    const d = new Date(NOW);
    d.setUTCHours(3, 0, 0, 0);
    return d.getTime() > NOW ? d.getTime() - DAY : d.getTime();
  })();
  S.offHours(offTs, emp('Odette'), emp('Tobias'), 'Mr. Tobias Nkemelu: soc_analyst -> security_admin');

  // ---- settle old approved payments
  for (const p of db.payment_events.rows) {
    if (p.status === 'approved' && p.ts < NOW - 3 * HOUR) {
      p.status = 'settled';
      search.refresh(p);
    }
  }

  // ---- first detection pass, then age the queue
  const alerts = runDetection(NOW);
  for (const a of alerts) {
    if (a.ts < NOW - 6 * HOUR) {
      a.status = U.chance(0.8) ? 'resolved' : 'false_positive';
      a.assignee = 'Mr. Tobias Nkemelu';
    } else if (U.chance(0.2) && a.severity !== 'critical') {
      a.status = 'acknowledged';
      a.assignee = 'Mr. Tobias Nkemelu';
    }
    search.refresh(a);
  }

  stats.times.length = 0;
  stats.ingested = 0;
  return alerts.length;
}

module.exports = { seed };
