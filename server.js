'use strict';
// Veridian Pay SIEM demo server: static frontend + JSON API. Zero dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const U = require('./backend/util');
const { db } = require('./backend/db');
const { seed } = require('./backend/seed');
const auth = require('./backend/auth');
const L = require('./backend/logic');
const reports = require('./backend/reports');
const simulator = require('./backend/simulator');
const demo = require('./backend/demo');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const routes = [];
// perm: null = public, '*' = any signed-in employee, otherwise a permission id
const route = (method, pattern, perm, fn) =>
  routes.push({ method, perm, fn, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

route('POST', '/api/login', null, ({ body, ip }) => auth.login(body.email, body.password, ip));
route('POST', '/api/login/mfa', null, ({ body, ip }) => auth.mfa(body.challenge, body.code, ip));
route('POST', '/api/logout', '*', ({ user, ip }) => auth.logout(user, ip));
route('GET', '/api/me', '*', ({ user }) => auth.profile(user));
route('GET', '/api/demo-accounts', null, () => auth.demoAccounts());
route('GET', '/api/health', null, () => ({ status: 'ok', time: Date.now() }));

route('GET', '/api/dashboard', 'dashboard:read', () => reports.dashboard());
route('GET', '/api/live', 'dashboard:read', ({ query }) => reports.live(query.since));
route('GET', '/api/impact', 'dashboard:read', () => reports.impact());
route('GET', '/api/demo/scenarios', 'demo:control', () => demo.list());
route('POST', '/api/demo/trigger', 'demo:control', ({ body, user, ip }) => demo.trigger(body.scenario, user.employee, ip));

route('GET', '/api/alerts', 'alerts:read', ({ query }) => reports.alerts(query));
route('GET', '/api/alerts/:id', 'alerts:read', ({ params }) => reports.alertDetail(params.id));
route('POST', '/api/alerts/:id/action', 'alerts:write', ({ params, body, user }) => L.alertAction(params.id, body.action, user.employee, body.note));

route('GET', '/api/payments', 'payments:read', ({ query }) => reports.payments(query));
route('GET', '/api/payments/:id', 'payments:read', ({ params }) => reports.paymentDetail(params.id));
route('POST', '/api/payments/:id/action', 'payments:action', ({ params, body, user }) => L.paymentAction(params.id, body.action, user.employee, body.note));

route('GET', '/api/fraud', 'fraud:read', () => reports.fraud());
route('POST', '/api/customers/:id/block', 'fraud:write', ({ params, body, user }) => L.blockCustomer(params.id, body.block !== false, user.employee, body.reason));

route('GET', '/api/employees', 'employees:read', () => reports.employees());
route('GET', '/api/employees/:id', 'employees:read', ({ params }) => reports.employeeDetail(params.id));
route('POST', '/api/employees/:id/status', 'employees:write', ({ params, body, user }) => L.setEmployeeStatus(params.id, body.status, user.employee));
route('POST', '/api/employees/:id/role', 'admins:manage', ({ params, body, user }) => L.setEmployeeRole(params.id, body.role_id, user.employee));

route('GET', '/api/admins', 'admins:manage', () => reports.admins());
route('POST', '/api/admins/config', 'config:write', ({ body, user }) => L.updateConfig(body.key, body.value, user.employee));
route('POST', '/api/query', 'query:run', ({ body, user, ip }) => {
  const out = reports.runQuery(body || {});
  L.audit(user.employee, 'query.run', body.mode, String(body.query || '').slice(0, 200), { ip });
  return out;
});

route('GET', '/api/audit', 'audit:read', ({ query }) => reports.audit(query));
route('GET', '/api/audit/export', 'audit:read', ({ query, user, ip }) => {
  L.audit(user.employee, 'report.export', 'audit_events', 'Audit log CSV export', { ip });
  return { __raw: { type: 'text/csv; charset=utf-8', body: reports.auditCsv(query), name: 'audit-log.csv' } };
});

function clientIp(req) {
  const a = req.socket.remoteAddress || '127.0.0.1';
  return a === '::1' ? '127.0.0.1' : a.replace(/^::ffff:/, '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new U.HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new U.HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

async function handleApi(req, res, url) {
  const route_ = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route_) return sendJson(res, 404, { error: 'Not found' });
  const params = route_.re.exec(url.pathname).groups || {};
  const ctx = { params, query: Object.fromEntries(url.searchParams), ip: clientIp(req), body: {}, user: null };
  if (route_.perm) {
    const user = auth.authenticate(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in' });
    if (route_.perm !== '*' && !user.perms.has(route_.perm)) {
      L.audit(user.employee, 'access.denied', url.pathname, `Missing permission ${route_.perm}`, { ip: ctx.ip, result: 'denied' });
      return sendJson(res, 403, { error: `Your role does not have the "${route_.perm}" permission` });
    }
    ctx.user = user;
  }
  if (req.method === 'POST') ctx.body = await readBody(req);
  const out = await route_.fn(ctx);
  if (out && out.__raw) {
    return send(res, 200, out.__raw.body, { 'Content-Type': out.__raw.type, 'Content-Disposition': `attachment; filename="${out.__raw.name}"` });
  }
  return sendJson(res, 200, out);
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET') serveStatic(req, res, url);
    else send(res, 405, 'Method not allowed');
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error' : err.message });
  }
});

const created = seed();
simulator.start(6000);
server.listen(PORT, () => {
  console.log(`Veridian Pay SIEM running on http://localhost:${PORT}`);
  console.log(`Seeded ${db.employees.rows.length} employees, ${db.payment_events.rows.length} payments, ${created} alerts.`);
  console.log(`Demo password: ${auth.DEMO_PASSWORD}   MFA code: ${auth.DEMO_MFA_CODE}`);
});
