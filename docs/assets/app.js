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

// Top bar with navigation (pages shown depend on role)
const NAV = [
  { key: 'org', label: 'Organisation', href: 'org.html', roles: ['SuperAdmin', 'Admin', 'HR', 'Manager'] },
  { key: 'employees', label: 'Employees', href: 'employees.html', roles: ['SuperAdmin', 'Admin', 'HR', 'Manager'] },
  { key: 'roles', label: 'Roles', href: 'roles.html', roles: ['SuperAdmin', 'Admin', 'HR', 'Manager'] },
  { key: 'policies', label: 'Policies', href: 'policies.html', roles: ['SuperAdmin', 'Admin', 'HR', 'Manager'] },
  { key: 'kpi', label: 'KPIs', href: 'kpi.html', roles: ['SuperAdmin', 'Admin', 'HR', 'Manager'] },
  { key: 'hiring', label: 'Hiring', href: 'hiring.html', roles: ['SuperAdmin', 'Admin', 'HR'] },
  { key: 'lifecycle', label: 'Onboarding & Exit', href: 'lifecycle.html', roles: ['SuperAdmin', 'Admin', 'HR'] },
  { key: 'letters', label: 'Letters', href: 'letters.html', roles: ['SuperAdmin', 'Admin', 'HR'] },
  { key: 'reports', label: 'Reports', href: 'reports.html', roles: ['SuperAdmin', 'Admin', 'HR', 'Manager'] },
  { key: 'settings', label: 'Settings', href: 'settings.html', roles: ['SuperAdmin', 'Admin'] }
];
function renderTop(active, companyName) {
  const s = Session.get(); if (!s) return;
  const links = NAV.filter(n => n.roles.includes(s.role))
    .map(n => `<a href="${n.href}" class="${n.key === active ? 'on' : ''}">${n.label}</a>`).join('');
  $('#top').innerHTML = `<b id="co">${esc(companyName || s.company || 'HR System')}</b><nav class="nav">${links}</nav>
    <span class="who">${esc(s.name)} · ${esc(s.role)}</span><button id="out">Sign out</button>`;
  $('#out').onclick = () => { Session.clear(); location.href = 'index.html'; };
}
function setCompanyName(n) { const s = Session.get(); if (s && n) { s.company = n; Session.set(s); const el = $('#co'); if (el) el.textContent = n; } }
