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

// ── In-app dialogs (instead of the browser's alert / confirm / prompt) ──
function uiDialog({ title = '', message = '', input = false, def = '', required = false, okText = 'OK', cancelText = '', danger = false, choices = null }) {
  const opener = LAST_BTN;                         // the button that led here keeps the busy lock afterwards
  return new Promise(resolve => {
    const d = document.createElement('dialog'); d.className = 'ui-dlg';
    d.innerHTML = `<form method="dialog">${title ? `<h3>${esc(title)}</h3>` : ''}<p class="ui-msg">${esc(message)}</p>
      ${input ? `<textarea id="uiIn" rows="2">${esc(def)}</textarea>` : ''}<div class="msg" id="uiM"></div>
      <div class="row-end">${cancelText ? `<button value="cancel" formnovalidate>${esc(cancelText)}</button>` : ''}
      ${choices ? choices.map((c, i) => `<button class="btn" value="c${i}">${esc(c)}</button>`).join('') : `<button class="btn ${danger ? 'btn-err' : ''}" value="ok" id="uiOk">${esc(okText)}</button>`}</div></form>`;
    document.body.appendChild(d);
    const ok = d.querySelector('#uiOk'), inp = d.querySelector('#uiIn');
    if (ok && input && required) ok.addEventListener('click', e => { if (!inp.value.trim()) { e.preventDefault(); showMsg(d.querySelector('#uiM'), 'Please type something'); inp.focus(); } });
    d.addEventListener('close', () => {
      const v = d.returnValue, val = inp ? inp.value.trim() : '';
      d.remove();
      if (opener && v && v !== 'cancel') LAST_BTN = { b: opener.b, t: Date.now() };
      resolve({ v, val });
    });
    d.showModal(); (inp || ok || d.querySelector('button.btn')).focus();
  });
}
const uiAlert = (message, title) => uiDialog({ message: String(message ?? ''), title }).then(() => {});
const uiConfirm = (message, opt = {}) => uiDialog({ message, cancelText: opt.cancelText || 'Cancel', okText: opt.okText || 'Yes, continue', danger: opt.danger, title: opt.title }).then(r => r.v === 'ok');
// Resolves to the typed text, or null when cancelled. opt may be a default text or { def, required, okText, title }
const uiPrompt = (message, opt = {}) => { if (typeof opt === 'string') opt = { def: opt };
  return uiDialog({ message, input: true, def: opt.def || '', required: !!opt.required, cancelText: 'Cancel', okText: opt.okText || 'OK', title: opt.title }).then(r => r.v === 'ok' ? r.val : null); };
// Resolves to the index of the chosen button, or null when cancelled
const uiChoose = (message, choices, title) => uiDialog({ message, choices, cancelText: 'Cancel', title }).then(r => /^c\d+$/.test(r.v) ? Number(r.v.slice(1)) : null);

const CREDIT_HTML = '<span class="credit">Powered by <i></i><b>C&amp;B</b></span>';

