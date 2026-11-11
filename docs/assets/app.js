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
