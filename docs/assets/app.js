// Shared front-end helpers
const API_URL = 'https://hr-api.subasrivallivilashr.workers.dev/';
const SESSION_KEY = 'hr_session';

const Session = {
  get() { try { const s = JSON.parse(localStorage.getItem(SESSION_KEY)); return s && s.exp > Date.now() ? s : null; } catch { return null; } },
  set(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} },
  clear() { try { localStorage.removeItem(SESSION_KEY); } catch {} }
};

async function api(action, params = {}) {
  const s = Session.get();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...(s ? { Authorization: 'Bearer ' + s.token } : {}) },
    body: JSON.stringify({ action, ...params })
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Server not reachable' }));
  if (res.status === 401) { Session.clear(); location.href = 'index.html'; }
  if (!data.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

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
  const closeAll = except => document.querySelectorAll('.ng.open').forEach(n => { if (n !== except) { n.classList.remove('open'); n.querySelector('.nl').setAttribute('aria-expanded', 'false'); } });
  document.querySelectorAll('.ng > .nl').forEach(b => b.onclick = e => {
    e.stopPropagation(); const g = b.parentElement; closeAll(g);
    const open = g.classList.toggle('open'); b.setAttribute('aria-expanded', open);
  });
  document.addEventListener('click', () => closeAll());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
}
function setCompanyName(n) { const s = Session.get(); if (s && n) { s.company = n; Session.set(s); const el = $('#co'); if (el) el.textContent = n; } }