// mods: module key or list (any one enabled is enough) — see Settings → Modules
function guard(roles, mods) {
  const s = Session.get();
  if (!s) { location.href = 'index.html'; return null; }
  if (roles && !roles.includes(s.role)) { uiAlert('You do not have access to this page.').then(() => location.href = 'org.html'); return null; }
  if (mods && !hasMod(mods)) { moduleOffPage(); return null; }
  return s;
}
function hasMod(mods) {
  const s = Session.get(), on = s && Array.isArray(s.modules) ? s.modules : null;
  if (!on) return true;                                 // older session without the list: let the server decide
  return [].concat(mods).some(m => on.includes(m));
}
function moduleOffPage() {
  const main = document.querySelector('main'); if (!main) return;
  [...main.children].forEach(c => c.classList.add('hidden'));
  const d = document.createElement('div'); d.className = 'card'; d.style.maxWidth = '560px';
  d.innerHTML = '<h2>Not enabled</h2><p class="sub">This part of the app is not enabled for your company. Contact C&amp;B if you need it.</p><a href="org.html">Go to Organisation</a>';
  main.prepend(d);
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
    { key: 'roles', label: 'Roles & responsibilities', href: 'roles.html', roles: ALL, mod: 'ROLES' }] },
  { label: 'Hiring', items: [
    { key: 'hiring', label: 'Hiring pipeline', href: 'hiring.html', roles: HRR, mod: 'HIRING' },
    { key: 'lifecycle', label: 'Onboarding & exit', href: 'lifecycle.html', roles: HRR, mod: ['ONBOARDING', 'EXIT'] }] },
  { label: 'Performance', items: [
    { key: 'kpi', label: 'KPIs', href: 'kpi.html', roles: ALL, mod: 'KPI' },
    { key: 'reports', label: 'Reports', href: 'reports.html', roles: ALL, mod: 'REPORTS' }] },
  { label: 'Documents', items: [
    { key: 'policies', label: 'Policies', href: 'policies.html', roles: ALL, mod: 'POLICIES' },
    { key: 'letters', label: 'Letters', href: 'letters.html', roles: HRR, mod: 'LETTERS' }] },
  { key: 'settings', label: 'Settings', href: 'settings.html', roles: ['SuperAdmin', 'Admin'] }
];
const lifecycleLabel = () => hasMod('ONBOARDING') && hasMod('EXIT') ? 'Onboarding & exit' : hasMod('ONBOARDING') ? 'Onboarding' : 'Exit';
// Line icons for the sidebar (24px, stroke = currentColor)
const SB_ICONS = {
  People: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5 6-5s5.4 1.6 6 5"/><path d="M16 4.5a3 3 0 0 1 0 6M18 14.5c1.6.7 2.7 2.4 3 5"/>',
  Hiring: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M3 12.5h18"/>',
  Performance: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".9" fill="currentColor"/>',
  Documents: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7.5h6M9 11h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  out: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>'
};
const sbIcon = (k, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SB_ICONS[k] || ''}</svg>`;
function sbOpenGroups() { try { return JSON.parse(sessionStorage.getItem('hr_sb_open') || '[]'); } catch { return []; } }
function sbSaveGroups(list) { try { sessionStorage.setItem('hr_sb_open', JSON.stringify(list)); } catch {} }

// Sidebar (design C): group headings with icons, the current group open, others fold away
function renderTop(active, companyName) {
  const s = Session.get(); if (!s) return;
  const lbl = i => i.key === 'lifecycle' ? lifecycleLabel() : i.key === 'settings' && s.role !== 'SuperAdmin' ? 'Users' : i.label;
  const remembered = sbOpenGroups();
  const html = NAV.map((g, gi) => {
    if (!g.items) {                                   // single page (Settings / Users): a direct link
      if (!g.roles.includes(s.role)) return '';
      const on = g.key === active;
      return `<a href="${g.href}" class="sb-h sb-link ${on ? 'on' : ''}" ${on ? 'aria-current="page"' : ''}>${sbIcon(g.key)}<span>${lbl(g)}</span></a>`;
    }
    const items = g.items.filter(i => i.roles.includes(s.role) && (!i.mod || hasMod(i.mod))); if (!items.length) return '';
    const cur = items.some(i => i.key === active), open = cur || remembered.includes(g.label);
    return `<div class="sb-grp ${open ? 'open' : ''} ${cur ? 'cur' : ''}">
      <button type="button" class="sb-h" aria-expanded="${open}" aria-controls="sbg${gi}" data-g="${esc(g.label)}">${sbIcon(g.label)}<span>${g.label}</span><em>${sbIcon('chev', 14)}</em></button>
      <div class="sb-items" id="sbg${gi}">${items.map(i => `<a href="${i.href}" class="nl ${i.key === active ? 'on' : ''}" ${i.key === active ? 'aria-current="page"' : ''}>${lbl(i)}</a>`).join('')}</div></div>`;
  }).join('');
  const name = esc(companyName || s.company || 'HR System');
  const initials = String(s.name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  $('#top').innerHTML = `${s.logo ? `<div class="sb-logo"><img src="${esc(s.logo)}" alt="${name} logo"></div>` : ''}<div class="sb-brand"><i></i><b id="co">${name}</b></div>
    <nav class="nav" aria-label="Main menu">${html}</nav>
    <div class="sb-foot">${langPicker(s.languages)}<div class="sb-user"><span class="sb-av" aria-hidden="true">${esc(initials)}</span><div class="sb-who"><b>${esc(s.name)}</b><small>${esc(s.role === 'SuperAdmin' ? 'C&B Super Admin' : s.role)}</small></div>
      <button type="button" id="out" class="sb-out" aria-label="Sign out" title="Sign out">${sbIcon('out', 17)}</button></div>${CREDIT_HTML}</div>`;
  wireLangPicker(); startTranslator(s.languages);
  document.querySelectorAll('#top .sb-grp > .sb-h').forEach(b => b.onclick = () => {
    const grp = b.parentElement, open = !grp.classList.contains('open');
    grp.classList.toggle('open', open); b.setAttribute('aria-expanded', open);
    const keep = sbOpenGroups().filter(x => x !== b.dataset.g); if (open) keep.push(b.dataset.g); sbSaveGroups(keep);
  });
  document.body.classList.add('has-side');
  $('#out').onclick = () => { Session.clear(); location.href = 'index.html'; };
  if (!$('#mtop')) {                                // phone: top strip with a menu button that slides the sidebar in
    const m = document.createElement('div'); m.id = 'mtop'; m.className = 'mtop noprint';
    m.innerHTML = `<button type="button" id="sbToggle" aria-label="Menu">☰</button><i></i><span id="co2">${name}</span>`;
    document.body.prepend(m);
    $('#sbToggle').onclick = e => { e.stopPropagation(); document.body.classList.toggle('sb-open'); };
    document.addEventListener('click', e => { if (document.body.classList.contains('sb-open') && !e.target.closest('#top')) document.body.classList.remove('sb-open'); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.body.classList.remove('sb-open'); });
  }
  if (!renderTop.checked) {                         // pick up module changes made by C&B since login (once per page)
    renderTop.checked = true;
    api('me').then(m => { const cur = Session.get(); if (!cur || !m.modules) return;
      const changed = JSON.stringify(cur.modules || null) !== JSON.stringify(m.modules);
      const look = (cur.logo || '') !== (m.logo || '') || (cur.company || '') !== (m.company || '') || JSON.stringify(cur.languages || []) !== JSON.stringify(m.languages || []);
      cur.modules = m.modules; cur.logo = m.logo || ''; cur.company = m.company || ''; cur.languages = m.languages || []; Session.set(cur);
      if (changed) location.reload(); else if (look) renderTop(active, companyName);
    }).catch(() => {});
  }
}
function setCompanyName(n) { const s = Session.get(); if (s && n) { s.company = n; Session.set(s); const el = $('#co'); if (el) el.textContent = n; const e2 = $('#co2'); if (e2) e2.textContent = n; } }

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

// ── Languages ─────────────────────────────────────────────────────────────────────────────
// Google Translate only changes what is SHOWN. Everything saved stays English:
//  • every <option> gets a fixed English value before translation can touch it
//  • data (table cells, names, codes, dropdown values, inputs) is marked "do not translate"
//  • the server refuses non-English letters in typed text (see the API)
const LANGS = [['ta', 'தமிழ் · Tamil'], ['en', 'English'], ['kn', 'ಕನ್ನಡ · Kannada'], ['hi', 'हिन्दी · Hindi'], ['te', 'తెలుగు · Telugu'], ['ml', 'മലയാളം · Malayalam'], ['mr', 'मराठी · Marathi']];
const KEEP_ENGLISH = 'td,option,select,input,textarea,.pill,.tag-inc,.av,.av-i,.sb-av,.sb-who,.sb-brand b,#co,#co2,.credit,.lang-pick,.kv-v,code,.dup,'
  + '.nm,.meta,#plist li:not(.cat),#qList li span:first-child,#dEmpT,#kT,#kS,#cT,#cS,.rp .rt span,.rp .co,.nt';
function protectNode(root) {
  if (!root || root.nodeType !== 1) return;
  const els = root.matches && root.matches('option,' + KEEP_ENGLISH) ? [root] : [];
  root.querySelectorAll && els.push(...root.querySelectorAll('option,' + KEEP_ENGLISH));
  els.forEach(el => {
    if (el.tagName === 'OPTION' && !el.hasAttribute('value')) el.setAttribute('value', el.textContent);   // the saved value is the English text
    if (el.getAttribute('translate') !== 'no') el.setAttribute('translate', 'no');
  });
  // "Label: value" blocks — the label may be translated, the value stays as stored
  const kv = root.matches && root.matches(KV_SEL) ? [root] : [];
  root.querySelectorAll && kv.push(...root.querySelectorAll(KV_SEL));
  kv.forEach(div => [...div.childNodes].forEach((n, i) => {
    if (i === 0 && n.nodeName === 'SPAN') return;
    if (n.nodeType === 3 && n.textContent.trim()) { const w = document.createElement('span'); w.setAttribute('translate', 'no'); n.replaceWith(w); w.appendChild(n); }
    else if (n.nodeType === 1 && n.getAttribute('translate') !== 'no') n.setAttribute('translate', 'no');
  }));
}
const KV_SEL = '.kv > div, .kv2 > div, #cKv > div';
protectNode(document.documentElement);
new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(protectNode))).observe(document.documentElement, { childList: true, subtree: true });

function curLang() { const m = document.cookie.match(/(?:^|;\s*)googtrans=\/en\/([a-z-]+)/i); return m ? m[1] : 'en'; }
function setLang(code) {
  const exp = code === 'en' ? 'Thu, 01 Jan 1970 00:00:00 GMT' : new Date(Date.now() + 365 * 864e5).toUTCString();
  document.cookie = `googtrans=/en/${code};expires=${exp};path=/`;
  try { localStorage.setItem('hr_lang', code); } catch {}
  location.reload();
}
// Enabled languages (Settings → Languages). English is always there once any other language is on.
function enabledLangs(list) { const on = (list || []).filter(c => c !== 'en'); return on.length ? LANGS.filter(([c]) => c === 'en' || on.includes(c)) : []; }
function langPicker(list, id = 'langSel') {
  const L = enabledLangs(list); if (!L.length) return '';
  const cur = curLang();
  return `<label class="lang-pick" translate="no"><span aria-hidden="true">🌐</span><select id="${id}" aria-label="Language">${L.map(([c, n]) => `<option value="${c}" ${c === cur ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
}
function wireLangPicker(id = 'langSel') { const s = document.getElementById(id); if (s) s.onchange = () => setLang(s.value); }
// Loads Google's translator only when a non-English language is chosen and allowed for this company
function startTranslator(list) {
  const cur = curLang(), L = enabledLangs(list);
  if (cur === 'en') return;
  if (!L.some(([c]) => c === cur)) { setLang('en'); return; }        // language was switched off by C&B
  if (window.__gtLoaded) return; window.__gtLoaded = true;
  const box = document.createElement('div'); box.id = 'gtBox'; box.style.display = 'none'; document.body.appendChild(box);
  window.__gtInit = () => { try { new google.translate.TranslateElement({ pageLanguage: 'en', includedLanguages: L.map(([c]) => c).join(','), autoDisplay: false }, 'gtBox'); } catch (e) { } };
  const sc = document.createElement('script'); sc.src = 'https://translate.google.com/translate_a/element.js?cb=__gtInit'; sc.async = true;
  sc.onerror = () => console.warn('Translation service not reachable — showing English');
  document.head.appendChild(sc);
}
