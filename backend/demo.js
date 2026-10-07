'use strict';
// Presenter tools: fire a realistic incident on demand so alerts appear live during a demo.
// Every scenario uses fresh entities so the detection engine raises a new alert each time.
const U = require('./util');
const { db } = require('./db');
const S = require('./scenarios');
const L = require('./logic');
const { runDetection } = require('./detection');

const MIN = 60e3;
const HOUR = 3600e3;

const SCENARIOS = {
  card_testing: { label: 'Card testing attack', desc: 'A burst of tiny payments at a gaming merchant from a new device.' },
  velocity: { label: 'Payment velocity burst', desc: 'One customer pays many merchants within minutes from abroad.' },
  brute_force: { label: 'Account takeover', desc: 'Password guessing against an employee account, then a successful sign-in.' },
  impossible_travel: { label: 'Impossible travel', desc: 'An employee signs in from two countries 38 minutes apart.' },
  large_txn: { label: 'Large suspicious payment', desc: 'A five-figure jewellery purchase from a foreign IP on a new device.' },
  api_abuse: { label: 'API abuse', desc: 'A merchant key hammers the API with failing and rate-limited requests.' },
  port_scan: { label: 'Port scan', desc: 'An outside address probes forty ports on an internal host.' },
  exfil: { label: 'Data exfiltration', desc: 'A workstation sends more than 800 MB to an unknown external address.' },
  insider: { label: 'Insider data export', desc: 'Data loss prevention blocks a bulk customer export to removable media.' },
};

function list() {
  return Object.entries(SCENARIOS).map(([id, s]) => ({ id, ...s }));
}

function trigger(name, actor, ip) {
  const def = SCENARIOS[name];
  if (!def) throw new U.HttpError(400, 'Unknown scenario');
  const now = Date.now();
  const hour = Math.floor(now / HOUR);
  const taken = (prefix, id) => db.alertKeys.has(`${prefix}:${id}:${hour}`);
  const freshFrom = (prefix, items, idOf) => {
    for (let i = 0; i < 40; i++) {
      const c = U.pick(items);
      if (!taken(prefix, idOf(c))) return c;
    }
    return U.pick(items);
  };
  const freshIp = (prefix, base) => {
    for (let i = 0; i < 40; i++) {
      const ipAddr = `${base}.${U.int(30, 240)}`;
      if (!taken(prefix, ipAddr)) return ipAddr;
    }
    return `${base}.${U.int(30, 240)}`;
  };
  const customers = S.activeCustomers();
  const staff = db.employees.rows.filter((e) => e.status === 'active');

  switch (name) {
    case 'card_testing': S.cardTesting(now - 5 * MIN, freshFrom('ct', customers, (c) => c.id)); break;
    case 'velocity': S.velocity(now - 9 * MIN, freshFrom('vel', customers, (c) => c.id)); break;
    case 'brute_force': S.bruteForce(now - 6 * MIN, freshIp('bf', '198.51.100'), U.pick(staff).email, true); break;
    case 'impossible_travel': S.impossibleTravel(now - 40 * MIN, U.pick(staff)); break;
    case 'large_txn': S.largeTxn(now - 1000, U.pick(customers)); break;
    case 'api_abuse': S.apiAbuse(now - 70e3, freshFrom('api', db.merchants.rows, (m) => m.api_key)); break;
    case 'port_scan': S.portScan(now - 2 * MIN, freshIp('ps', '203.0.113')); break;
    case 'exfil': S.exfil(now - 1000, `10.0.${U.int(1, 9)}.${U.int(2, 250)}`); break;
    case 'insider':
      L.createSecurity({
        ts: now - 1000, sensor: 'DLP', signature: 'Bulk customer export attempted', severity: 'critical',
        host: `WS-OPS-0${U.int(10, 60)}`, user: U.pick(staff).email,
        detail: `Attempt to copy ${U.int(20, 60)},000 customer rows to removable media.`,
      });
      break;
    default: break;
  }
  const created = runDetection(now);
  L.audit(actor, 'demo.trigger', name, def.label, { ip });
  return { scenario: name, label: def.label, alerts: created.map((a) => ({ id: a.id, severity: a.severity, title: a.title })) };
}

module.exports = { list, trigger, SCENARIOS };
