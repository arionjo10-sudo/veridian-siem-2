/* Presenter layer for sales demos. Loaded after app.js and uses only the small window.VP API.
   Adds: guided tour, presenter panel, incident triggers, live payment ticker, alert pop-ups,
   SOC wall, business-impact / ROI page, dark mode and brand config.
   Shortcuts: P presenter panel, G guided tour, W SOC wall, T theme. */
(function () {
  'use strict';
  const VP = window.VP;
  if (!VP) return;
  const { esc, money, num, can, api } = VP;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const prefs = { theme: store.get('vp_theme', 'light'), ticker: store.get('vp_ticker', true), popups: store.get('vp_popups', true), sound: store.get('vp_sound', true) };
  const DEFAULT_BRAND = 'Veridian Pay';

  // ------------------------------------------------------------------ brand + theme
  let brand = null;
  function applyTheme() {
    document.documentElement.dataset.theme = prefs.theme;
  }
  applyTheme();

  function applyBrandColors() {
    if (!brand) return;
    const r = document.documentElement.style;
    const c = brand.colors || {};
    const map = { brand: '--brand', brand2: '--brand-2', accent: '--accent', side: '--side', side2: '--side-2' };
    for (const [k, v] of Object.entries(map)) if (c[k]) r.setProperty(v, c[k]);
    if (brand.name) document.title = `${brand.name} - ${brand.tagline || 'Security Operations'}`;
  }

  let rebranding = false;
  function rebrand() {
    if (!brand || rebranding) return;
    const name = brand.name || DEFAULT_BRAND;
    const tag = brand.tagline || 'Security Operations';
    const logo = brand.logo || 'logo.svg';
    if (name === DEFAULT_BRAND && tag === 'Security Operations' && logo === 'logo.svg') return;
    rebranding = true;
    observer.disconnect();
    const root = $('#app');
    if (root) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (n.nodeValue.includes(DEFAULT_BRAND)) n.nodeValue = n.nodeValue.split(DEFAULT_BRAND).join(name);
        if (n.nodeValue.trim() === 'Security Operations') n.nodeValue = tag;
      }
      $$('img[src="logo.svg"]', root).forEach((i) => i.setAttribute('src', logo));
    }
    observer.observe(document.body, { childList: true, subtree: true });
    rebranding = false;
  }
  let rebrandTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(rebrandTimer);
    rebrandTimer = setTimeout(rebrand, 30);
  });
  fetch('brand.json').then((r) => r.json()).then((b) => {
    brand = b;
    applyBrandColors();
    observer.observe(document.body, { childList: true, subtree: true });
    rebrand();
  }).catch(() => { /* brand.json is optional */ });

  // ------------------------------------------------------------------ sound (Web Audio, no files needed)
  let actx = null;
  function audio() {
    if (!actx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { actx = new C(); } catch (e) { return null; }
    }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }
  function tone(freq, start, dur, vol) {
    const c = audio();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    const t = c.currentTime + start;
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  // Three quick descending-ascending tones, about half a second.
  function criticalBeep() {
    tone(880, 0, 0.13);
    tone(660, 0.16, 0.13);
    tone(880, 0.32, 0.22);
  }
  // Browsers only allow sound after a click or key press, so warm the audio context on the first one.
  document.addEventListener('pointerdown', () => { if (prefs.sound) audio(); });
  document.addEventListener('keydown', () => { if (prefs.sound) audio(); });
  VP.audioState = () => (actx ? actx.state : 'none');

  // ------------------------------------------------------------------ live feed: ticker + alert pop-ups
  let since = 0;
  let liveTimer = null;
  const tickerSeen = new Set();
  const stClass = (s) => (s === 'declined' ? 'bad' : s === 'review' || s === 'held' ? 'warn' : 'ok');

  function renderTicker(pays) {
    const el = $('#ticker');
    if (!el) return;
    const first = !el.dataset.ready;
    el.dataset.ready = '1';
    el.innerHTML = '<span class="tk-label"><i class="dot"></i>Live payments</span>' + pays.map((p) => `<span class="tk ${stClass(p.status)} ${!first && !tickerSeen.has(p.id) ? 'new' : ''}" data-open="payment:${esc(p.id)}" title="${esc(p.customer_name)} - ${esc(p.status)}"><b>${money(p.amount)}</b> ${esc(p.merchant_name)} <small>risk ${p.risk_score}</small></span>`).join('');
    pays.forEach((p) => tickerSeen.add(p.id));
  }

  function popup(a) {
    if (!can('alerts:read')) return;
    if (a.severity === 'critical' && prefs.sound) criticalBeep();
    if (!prefs.popups) return;
    let box = $('#popups');
    if (!box) {
      box = document.createElement('div');
      box.id = 'popups';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `popup pop-${esc(a.severity)}`;
    el.dataset.open = `alert:${a.id}`;
    el.innerHTML = `<span class="chip sev-${esc(a.severity)}">${esc(a.severity)}</span><div><b>${esc(a.title)}</b><small>${esc(a.rule_name)} - click to investigate</small></div>`;
    box.prepend(el);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => el.remove(), 9000);
  }

  async function poll() {
    if (!VP.state.me) return;
    try {
      const d = await api('/live' + (since ? `?since=${since}` : ''));
      const firstPoll = !since;
      since = d.now;
      if (!firstPoll) d.alerts.forEach(popup);
      if (can('payments:read')) renderTicker(d.payments);
    } catch (e) { /* the main refresh loop reports connectivity */ }
  }

  function startLive() {
    clearInterval(liveTimer);
    since = 0;
    tickerSeen.clear();
    let t = $('#ticker');
    if (t) t.remove();
    if (can('payments:read')) {
      t = document.createElement('div');
      t.id = 'ticker';
      t.className = 'ticker';
      document.body.appendChild(t);
    }
    document.body.classList.toggle('has-ticker', prefs.ticker && !!$('#ticker'));
    poll();
    liveTimer = setInterval(poll, 4000);
  }

  // ------------------------------------------------------------------ presenter panel
  function closePanel() {
    const p = $('#ppanel');
    if (p) p.hidden = true;
  }
  async function buildPanel() {
    let panel = $('#ppanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ppanel';
      panel.className = 'ppanel';
      document.body.appendChild(panel);
    }
    let scen = [];
    if (can('demo:control')) {
      try { scen = await api('/demo/scenarios'); } catch (e) { scen = []; }
    }
    panel.innerHTML = `
      <div class="pp-sec"><div class="pp-row"><button class="btn sm" data-do="tour">Start guided tour</button><button class="btn alt sm" data-do="wall">SOC wall</button></div></div>
      <div class="pp-sec">
        <label class="sw"><input type="checkbox" data-pref="theme" ${prefs.theme === 'dark' ? 'checked' : ''}> Dark mode <kbd>T</kbd></label>
        ${can('payments:read') ? `<label class="sw"><input type="checkbox" data-pref="ticker" ${prefs.ticker ? 'checked' : ''}> Live payment ticker</label>` : ''}
        <label class="sw"><input type="checkbox" data-pref="popups" ${prefs.popups ? 'checked' : ''}> New-alert pop-ups</label>
        <label class="sw"><input type="checkbox" data-pref="sound" ${prefs.sound ? 'checked' : ''}> Sound on critical alerts <button class="btn alt sm" data-do="testSound" style="margin-left:auto">Test</button></label>
      </div>
      ${scen.length ? `<div class="pp-sec"><div class="section-title">Trigger an incident</div><div class="footnote" style="margin-bottom:6px">Fires realistic events and raises a live alert.</div>${scen.map((s) => `<button class="pp-scn" data-do="trigger:${esc(s.id)}"><b>${esc(s.label)}</b><span>${esc(s.desc)}</span></button>`).join('')}</div>` : ''}
      <div class="pp-sec footnote">Shortcuts: <kbd>P</kbd> panel, <kbd>G</kbd> tour, <kbd>W</kbd> wall, <kbd>T</kbd> theme</div>`;
    $$('input[data-pref]', panel).forEach((i) => (i.onchange = () => setPref(i.dataset.pref, i.checked)));
  }
  function setPref(key, on) {
    if (key === 'theme') {
      prefs.theme = on ? 'dark' : 'light';
      store.set('vp_theme', prefs.theme);
      applyTheme();
    } else if (key === 'ticker') {
      prefs.ticker = on;
      store.set('vp_ticker', on);
      document.body.classList.toggle('has-ticker', on && !!$('#ticker'));
    } else if (key === 'popups') {
      prefs.popups = on;
      store.set('vp_popups', on);
    } else if (key === 'sound') {
      prefs.sound = on;
      store.set('vp_sound', on);
      if (on) criticalBeep();
    }
  }
  async function togglePanel() {
    let p = $('#ppanel');
    if (p && !p.hidden) return closePanel();
    await buildPanel();
    p = $('#ppanel');
    p.hidden = false;
  }

  // ------------------------------------------------------------------ guided tour
  const rows = () => $$('#view > .card');
  const STEPS = [
    { page: 'dashboard', title: 'Everything in one view', text: 'Payments, fraud and security signals on a single screen. These numbers update live as events stream in.', target: () => $('#view .g4') },
    { page: 'dashboard', title: 'Money in motion', text: 'Hourly approved volume next to the severity mix of open alerts. A volume spike or a cluster of critical alerts stands out immediately.', target: () => $('#view .g32') },
    { page: 'dashboard', title: 'Every engine is observable', text: 'Authentication, authorization, risk scoring, detection, the SQL store and the search index each report their own health.', target: () => { const e = $('#view .engines'); return e && e.closest('.card'); } },
    { page: 'alerts', perm: 'alerts:read', title: 'Detections, not just logs', text: 'Ten detection rules turn raw events into prioritized alerts: brute force, impossible travel, card testing, port scans and more. Each maps to MITRE ATT&CK.', wait: () => $('#alerts-results tr[data-open]'), target: () => $('#alerts-results') },
    { page: 'alerts', perm: 'alerts:read', drawer: true, title: 'Investigate with context', text: 'Every alert carries its evidence, the entity involved and a response workflow. Analysts acknowledge, escalate or resolve with a note, and each action is audited.', ready: () => $('#alerts-results tr[data-open]'), before: () => { const r = $('#alerts-results tr[data-open]'); if (r) r.click(); }, wait: () => $('#drawer:not([hidden]) .kv'), target: () => $('#drawer') },
    { page: 'payments', perm: 'payments:read', title: 'Every payment is risk scored', text: 'Each payment gets a 0 to 100 score as it arrives, then is approved, sent to review or declined automatically. This view is filtered to the risky ones.', prep: () => { VP.state.filters.payments.min_risk = '45'; VP.state.filters.payments.status = ''; VP.state.filters.payments.q = ''; }, wait: () => $('#pay-results tr[data-open]'), target: () => $('#pay-results') },
    { page: 'payments', perm: 'payments:read', drawer: true, title: 'Explainable decisions', text: 'The score is broken into plain-language reasons, so an analyst sees why a payment was flagged and can decide in seconds.', ready: () => $('#pay-results tr[data-open]'), before: () => { const r = $('#pay-results tr[data-open]'); if (r) r.click(); }, wait: () => $('#drawer:not([hidden]) .kv'), target: () => $('#drawer') },
    { page: 'fraud', perm: 'fraud:read', title: 'Work the queue', text: 'Highest risk first, with one-click approve or decline and customer blocking for the analyst on shift.', target: () => rows()[0] },
    { page: 'employees', perm: 'employees:read', title: 'Know who has access', text: 'Every employee with their role, last sign-in and failed attempts. Suspending an account ends its sessions at once.', target: () => rows()[0] },
    { page: 'admins', perm: 'admins:manage', title: 'Least privilege by design', text: 'Nine roles with explicit permissions. Executives can see everything but change nothing, and analysts can act only inside their own lane.', target: () => rows()[0] },
    { page: 'admins', perm: 'query:run', title: 'Ask anything', text: 'Analysts can run read-only SQL or search any event stream directly. Every query is audit logged.', target: () => $('#view .console') },
    { page: 'audit', perm: 'audit:read', title: 'Accountable by default', text: 'Every sign-in, decision, role change and query is recorded with who, what, when and from where. Export it for auditors in one click.', wait: () => $('#audit-results tbody tr'), target: () => $('#audit-results') },
    { page: 'impact', perm: 'dashboard:read', title: 'Put a number on it', text: 'Adjust the assumptions to the prospect\'s own volumes and costs to show annual loss avoided, analyst effort saved and payback.', wait: () => $('#view .calc'), target: () => $('#view .calc') },
    { page: 'dashboard', title: 'Questions?', text: 'Anything here can be reproduced live. Use the Presenter menu to trigger an incident and watch it appear.', target: () => null },
  ];
  let tour = null;

  function tourClose() {
    if (!tour) return;
    clearInterval(tour.timer);
    ['tour-scrim', 'tour-hl', 'tour-card'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
    const x = $('#drawer:not([hidden]) [data-do="close"]');
    if (x) x.click();
    VP.state.filters.payments.min_risk = '';
    tour = null;
  }

  function place() {
    if (!tour) return;
    const s = tour.steps[tour.i];
    const el = s.target ? s.target() : null;
    const hl = $('#tour-hl');
    const card = $('#tour-card');
    if (!hl || !card) return;
    card.style.top = card.style.bottom = '';
    if (!el) {
      hl.style.display = 'none';
      $('#tour-scrim').style.display = 'block';
      card.style.left = '50%';
      card.style.transform = 'translateX(-50%)';
      card.style.bottom = '40%';
      return;
    }
    $('#tour-scrim').style.display = 'none';
    const r = el.getBoundingClientRect();
    hl.style.cssText = `display:block;top:${r.top - 8}px;left:${r.left - 8}px;width:${r.width + 16}px;height:${r.height + 16}px`;
    card.style.left = '24px';
    card.style.transform = 'none';
    const hits = r.left < 24 + 470 && r.bottom > window.innerHeight - 270;
    if (hits) card.style.top = '84px';
    else card.style.bottom = '24px';
  }

  async function showStep() {
    const s = tour.steps[tour.i];
    const token = ++tour.token;
    if (!s.drawer) {
      const x = $('#drawer:not([hidden]) [data-do="close"]');
      if (x) x.click();
    }
    if (s.prep) s.prep();
    if (s.page && VP.state.page !== s.page) {
      location.hash = '#/' + s.page;
      await waitFor(() => VP.state.page === s.page);
    }
    await waitFor((s.drawer ? s.ready : s.wait) || (() => $('#view .card, #view .grid')));
    if (s.before && !(s.drawer && $('#drawer:not([hidden])'))) s.before();
    if (s.drawer) await waitFor(s.wait);
    await sleep(250);
    if (!tour || token !== tour.token) return;
    const el = s.target ? s.target() : null;
    if (el && !s.drawer) {
      const r = el.getBoundingClientRect();
      el.scrollIntoView({ block: r.height > window.innerHeight * 0.7 ? 'start' : 'center', behavior: 'auto' });
    }
    const last = tour.i === tour.steps.length - 1;
    $('#tour-card').innerHTML = `
      <div class="tc-top"><span>${tour.i + 1} / ${tour.steps.length}</span><button class="tc-x" data-do="tourExit" aria-label="End tour">&times;</button></div>
      <h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>
      <div class="tc-bar"><i style="width:${((tour.i + 1) / tour.steps.length) * 100}%"></i></div>
      <div class="tc-actions"><button class="btn alt sm" data-do="tourPrev" ${tour.i === 0 ? 'disabled' : ''}>Back</button><button class="btn sm" data-do="${last ? 'tourExit' : 'tourNext'}">${last ? 'Finish' : 'Next'}</button></div>`;
    place();
  }

  async function startTour() {
    closePanel();
    tourClose();
    closeWall();
    const steps = STEPS.filter((s) => (!s.perm || can(s.perm)) && (!s.page || VP.NAV.some((n) => n.id === s.page && can(n.perm))));
    tour = { steps, i: 0, token: 0, timer: null };
    ['tour-scrim', 'tour-hl', 'tour-card'].forEach((id) => {
      const e = document.createElement('div');
      e.id = id;
      document.body.appendChild(e);
    });
    tour.timer = setInterval(place, 800);
    await showStep();
  }
  const tourNext = () => { if (tour && tour.i < tour.steps.length - 1) { tour.i++; return showStep(); } };
  const tourPrev = () => { if (tour && tour.i > 0) { tour.i--; return showStep(); } };

  // ------------------------------------------------------------------ SOC wall
  let wall = null;
  const brandName = () => (brand && brand.name) || DEFAULT_BRAND;
  const brandLogo = () => (brand && brand.logo) || 'logo.svg';

  async function drawWall() {
    if (!wall) return;
    let d;
    try { d = await api('/dashboard'); } catch (e) { return; }
    if (!wall) return;
    const k = d.kpis;
    const big = (label, value, tone) => `<div class="w-kpi ${tone || ''}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    wall.el.innerHTML = `
      <div class="w-head"><div class="w-brand"><img src="${esc(brandLogo())}" alt=""><b>${esc(brandName())}</b><span>Security Operations</span></div><div class="w-clock" id="w-clock"></div><button class="btn alt sm" data-do="wallClose">Exit</button></div>
      <div class="w-kpis">
        ${big('Open alerts', k.open_alerts, k.critical_open ? 'crit' : '')}
        ${big('Critical', k.critical_open, k.critical_open ? 'crit' : 'good')}
        ${big('Payments, 24h', num(k.payments_24h))}
        ${big('Approved volume', money(k.volume_24h))}
        ${big('Fraud prevented', money(k.fraud_prevented), 'good')}
        ${big('Events / sec', d.system.eps)}
      </div>
      <div class="w-grid">
        <div class="w-card"><h3>Approved volume, last 24 hours</h3>${VP.area(d.payments_series.map((p) => p.volume), d.payments_series.map((p) => p.ts), '#14b8a6', (v) => '$' + VP.compact(v), (v) => money(v))}</div>
        <div class="w-card"><h3>Latest alerts</h3>${d.recent_alerts.slice(0, 6).map((a) => `<div class="w-alert"><span class="chip sev-${esc(a.severity)}">${esc(a.severity)}</span><div><b>${esc(a.title)}</b><small>${esc(a.rule_name)} - ${VP.ago(a.ts)}</small></div></div>`).join('') || '<div class="empty">No alerts</div>'}</div>
      </div>
      <div class="w-engines">${d.system.engines.map((e) => `<span><i class="dot"></i>${esc(e.name)}</span>`).join('')}</div>`;
    tickClock();
  }
  function tickClock() {
    const c = $('#w-clock');
    if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  async function openWall() {
    closePanel();
    tourClose();
    if (wall) return;
    const el = document.createElement('div');
    el.id = 'wall';
    document.body.appendChild(el);
    wall = { el, timer: setInterval(drawWall, 5000), clock: setInterval(tickClock, 1000) };
    try { await el.requestFullscreen(); } catch (e) { /* the overlay still works without fullscreen */ }
    await drawWall();
  }
  function closeWall() {
    if (!wall) return;
    clearInterval(wall.timer);
    clearInterval(wall.clock);
    wall.el.remove();
    wall = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) closeWall(); });

  // ------------------------------------------------------------------ business impact + ROI
  const short = (n) => {
    const a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
    return '$' + Math.round(n);
  };
  const FIELDS = [
    { id: 'volume', label: 'Annual payment volume', min: 10e6, max: 2e9, step: 10e6, value: 1e9, fmt: short },
    { id: 'bps', label: 'Fraud loss rate', min: 1, max: 60, step: 1, value: 10, fmt: (v) => `${v} bps` },
    { id: 'reduction', label: 'Expected reduction in fraud loss', min: 5, max: 70, step: 1, value: 35, fmt: (v) => `${v}%` },
    { id: 'avgFraud', label: 'Average fraudulent payment', min: 50, max: 2000, step: 10, value: 180, fmt: (v) => `$${v}` },
    { id: 'caseCost', label: 'Handling cost per fraud case', min: 5, max: 200, step: 1, value: 25, fmt: (v) => `$${v}` },
    { id: 'analysts', label: 'Fraud and SOC analysts', min: 1, max: 60, step: 1, value: 12, fmt: (v) => String(v) },
    { id: 'loaded', label: 'Loaded cost per analyst, per year', min: 40e3, max: 200e3, step: 5e3, value: 85e3, fmt: short },
    { id: 'labor', label: 'Analyst effort saved', min: 0, max: 60, step: 1, value: 30, fmt: (v) => `${v}%` },
    { id: 'price', label: 'Annual platform cost', min: 50e3, max: 3e6, step: 25e3, value: 400e3, fmt: short },
  ];

  function calc() {
    const v = Object.fromEntries(FIELDS.map((f) => [f.id, Number($('#f-' + f.id).value)]));
    FIELDS.forEach((f) => { $('#v-' + f.id).textContent = f.fmt(v[f.id]); });
    const baseLoss = (v.volume * v.bps) / 1e4;
    const avoided = (baseLoss * v.reduction) / 100;
    const cases = baseLoss / Math.max(v.avgFraud, 1);
    const caseSaved = ((cases * v.reduction) / 100) * v.caseCost;
    const labor = (v.analysts * v.loaded * v.labor) / 100;
    const total = avoided + caseSaved + labor;
    const roi = total / Math.max(v.price, 1);
    const payback = total > 0 ? (v.price / (total / 12)) : Infinity;
    $('#calc-out').innerHTML = `
      <div class="big-total"><span>Estimated annual benefit</span><b>${short(total)}</b></div>
      <div class="calc-kpis"><div><span>Return on platform cost</span><b>${roi.toFixed(1)}x</b></div><div><span>Payback</span><b>${isFinite(payback) ? (payback < 1 ? '< 1 month' : payback.toFixed(1) + ' months') : 'n/a'}</b></div><div><span>Fraud cases avoided</span><b>${num(Math.round((cases * v.reduction) / 100))}</b></div></div>
      <div class="section-title" style="margin-top:14px">Where the benefit comes from</div>
      ${VP.hbars([{ label: 'Fraud loss avoided', value: avoided }, { label: 'Case handling saved', value: caseSaved }, { label: 'Analyst effort saved', value: labor }], short)}
      <div class="section-title" style="margin-top:14px">Annual fraud loss</div>
      ${VP.hbars([{ label: 'Today', value: baseLoss }, { label: 'With the platform', value: baseLoss - avoided }], short)}`;
  }

  async function renderImpact() {
    const d = await api('/impact');
    $('#view').innerHTML = `
      <div class="grid g4">
        ${VP.kpi('Fraud stopped (24h)', money(d.stopped_amount), `${d.stopped_count} payments declined, held or in review`, 'good')}
        ${VP.kpi('Decided automatically', d.auto_rate + '%', 'no analyst touch needed')}
        ${VP.kpi('Events monitored', num(d.events_monitored), `${d.rules} detection rules running`)}
        ${VP.kpi('Threats detected', d.alerts_total, `${d.critical} critical`, d.critical ? 'warn' : '')}
      </div>
      <div class="grid g32 calc">
        <div class="card"><h3>ROI model</h3><div class="hint">Illustrative assumptions. Replace them with the prospect's own figures; nothing here is a forecast.</div>
          ${FIELDS.map((f) => `<label class="fld"><span>${esc(f.label)}<b id="v-${f.id}"></b></span><input type="range" id="f-${f.id}" min="${f.min}" max="${f.max}" step="${f.step}" value="${f.value}"></label>`).join('')}</div>
        <div class="card"><h3>Result</h3><div class="hint">Updates as you move the sliders</div><div id="calc-out"></div>
          <div class="no-print" style="margin-top:16px"><button class="btn alt sm" data-do="print">Print or save as PDF</button></div></div>
      </div>`;
    FIELDS.forEach((f) => ($('#f-' + f.id).oninput = calc));
    calc();
  }

  VP.ICONS.chart = '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>';
  VP.NAV.push({ id: 'impact', label: 'Business Impact', icon: 'chart', perm: 'dashboard:read', sub: 'Value delivered, with an adjustable ROI model' });
  VP.PAGES.impact = { load: renderImpact };

  // ------------------------------------------------------------------ actions, shortcuts, wiring
  Object.assign(VP.DO, {
    panel: togglePanel,
    tour: startTour,
    tourNext,
    tourPrev,
    tourExit: tourClose,
    wall: openWall,
    wallClose: closeWall,
    print: () => window.print(),
    testSound: () => criticalBeep(),
    trigger: async (id) => {
      const r = await api('/demo/trigger', { method: 'POST', body: { scenario: id } });
      VP.toast(`${r.label}: ${r.alerts.length} new alert${r.alerts.length === 1 ? '' : 's'} raised`);
      await poll();
      const p = VP.PAGES[VP.state.page];
      if (p && p.refresh && ['dashboard', 'alerts', 'fraud'].includes(VP.state.page)) await p.refresh();
    },
  });

  document.addEventListener('click', (e) => {
    const p = $('#ppanel');
    if (p && !p.hidden && !e.target.closest('#ppanel') && !e.target.closest('#pbtn')) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (!VP.state.me || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      closePanel();
      if (tour) tourClose();
      if (wall) closeWall();
      return;
    }
    const t = e.target;
    if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    if (tour) {
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); tourNext(); }
      else if (e.key === 'ArrowLeft') tourPrev();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'p') VP.attempt(togglePanel);
    else if (k === 't') { setPref('theme', prefs.theme !== 'dark'); const c = $('input[data-pref="theme"]'); if (c) c.checked = prefs.theme === 'dark'; }
    else if (k === 'w') VP.attempt(openWall);
    else if (k === 'g') VP.attempt(startTour);
  });

  VP.onEnter(() => {
    applyTheme();
    closeWall();
    tourClose();
    const p = $('#ppanel');
    if (p) p.remove();
    const live = $('.top .live');
    if (live && !$('#pbtn')) live.insertAdjacentHTML('beforebegin', '<button class="btn alt sm" id="pbtn" data-do="panel" title="Presenter tools (P)">Presenter</button>');
    startLive();
    rebrand();
  });
})();
