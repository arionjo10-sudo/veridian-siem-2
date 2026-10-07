# Veridian Pay SIEM (demo)

A demo security operations dashboard for **Veridian Pay**, a fictional digital payments company.
Every company, person, account, address and transaction in it is invented. 

```
cd veridian-siem
node server.js        # then open http://localhost:3000   (PORT=4000 node server.js to change it)
```

## Signing in

The sign-in page lists the demo employees. Click one, then press **Verify and sign in**.
Password for all accounts: `Demo#2026!`   Verification code: `246810`

What each role can see and do is different, so try a few:

| Role | Can do |
| --- | --- |
| Chairman, Deputy Chairman, Directors, Internal Auditor | Read-only: dashboard, alerts, payments, fraud, employees, audit |
| Super Administrator | Everything, including editing detection configuration |
| Security Administrator | Alerts, staff accounts and roles, audit, data explorer |
| SOC Analyst | Triage and resolve alerts, audit, data explorer |
| Fraud Analyst | Decide payments, block customers, view alerts |
| Payments Operations | Decide payments, view fraud |

The suspended contractor account shows how a blocked sign-in looks.

## Pages

Dashboard, Alerts, Payments, Employees, Admins, Fraud, Audit Logs. The Admins page also holds the roles and permissions matrix, detection rules, risk configuration and a **data explorer** (SQL and search queries).

## Sales demo features

Sign in as **Ms. Odette Marchand** (Super Administrator) for the full set. Click **Presenter** in the top bar, or use the keyboard.

| Feature | How |
| --- | --- |
| Guided tour | Presenter > Start guided tour, or press `G`. 14 steps with a talk track; arrow keys move, Esc exits. Steps a role cannot see are skipped. |
| Trigger an incident | Presenter > pick one of 9 scenarios (card testing, account takeover, data exfiltration and more). A live alert pops up within seconds. Needs the `demo:control` permission. |
| Live payment ticker | Bottom bar of recent payments, colored by outcome. Click one to open it. |
| New-alert pop-ups | Appear bottom right when the detection engine raises an alert. Click to investigate. |
| SOC wall | Presenter > SOC wall, or `W`. Full-screen display for a big screen. Esc exits. |
| Business Impact | Sidebar page with live numbers plus an ROI calculator. Use **Print or save as PDF** for a one-page summary. The sliders hold placeholder assumptions: replace them with the prospect's own figures. |
| Sound alert | A short three-tone beep plays when a critical alert arrives. Presenter > Sound on critical alerts turns it off, and the Test button plays it. Browsers only allow sound after you have clicked or pressed a key on the page once. |
| Dark mode | Presenter > Dark mode, or `T`. |
| Branding | Edit `public/brand.json` to change the product name, tagline, colors and logo file. Use your own product's branding with invented data. |

Restart the server (`node server.js`) to reset the demo data to its starting state.

## Backend

| File | Role |
| --- | --- |
| `backend/auth.js` | Password plus MFA sign-in, signed session tokens, lockout after 5 failures, permission checks |
| `backend/logic.js` | Business logic: payment decisions, alert workflow, blocking, role and config changes, all audit logged |
| `backend/risk.js` | Risk engine: scores each payment 0 to 100 and decides approve, review or decline |
| `backend/detection.js` | Detection engine: 10 rules (brute force, impossible travel, velocity, card testing, large payments, API abuse, port scan, exfiltration, off-hours admin changes, sensor signatures) |
| `backend/sqlstore.js` | In-memory relational tables with a read-only SQL subset |
| `backend/search.js` | Elastic-style inverted index with a query language and aggregations |
| `backend/db.js` | Tables for employees, roles, permissions, customers, merchants, config, alerts and the login, payment, network, API, security and audit event streams |
| `backend/simulator.js` | Adds live traffic and occasional attacks every 6 seconds |
| `backend/demo.js` | Fires the on-demand incident scenarios used by the Presenter menu |

Data is seeded fresh on every start and nothing is written to disk.

## Data explorer examples

SQL: `SELECT merchant_category, count(*) AS payments, sum(amount) AS volume FROM payment_events GROUP BY merchant_category ORDER BY volume DESC`

Search (pick an index): `success:false country:RU`, `risk_score:>=60`, `action:deny dst_port:>1000`, `status:429`, `-result:success`

This is a demonstration. It has no real authentication store, no HTTPS and no persistence, so do not expose it to a network you do not control.
