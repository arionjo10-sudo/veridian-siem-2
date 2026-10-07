'use strict';
// Risk engine: scores a payment 0-100 from behavioural and contextual signals
// and returns a decision (approve / review / decline) plus human-readable reasons.

const DEFAULT_CONFIG = {
  review_score: 45,
  decline_score: 75,
  large_txn_amount: 5000,
  velocity_count: 6,
  velocity_window_min: 10,
  bruteforce_threshold: 5,
  bruteforce_window_min: 10,
  api_rate_limit: 200,
  exfil_bytes: 500000000,
  portscan_ports: 20,
  impossible_travel_hours: 2,
};

const CONFIG_DESCRIPTIONS = {
  review_score: 'Risk score at or above which a payment is sent to manual review',
  decline_score: 'Risk score at or above which a payment is declined automatically',
  large_txn_amount: 'Single payment amount (USD) treated as a large transaction',
  velocity_count: 'Payments by one customer inside the velocity window that count as a burst',
  velocity_window_min: 'Velocity window length in minutes',
  bruteforce_threshold: 'Failed logins from one IP inside the window that raise a brute-force alert',
  bruteforce_window_min: 'Brute-force window length in minutes',
  api_rate_limit: 'API requests per minute from one key before abuse is flagged',
  exfil_bytes: 'Outbound bytes in one connection treated as possible data exfiltration',
  portscan_ports: 'Distinct denied destination ports from one source that indicate a port scan',
  impossible_travel_hours: 'Two successful logins from different countries inside this many hours are impossible travel',
};

function scorePayment(p, { customer, merchant, recent, cfg }) {
  let score = 4;
  const reasons = [];
  const codes = [];
  const add = (pts, code, text) => {
    score += pts;
    reasons.push(`+${pts} ${text}`);
    codes.push(code);
  };

  if (customer.status === 'blocked') add(100, 'BLOCKED_CUSTOMER', 'Customer account is blocked');

  const ratio = p.amount / Math.max(customer.avg_ticket, 1);
  if (p.amount >= 5 && ratio >= 5) add(25, 'AMOUNT_SPIKE', `Amount ${ratio.toFixed(1)}x above customer average`);
  else if (p.amount >= 5 && ratio >= 3) add(12, 'AMOUNT_HIGH', `Amount ${ratio.toFixed(1)}x above customer average`);

  if (p.amount >= cfg.large_txn_amount) add(20, 'LARGE_AMOUNT', `Amount exceeds the ${cfg.large_txn_amount} large-transaction threshold`);
  if (p.country !== customer.country) add(20, 'GEO_MISMATCH', `IP country ${p.country} differs from home country ${customer.country}`);
  if (p.device_new) add(10, 'NEW_DEVICE', 'First time this device is seen for the customer');

  if (merchant.risk === 'high') add(15, 'HIGH_RISK_MERCHANT', `High-risk merchant category (${merchant.category})`);
  else if (merchant.risk === 'medium') add(5, 'MEDIUM_RISK_MERCHANT', `Medium-risk merchant category (${merchant.category})`);

  const w = cfg.velocity_window_min * 60e3;
  const inWin = recent.filter((r) => p.ts - r.ts <= w).length;
  if (inWin + 1 >= cfg.velocity_count) add(25, 'VELOCITY', `${inWin + 1} payments within ${cfg.velocity_window_min} minutes`);
  else if (recent.filter((r) => p.ts - r.ts <= 3600e3).length >= 8) add(10, 'HOURLY_VOLUME', 'Unusually high hourly payment volume');

  const micro = recent.filter((r) => r.amount < 5 && p.ts - r.ts <= 15 * 60e3).length;
  if (p.amount < 5 && micro >= 3) add(30, 'CARD_TESTING', 'Repeated micro-amount attempts (card testing pattern)');

  const hr = new Date(p.ts).getUTCHours();
  if (hr >= 2 && hr < 6) add(6, 'ODD_HOURS', 'Unusual hour (02:00-06:00 UTC)');
  if (customer.risk_tier === 'high') add(10, 'HIGH_RISK_CUSTOMER', 'Customer risk tier is high');

  score = Math.max(0, Math.min(100, Math.round(score)));
  const decision = score >= cfg.decline_score ? 'decline' : score >= cfg.review_score ? 'review' : 'approve';
  return { score, reasons, codes, decision };
}

module.exports = { scorePayment, DEFAULT_CONFIG, CONFIG_DESCRIPTIONS };
