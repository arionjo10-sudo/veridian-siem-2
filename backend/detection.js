'use strict';
// Detection engine: a set of rules that scan the event tables and raise alerts.
// Alerts are de-duplicated with a stable key so re-running the engine is idempotent.
const { db, search, nextId, getCfg } = require('./db');

const DAY = 864e5;
const HOUR = 3600e3;

function clusters(events, keyFn, windowMs, min) {
  const groups = new Map();
  for (const e of events) {
    const k = keyFn(e);
    if (k == null || k === '') continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const res = [];
  for (const [k, list] of groups) {
    list.sort((a, b) => a.ts - b.ts);
    let best = null;
    let i = 0;
    for (let j = 0; j < list.length; j++) {
      while (list[j].ts - list[i].ts > windowMs) i++;
      const n = j - i + 1;
      if (n >= min && (!best || n > best.n)) best = { n, i, j };
    }
    if (best) res.push({ key: k, events: list.slice(best.i, best.j + 1) });
  }
  return res;
}

const ev = (type, list) => list.filter(Boolean).map((e) => ({ type, id: e.id }));
const hourKey = (ts) => Math.floor(ts / HOUR);

const RULES = [
  {
    id: 'DET-001', name: 'Brute-force login attempts', severity: 'high', mitre: 'T1110 Brute Force',
    description: 'Many failed logins from one source address inside a short window.',
    run({ cfg, now }) {
      const failed = db.login_events.find((e) => !e.success && e.ts >= now - DAY);
      return clusters(failed, (e) => e.ip, cfg.bruteforce_window_min * 60e3, cfg.bruteforce_threshold).map((c) => {
        const last = c.events[c.events.length - 1];
        const succ = db.login_events.find((e) => e.success && e.ip === c.key && e.ts > last.ts && e.ts - last.ts < 30 * 60e3)[0];
        const users = [...new Set(c.events.map((e) => e.user))];
        return {
          key: `bf:${c.key}:${hourKey(last.ts)}`, ts: succ ? succ.ts : last.ts,
          severity: succ ? 'critical' : 'high',
          title: succ ? `Successful login after ${c.events.length} failures from ${c.key}` : `${c.events.length} failed logins from ${c.key}`,
          description: `${c.events.length} failed sign-ins against ${users.slice(0, 3).join(', ')} within ${cfg.bruteforce_window_min} minutes.` +
            (succ ? ` The same address then signed in successfully as ${succ.user}, which suggests account takeover.` : ''),
          entity: c.key, entity_type: 'ip', evidence: ev('login_events', [...c.events, succ]),
        };
      });
    },
  },
  {
    id: 'DET-002', name: 'Impossible travel', severity: 'high', mitre: 'T1078 Valid Accounts',
    description: 'Successful logins for one account from different countries inside an unrealistic time span.',
    run({ cfg, now }) {
      const out = [];
      const byUser = new Map();
      for (const e of db.login_events.find((x) => x.success && x.ts >= now - DAY)) {
        if (!byUser.has(e.user)) byUser.set(e.user, []);
        byUser.get(e.user).push(e);
      }
      for (const [user, list] of byUser) {
        list.sort((a, b) => a.ts - b.ts);
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1];
          const b = list[i];
          if (a.country !== b.country && b.ts - a.ts <= cfg.impossible_travel_hours * HOUR) {
            out.push({
              key: `it:${user}:${b.id}`, ts: b.ts, severity: b.actor_type === 'employee' ? 'high' : 'medium',
              title: `Impossible travel for ${user}: ${a.country} to ${b.country}`,
              description: `Successful logins from ${a.country} (${a.ip}) and ${b.country} (${b.ip}) only ${Math.round((b.ts - a.ts) / 60000)} minutes apart.`,
              entity: user, entity_type: 'user', evidence: ev('login_events', [a, b]),
            });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'DET-003', name: 'Payment velocity burst', severity: 'medium', mitre: 'T1657 Financial Theft',
    description: 'A customer makes an unusually high number of payments in a short window.',
    run({ cfg, now }) {
      const pays = db.payment_events.find((p) => p.ts >= now - DAY);
      return clusters(pays, (p) => p.customer_id, cfg.velocity_window_min * 60e3, cfg.velocity_count).map((c) => {
        const last = c.events[c.events.length - 1];
        const total = c.events.reduce((s, p) => s + p.amount, 0);
        return {
          key: `vel:${c.key}:${hourKey(last.ts)}`, ts: last.ts, severity: 'medium',
          title: `${c.events.length} payments in ${cfg.velocity_window_min} min by ${last.customer_name}`,
          description: `Customer ${c.key} made ${c.events.length} payments totalling $${total.toFixed(2)} inside ${cfg.velocity_window_min} minutes.`,
          entity: c.key, entity_type: 'customer', evidence: ev('payment_events', c.events),
        };
      });
    },
  },
  {
    id: 'DET-004', name: 'Card testing pattern', severity: 'high', mitre: 'T1657 Financial Theft',
    description: 'Several tiny payments in quick succession, typical of stolen card validation.',
    run({ now }) {
      const pays = db.payment_events.find((p) => p.ts >= now - DAY && p.amount < 5);
      return clusters(pays, (p) => p.customer_id, 15 * 60e3, 4).map((c) => {
        const last = c.events[c.events.length - 1];
        return {
          key: `ct:${c.key}:${hourKey(last.ts)}`, ts: last.ts, severity: 'high',
          title: `Card testing suspected for ${last.customer_name}`,
          description: `${c.events.length} payments under $5 in 15 minutes, mostly at ${last.merchant_name}.`,
          entity: c.key, entity_type: 'customer', evidence: ev('payment_events', c.events),
        };
      });
    },
  },
  {
    id: 'DET-005', name: 'Large high-risk transaction', severity: 'medium', mitre: 'T1657 Financial Theft',
    description: 'A payment above the large-transaction threshold that also scores at or above the review line.',
    run({ cfg, now }) {
      return db.payment_events.find((p) => p.ts >= now - DAY && p.amount >= cfg.large_txn_amount && p.risk_score >= cfg.review_score).map((p) => ({
        key: `lt:${p.id}`, ts: p.ts, severity: p.risk_score >= cfg.decline_score ? 'high' : 'medium',
        title: `Large payment of $${p.amount.toLocaleString('en-US')} at ${p.merchant_name}`,
        description: `Risk score ${p.risk_score}. ${p.risk_reasons.slice(0, 3).join('; ')}.`,
        entity: p.customer_id, entity_type: 'customer', evidence: ev('payment_events', [p]),
      }));
    },
  },
  {
    id: 'DET-006', name: 'API abuse', severity: 'medium', mitre: 'T1190 Exploit Public-Facing Application',
    description: 'Request rate above the per-minute limit, or a spike in auth and rate-limit errors, for one API key.',
    run({ cfg, now }) {
      const out = [];
      const calls = db.api_events.find((e) => e.ts >= now - DAY);
      for (const c of clusters(calls, (e) => e.api_key, 60e3, cfg.api_rate_limit)) {
        const last = c.events[c.events.length - 1];
        const errs = c.events.filter((e) => e.status >= 400).length;
        out.push({
          key: `api:${c.key}:${hourKey(last.ts)}`, ts: last.ts, severity: errs > c.events.length / 3 ? 'high' : 'medium',
          title: `${c.events.length} API requests in one minute from key ${c.key}`,
          description: `${errs} of the requests failed (401/403/429). Source ${last.ip}.`,
          entity: c.key, entity_type: 'api_key', evidence: ev('api_events', c.events.slice(0, 25)),
        });
      }
      return out;
    },
  },
  {
    id: 'DET-007', name: 'Port scan', severity: 'high', mitre: 'T1046 Network Service Discovery',
    description: 'One source is denied on many distinct destination ports in a short window.',
    run({ cfg, now }) {
      const denied = db.network_events.find((e) => e.action === 'deny' && e.ts >= now - DAY);
      const out = [];
      for (const c of clusters(denied, (e) => e.src_ip, 120e3, cfg.portscan_ports)) {
        const ports = new Set(c.events.map((e) => e.dst_port));
        if (ports.size < cfg.portscan_ports) continue;
        const last = c.events[c.events.length - 1];
        out.push({
          key: `ps:${c.key}:${hourKey(last.ts)}`, ts: last.ts, severity: 'high',
          title: `Port scan from ${c.key} (${ports.size} ports)`,
          description: `${c.events.length} denied connections across ${ports.size} distinct ports against ${last.dst_ip}.`,
          entity: c.key, entity_type: 'ip', evidence: ev('network_events', c.events.slice(0, 25)),
        });
      }
      return out;
    },
  },
  {
    id: 'DET-008', name: 'Possible data exfiltration', severity: 'critical', mitre: 'T1041 Exfiltration Over C2 Channel',
    description: 'A single allowed connection moved an abnormal volume of data to an external address.',
    run({ cfg, now }) {
      return db.network_events.find((e) => e.ts >= now - DAY && e.action === 'allow' && e.bytes_out >= cfg.exfil_bytes).map((e) => ({
        key: `ex:${e.id}`, ts: e.ts, severity: 'critical',
        title: `${(e.bytes_out / 1e6).toFixed(0)} MB sent from ${e.src_ip} to ${e.dst_ip}`,
        description: `Outbound transfer on port ${e.dst_port} exceeded the ${(cfg.exfil_bytes / 1e6).toFixed(0)} MB threshold.`,
        entity: e.src_ip, entity_type: 'ip', evidence: ev('network_events', [e]),
      }));
    },
  },
  {
    id: 'DET-009', name: 'Privileged change outside hours', severity: 'medium', mitre: 'T1098 Account Manipulation',
    description: 'Role, configuration or account changes made between 02:00 and 06:00 UTC.',
    run({ now }) {
      const watched = new Set(['role.update', 'config.update', 'employee.suspend', 'employee.activate']);
      return db.audit_events.find((e) => e.ts >= now - DAY && watched.has(e.action) && e.actor_id !== 'SYSTEM' && new Date(e.ts).getUTCHours() >= 2 && new Date(e.ts).getUTCHours() < 6).map((e) => ({
        key: `oh:${e.id}`, ts: e.ts, severity: 'medium',
        title: `${e.action} by ${e.actor_name} outside business hours`,
        description: `${e.detail}. Performed at ${new Date(e.ts).toISOString().slice(11, 16)} UTC from ${e.ip}.`,
        entity: e.actor_id, entity_type: 'employee', evidence: ev('audit_events', [e]),
      }));
    },
  },
  {
    id: 'DET-010', name: 'Sensor threat signature', severity: 'high', mitre: 'T1204 User Execution',
    description: 'High and critical detections from endpoint, WAF, DLP and IDS sensors.',
    run({ now }) {
      return db.security_events.find((e) => e.ts >= now - DAY && (e.severity === 'high' || e.severity === 'critical')).map((e) => ({
        key: `sec:${e.id}`, ts: e.ts, severity: e.severity,
        title: `${e.sensor}: ${e.signature}`,
        description: `${e.detail || e.signature} Host ${e.host}${e.user ? `, user ${e.user}` : ''}.`,
        entity: e.host, entity_type: 'host', evidence: ev('security_events', [e]),
      }));
    },
  },
];

const RISK = { critical: 95, high: 80, medium: 55, low: 30 };

function runDetection(now = Date.now()) {
  const cfg = getCfg();
  const findings = [];
  for (const rule of RULES) {
    let list = [];
    try {
      list = rule.run({ cfg, now }) || [];
    } catch (err) {
      console.error(`[detection] ${rule.id} failed:`, err.message);
    }
    for (const f of list) if (!db.alertKeys.has(f.key)) findings.push({ rule, f });
  }
  findings.sort((a, b) => a.f.ts - b.f.ts);
  const created = [];
  for (const { rule, f } of findings) {
    if (db.alertKeys.has(f.key)) continue;
    db.alertKeys.add(f.key);
    const alert = {
      id: nextId('AL'), ts: f.ts, created_at: now, rule_id: rule.id, rule_name: rule.name,
      severity: f.severity, status: 'open', title: f.title, description: f.description,
      entity: f.entity, entity_type: f.entity_type, mitre: rule.mitre, risk: RISK[f.severity] || 40,
      evidence: f.evidence.slice(0, 25), evidence_total: f.evidence.length,
      assignee: null, notes: [], updated: f.ts,
    };
    db.alerts.insert(alert);
    search.index('alerts', alert);
    created.push(alert);
  }
  return created;
}

function ruleMeta() {
  return RULES.map((r) => ({
    id: r.id, name: r.name, severity: r.severity, mitre: r.mitre, description: r.description,
    alerts: db.alerts.rows.filter((a) => a.rule_id === r.id).length,
  }));
}

module.exports = { runDetection, ruleMeta, RULES };
