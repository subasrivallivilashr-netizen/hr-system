// Shared front-end helpers
const API_URL = 'https://hr-api.subasrivallivilashr.workers.dev/';
const SESSION_KEY = 'hr_session';

const Session = {
  get() { try { const s = JSON.parse(localStorage.getItem(SESSION_KEY)); return s && s.exp > Date.now() ? s : null; } catch { return null; } },
  set(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} },
  clear() { try { localStorage.removeItem(SESSION_KEY); } catch {} }
};

// ── Double-click protection ──
// 1) A button (or form) clicked again within 0.7 s, or while its request is still running, is ignored.
// 2) The button that started a request is disabled with a spinner until the server answers.
// 3) Identical requests within 10 s carry the same request ID, so the server runs them only once.
let LAST_BTN = null;
const RECENT_CLICK = new WeakMap(), BUSY_COUNT = new WeakMap(), REQ_IDS = new Map();
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('button'); if (!b) return;
  const t = Date.now();
  if (b.classList.contains('is-busy') || t - (RECENT_CLICK.get(b) || 0) < 700) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  RECENT_CLICK.set(b, t); LAST_BTN = { b, t };
}, true);
document.addEventListener('submit', e => {
  const f = e.target, t = Date.now();
  if (f.classList.contains('is-busy') || t - (RECENT_CLICK.get(f) || 0) < 700) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  RECENT_CLICK.set(f, t);
  const b = e.submitter || f.querySelector('button:not([type=button]):not([value=cancel])'); if (b) LAST_BTN = { b, t };
}, true);
function setBusy(b, on) {
  const n = (BUSY_COUNT.get(b) || 0) + (on ? 1 : -1); BUSY_COUNT.set(b, Math.max(0, n));
  if (on && n === 1) { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; b.classList.add('is-busy'); b.setAttribute('aria-busy', 'true'); }
  if (!on && n <= 0) { b.classList.remove('is-busy'); b.removeAttribute('aria-busy'); if (!b.dataset.wasDisabled) b.disabled = false; }
}
function reqIdFor(action, params) {
  const s = action + '|' + JSON.stringify(params); let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const key = action + ':' + (h >>> 0).toString(36) + ':' + s.length, now = Date.now();
  for (const [k, v] of REQ_IDS) if (now - v.t > 10000) REQ_IDS.delete(k);
  let hit = REQ_IDS.get(key); if (!hit) { hit = { id: now.toString(36) + Math.random().toString(36).slice(2, 8), t: now }; REQ_IDS.set(key, hit); }
  return hit.id;
}

async function api(action, params = {}) {
  const s = Session.get();
  const own = LAST_BTN && Date.now() - LAST_BTN.t < 15000 && LAST_BTN.b.isConnected ? LAST_BTN.b : null; LAST_BTN = null;
  if (own) setBusy(own, true);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...(s ? { Authorization: 'Bearer ' + s.token } : {}) },
      body: JSON.stringify({ action, ...params, reqId: reqIdFor(action, params) })
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'Server not reachable' }));
    if (res.status === 401) { Session.clear(); location.href = 'index.html'; }
    if (!data.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  } catch (e) {
    if (e instanceof TypeError) throw new Error('Server not reachable. Check your internet and try again.');
    throw e;
  } finally { if (own) setBusy(own, false); }
}

// ── Editable dropdown lists with "Other" (values come from Settings → Lists) ──
function listSelect(id, values, current, opt = {}) {
  current = String(current ?? ''); values = values || [];
  const other = current && !values.includes(current);
  return `<span class="lsel"><select id="${id}" data-list ${opt.name ? `name="${opt.name}"` : ''}>${opt.blank ? `<option value="">${esc(opt.blank)}</option>` : ''}${values.map(v => `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('')}<option value="__other" ${other ? 'selected' : ''}>Other…</option></select>
    <input id="${id}_o" class="${other ? '' : 'hidden'}" placeholder="${esc(opt.placeholder || 'Type here')}" value="${other ? esc(current) : ''}" style="margin-top:6px"></span>`;
}
function listValue(id) { const s = document.getElementById(id); if (!s) return ''; return s.value === '__other' ? document.getElementById(id + '_o').value.trim() : s.value; }
document.addEventListener('change', e => {
  const s = e.target; if (!s.matches || !s.matches('select[data-list]')) return;
  const o = document.getElementById(s.id + '_o'); if (!o) return;
  o.classList.toggle('hidden', s.value !== '__other'); if (s.value === '__other') o.focus();
});

// ── Small dialog asking for a reason (list + Other) and an optional note ──
function askReason({ title, intro = '', list, reasonLabel = 'Reason', noteLabel = 'Remarks (optional)', noteRequired = false, okText = 'Confirm', danger = false }) {
  const opener = LAST_BTN;                         // keep the button that opened this dialog, so it gets the busy lock
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog" style="min-width:min(420px,86vw)"><h3 style="margin-top:0">${esc(title)}</h3>${intro ? `<p class="sub" style="margin-top:-4px">${esc(intro)}</p>` : ''}
      ${list ? `<label>${esc(reasonLabel)}</label>${listSelect('arR', list, '', { blank: '— Select —' })}` : ''}
      <label>${esc(noteLabel)}</label><textarea id="arN" rows="2"></textarea>
      <div class="row-end"><span class="msg" id="arM"></span><button value="cancel" formnovalidate>Go back</button><button class="btn ${danger ? 'btn-err' : ''}" value="ok" id="arOk">${esc(okText)}</button></div></form>`;
    document.body.appendChild(d);
    d.querySelector('#arOk').onclick = e => {
      const reason = list ? listValue('arR') : '', note = d.querySelector('#arN').value.trim();
      if (list && !reason) { e.preventDefault(); return showMsg(d.querySelector('#arM'), 'Choose a reason'); }
      if (noteRequired && !note) { e.preventDefault(); return showMsg(d.querySelector('#arM'), 'Please write a note'); }
      d.result = { reason, note };
    };
    d.addEventListener('close', () => { if (opener && d.result) LAST_BTN = { b: opener.b, t: Date.now() }; resolve(d.result || null); d.remove(); });
    d.showModal();
  });
}

