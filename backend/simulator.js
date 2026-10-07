'use strict';
// Live traffic simulator: every few seconds new payments, logins, network and API events
// arrive, occasionally with an attack burst, and the detection engine runs again.
const U = require('./util');
const { db, COUNTRIES } = require('./db');
const L = require('./logic');
const S = require('./scenarios');
const { runDetection } = require('./detection');

let lastNew = 0;

function tick() {
  const now = Date.now();
  const customers = S.activeCustomers();
  const merchants = db.merchants.rows;

  for (let i = 0, n = U.int(1, 4); i < n; i++) {
    const c = U.pick(customers);
    const m = U.chance(0.8) ? U.pick(merchants.filter((x) => x.risk !== 'high')) : U.pick(merchants);
    const odd = U.chance(0.09);
    let amount = U.round2(c.avg_ticket * (0.3 + U.rand() * 1.5));
    if (odd) amount = U.round2(amount * U.int(3, 7));
    L.createPayment({
      ts: now - U.int(0, 4000), customer: c, merchant: m, amount,
      country: odd ? U.pick(COUNTRIES.filter((x) => x !== c.country)) : c.country,
      device_new: odd && U.chance(0.6), method: U.pick(['card', 'card', 'wallet', 'bank_transfer']), ip: U.extIp(),
    });
  }
  for (let i = 0, n = U.int(1, 2); i < n; i++) {
    const c = U.pick(customers);
    const ok = !U.chance(0.1);
    L.createLogin({ ts: now, actor_type: 'customer', user: c.email, ip: U.extIp(), country: c.country, success: ok, reason: ok ? '' : 'bad_password', mfa: U.chance(0.4) });
  }
  for (let i = 0, n = U.int(2, 5); i < n; i++) {
    L.createNetwork({ ts: now, src_ip: U.intIp(), dst_ip: U.extIp(), dst_port: U.pick([443, 443, 80, 53, 22]), bytes_out: U.int(400, 3000000), action: U.chance(0.04) ? 'deny' : 'allow' });
  }
  for (let i = 0, n = U.int(3, 8); i < n; i++) {
    const m = U.pick(merchants);
    L.createApi({ ts: now, api_key: m.api_key, merchant_id: m.id, endpoint: U.pick(['/v1/payments', '/v1/refunds', '/v1/customers']), status: U.chance(0.95) ? 200 : 400, latency_ms: U.int(35, 400), ip: U.extIp() });
  }

  // Occasional incident
  if (U.chance(0.07)) {
    const kind = U.pick(['card', 'velocity', 'brute', 'scan', 'api']);
    const t0 = now - 90e3;
    if (kind === 'card') S.cardTesting(t0, U.pick(customers));
    else if (kind === 'velocity') S.velocity(t0 - 5 * 60e3, U.pick(customers));
    else if (kind === 'brute') S.bruteForce(t0 - 3 * 60e3, `198.51.100.${U.int(30, 240)}`, `${U.pick(['a.test', 'b.test', 'ops'])}@veridianpay.example`, false);
    else if (kind === 'scan') S.portScan(t0 - 60e3, `203.0.113.${U.int(30, 240)}`);
    else S.apiAbuse(t0 - 30e3, U.pick(merchants));
  }

  lastNew = runDetection(now).length;
}

function start(ms = 6000) {
  const h = setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.error('[simulator]', e.message);
    }
  }, ms);
  h.unref();
  return h;
}

module.exports = { start, tick, lastNew: () => lastNew };
