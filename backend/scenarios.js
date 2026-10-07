'use strict';
// Attack and fraud scenarios used to seed realistic incidents and to drive the live simulator.
// All addresses are from documentation-reserved ranges (RFC 5737) or private space.
const U = require('./util');
const { db } = require('./db');
const L = require('./logic');

const MIN = 60e3;
const activeCustomers = () => db.customers.rows.filter((c) => c.status === 'active');
const merchantByName = (n) => db.merchants.rows.find((m) => m.name === n);
const otherCountry = (c) => U.pick(['RU', 'RO', 'VN', 'NG', 'BR', 'ID'].filter((x) => x !== c));

function bruteForce(t0, ip, email, succeed) {
  const n = U.int(7, 10);
  for (let i = 0; i < n; i++) {
    L.createLogin({ ts: t0 + i * 25e3, actor_type: 'employee', user: email, ip, country: 'RU', success: false, reason: 'bad_password', user_agent: 'python-requests/2.31' });
  }
  if (succeed) L.createLogin({ ts: t0 + n * 25e3 + 40e3, actor_type: 'employee', user: email, ip, country: 'RU', success: true, mfa: false, user_agent: 'python-requests/2.31' });
}

function impossibleTravel(t0, employee) {
  L.createLogin({ ts: t0, actor_type: 'employee', user: employee.email, ip: '203.0.113.41', country: 'US', success: true, mfa: true });
  L.createLogin({ ts: t0 + 38 * MIN, actor_type: 'employee', user: employee.email, ip: '198.51.100.77', country: 'SG', success: true, mfa: true });
}

function cardTesting(t0, customer) {
  const m = merchantByName('PixelPlay Gaming');
  const n = U.int(5, 7);
  for (let i = 0; i < n; i++) {
    L.createPayment({ ts: t0 + i * 38e3, customer, merchant: m, amount: U.round2(0.99 + U.rand() * 2), country: customer.country, device_new: true, method: 'card', ip: '198.51.100.9' });
  }
}

function velocity(t0, customer) {
  const ms = db.merchants.rows;
  const country = otherCountry(customer.country);
  const n = U.int(7, 9);
  for (let i = 0; i < n; i++) {
    L.createPayment({ ts: t0 + i * 55e3, customer, merchant: U.pick(ms), amount: U.round2(customer.avg_ticket * (1 + U.rand() * 2)), country, device_new: true, method: 'wallet', ip: '203.0.113.130' });
  }
}

function largeTxn(t0, customer) {
  L.createPayment({ ts: t0, customer, merchant: merchantByName('Vaultline Jewelers'), amount: U.round2(8800 + U.rand() * 2400), country: otherCountry(customer.country), device_new: true, method: 'card', ip: '192.0.2.200' });
}

function apiAbuse(t0, merchant) {
  const ip = '198.51.100.250';
  const n = 230 + U.int(0, 90);
  for (let i = 0; i < n; i++) {
    const r = U.rand();
    L.createApi({
      ts: t0 + Math.floor((i / n) * 55e3), api_key: merchant.api_key, merchant_id: merchant.id,
      endpoint: U.pick(['/v1/payouts', '/v1/customers', '/v1/payments']), method: 'POST',
      status: r < 0.45 ? 401 : r < 0.75 ? 429 : 200, latency_ms: U.int(20, 80), ip,
    });
  }
}

function portScan(t0, srcIp) {
  const target = '10.0.4.12';
  for (let p = 1; p <= 40; p++) {
    L.createNetwork({ ts: t0 + p * 2200, sensor: 'fw-edge-01', src_ip: srcIp, dst_ip: target, dst_port: p * 7 + 20, bytes_out: 0, action: 'deny' });
  }
}

function exfil(t0, srcIp) {
  L.createNetwork({ ts: t0, sensor: 'fw-core-02', src_ip: srcIp, dst_ip: '192.0.2.88', dst_port: 443, bytes_out: 812000000 + U.int(0, 90000000), action: 'allow' });
}

function offHours(ts, actor, target, detail) {
  const d = new Date(ts);
  d.setUTCHours(3, U.int(5, 40), 0, 0);
  L.audit(actor, 'role.update', target.id, detail, { ts: d.getTime(), ip: '203.0.113.60' });
}

function sensors(now) {
  L.createSecurity({ ts: now - 55 * MIN, sensor: 'EDR', signature: 'Ransomware behaviour blocked', severity: 'high', host: 'WS-FIN-014', user: 'rosalind.teague@veridianpay.example', detail: 'Mass file rename pattern terminated by endpoint agent.' });
  L.createSecurity({ ts: now - 30 * MIN, sensor: 'DLP', signature: 'Bulk customer export attempted', severity: 'critical', host: 'WS-OPS-022', user: 'gordon.pell@veridianpay.example', detail: 'Attempt to copy 40,000 customer rows to removable media.' });
  L.createSecurity({ ts: now - 12 * MIN, sensor: 'WAF', signature: 'SQL injection burst on /v1/customers', severity: 'high', host: 'api-gw-01', detail: 'Repeated UNION SELECT payloads from 198.51.100.250.' });
}

module.exports = { bruteForce, impossibleTravel, cardTesting, velocity, largeTxn, apiAbuse, portScan, exfil, offHours, sensors, activeCustomers, merchantByName };