const CREDIT_HTML = '<span class="credit">Powered by <i></i><b>C&amp;B</b></span>';

function guard(roles) {
  const s = Session.get();
  if (!s) { location.href = 'index.html'; return null; }
  if (roles && !roles.includes(s.role)) { alert('You do not have access to this page.'); location.href = 'index.html'; return null; }
  return s;
}

function $(sel, root = document) { return root.querySelector(sel); }
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function showMsg(el, text, ok) { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); }

// Top bar with grouped navigation (items shown depend on role)
const ALL = ['SuperAdmin', 'Admin', 'HR', 'Manager'], HRR = ['SuperAdmin', 'Admin', 'HR'];
const NAV = [
  { label: 'People', items: [
    { key: 'org', label: 'Organisation', href: 'org.html', roles: ALL },
    { key: 'employees', label: 'Employees', href: 'employees.html', roles: ALL },
    { key: 'roles', label: 'Roles & responsibilities', href: 'roles.html', roles: ALL }] },
  { label: 'Hiring', items: [
    { key: 'hiring', label: 'Hiring pipeline', href: 'hiring.html', roles: HRR },
    { key: 'lifecycle', label: 'Onboarding & exit', href: 'lifecycle.html', roles: HRR }] },
  { label: 'Performance', items: [
    { key: 'kpi', label: 'KPIs', href: 'kpi.html', roles: ALL },
    { key: 'reports', label: 'Reports', href: 'reports.html', roles: ALL }] },
  { label: 'Documents', items: [
    { key: 'policies', label: 'Policies', href: 'policies.html', roles: ALL },
    { key: 'letters', label: 'Letters', href: 'letters.html', roles: HRR }] },
  { key: 'settings', label: 'Settings', href: 'settings.html', roles: ['SuperAdmin', 'Admin'] }
];
function renderTop(active, companyName) {
  const s = Session.get(); if (!s) return;
  const html = NAV.map((g, gi) => {
    if (!g.items) return g.roles.includes(s.role) ? `<a href="${g.href}" class="nl ${g.key === active ? 'on' : ''}">${g.label}</a>` : '';
    const items = g.items.filter(i => i.roles.includes(s.role)); if (!items.length) return '';
    const on = items.some(i => i.key === active);
    return `<div class="ng"><button type="button" class="nl ${on ? 'on' : ''}" data-g="${gi}" aria-haspopup="true" aria-expanded="false">${g.label} <span class="car">▾</span></button>
      <div class="dd">${items.map(i => `<a href="${i.href}" class="${i.key === active ? 'on' : ''}">${i.label}</a>`).join('')}</div></div>`;
  }).join('');
  $('#top').innerHTML = `<b id="co">${esc(companyName || s.company || 'HR System')}</b><nav class="nav">${html}</nav>
    <span class="who">${esc(s.name)} · ${esc(s.role)}</span><button id="out">Sign out</button>`;
  $('#out').onclick = () => { Session.clear(); location.href = 'index.html'; };
  if (!$('#appFoot')) { const f = document.createElement('footer'); f.id = 'appFoot'; f.className = 'app-foot noprint'; f.innerHTML = CREDIT_HTML; document.body.appendChild(f); }
  const closeAll = except => document.querySelectorAll('.ng.open').forEach(n => { if (n !== except) { n.classList.remove('open'); n.querySelector('.nl').setAttribute('aria-expanded', 'false'); } });
  document.querySelectorAll('.ng > .nl').forEach(b => b.onclick = e => {
    e.stopPropagation(); const g = b.parentElement; closeAll(g);
    const open = g.classList.toggle('open'); b.setAttribute('aria-expanded', open);
  });
  document.addEventListener('click', () => closeAll());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
}
function setCompanyName(n) { const s = Session.get(); if (s && n) { s.company = n; Session.set(s); const el = $('#co'); if (el) el.textContent = n; } }

// ── Auto-update: when version.json changes, refresh the browser's copy of every page & asset once, then reload ──
(async function autoUpdate() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return;
    const v = (await r.json()).v; let old = null;
    try { old = localStorage.getItem('hr_app_version'); } catch {}
    if (!v || old === v) return;
    try { localStorage.setItem('hr_app_version', v); } catch {}
    try { if (sessionStorage.getItem('hr_updated') === v) return; sessionStorage.setItem('hr_updated', v); } catch {}
    const pages = ['index', 'org', 'employees', 'roles', 'policies', 'kpi', 'hiring', 'interview', 'apply', 'lifecycle', 'letters', 'letter', 'reports', 'settings'].map(p => p + '.html');
    const assets = ['app.js', 'app.css', 'letter.js', 'salary.js', 'files.js', 'form.js'].map(a => 'assets/' + a);
    await Promise.all(pages.concat(assets).map(u => fetch(u, { cache: 'reload' }).catch(() => {})));
    if (old) location.reload();                     // first ever visit: files are already fresh, no reload needed
  } catch {}
})();
