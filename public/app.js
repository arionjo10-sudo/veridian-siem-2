(function () {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const money2 = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ago = (ts) => {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };
  const label = (s) => String(s || '').replace(/_/g, ' ');
  const initials = (n) => String(n).replace(/^(Dr|Mr|Ms)\.\s+/, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const SEV_COLOR = { critical: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#0284c7' };

  const ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    card: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  };
  const icon = (n) => `<svg class="icon" viewBox="0 0 24 24">${ICONS[n]}</svg>`;

  const sevChip = (s) => `<span class="chip sev-${esc(s)}">${esc(s)}</span>`;
  const stChip = (s) => `<span class="chip st-${esc(s)}">${esc(label(s))}</span>`;
  const riskBar = (s) => {
    const c = s >= 75 ? 'var(--crit)' : s >= 45 ? 'var(--accent)' : 'var(--brand-2)';
    return `<span class="risk"><i><b style="width:${s}%;background:${c}"></b></i><span>${s}</span></span>`;
  };
  const kpi = (labelTxt, value, note, tone = '') =>
    `<div class="card kpi ${tone}"><div class="label">${esc(labelTxt)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note || '')}</div></div>`;

  const REASON = {
    AMOUNT_SPIKE: 'Amount spike', AMOUNT_HIGH: 'Elevated amount', LARGE_AMOUNT: 'Large amount', GEO_MISMATCH: 'Country mismatch',
    NEW_DEVICE: 'New device', HIGH_RISK_MERCHANT: 'High-risk merchant', MEDIUM_RISK_MERCHANT: 'Medium-risk merchant',
    VELOCITY: 'Velocity burst', HOURLY_VOLUME: 'High hourly volume', CARD_TESTING: 'Card testing', ODD_HOURS: 'Unusual hour',
    HIGH_RISK_CUSTOMER: 'High-risk customer', BLOCKED_CUSTOMER: 'Blocked customer',
  };

  // ------------------------------------------------------------------ state + api
  const state = {
    token: sessionStorage.getItem('vp_token'), me: null, page: 'dashboard', challenge: null, drawer: null,
    filters: {
      alerts: { severity: '', status: '', q: '', size: 50 },
      payments: { status: '', q: '', min_risk: '', size: 50 },
      audit: { q: '', action: '', size: 50 },
    },
  };

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token) {
      signOutLocal();
      throw new Error('Your session has ended. Please sign in again.');
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2600);
  }
  async function attempt(fn) {
    try {
      return await fn();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ------------------------------------------------------------------ charts
  let gid = 0;
  const niceMax = (v) => {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v * 1.05) return m * p;
    return 10 * p;
  };
  const compact = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : String(Math.round(v)));

  function area(vals, tss, color, fmt = compact, tipFmt = (v) => num(v), integer = false) {
    const W = 640, H = 200, pl = 44, pr = 12, pt = 12, pb = 26;
    const max = integer ? Math.max(4, Math.ceil(Math.max(...vals) / 4) * 4) : niceMax(Math.max(1, ...vals));
    const n = vals.length;
    const x = (i) => pl + (W - pl - pr) * (n < 2 ? 0 : i / (n - 1));
    const y = (v) => pt + (H - pt - pb) * (1 - v / max);
    const g = 'ag' + ++gid;
    let grid = '';
    for (let k = 0; k <= 4; k++) {
      const v = (max * k) / 4;
      grid += `<line class="gridline" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pl - 6}" y="${y(v) + 3}" text-anchor="end">${fmt(v)}</text>`;
    }
    let xl = '';
    tss.forEach((t, i) => {
      if (i % 4 === 0) xl += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${String(new Date(t).getHours()).padStart(2, '0')}:00</text>`;
    });
    const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const fill = `${line} L${x(n - 1).toFixed(1)} ${H - pb} L${x(0).toFixed(1)} ${H - pb} Z`;
    const dots = vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="7" fill="transparent"><title>${String(new Date(tss[i]).getHours()).padStart(2, '0')}:00 - ${tipFmt(v)}</title></circle>`).join('');
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img"><defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>${grid}${xl}<path d="${fill}" fill="url(#${g})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>${dots}</svg></div>`;
  }

  function donut(items, centerTop, centerBottom) {
    const total = items.reduce((s, i) => s + i.value, 0);
    const r = 54, c = 2 * Math.PI * r;
    let off = 0, segs = '';
    if (!total) segs = `<circle r="${r}" cx="75" cy="75" fill="none" stroke="#e6eeed" stroke-width="18"/>`;
    else {
      for (const it of items) {
        const len = (it.value / total) * c;
        if (len > 0) segs += `<circle r="${r}" cx="75" cy="75" fill="none" stroke="${it.color}" stroke-width="18" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 75 75)"/>`;
        off += len;
      }
    }
    const svg = `<svg viewBox="0 0 150 150" role="img">${segs}<text x="75" y="76" text-anchor="middle" font-size="26" font-weight="700" fill="#12302d">${esc(centerTop)}</text><text x="75" y="94" text-anchor="middle" font-size="10" fill="#5f7a76">${esc(centerBottom)}</text></svg>`;
    const legend = `<div class="legend">${items.map((i) => `<div><i style="background:${i.color}"></i>${esc(i.label)}<b>${i.value}</b></div>`).join('')}</div>`;
    return `<div class="donutwrap">${svg}${legend}</div>`;
  }

  function hbars(items, fmt = num) {
    const max = Math.max(1, ...items.map((i) => i.value));
    if (!items.length) return '<div class="empty">Nothing to show</div>';
    return items.map((i) => `<div class="hbar"><span>${esc(i.label)}</span><div class="track"><i style="width:${(i.value / max) * 100}%"></i></div><b>${fmt(i.value)}</b></div>`).join('');
  }

  // ------------------------------------------------------------------ drawer
  function showDrawer(html, ref) {
    $('#drawer').innerHTML = `<button class="x" data-do="close" aria-label="Close">&times;</button>${html}`;
    $('#drawer').hidden = false;
    $('#scrim').hidden = false;
    state.drawer = ref || { kind: 'x' };
  }
  function closeDrawer() {
    $('#drawer').hidden = true;
    $('#scrim').hidden = true;
    state.drawer = null;
  }

  // ------------------------------------------------------------------ sign-in
  async function showLogin() {
    stopRefresh();
    closeDrawer();
    $('#app').innerHTML = `
      <div class="login">
        <div class="login-brand">
          <div class="brand"><img src="logo.svg" alt=""><div><b style="font-size:20px">Veridian Pay</b><span>Security Operations</span></div></div>
          <div>
            <h2>One view of payments, fraud and security.</h2>
            <p>Sign in with your employee account to review alerts, investigate risky payments and audit activity across the platform.</p>
          </div>
          <div class="fine">Demonstration environment. Veridian Pay is a fictional company and all people, accounts and data shown are invented.</div>
        </div>
        <div class="login-panel">
          <div id="loginbox"></div>
          <div class="demo">
            <h3>Demo employees</h3>
            <div class="creds" id="creds"></div>
            <div class="accounts" id="accounts"><div class="footnote">Loading...</div></div>
          </div>
        </div>
      </div>`;
    renderCredsStep();
    attempt(async () => {
      const d = await api('/demo-accounts');
      $('#creds').innerHTML = `Password for every account: <code>${esc(d.password)}</code> &nbsp; Verification code: <code>${esc(d.mfa_code)}</code>`;
      $('#accounts').innerHTML = d.accounts.map((a) => `
        <button class="acct" data-do="demo:${esc(a.email)}:${esc(d.password)}" ${a.status !== 'active' ? 'title="This account is suspended"' : ''}>
          <span class="avatar">${esc(initials(a.name))}</span>
          <span><b>${esc(a.name)}</b><small>${esc(a.title)}</small></span>
          <span class="chip ${a.status === 'active' ? '' : 'st-suspended'}">${esc(a.status === 'active' ? a.role : 'suspended')}</span>
        </button>`).join('');
      state.demo = d;
    });
  }

  function renderCredsStep(prefill = {}) {
    $('#loginbox').innerHTML = `
      <h2 style="font-size:24px;margin-bottom:4px">Employee sign-in</h2>
      <div class="footnote" style="margin-bottom:16px">Use your Veridian Pay work account.</div>
      <form id="lf" autocomplete="off">
        <label>Work email<input id="em" type="email" required value="${esc(prefill.email || '')}" placeholder="name@veridianpay.example"></label>
        <label>Password<input id="pw" type="password" required value="${esc(prefill.password || '')}"></label>
        <div class="err" id="lerr"></div>
        <button class="btn" type="submit">Continue</button>
      </form>`;
    $('#lf').onsubmit = (e) => {
      e.preventDefault();
      submitCreds($('#em').value, $('#pw').value);
    };
  }

  async function submitCreds(email, password) {
    try {
      const r = await api('/login', { method: 'POST', body: { email, password } });
      state.challenge = r.challenge;
      renderMfaStep(email);
    } catch (e) {
      if (!$('#lerr')) renderCredsStep({ email, password });
      $('#lerr').textContent = e.message;
    }
  }

  function renderMfaStep(email) {
    $('#loginbox').innerHTML = `
      <h2 style="font-size:24px;margin-bottom:4px">Verify it's you</h2>
      <div class="footnote" style="margin-bottom:16px">Enter the 6-digit code for <b>${esc(email)}</b>.</div>
      <form id="mf" autocomplete="off">
        <label>Verification code<input id="code" type="text" inputmode="numeric" maxlength="6" required value="${esc((state.demo && state.demo.mfa_code) || '')}"></label>
        <div class="err" id="lerr"></div>
        <button class="btn" type="submit">Verify and sign in</button>
        <button class="btn alt" type="button" data-do="restart">Use a different account</button>
      </form>`;
    $('#mf').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('/login/mfa', { method: 'POST', body: { challenge: state.challenge, code: $('#code').value } });
        state.token = r.token;
        sessionStorage.setItem('vp_token', r.token);
        state.me = { employee: r.employee, permissions: r.permissions };
        enterApp();
      } catch (err) {
        $('#lerr').textContent = err.message;
      }
    };
    $('#code').focus();
  }

  function signOutLocal() {
    state.token = null;
    state.me = null;
    sessionStorage.removeItem('vp_token');
    showLogin();
  }

  // ------------------------------------------------------------------ shell + router
  const NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: 'grid', perm: 'dashboard:read', sub: 'Real-time overview of payments, fraud and security signals' },
    { id: 'alerts', label: 'Alerts', icon: 'bell', perm: 'alerts:read', sub: 'Detections raised by the rules engine' },
    { id: 'payments', label: 'Payments', icon: 'card', perm: 'payments:read', sub: 'Every payment with its risk decision' },
    { id: 'employees', label: 'Employees', icon: 'users', perm: 'employees:read', sub: 'Staff directory, roles and sign-in health' },
    { id: 'admins', label: 'Admins', icon: 'shield', perm: 'admins:manage', sub: 'Administrators, roles, detection settings and data explorer' },
    { id: 'fraud', label: 'Fraud', icon: 'warn', perm: 'fraud:read', sub: 'Review queue, risky customers and merchants' },
    { id: 'audit', label: 'Audit Logs', icon: 'file', perm: 'audit:read', sub: 'Who did what, when and from where' },
  ];
  const can = (p) => !!state.me && state.me.permissions.includes(p);
  let timer = null;
  const hooks = [];
  const stopRefresh = () => clearInterval(timer);

  function enterApp() {
    const e = state.me.employee;
    $('#app').innerHTML = `
      <div class="shell">
        <aside class="side">
          <div class="brand"><img src="logo.svg" alt=""><div><b>Veridian Pay</b><span>Security Operations</span></div></div>
          <nav class="nav" id="nav">${NAV.filter((n) => can(n.perm)).map((n) => `<a data-nav="${n.id}" href="#/${n.id}">${icon(n.icon)}<span>${n.label}</span>${n.id === 'alerts' ? '<span class="badge" id="alertbadge" hidden></span>' : ''}</a>`).join('')}</nav>
          <div class="me">
            <div class="avatar">${esc(initials(e.name))}</div>
            <div class="who"><b>${esc(e.name)}</b><span>${esc(e.role_name)}</span></div>
            <button data-do="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>
          </div>
        </aside>
        <div class="main">
          <header class="top">
            <div><h1 id="title"></h1><div class="sub" id="subtitle"></div></div>
            <div class="grow"></div>
            <div class="live"><span class="dot"></span><span id="livetxt">Live</span></div>
          </header>
          <div id="view"></div>
        </div>
      </div>`;
    route();
    stopRefresh();
    timer = setInterval(autoRefresh, 8000);
    hooks.forEach((fn) => fn());
  }

  function route() {
    if (!state.me) return;
    const allowed = NAV.filter((n) => can(n.perm));
    let id = (location.hash || '').replace(/^#\//, '') || 'dashboard';
    let item = allowed.find((n) => n.id === id);
    if (!item) {
      item = allowed[0];
      id = item.id;
      history.replaceState(null, '', '#/' + id);
    }
    state.page = id;
    closeDrawer();
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === id));
    $('#title').textContent = item.label;
    $('#subtitle').textContent = item.sub;
    $('#view').innerHTML = '<div class="empty">Loading...</div>';
    attempt(() => PAGES[id].load());
  }

  async function autoRefresh() {
    if (!state.me || document.hidden || state.drawer) return;
    const p = PAGES[state.page];
    if (!p || !p.refresh) return;
    const a = document.activeElement;
    if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && p.guardInputs) return;
    try {
      await p.refresh();
      $('#livetxt').textContent = 'Live - updated ' + new Date().toLocaleTimeString();
    } catch (e) {
      $('#livetxt').textContent = 'Reconnecting...';
    }
  }

  function setBadge(n) {
    const b = $('#alertbadge');
    if (!b) return;
    b.hidden = !n;
    b.textContent = n;
  }

  // ------------------------------------------------------------------ shared UI
  function pillRow(el, items, active, onPick) {
    el.innerHTML = items.map(([v, text, count]) => `<button class="pill ${String(active) === String(v) ? 'on' : ''}" data-v="${esc(v)}">${esc(text)}${count !== undefined ? `<small>${num(count)}</small>` : ''}</button>`).join('');
    $$('.pill', el).forEach((b) => (b.onclick = () => onPick(b.dataset.v)));
  }
  function bindSearch(sel, fn) {
    let t;
    $(sel).addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => fn(e.target.value.trim()), 300);
    });
  }
  const moreBtn = (shown, total, key) => (shown < total ? `<div style="text-align:center;padding:14px"><button class="btn alt" data-do="more:${key}">Show more (${num(total - shown)} remaining)</button></div>` : '');

  function evidenceLine(type, d) {
    const t = fmtTime(d.ts);
    switch (type) {
      case 'login_events': return `${esc(d.user)} ${d.success ? 'signed in' : 'failed'} from ${esc(d.ip)} (${esc(d.country)})${d.reason ? ' - ' + esc(label(d.reason)) : ''}<small>${t} - login ${esc(d.id)}</small>`;
      case 'payment_events': return `${money2(d.amount)} at ${esc(d.merchant_name)} - risk ${d.risk_score}<small>${t} - payment ${esc(d.id)} - ${esc(d.customer_name)}</small>`;
      case 'network_events': return `${esc(d.src_ip)} to ${esc(d.dst_ip)}:${d.dst_port} ${esc(d.action)} - ${(d.bytes_out / 1e6).toFixed(1)} MB<small>${t} - ${esc(d.sensor)} ${esc(d.id)}</small>`;
      case 'api_events': return `${esc(d.method)} ${esc(d.endpoint)} returned ${d.status} (${d.latency_ms} ms)<small>${t} - key ${esc(d.api_key)} from ${esc(d.ip)}</small>`;
      case 'audit_events': return `${esc(d.actor_name)} ran ${esc(d.action)} on ${esc(d.target)}<small>${t} - ${esc(d.detail)}</small>`;
      case 'security_events': return `${esc(d.sensor)}: ${esc(d.signature)} on ${esc(d.host)}<small>${t} - ${esc(d.detail)}</small>`;
      default: return esc(d.id);
    }
  }
  const notesHtml = (notes) => (notes && notes.length ? `<div><div class="section-title">Notes</div><div class="list">${notes.map((n) => `<div>${esc(n.text)}<small>${esc(n.by)} - ${fmtTime(n.ts)}</small></div>`).join('')}</div></div>` : '');

  // ------------------------------------------------------------------ pages
  const view = () => $('#view');

  // ---- Dashboard
  async function renderDashboard() {
    const d = await api('/dashboard');
    const k = d.kpis;
    setBadge(k.open_alerts);
    const sevItems = ['critical', 'high', 'medium', 'low'].map((s) => ({ label: s[0].toUpperCase() + s.slice(1), value: d.severity[s], color: SEV_COLOR[s] }));
    view().innerHTML = `
      <div class="grid g4">
        ${kpi('Open alerts', k.open_alerts, `${k.critical_open} critical, ${k.high_open} high`, k.critical_open ? 'crit' : 'warn')}
        ${kpi('Payments (24h)', num(k.payments_24h), `${money(k.volume_24h)} approved volume`)}
        ${kpi('Fraud prevented', money(k.fraud_prevented), `${k.review_queue} payments awaiting review`, 'good')}
        ${kpi('Failed logins (24h)', num(k.failed_logins_24h), 'staff and customers', k.failed_logins_24h > 50 ? 'warn' : '')}
        ${kpi('Average risk score', k.avg_risk, 'across payments, scale 0 to 100')}
      </div>
      <div class="grid g32">
        <div class="card"><h3>Approved payment volume</h3><div class="hint">Hourly, last 24 hours (USD)</div>
          ${area(d.payments_series.map((p) => p.volume), d.payments_series.map((p) => p.ts), '#0f766e', (v) => '$' + compact(v), (v) => money(v))}</div>
        <div class="card"><h3>Open alerts by severity</h3><div class="hint">Open, acknowledged and escalated</div>
          ${donut(sevItems, k.open_alerts, 'open alerts')}</div>
      </div>
      <div class="grid g32">
        <div class="card"><h3>Latest alerts</h3><div class="hint">Select an alert to investigate</div>
          ${d.recent_alerts.map((a) => `<div class="alert-row" data-open="alert:${esc(a.id)}">${sevChip(a.severity)}<div class="t"><b>${esc(a.title)}</b><span>${esc(a.rule_name)} - ${ago(a.ts)}</span></div>${stChip(a.status)}</div>`).join('') || '<div class="empty">No alerts</div>'}</div>
        <div class="card"><h3>Platform engines</h3><div class="hint">${d.system.eps} events per second ingested</div>
          <div class="engines">${d.system.engines.map((e) => `<div class="engine"><span class="dot"></span><b>${esc(e.name)}</b><span>${esc(e.detail)}</span></div>`).join('')}</div></div>
      </div>
      <div class="grid g2">
        <div class="card"><h3>Alerts raised per hour</h3><div class="hint">By event time, last 24 hours</div>
          ${area(d.alerts_series.map((p) => p.count), d.alerts_series.map((p) => p.ts), '#f5a524', (v) => String(Math.round(v)), (v) => String(v), true)}</div>
        <div class="card"><h3>Top detection rules</h3><div class="hint">Open alerts by rule</div>${hbars(d.top_rules.map((r) => ({ label: r.name, value: r.count })))}</div>
      </div>
      <div class="card"><h3>Payment sources by country</h3><div class="hint">Last 24 hours, by IP country</div>
        <div class="tablewrap"><table><thead><tr><th>Country</th><th class="num">Payments</th><th class="num">Volume</th><th class="num">Flagged</th></tr></thead><tbody>
        ${d.countries.map((c) => `<tr><td><b>${esc(c.country)}</b></td><td class="num">${num(c.count)}</td><td class="num">${money(c.volume)}</td><td class="num">${c.flagged}</td></tr>`).join('')}
        </tbody></table></div></div>`;
  }

  // ---- Alerts
  async function renderAlerts() {
    const f = state.filters.alerts;
    if (!$('#alerts-results')) {
      view().innerHTML = `
        <div class="card">
          <div class="toolbar"><input id="aq" class="search" type="text" placeholder="Search alerts, e.g. severity:critical or entity:198.51.100.23" value="${esc(f.q)}"></div>
          <div style="height:12px"></div><div class="tabs" id="a-sev"></div><div style="height:8px"></div><div class="tabs" id="a-st"></div>
        </div>
        <div class="card"><div id="alerts-results" class="tablewrap"></div></div>`;
      bindSearch('#aq', (v) => { f.q = v; f.size = 50; attempt(renderAlerts); });
    }
    const d = await api('/alerts?' + qs(f));
    const fc = d.facets;
    setBadge(fc.status.open + fc.status.acknowledged + fc.status.escalated);
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    pillRow($('#a-sev'), [['', 'All severities', sum(fc.severity)], ...Object.entries(fc.severity).map(([k, v]) => [k, k, v])], f.severity, (v) => { f.severity = v; f.size = 50; attempt(renderAlerts); });
    pillRow($('#a-st'), [['', 'All statuses', sum(fc.status)], ...Object.entries(fc.status).map(([k, v]) => [k, label(k), v])], f.status, (v) => { f.status = v; f.size = 50; attempt(renderAlerts); });
    $('#alerts-results').innerHTML = `<table><thead><tr><th>Severity</th><th>Alert</th><th>Entity</th><th>Status</th><th>Raised</th></tr></thead><tbody>
      ${d.rows.map((a) => `<tr class="click" data-open="alert:${esc(a.id)}"><td>${sevChip(a.severity)}</td><td><b>${esc(a.title)}</b><span class="sub">${esc(a.rule_name)} - ${esc(a.id)}</span></td><td class="mono">${esc(a.entity)}<span class="sub">${esc(label(a.entity_type))}</span></td><td>${stChip(a.status)}</td><td>${fmtTime(a.ts)}<span class="sub">${ago(a.ts)}</span></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No alerts match these filters</td></tr>'}
      </tbody></table>${moreBtn(d.rows.length, d.total, 'alerts')}<div class="footnote" style="padding:8px 4px">${num(d.total)} results in ${d.took_ms.toFixed(1)} ms</div>`;
  }

  async function openAlert(id) {
    const d = await api('/alerts/' + id);
    const a = d.alert;
    const writable = can('alerts:write');
    const acts = { open: ['acknowledge', 'escalate', 'resolve', 'false_positive'], acknowledged: ['escalate', 'resolve', 'false_positive'], escalated: ['resolve', 'false_positive'], resolved: ['reopen'], false_positive: ['reopen'] }[a.status] || [];
    showDrawer(`
      <div class="chips">${sevChip(a.severity)}${stChip(a.status)}<span class="chip">${esc(a.rule_id)}</span></div>
      <h2>${esc(a.title)}</h2>
      <div>${esc(a.description)}</div>
      <dl class="kv">
        <dt>Alert ID</dt><dd class="mono">${esc(a.id)}</dd>
        <dt>Event time</dt><dd>${fmtTime(a.ts)} (${ago(a.ts)})</dd>
        <dt>Rule</dt><dd>${esc(a.rule_name)}</dd>
        <dt>MITRE ATT&amp;CK</dt><dd>${esc(a.mitre)}</dd>
        <dt>Entity</dt><dd class="mono">${esc(a.entity)} <span class="footnote">(${esc(label(a.entity_type))})</span></dd>
        <dt>Risk score</dt><dd>${riskBar(a.risk)}</dd>
        <dt>Assignee</dt><dd>${esc(a.assignee || 'Unassigned')}</dd>
      </dl>
      <div><div class="section-title">Evidence (${d.evidence.length}${a.evidence_total > d.evidence.length ? ' of ' + a.evidence_total : ''})</div>
        <div class="list">${d.evidence.map((e) => `<div>${evidenceLine(e.type, e.doc)}</div>`).join('') || '<div>No evidence recorded</div>'}</div></div>
      ${notesHtml(a.notes)}
      ${writable && acts.length ? `<div><div class="section-title">Respond</div><textarea id="note" placeholder="Add a note (optional)"></textarea><div class="actions" style="margin-top:8px">${acts.map((x) => `<button class="btn ${x === 'resolve' ? '' : 'alt'}" data-do="alertd:${x}:${esc(a.id)}">${esc(label(x))}</button>`).join('')}</div></div>` : ''}
    `, { kind: 'alert', id });
  }

  // ---- Payments
  async function renderPayments() {
    const f = state.filters.payments;
    if (!$('#pay-results')) {
      view().innerHTML = `
        <div class="card">
          <div class="toolbar">
            <input id="pq" class="search" type="text" placeholder="Search payments, e.g. PixelPlay or country:NG or amount:>1000" value="${esc(f.q)}">
            <select id="pr"><option value="">Any risk</option><option value="45">Risk 45 and above</option><option value="75">Risk 75 and above</option></select>
            <div class="grow"></div><span class="footnote" id="pay-sum"></span>
          </div>
          <div style="height:12px"></div><div class="tabs" id="p-st"></div>
        </div>
        <div class="card"><div id="pay-results" class="tablewrap"></div></div>`;
      $('#pr').value = f.min_risk;
      $('#pr').onchange = (e) => { f.min_risk = e.target.value; f.size = 50; attempt(renderPayments); };
      bindSearch('#pq', (v) => { f.q = v; f.size = 50; attempt(renderPayments); });
    }
    const d = await api('/payments?' + qs(f));
    const sc = d.status_counts;
    const total = Object.values(sc).reduce((a, b) => a + b, 0);
    pillRow($('#p-st'), [['', 'All', total], ...['approved', 'settled', 'review', 'held', 'declined'].map((s) => [s, s, sc[s] || 0])], f.status, (v) => { f.status = v; f.size = 50; attempt(renderPayments); });
    $('#pay-sum').textContent = `${num(d.total)} payments, ${money(d.volume)} total`;
    $('#pay-results').innerHTML = `<table><thead><tr><th>Payment</th><th>Customer</th><th>Merchant</th><th class="num">Amount</th><th>Country</th><th>Risk</th><th>Status</th></tr></thead><tbody>
      ${d.rows.map((p) => `<tr class="click" data-open="payment:${esc(p.id)}"><td><b class="mono">${esc(p.id)}</b><span class="sub">${fmtTime(p.ts)}</span></td><td>${esc(p.customer_name)}<span class="sub">${esc(p.customer_id)}</span></td><td>${esc(p.merchant_name)}<span class="sub">${esc(label(p.merchant_category))}</span></td><td class="num">${money2(p.amount)}</td><td>${esc(p.country)}</td><td>${riskBar(p.risk_score)}</td><td>${stChip(p.status)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No payments match these filters</td></tr>'}
      </tbody></table>${moreBtn(d.rows.length, d.total, 'payments')}<div class="footnote" style="padding:8px 4px">Search took ${d.took_ms.toFixed(1)} ms</div>`;
  }

  async function openPayment(id) {
    const d = await api('/payments/' + id);
    const p = d.payment, c = d.customer, m = d.merchant;
    const acts = [];
    if (can('payments:action')) {
      if (['review', 'approved'].includes(p.status)) acts.push('hold');
      if (['review', 'held'].includes(p.status)) acts.push('approve');
      if (['review', 'held', 'approved'].includes(p.status)) acts.push('decline');
    }
    showDrawer(`
      <div class="chips">${stChip(p.status)}<span class="chip">decision: ${esc(p.decision)}</span></div>
      <h2>${money2(p.amount)} at ${esc(p.merchant_name)}</h2>
      <dl class="kv">
        <dt>Payment ID</dt><dd class="mono">${esc(p.id)}</dd>
        <dt>Time</dt><dd>${fmtTime(p.ts)}</dd>
        <dt>Method</dt><dd>${esc(label(p.method))}</dd>
        <dt>Source</dt><dd class="mono">${esc(p.ip)} (${esc(p.country)})</dd>
        <dt>New device</dt><dd>${p.device_new ? 'Yes' : 'No'}</dd>
        <dt>Merchant</dt><dd>${esc(m.name)} <span class="footnote">(${esc(label(m.category))}, ${esc(m.risk)} risk)</span></dd>
        <dt>Reviewed by</dt><dd>${esc(p.reviewed_by || 'Not reviewed')}</dd>
      </dl>
      <div><div class="section-title">Risk score</div>${riskBar(p.risk_score)}
        <div class="list" style="margin-top:8px">${p.risk_reasons.map((r) => `<div>${esc(r)}</div>`).join('') || '<div>No risk signals</div>'}</div></div>
      <div><div class="section-title">Customer</div>
        <div class="list"><div><b>${esc(c.name)}</b> <span class="mono">${esc(c.id)}</span> ${stChip(c.status)}
          <small>Home ${esc(c.country)} - tier ${esc(c.risk_tier)} - KYC ${esc(c.kyc_level)} - average ticket ${money2(c.avg_ticket)}</small></div></div>
        ${can('fraud:write') ? `<div class="actions" style="margin-top:8px">${c.status === 'blocked' ? `<button class="btn alt sm" data-do="block:${esc(c.id)}:0:${esc(p.id)}">Unblock customer</button>` : `<button class="btn warn sm" data-do="block:${esc(c.id)}:1:${esc(p.id)}">Block customer</button>`}</div>` : ''}</div>
      ${d.related_alerts.length ? `<div><div class="section-title">Related alerts</div><div class="list">${d.related_alerts.map((a) => `<div ${can('alerts:read') ? `data-open="alert:${esc(a.id)}" style="cursor:pointer"` : ''}>${sevChip(a.severity)} ${esc(a.title)} ${stChip(a.status)}</div>`).join('')}</div></div>` : ''}
      <div><div class="section-title">Recent payments by this customer</div><div class="list">${d.history.map((h) => `<div>${money2(h.amount)} at ${esc(h.merchant_name)}<small>${fmtTime(h.ts)} - risk ${h.risk_score} - ${esc(h.status)}</small></div>`).join('') || '<div>No other payments</div>'}</div></div>
      ${notesHtml(p.notes)}
      ${acts.length ? `<div><div class="section-title">Decision</div><textarea id="note" placeholder="Add a note (optional)"></textarea><div class="actions" style="margin-top:8px">${acts.map((x) => `<button class="btn ${x === 'decline' ? 'warn' : x === 'approve' ? '' : 'alt'}" data-do="payd:${x}:${esc(p.id)}">${esc(label(x))}</button>`).join('')}</div></div>` : ''}
    `, { kind: 'payment', id });
  }

  // ---- Employees
  async function renderEmployees() {
    const d = await api('/employees');
    const k = d.kpis;
    view().innerHTML = `
      <div class="grid g4">${kpi('Employees', k.total, 'in the directory')}${kpi('Active', k.active, 'can sign in', 'good')}${kpi('Suspended', k.suspended, 'blocked from signing in', k.suspended ? 'warn' : '')}${kpi('MFA enrolled', `${k.mfa}/${k.total}`, 'verification required at sign-in')}</div>
      <div class="card"><div class="tablewrap"><table><thead><tr><th>Employee</th><th>Role</th><th>Department</th><th>Last sign-in</th><th class="num">Failed (24h)</th><th>Status</th></tr></thead><tbody>
      ${d.rows.map((e) => `<tr class="click" data-open="employee:${esc(e.id)}"><td><div style="display:flex;align-items:center;gap:10px"><span class="avatar" style="width:32px;height:32px;font-size:12px">${esc(initials(e.name))}</span><div><b>${esc(e.name)}</b><span class="sub">${esc(e.title)}</span></div></div></td><td>${esc(e.role_name)}</td><td>${esc(e.department)}</td><td>${e.last_login ? fmtTime(e.last_login) + `<span class="sub">${ago(e.last_login)}</span>` : '<span class="footnote">Never</span>'}</td><td class="num">${e.failed_24h}</td><td>${stChip(e.status)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  }

  async function openEmployee(id) {
    const d = await api('/employees/' + id);
    const e = d.employee;
    const self = e.id === state.me.employee.id;
    let roles = [];
    if (can('admins:manage')) roles = (await api('/employees')).roles;
    showDrawer(`
      <div class="chips">${stChip(e.status)}<span class="chip">${esc(e.role_name)}</span></div>
      <h2>${esc(e.name)}</h2>
      <dl class="kv">
        <dt>Title</dt><dd>${esc(e.title)}</dd><dt>Department</dt><dd>${esc(e.department)}</dd>
        <dt>Email</dt><dd class="mono">${esc(e.email)}</dd><dt>Employee ID</dt><dd class="mono">${esc(e.id)}</dd>
        <dt>MFA</dt><dd>${e.mfa_enabled ? 'Enrolled' : 'Not enrolled'}</dd>
        <dt>Last sign-in</dt><dd>${e.last_login ? fmtTime(e.last_login) : 'Never'}</dd>
      </dl>
      <div><div class="section-title">Permissions from role</div><div class="chips">${d.permissions.map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</div></div>
      <div><div class="section-title">Recent sign-ins</div><div class="list">${d.logins.map((l) => `<div>${l.success ? 'Signed in' : 'Failed'} from <span class="mono">${esc(l.ip)}</span> (${esc(l.country)})${l.reason ? ' - ' + esc(label(l.reason)) : ''}<small>${fmtTime(l.ts)}</small></div>`).join('') || '<div>None recorded</div>'}</div></div>
      <div><div class="section-title">Recent activity</div><div class="list">${d.activity.map((a) => `<div>${esc(a.action)} ${esc(a.target)}<small>${fmtTime(a.ts)}${a.detail ? ' - ' + esc(a.detail) : ''}</small></div>`).join('') || '<div>None recorded</div>'}</div></div>
      ${can('employees:write') && !self ? `<div class="actions">${e.status === 'active' ? `<button class="btn warn" data-do="emp:suspended:${esc(e.id)}">Suspend account</button>` : `<button class="btn" data-do="emp:active:${esc(e.id)}">Reactivate account</button>`}</div>` : ''}
      ${roles.length && !self ? `<div><div class="section-title">Change role</div><div class="actions"><select id="rolesel">${roles.map((r) => `<option value="${esc(r.id)}" ${r.id === e.role_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select><button class="btn alt" data-do="role:${esc(e.id)}">Save role</button></div></div>` : ''}
    `, { kind: 'employee', id });
  }

  // ---- Admins
  const SQL_EXAMPLES = [
    ['sql', '', "SELECT merchant_category, count(*) AS payments, sum(amount) AS volume FROM payment_events GROUP BY merchant_category ORDER BY volume DESC LIMIT 10"],
    ['sql', '', "SELECT name, role_id, status FROM employees WHERE status = 'active' ORDER BY name"],
    ['sql', '', "SELECT id, severity, title FROM alerts WHERE severity = 'critical'"],
    ['search', 'login_events', 'success:false country:RU'],
    ['search', 'payment_events', 'risk_score:>=60'],
    ['search', 'network_events', 'action:deny dst_port:>1000'],
    ['search', 'api_events', 'status:429'],
  ];
  async function renderAdmins() {
    const d = await api('/admins');
    const perms = d.permissions;
    const canCfg = can('config:write');
    view().innerHTML = `
      <div class="grid g2">
        <div class="card"><h3>Administrator accounts</h3><div class="hint">Accounts with elevated access</div>
          <div class="tablewrap"><table><tbody>${d.admins.map((e) => `<tr class="click" data-open="employee:${esc(e.id)}"><td><b>${esc(e.name)}</b><span class="sub">${esc(e.title)}</span></td><td>${esc(e.role_name)}</td><td>${stChip(e.status)}</td></tr>`).join('')}</tbody></table></div></div>
        <div class="card"><h3>Data stores</h3><div class="hint">SQL-style tables and the search index</div>
          <div class="tablewrap" style="max-height:230px;overflow-y:auto"><table><thead><tr><th>Table</th><th class="num">Rows</th><th>Search docs</th></tr></thead><tbody>
          ${d.tables.map((t) => `<tr><td class="mono">${esc(t.name)}</td><td class="num">${num(t.rows)}</td><td class="num">${d.search.indices[t.name] ? num(d.search.indices[t.name]) : '-'}</td></tr>`).join('')}
          </tbody></table></div><div class="footnote" style="margin-top:6px">${num(d.search.terms)} indexed terms</div></div>
      </div>
      <div class="card"><h3>Roles and permissions</h3><div class="hint">What each role is allowed to do</div>
        <div class="tablewrap"><table class="matrix"><thead><tr><th>Role</th><th>Members</th>${perms.map((p) => `<th class="rot" title="${esc(p.description)}">${esc(p.id)}</th>`).join('')}</tr></thead><tbody>
        ${d.roles.map((r) => `<tr><td><b>${esc(r.name)}</b><span class="sub">${esc(r.description)}</span></td><td>${r.members}</td>${perms.map((p) => `<td>${r.permissions.includes(p.id) ? '<span class="yes">&#10003;</span>' : '<span class="no">-</span>'}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div></div>
      <div class="card"><h3>Detection rules</h3><div class="hint">Rules evaluated by the detection engine on every cycle</div>
        <div class="tablewrap"><table><thead><tr><th>Rule</th><th>Severity</th><th>MITRE ATT&amp;CK</th><th class="num">Alerts</th></tr></thead><tbody>
        ${d.rules.map((r) => `<tr><td><b>${esc(r.name)}</b><span class="sub">${esc(r.id)} - ${esc(r.description)}</span></td><td>${sevChip(r.severity)}</td><td>${esc(r.mitre)}</td><td class="num">${r.alerts}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="card"><h3>Risk and detection configuration</h3><div class="hint">${canCfg ? 'Changes apply to the next payment scored and the next detection cycle, and are written to the audit log.' : 'Read only. Changing these values needs the config:write permission.'}</div>
        <div class="cfg">${d.config.map((c) => `<label><b>${esc(c.key)}</b>${esc(c.description)}<span class="row"><input id="cfg-${esc(c.key)}" type="number" min="0" value="${esc(c.value)}" ${canCfg ? '' : 'disabled'}>${canCfg ? `<button class="btn alt sm" data-do="cfg:${esc(c.key)}">Save</button>` : ''}</span><span class="footnote">Last changed by ${esc(c.updated_by)}, ${fmtTime(c.updated_at)}</span></label>`).join('')}</div></div>
      <div class="card console"><h3>Data explorer</h3><div class="hint">Run read-only SQL against the tables, or search the event indices. Every query is audit logged.</div>
        <div class="toolbar"><select id="qmode"><option value="sql">SQL</option><option value="search">Search</option></select>
          <select id="qindex" hidden>${Object.keys(d.search.indices).map((i) => `<option>${esc(i)}</option>`).join('')}</select>
          <div class="grow"></div><button class="btn" data-do="query">Run query</button></div>
        <div style="height:8px"></div><textarea id="qtext" spellcheck="false">${esc(SQL_EXAMPLES[0][2])}</textarea>
        <div class="examples">${SQL_EXAMPLES.map((x, i) => `<button data-do="ex:${i}">${esc(x[2].length > 52 ? x[2].slice(0, 52) + '...' : x[2])}</button>`).join('')}</div>
        <div id="qout"></div></div>`;
    $('#qmode').onchange = (e) => ($('#qindex').hidden = e.target.value !== 'search');
  }

  function renderQueryResult(r) {
    if (!r.rows.length) return `<div class="empty">No rows. ${r.took_ms} ms</div>`;
    const cell = (c, v) => {
      if (v !== null && typeof v === 'object') return `<span class="mono">${esc(JSON.stringify(v).slice(0, 80))}</span>`;
      if ((c === 'ts' || /_at$/.test(c) || c === 'created' || c === 'last_login') && typeof v === 'number' && v > 1e12) return esc(fmtTime(v));
      return esc(v);
    };
    return `<div class="footnote" style="margin:8px 0">${num(r.total)} rows${r.total > r.rows.length ? ` (showing ${r.rows.length})` : ''} in ${r.took_ms} ms</div>
      <div class="tablewrap" style="max-height:380px;overflow:auto"><table><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${r.rows.map((row) => `<tr>${r.columns.map((c) => `<td>${cell(c, row[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  // ---- Fraud
  async function renderFraud() {
    const d = await api('/fraud');
    const k = d.kpis;
    const canAct = can('payments:action');
    const maxBucket = Math.max(1, ...d.distribution.map((b) => b.count));
    view().innerHTML = `
      <div class="grid g4">
        ${kpi('Flagged payments (24h)', k.flagged, 'risk score 45 or higher')}
        ${kpi('Declined (24h)', k.declined, 'by the risk engine or an analyst', k.declined ? 'warn' : '')}
        ${kpi('Awaiting review', k.in_review, 'review and held payments', k.in_review ? 'warn' : 'good')}
        ${kpi('Amount stopped', money(k.amount_stopped), 'declined, held or in review', 'good')}
        ${kpi('Blocked customers', k.blocked_customers, 'cannot transact')}
      </div>
      <div class="card"><h3>Review queue</h3><div class="hint">Highest risk first</div>
        <div class="tablewrap"><table><thead><tr><th>Payment</th><th>Customer</th><th>Merchant</th><th class="num">Amount</th><th>Risk</th><th>Top signal</th><th>Status</th>${canAct ? '<th></th>' : ''}</tr></thead><tbody>
        ${d.queue.map((p) => `<tr class="click" data-open="payment:${esc(p.id)}"><td><b class="mono">${esc(p.id)}</b><span class="sub">${ago(p.ts)}</span></td><td>${esc(p.customer_name)}</td><td>${esc(p.merchant_name)}</td><td class="num">${money2(p.amount)}</td><td>${riskBar(p.risk_score)}</td><td>${esc(REASON[p.risk_codes[0]] || '-')}</td><td>${stChip(p.status)}</td>${canAct ? `<td style="white-space:nowrap"><button class="btn sm" data-do="pay:approve:${esc(p.id)}">Approve</button> <button class="btn warn sm" data-do="pay:decline:${esc(p.id)}">Decline</button></td>` : ''}</tr>`).join('') || `<tr><td colspan="8" class="empty">The review queue is empty</td></tr>`}
        </tbody></table></div></div>
      <div class="grid g2">
        <div class="card"><h3>Risk score distribution</h3><div class="hint">Payments in the last 24 hours</div>
          <div class="hist">${d.distribution.map((b, i) => `<div title="${b.count} payments"><span>${b.count}</span><i style="height:${Math.max(2, (b.count / maxBucket) * 90)}px;background:${i >= 7 ? 'var(--crit)' : i >= 5 ? 'var(--accent)' : 'var(--brand-2)'}"></i>${b.label.split('-')[0]}</div>`).join('')}</div></div>
        <div class="card"><h3>What is driving risk</h3><div class="hint">Signals on flagged payments</div>${hbars(d.reasons.map((r) => ({ label: REASON[r.code] || r.code, value: r.count })))}</div>
      </div>
      <div class="grid g2">
        <div class="card"><h3>Highest-risk customers</h3><div class="hint">By peak score on flagged payments</div>
          <div class="tablewrap"><table><thead><tr><th>Customer</th><th class="num">Flagged</th><th class="num">Peak</th><th>Status</th>${can('fraud:write') ? '<th></th>' : ''}</tr></thead><tbody>
          ${d.customers.map((c) => `<tr><td><b>${esc(c.name)}</b><span class="sub">${esc(c.id)} - ${esc(c.country)} - ${money(c.amount)}</span></td><td class="num">${c.flagged}</td><td class="num">${c.max_risk}</td><td>${stChip(c.status)}</td>${can('fraud:write') ? `<td>${c.status === 'blocked' ? `<button class="btn alt sm" data-do="block:${esc(c.id)}:0">Unblock</button>` : `<button class="btn warn sm" data-do="block:${esc(c.id)}:1">Block</button>`}</td>` : ''}</tr>`).join('') || '<tr><td colspan="5" class="empty">No flagged customers</td></tr>'}
          </tbody></table></div></div>
        <div class="card"><h3>Merchant risk</h3><div class="hint">Merchants with at least 5 payments</div>
          <div class="tablewrap"><table><thead><tr><th>Merchant</th><th class="num">Payments</th><th class="num">Declined</th><th>Avg risk</th></tr></thead><tbody>
          ${d.merchants.map((m) => `<tr><td><b>${esc(m.name)}</b><span class="sub">${esc(label(m.category))}</span></td><td class="num">${m.count}</td><td class="num">${m.decline_rate}%</td><td>${riskBar(m.avg_risk)}</td></tr>`).join('')}
          </tbody></table></div></div>
      </div>`;
  }

  // ---- Audit
  async function renderAudit() {
    const f = state.filters.audit;
    if (!$('#audit-results')) {
      view().innerHTML = `
        <div class="card">
          <div class="toolbar"><input id="uq" class="search" type="text" placeholder="Search the audit trail, e.g. role.update or actor_name:odette or result:denied" value="${esc(f.q)}"><div class="grow"></div><button class="btn alt" data-do="export">Export CSV</button></div>
          <div style="height:12px"></div><div class="tabs" id="u-act"></div>
        </div>
        <div class="card"><div id="audit-results" class="tablewrap"></div></div>`;
      bindSearch('#uq', (v) => { f.q = v; f.size = 50; attempt(renderAudit); });
    }
    const d = await api('/audit?' + qs(f));
    pillRow($('#u-act'), [['', 'All actions'], ...d.facets.actions.map((b) => [b.key, b.key, b.doc_count])], f.action, (v) => { f.action = v; f.size = 50; attempt(renderAudit); });
    $('#audit-results').innerHTML = `<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th><th>Source</th><th>Result</th></tr></thead><tbody>
      ${d.rows.map((a) => `<tr><td style="white-space:nowrap">${fmtTime(a.ts)}<span class="sub">${ago(a.ts)}</span></td><td><b>${esc(a.actor_name)}</b><span class="sub">${esc(a.actor_role)}</span></td><td><span class="chip">${esc(a.action)}</span></td><td class="mono">${esc(a.target)}</td><td>${esc(a.detail)}</td><td class="mono">${esc(a.ip)}</td><td>${stChip(a.result)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No audit events match</td></tr>'}
      </tbody></table>${moreBtn(d.rows.length, d.total, 'audit')}<div class="footnote" style="padding:8px 4px">${num(d.total)} events in ${d.took_ms.toFixed(1)} ms</div>`;
  }

  const PAGES = {
    dashboard: { load: renderDashboard, refresh: renderDashboard },
    alerts: { load: renderAlerts, refresh: renderAlerts },
    payments: { load: renderPayments, refresh: renderPayments },
    employees: { load: renderEmployees, refresh: renderEmployees },
    admins: { load: renderAdmins },
    fraud: { load: renderFraud, refresh: renderFraud },
    audit: { load: renderAudit, refresh: renderAudit },
  };
  const OPEN = { alert: openAlert, payment: openPayment, employee: openEmployee };
  const RELOAD = { alert: openAlert, payment: openPayment, employee: openEmployee };

  async function afterChange() {
    const ref = state.drawer;
    const p = PAGES[state.page];
    if (p) await (p.refresh || p.load)();
    if (ref && RELOAD[ref.kind]) await RELOAD[ref.kind](ref.id);
  }

  // ------------------------------------------------------------------ actions
  const DO = {
    close: () => closeDrawer(),
    logout: async () => {
      await api('/logout', { method: 'POST' }).catch(() => {});
      signOutLocal();
    },
    restart: () => renderCredsStep(),
    demo: (email, password) => {
      renderCredsStep({ email, password });
      return submitCreds(email, password);
    },
    more: (key) => {
      state.filters[key].size += 50;
      return PAGES[key].load();
    },
    alertd: async (action, id) => {
      await api(`/alerts/${id}/action`, { method: 'POST', body: { action, note: ($('#note') || {}).value } });
      toast('Alert updated');
      await afterChange();
    },
    payd: async (action, id) => {
      await api(`/payments/${id}/action`, { method: 'POST', body: { action, note: ($('#note') || {}).value } });
      toast('Payment ' + (action === 'hold' ? 'held' : action === 'approve' ? 'approved' : 'declined'));
      await afterChange();
    },
    pay: async (action, id) => {
      await api(`/payments/${id}/action`, { method: 'POST', body: { action } });
      toast('Payment ' + (action === 'approve' ? 'approved' : 'declined'));
      await afterChange();
    },
    block: async (id, flag) => {
      await api(`/customers/${id}/block`, { method: 'POST', body: { block: flag === '1' } });
      toast(flag === '1' ? 'Customer blocked' : 'Customer unblocked');
      await afterChange();
    },
    emp: async (status, id) => {
      await api(`/employees/${id}/status`, { method: 'POST', body: { status } });
      toast(status === 'active' ? 'Account reactivated' : 'Account suspended');
      await afterChange();
    },
    role: async (id) => {
      await api(`/employees/${id}/role`, { method: 'POST', body: { role_id: $('#rolesel').value } });
      toast('Role updated');
      await afterChange();
    },
    cfg: async (key) => {
      await api('/admins/config', { method: 'POST', body: { key, value: $('#cfg-' + key).value } });
      toast(`${key} saved`);
    },
    ex: (i) => {
      const [mode, index, text] = SQL_EXAMPLES[Number(i)];
      $('#qmode').value = mode;
      $('#qindex').hidden = mode !== 'search';
      if (index) $('#qindex').value = index;
      $('#qtext').value = text;
    },
    query: async () => {
      const mode = $('#qmode').value;
      $('#qout').innerHTML = '<div class="empty">Running...</div>';
      try {
        const r = await api('/query', { method: 'POST', body: { mode, index: mode === 'search' ? $('#qindex').value : '', query: $('#qtext').value } });
        $('#qout').innerHTML = renderQueryResult(r);
      } catch (e) {
        $('#qout').innerHTML = `<div class="err" style="padding:10px 0">${esc(e.message)}</div>`;
      }
    },
    export: async () => {
      const res = await fetch('/api/audit/export?' + qs({ q: state.filters.audit.q, action: state.filters.audit.action }), { headers: { Authorization: 'Bearer ' + state.token } });
      if (!res.ok) throw new Error('Export failed');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audit-log.csv';
      a.click();
      URL.revokeObjectURL(url);
      toast('Audit log exported');
    },
  };

  document.addEventListener('click', (e) => {
    const d = e.target.closest('[data-do]');
    if (d) {
      e.stopPropagation();
      const [name, ...args] = d.dataset.do.split(':');
      if (DO[name]) attempt(() => DO[name](...args));
      return;
    }
    const o = e.target.closest('[data-open]');
    if (o) {
      const [kind, id] = o.dataset.open.split(':');
      if (OPEN[kind]) attempt(() => OPEN[kind](id));
    }
  });
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------------ extension point (used by demo.js)
  window.VP = {
    api, state, toast, attempt, can, NAV, PAGES, DO, ICONS, icon, esc, money, money2, num, fmtTime, ago, label, initials,
    kpi, riskBar, sevChip, stChip, area, donut, hbars, compact, SEV_COLOR, route,
    onEnter: (fn) => hooks.push(fn),
  };

  // ------------------------------------------------------------------ boot
  (async function boot() {
    if (state.token) {
      try {
        state.me = await api('/me');
        enterApp();
        return;
      } catch (e) {
        /* fall through to sign-in */
      }
    }
    state.token = null;
    sessionStorage.removeItem('vp_token');
    showLogin();
  })();
})();
