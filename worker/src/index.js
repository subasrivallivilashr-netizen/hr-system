/**
 * HR Management System — API (Cloudflare Worker)
 * All requests go through one Durable Object ("Hub"), which:
 *   - keeps an in-memory cache of sheet tabs (fast reads, few Google calls)
 *   - runs writes one at a time (no clashes, no duplicate IDs)
 * Data lives in Google Sheets; spreadsheet IDs come from the Settings > Registry tab.
 */

const enc = new TextEncoder();
const READ_TTL_MS = 5 * 60 * 1000;      // cached tab lifetime
const SESSION_HOURS = 12;
const PBKDF2_ITER = 100000;

// ───────────────────────── Worker entry ─────────────────────────
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (new URL(request.url).pathname.startsWith('/__')) return new Response('Not found', { status: 404 });
    const id = env.HUB.idFromName('main');
    const res = await env.HUB.get(id).fetch(request);
    const out = new Response(res.body, res);
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  },
  // Daily job (see wrangler.toml [triggers]): deletes files of rejected candidates after the retention period
  async scheduled(event, env, ctx) {
    const id = env.HUB.idFromName('main');
    ctx.waitUntil(env.HUB.get(id).fetch(new Request('https://internal/__cleanup', { method: 'POST' })));
  }
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

// ───────────────────────── Durable Object ─────────────────────────
export class Hub {
  constructor(state, env) {
    this.env = env;
    this.state = state;
    this.cache = new Map();          // key -> {at, rows}
    this.writeChain = Promise.resolve();
    this.gToken = null; this.gTokenExp = 0;
    this.registry = null; this.registryAt = 0;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/__cleanup') return json({ ok: true, ...(await this.serialWrite(() => this.purgeRejected('daily job'))) });
      let body = {};
      if (request.method === 'POST') body = await request.json().catch(() => ({}));
      else url.searchParams.forEach((v, k) => body[k] = v);
      const action = body.action;
      const handler = ACTIONS[action];
      if (!handler) return json({ ok: false, error: 'Unknown action: ' + action }, 400);

      let user = null;
      if (handler.auth) {
        user = await this.verifySession(request.headers.get('Authorization'));
        if (!user) return json({ ok: false, error: 'Not logged in or session expired' }, 401);
        if (handler.roles && !handler.roles.includes(user.r)) return json({ ok: false, error: 'Not allowed for your role' }, 403);
      }
      const need = moduleFor(action, body);
      if (need) {
        const on = await this.modules();
        if (!need.some(m => on.includes(m))) return json({ ok: false, error: 'This part of the app is not enabled for your company. Contact C&B to enable it.', moduleOff: need }, 403);
      }
      const run = () => handler.fn.call(this, body, user);
      let result;
      if (handler.write && body.reqId) {
        // Same click arriving twice (double tap, slow network retry): run once, answer both with the first result
        this.done = this.done || new Map();
        const key = (user ? user.u : 'public') + ':' + action + ':' + String(body.reqId).slice(0, 64), now = Date.now();
        result = await this.serialWrite(async () => {
          for (const [k, v] of this.done) if (now - v.at > 15 * 60000) this.done.delete(k);
          const hit = this.done.get(key);
          if (hit) return { ...hit.result, repeated: true };
          const out = await run();
          if (!(out && out.__raw)) this.done.set(key, { at: Date.now(), result: out });
          return out;
        });
      } else result = handler.write ? await this.serialWrite(run) : await run();
      if (result && result.__raw) return result.__raw;
      return json({ ok: true, ...result });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }

  serialWrite(fn) {
    const p = this.writeChain.then(fn, fn);
    this.writeChain = p.catch(() => {});
    return p;
  }

  // ── Google auth (service account JWT) ──
  async googleToken() {
    if (this.gToken && Date.now() < this.gTokenExp - 60000) return this.gToken;
    const sa = JSON.parse(this.env.GOOGLE_SA_KEY);
    const now = Math.floor(Date.now() / 1000);
    const head = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64urlStr(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
    }));
    const key = await crypto.subtle.importKey('pkcs8', pemToBuf(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + claim));
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claim + '.' + b64url(sig)
    });
    const j = await res.json();
    if (!j.access_token) throw new Error('Google sign-in failed: ' + (j.error_description || j.error));
    this.gToken = j.access_token; this.gTokenExp = Date.now() + j.expires_in * 1000;
    return this.gToken;
  }

  async gfetch(url, opts = {}) {
    const token = await this.googleToken();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
      const j = await res.json().catch(() => ({}));
      if (res.ok) return j;
      // Google's per-minute limit: wait and try again (2 s, 5 s, 12 s) before giving up
      if (res.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, [2000, 5000, 12000][attempt])); continue; }
      if (res.status === 429) throw new Error('Google Sheets is busy right now (too many requests in the last minute). Please wait a minute and try again.');
      throw new Error('Google Sheets error ' + res.status + ': ' + (j.error && j.error.message || ''));
    }
  }

  // ── Registry: module key -> spreadsheet ID ──
  async getRegistry(force) {
    if (!force && this.registry && Date.now() - this.registryAt < READ_TTL_MS) return this.registry;
    const rows = await this.fetchTab(this.env.SETTINGS_SHEET_ID, 'Registry');
    const reg = {};
    rows.forEach(r => { if (r.Key) reg[r.Key] = r.SpreadsheetId; });
    reg.Settings = reg.Settings || this.env.SETTINGS_SHEET_ID;
    this.registry = reg; this.registryAt = Date.now();
    return reg;
  }

  async ssId(module) {
    const reg = await this.getRegistry();
    if (reg[module]) return reg[module];
    const yearly = module + '_' + new Date().getFullYear();
    if (reg[yearly]) return reg[yearly];
    if (/_\d{4}$/.test(module)) throw new Error(`The ${module.replace('_', ' ')} spreadsheet does not exist yet. Run the setup script for that year.`);
    throw new Error('Spreadsheet not found in Registry: ' + module);
  }

  async fetchTab(ssId, tab, key) {
    const j = await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent(tab)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
    if (key) this.keepHead(key, j.values);
    return rowsOf(j.values);
  }
  keepHead(key, values) {                 // the first row of a read is the header row: no separate request needed
    this.headCache = this.headCache || new Map();
    if (values && values[0] && values[0].length) this.headCache.set(key, values[0]);
  }

  // Durable memory (Durable Object storage): which tabs exist, per spreadsheet. Survives restarts and new deploys.
  async persisted() {
    if (this._pers) return this._pers;
    let saved = null;
    try { saved = this.state && this.state.storage ? await this.state.storage.get('tabTitles') : null; } catch (e) { saved = null; }
    this._pers = { titles: new Map(Object.entries(saved || {}).map(([k, v]) => [k, new Set(v)])) };
    return this._pers;
  }
  async savePersisted() {
    if (!(this.state && this.state.storage)) return;
    const o = {}; this._pers.titles.forEach((v, k) => o[k] = [...v]);
    try { await this.state.storage.put('tabTitles', o); } catch (e) { /* memory only */ }
  }
  // Tab names of a spreadsheet (one metadata request the first time, then remembered)
  async tabTitles(ssId, fresh) {
    const P = await this.persisted();
    if (!fresh && P.titles.has(ssId)) return P.titles.get(ssId);
    const meta = await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}?fields=sheets.properties.title`);
    const set = new Set((meta.sheets || []).map(x => x.properties.title));
    P.titles.set(ssId, set); await this.savePersisted();
    return set;
  }

  // Loads many tabs at once: one batchGet per spreadsheet, all spreadsheets in parallel. Fills the read cache.
  async prefetch(pairs) {
    const now = Date.now(), by = {};
    pairs.forEach(([m, t]) => { const h = this.cache.get(m + '/' + t); if (!(h && now - h.at < READ_TTL_MS)) (by[m] = by[m] || []).push(t); });
    if (!Object.keys(by).length) return;
    const reg = await this.getRegistry(); await this.googleToken();
    await Promise.all(Object.entries(by).map(async ([m, tabs]) => {
      if (!reg[m]) return;
      const id = await this.ssId(m);
      const tryGet = async list => {
        const q = list.map(t => 'ranges=' + encodeURIComponent(t)).join('&');
        const j = await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
        (j.valueRanges || []).forEach((vr, i) => { this.keepHead(m + '/' + list[i], vr.values); this.cache.set(m + '/' + list[i], { at: Date.now(), rows: rowsOf(vr.values) }); });
      };
      try { await tryGet(tabs); }
      catch (e) {                                   // a tab is missing → keep only tabs that exist and retry once
        if (BUSY(e)) throw e;
        try { const have = await this.tabTitles(id, true); const ok = tabs.filter(t => have.has(t));
          if (ok.length) await tryGet(ok); } catch (e2) { if (BUSY(e2)) throw e2; /* fall back to normal reads */ }
      }
    }));
  }

  // Cached read: (module, tab) -> array of row objects (see rowsOf)
  async read(module, tab) {
    const key = module + '/' + tab;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.rows;
    // Cache miss: refresh every tab of this spreadsheet in ONE request (the yearly KPI / log books are read tab by tab)
    if (!/^(KPI|ActivityLog)_/.test(module)) {
      try {
        this.inflight = this.inflight || new Map();
        let job = this.inflight.get(module);            // reads of the same spreadsheet at the same moment share one request
        if (!job) {
          job = (async () => { const id = await this.ssId(module), titles = await this.tabTitles(id); await this.prefetch([...titles].map(t => [module, t])); })();
          this.inflight.set(module, job);
          job.finally(() => this.inflight.delete(module)).catch(() => {});
        }
        await job;
        const hit2 = this.cache.get(key); if (hit2) return hit2.rows;
      } catch (e) { if (BUSY(e)) throw e; /* fall back to a single read */ }
    }
    let rows;
    try { rows = await this.fetchTab(await this.ssId(module), tab, key); }
    catch (e) {
      // Tab deleted by hand in Google Sheets: recreate it (when the app knows its columns) and read again
      const heads = this.tabHeads && this.tabHeads.get(key);
      if (!/Unable to parse range/i.test(e.message) || !heads || this._repairing) throw e;
      this._repairing = true;
      try { await this.tabTitles(await this.ssId(module), true); this.tabsOk.delete(key); await this.ensureTab(module, tab, heads); }
      finally { this._repairing = false; }
      rows = await this.fetchTab(await this.ssId(module), tab, key);
    }
    this.cache.set(key, { at: Date.now(), rows });
    return rows;
  }

  async headers(module, tab) {
    this.headCache = this.headCache || new Map();
    const hk = module + '/' + tab;
    if (this.headCache.has(hk)) return this.headCache.get(hk);
    await this.read(module, tab).catch(e => { if (BUSY(e)) throw e; });     // a normal read also keeps the header row
    if (this.headCache.has(hk)) return this.headCache.get(hk);
    const id = await this.ssId(module);
    const j = await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!1:1`);
    const h = (j.values && j.values[0]) || [];
    if (h.length) this.headCache.set(hk, h);
    return h;
  }

  // Append objects as rows (columns matched by header name)
  async append(module, tab, objs) {
    const id = await this.ssId(module);
    const head = await this.headers(module, tab);
    const values = objs.map(o => head.map(h => o[h] === undefined ? '' : o[h]));
    await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values }) });
    this.cache.delete(module + '/' + tab);
  }

  // Update the first row where row[keyCol] === keyVal
  async update(module, tab, keyCol, keyVal, changes) {
    this.cache.delete(module + '/' + tab);
    const rows = await this.read(module, tab);
    const row = rows.find(r => String(r[keyCol]) === String(keyVal));
    if (!row) throw new Error(`${tab}: no row with ${keyCol} = ${keyVal}`);
    const head = await this.headers(module, tab);
    const merged = head.map(h => (h in changes ? changes[h] : row[h]));
    const id = await this.ssId(module);
    await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!A${row._row}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [merged] }) });
    this.cache.delete(module + '/' + tab);
  }

  async empContext() {
    const employees = await this.read('Organisation', 'Employees');
    const positions = (await this.read('Organisation', 'Positions')).filter(p => p.Active !== 'No');
    const stores = (await this.read('Settings', 'Stores')).filter(s => s.Active !== 'No');
    const company = {}; (await this.read('Settings', 'Company')).forEach(r => company[r.Key] = r.Value);
    return { employees, positions, stores, company };
  }

  // Generates the next IDs (one per store code given) and saves the counters
  async nextEmpIds(storeCodes, ctx) {
    if (!storeCodes.length) return [];
    const c = ctx.company, perStore = c.EmpIdPerStore === 'Yes';
    const prefix = c.EmpIdPrefix || 'EMP-', digits = Number(c.EmpIdDigits || 4);
    const counters = {}, out = [];
    for (const sc of storeCodes) {
      const key = perStore ? 'EmpIdNext_' + sc : 'EmpIdNextNumber';
      if (!(key in counters)) counters[key] = Number(c[key] || 1);
      out.push(prefix + (perStore ? sc + '-' : '') + String(counters[key]++).padStart(digits, '0'));
    }
    const rows = await this.read('Settings', 'Company');
    for (const [k, v] of Object.entries(counters)) {
      if (rows.find(r => r.Key === k)) await this.update('Settings', 'Company', 'Key', k, { Value: v });
      else await this.append('Settings', 'Company', [{ Key: k, Value: v }]);
    }
    return out;
  }

  // Replace all data rows of a tab (used for small lists that are edited as a whole)
  async rewriteTab(module, tab, objs) {
    const id = await this.ssId(module);
    const head = await this.headers(module, tab);
    await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!A2:ZZ:clear`, { method: 'POST', body: '{}' });
    if (objs.length) {
      const values = objs.map(o => head.map(h => o[h] === undefined ? '' : o[h]));
      await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!A2?valueInputOption=RAW`,
        { method: 'PUT', body: JSON.stringify({ values }) });
    }
    this.cache.delete(module + '/' + tab);
  }

  async writeRole(code, summary, duties, keepDutiesIfEmpty) {
    const sums = await this.read('Library', 'Role_Summary');
    const old = sums.find(x => x.PositionCode === code);
    const version = old ? Number(old.Version || 0) + 1 : 1;
    const row = roleRow(code, summary, version);
    if (old) await this.update('Library', 'Role_Summary', 'PositionCode', code, row);
    else await this.append('Library', 'Role_Summary', [row]);
    if (duties.length || !keepDutiesIfEmpty) {
      const all = (await this.read('Library', 'Role_Responsibilities')).map(clean).filter(x => x.PositionCode !== code);
      duties.filter(d => String(d.Responsibility || '').trim()).forEach((d, i) =>
        all.push({ PositionCode: code, SlNo: i + 1, Responsibility: String(d.Responsibility).trim(), Frequency: d.Frequency || 'Daily' }));
      await this.rewriteTab('Library', 'Role_Responsibilities', all);
    }
    return version;
  }

  // Adds any missing column headings to row 1 of a tab
  async ensureColumns(module, tab, cols) {
    const head = await this.headers(module, tab);
    const missing = cols.filter(c => !head.includes(c));
    if (!missing.length) return;
    const id = await this.ssId(module);
    // Widen the tab first if it is too narrow for the new columns
    const meta = await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
    const sh = (meta.sheets || []).map(x => x.properties).find(pr => pr.title === tab);
    if (!sh) throw new Error('Tab not found: ' + tab);
    const need = head.length + missing.length - sh.gridProperties.columnCount;
    if (need > 0) await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`,
      { method: 'POST', body: JSON.stringify({ requests: [{ appendDimension: { sheetId: sh.sheetId, dimension: 'COLUMNS', length: need } }] }) });
    const start = colLetter(head.length + 1);
    await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!${start}1?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [missing] }) });
    this.headCache.set(module + '/' + tab, head.concat(missing));
    this.cache.delete(module + '/' + tab);
  }

  // Team in scope for this user + KPI setup for a month
  async kpiContext(month, user) {
    const emps = await this.read('Organisation', 'Employees');
    const monthEnd = month + '-31';
    let employees = emps.filter(e => !GONE(e.Status) && (!e.JoiningDate || e.JoiningDate <= monthEnd));
    if (user.r === ROLES.MANAGER) {
      if (!user.e) throw new Error('Your login is not linked to an employee. Ask Admin to link it in Settings → Users.');
      employees = employees.filter(e => e.ReportingManagerId === user.e);
    }
    employees = employees.map(e => ({ EmpId: e.EmpId, FullName: e.FullName, PositionCode: e.PositionCode, StoreCode: e.StoreCode, ReportingManagerId: e.ReportingManagerId, JoiningDate: e.JoiningDate }));
    const params = (await this.read('Performance', 'KPI_Parameters')).map(clean).filter(k => k.Active !== 'No');
    let bands = (await this.read('Performance', 'Rating_Bands')).map(clean); if (!bands.length) bands = DEFAULT_BANDS;
    const cycle = (await this.read('Performance', 'KPI_Cycles')).find(c => c.Month === month) || { Month: month, Status: 'Open' };
    const positions = (await this.read('Organisation', 'Positions')).map(p => ({ PositionCode: p.PositionCode, PositionName: p.PositionName }));
    return { employees, team: new Set(employees.map(e => e.EmpId)), params, bands, cycle: clean(cycle), positions };
  }

  // Update rows whose key matches, append the rest — 2-3 Google calls whatever the size
  async upsertMany(module, tab, keyCols, objs) {
    this.cache.delete(module + '/' + tab);
    const rows = await this.read(module, tab);
    const head = await this.headers(module, tab);
    const key = o => keyCols.map(k => String(o[k])).join('|');
    const at = new Map(rows.map(r => [key(r), r._row]));
    const id = await this.ssId(module);
    const data = [], fresh = [];
    objs.forEach(o => {
      const vals = head.map(h => o[h] === undefined ? '' : o[h]);
      const r = at.get(key(o));
      if (r) data.push({ range: `${tab}!A${r}`, values: [vals] }); else fresh.push(vals);
    });
    if (data.length) await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`,
      { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });
    if (fresh.length) await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: fresh }) });
    this.cache.delete(module + '/' + tab);
  }

  async companyMap() {
    const c = {}; (await this.read('Settings', 'Company')).forEach(r => c[r.Key] = r.Value); return c;
  }
  async setCompany(values) {
    const rows = await this.read('Settings', 'Company');
    const upd = Object.entries(values).map(([Key, Value]) => ({ Key, Value }));
    await this.upsertMany('Settings', 'Company', ['Key'], upd);
    return rows;
  }
  async candidate(appNo) {
    const c = (await this.read('Hiring', 'Candidates')).find(x => x.AppNo === appNo);
    if (!c) throw new Error('Candidate not found: ' + appNo);
    return c;
  }
  async position(code) {
    const p = (await this.read('Organisation', 'Positions')).find(x => x.PositionCode === String(code || '').toUpperCase() && x.Active !== 'No');
    if (!p) throw new Error('Unknown position: ' + code);
    return p;
  }
  async liveToken(token) {
    const t = (await this.read('Hiring', 'Interview_Tokens')).find(x => x.Token === String(token || ''));
    if (!t) throw new Error('This link is not valid.');
    if (t.Status === 'Completed') throw new Error('This interview has already been submitted. Thank you.');
    if (t.Status !== 'Pending') throw new Error('This link has been replaced by a newer one. Ask HR for the latest link.');
    if (new Date(t.ExpiresAt) < new Date()) throw new Error('This link has expired (links are valid for 24 hours). Ask HR for a new one.');
    return t;
  }
  async createCandidate(c, by, files, opt = {}) {
    files = (files || []).filter(f => f && f.data);
    const company0 = await this.companyMap();
    const form = await this.applyForm();
    c = checkAnswers(form, c);                        // types, dropdown values; throws on a bad value
    const filesOn = company0.UploadUrl && (await this.modules()).includes('FILES');
    if (!filesOn) files = [];
    const gaps = await this.candidateGaps(c, form, files.map(f => String(f.docType).toUpperCase()));
    let incomplete = false;
    if (gaps.length) {
      const docNames = (await this.docTypes()).map(d => d.Name);
      const docsMissing = gaps.filter(g => docNames.includes(g)), answersMissing = gaps.filter(g => !docNames.includes(g));
      if (!opt.hr) throw new Error(answersMissing.length ? 'Please answer: ' + answersMissing.join(', ') : 'Please attach: ' + docsMissing.join(', '));
      if (!opt.allowIncomplete) return { needConfirm: true, missing: gaps };
      incomplete = true;
    }
    files.forEach(f => { f.docType = String(f.docType || '').toUpperCase(); if (!CANDIDATE_FORM_DOCS.includes(f.docType)) throw new Error('Unknown attachment'); checkFile(f); });
    const name = String(c.Name || '').trim(), phone = String(c.Phone || '').replace(/\D/g, '');
    if (!name) throw new Error('Name is required');
    if (!/^\d{10}$/.test(phone)) throw new Error('Phone must be 10 digits');
    const pos = await this.position(c.PositionCode);
    if (!pos.ParentPositionCode) throw new Error('Choose the position you are applying for');
    const all = await this.read('Hiring', 'Candidates');
    const dup = all.find(x => String(x.Phone) === phone);
    const year = new Date().getFullYear(), key = 'AppNext_' + year;
    const company = await this.companyMap();
    let n = Number(company[key] || 1), appNo;
    do { appNo = `APP-${year}-${String(n++).padStart(4, '0')}`; } while (all.find(x => x.AppNo === appNo));
    await this.setCompany({ [key]: n });
    const now = new Date().toISOString(), row = {};
    CAND_FIELDS.forEach(k => row[k] = String(c[k] ?? '').trim());
    const custom = form.filter(f => f.System !== 'Yes').map(f => f.Code);
    await this.ensureColumns('Hiring', 'Candidates', custom.concat(['Incomplete']));
    custom.forEach(k => row[k] = String(c[k] ?? '').trim());
    if (incomplete) row.Incomplete = 'Yes';
    Object.assign(row, { AppNo: appNo, Name: name, Phone: phone, PositionCode: pos.PositionCode, Status: 'New', Date: now.slice(0, 10),
      DOB: c.DOB ? normDate(c.DOB) : '', IsDuplicatePhone: dup ? 'Yes' : 'No', CreatedAt: now, UpdatedAt: now, Source: row.Source || 'Walk-in' });
    await this.append('Hiring', 'Candidates', [row]);
    await this.log('Hiring', appNo, 'Applied', `${pos.PositionName} · ${by}${incomplete ? ' · saved incomplete: ' + gaps.join(', ') : ''}`, by);
    let fileNote = '';
    if (files.length) { try { await this.storeFiles(appNo, 'Candidates/' + appNo, files, by, ''); } catch (e) { fileNote = 'Application saved, but the files could not be uploaded: ' + e.message; } }
    return { appNo, fileNote, incomplete, duplicate: dup ? { AppNo: dup.AppNo, Name: dup.Name, Date: dup.Date } : null };
  }
  async recordRejection(c, stage, remarks, by, reason) {
    await this.ensureColumns('Hiring', 'Rejected_Candidates', ['Reason']);
    await this.append('Hiring', 'Rejected_Candidates', [{ AppNo: c.AppNo, Name: c.Name, Phone: c.Phone, PositionCode: c.PositionCode,
      Source: c.Source, Stage: stage, RejectionDate: new Date().toISOString().slice(0, 10), RejectedBy: by, Remarks: remarks || '', Reason: reason || '' }]);
  }

  // Enabled modules (Settings → Modules). Not set yet = everything on, so older setups keep working.
  async modules() {
    const v = String((await this.companyMap()).Modules ?? '').trim();
    if (!v) return Object.keys(MODULES);
    return v === 'NONE' ? [] : v.split(',').map(x => x.trim()).filter(m => MODULES[m]);
  }

  // ── Apply form questions & editable lists (Settings sheet) ──
  async formTabs() {
    await this.ensureTab('Settings', 'Apply_Form', FORM_HEAD);
    await this.ensureTab('Settings', 'Lists', ['List', 'Value', 'Order']);
  }
  async applyForm() {
    await this.formTabs();
    let rows = (await this.read('Settings', 'Apply_Form')).map(clean);
    if (!rows.length) { rows = defaultForm(); await this.rewriteTab('Settings', 'Apply_Form', rows); }
    return rows.sort((a, b) => Number(a.Order) - Number(b.Order));
  }
  async lists() {
    await this.formTabs();
    const rows = (await this.read('Settings', 'Lists')).map(clean), out = {};
    if (!rows.length) {
      const seed = []; Object.entries(LIST_DEFS).forEach(([k, d]) => d.values.forEach((v, i) => seed.push({ List: k, Value: v, Order: i + 1 })));
      await this.rewriteTab('Settings', 'Lists', seed);
      return this.lists();
    }
    Object.keys(LIST_DEFS).forEach(k => {
      const mine = rows.filter(r => r.List === k).sort((a, b) => Number(a.Order) - Number(b.Order)).map(r => String(r.Value));
      out[k] = mine.length ? mine : LIST_DEFS[k].values.slice();
    });
    return out;
  }
  // Mandatory answers / documents still missing for a candidate (used for HR walk-ins saved as Incomplete)
  async candidateGaps(c, form, uploadedTypes) {
    const miss = form.filter(f => f.Setting === 'Mandatory' && !FORM_LOCKED.includes(f.Code) && !String(c[f.Code] ?? '').trim()).map(f => f.Label);
    const company = await this.companyMap();
    if (company.UploadUrl && (await this.modules()).includes('FILES')) {
      const types = uploadedTypes || (await this.read('Organisation', 'Files').catch(() => [])).filter(x => x.Ref === c.AppNo && x.Status !== 'Deleted').map(x => x.DocType);
      (await this.docTypes()).filter(d => CANDIDATE_FORM_DOCS.includes(d.Code) && d.CandidateForm === 'Mandatory' && d.Active !== 'No' && !types.includes(d.Code)).forEach(d => miss.push(d.Name));
    }
    return miss;
  }
  async refreshIncomplete(appNo) {
    const c = await this.candidate(appNo);
    if (c.Incomplete !== 'Yes') return;
    if (!(await this.candidateGaps(c, await this.applyForm())).length)
      await this.update('Hiring', 'Candidates', 'AppNo', appNo, { Incomplete: '', UpdatedAt: new Date().toISOString() });
  }
  // Template rows; fills the default list the first time
  async checklistTemplate(kind) {
    let rows = (await this.read('HR_Ops', kind + '_Template')).map(clean);
    if (!rows.length) {
      rows = defaultTemplate(kind);
      await this.rewriteTab('HR_Ops', kind + '_Template', rows);
    }
    return rows;
  }
  // Creates a record + one item row per active template item (returns existing open record if any)
  async startChecklist(kind, e, extra) {
    const recs = await this.read('HR_Ops', kind + '_Records');
    const open = recs.find(r => r.EmpId === e.EmpId && !['Completed', 'Cancelled'].includes(r.Status));
    if (open) { if (kind === 'Exit') throw new Error('An exit is already in progress for this employee'); return clean(open); }
    if (kind === 'Onboarding' && recs.find(r => r.EmpId === e.EmpId && r.Status === 'Completed')) throw new Error('Onboarding already completed for this employee');
    const tpl = (await this.checklistTemplate(kind)).filter(t => t.Active !== 'No');
    const now = new Date().toISOString();
    let rid = (kind === 'Exit' ? 'EX-' : 'OB-') + e.EmpId + '-' + now.slice(0, 10).replace(/-/g, ''), n = 2;
    while (recs.find(r => r.RecordId === rid)) rid = rid.replace(/-\d+$/, m => m.length > 3 ? m : '') + '-' + n++;   // restarted the same day after a cancel
    const rec = { RecordId: rid, EmpId: e.EmpId, EmployeeName: e.FullName,
      PositionCode: e.PositionCode, Status: 'In Progress', CreatedAt: now, CompletedAt: '', ...(kind === 'Exit' ? extra : { JoiningDate: e.JoiningDate }) };
    await this.append('HR_Ops', kind + '_Records', [rec]);
    await this.append('HR_Ops', kind + '_Items', tpl.map(t => ({ RecordId: rec.RecordId, ItemId: t.ItemId, Status: '', Remarks: '', DoneBy: '', DoneAt: '' })));
    return rec;
  }

  // Creates a tab (with headings) if it does not exist yet
  // Creates a tab with its header row when missing. Safe when two requests ask at the same time.
  async ensureTab(module, tab, headers) {
    this.tabsOk = this.tabsOk || new Set(); this.tabLocks = this.tabLocks || new Map();
    const key = module + '/' + tab;
    this.tabHeads = this.tabHeads || new Map(); this.tabHeads.set(key, headers);      // remembered so a deleted tab can be rebuilt
    if (this.tabsOk.has(key)) return;
    if (this.tabLocks.has(key)) return this.tabLocks.get(key);          // someone is already creating it: wait for them
    const job = (async () => {
      const id = await this.ssId(module);
      let titles = await this.tabTitles(id);
      if (!titles.has(tab)) titles = await this.tabTitles(id, true);      // remembered list may be old: check once with Google
      if (!titles.has(tab)) {
        let created = true;
        try {
          await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, { method: 'POST',
            body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab, gridProperties: { rowCount: 1000, columnCount: Math.max(12, headers.length) } } } }] }) });
        } catch (e) { if (!/already exists/i.test(e.message)) throw e; created = false; }
        if (created) await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!A1?valueInputOption=RAW`,
          { method: 'PUT', body: JSON.stringify({ values: [headers] }) });
        titles.add(tab); await this.savePersisted();
        if (this.headCache) this.headCache.delete(key);
        this.cache.delete(key);
      } else if (!(await this.headers(module, tab)).length) {
        // tab exists but its header row is empty (created half-way earlier): write the header (usually no extra read — the batch read has it)
        await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!A1?valueInputOption=RAW`,
          { method: 'PUT', body: JSON.stringify({ values: [headers] }) });
        if (this.headCache) this.headCache.delete(key);
        this.cache.delete(key);
      }
      this.tabsOk.add(key);
    })();
    this.tabLocks.set(key, job);
    try { await job; } finally { this.tabLocks.delete(key); }
  }
  async letterTabs() {
    await this.ensureTab('Settings', 'Letter_Templates', ['Type', 'Title', 'Ref', 'Body', 'CustomHTML', 'UpdatedBy', 'UpdatedAt']);
    await this.ensureTab('Settings', 'Salary_Components', ['Name', 'Type', 'Order', 'Active']);
    await this.ensureTab('Organisation', 'Salary', ['Ref', 'Components', 'MonthlyEarnings', 'MonthlyDeductions', 'MonthlyEmployer', 'MonthlyNet', 'AnnualCTC', 'EffectiveFrom', 'UpdatedBy', 'UpdatedAt']);
    await this.ensureTab('Library', 'Letters_Issued', ['LetterNo', 'Type', 'Ref', 'Name', 'Title', 'IssuedOn', 'IssuedBy', 'Snapshot']);
  }
  async salaryOf(ref) {
    const r = (await this.read('Organisation', 'Salary')).find(s => s.Ref === ref);
    return r ? { ...clean(r), Components: parseJSON(r.Components) || {} } : null;
  }
  // Known placeholder values for a candidate (AppNo) or employee (EmpId)
  async letterFields(kind, ref, company) {
    const f = { CompanyName: company.CompanyName || '', CompanyAddress: String(company.BrandHeader || '').split('\n').filter(Boolean).join(', '),
      SignatoryName: company.BrandSignatoryName || '', SignatoryDesignation: company.BrandSignatoryDesignation || '', Today: longDate(new Date()),
      ProbationDays: company.ProbationDays || '' };
    const positions = await this.read('Organisation', 'Positions'), stores = await this.read('Settings', 'Stores');
    const P = c => positions.find(p => p.PositionCode === c) || {}, ST = c => stores.find(s => s.StoreCode === c) || {};
    const person = (x) => { f.Name = x.Name || x.FullName; f.FirstName = String(f.Name || '').split(' ')[0]; f.Salutation = x.Gender === 'Female' ? 'Ms.' : x.Gender === 'Male' ? 'Mr.' : '';
      f.Phone = x.Phone || ''; f.Email = x.Email || ''; };
    if (kind === 'candidate') {
      const c = await this.candidate(ref); person(c);
      Object.assign(f, { AppNo: c.AppNo, Address: c.Address || '', CityState: c.CityState || '', Position: P(c.PositionCode).PositionName || c.PositionCode,
        Department: P(c.PositionCode).Department || '', StoreName: ST(c.StoreCode).StoreName || '', StoreCity: ST(c.StoreCode).City || '', NoticePeriod: c.NoticePeriod || '' });
      const s = (await this.read('Hiring', 'Interview_Schedule')).find(x => x.AppNo === ref) || {};
      if (s.InterviewDate) { const [d, t] = String(s.InterviewDate).split('T'); f.InterviewDate = longDate(d); f.InterviewTime = t ? t.slice(0, 5) : ''; f.InterviewPlace = s.InterviewRemarks || ''; }
      const o = (await this.read('Hiring', 'Selection_Offer')).find(x => x.AppNo === ref) || {};
      if (o.EstDOJ) f.ExpectedJoiningDate = longDate(o.EstDOJ);
      if (o.NoticePeriod) f.NoticePeriod = o.NoticePeriod;
    } else {
      const emps = await this.read('Organisation', 'Employees');
      const e = emps.find(x => x.EmpId === ref); if (!e) throw new Error('Employee not found: ' + ref);
      person(e);
      const m = emps.find(x => x.EmpId === e.ReportingManagerId) || {};
      Object.assign(f, { EmpId: e.EmpId, Position: P(e.PositionCode).PositionName || e.PositionCode, Department: P(e.PositionCode).Department || '',
        StoreName: ST(e.StoreCode).StoreName || '', StoreCity: ST(e.StoreCode).City || '', ReportingManager: m.FullName || '', ReportingManagerPosition: P(m.PositionCode).PositionName || '',
        JoiningDate: longDate(e.JoiningDate), ProbationEndDate: longDate(e.ProbationEndDate), EmploymentType: e.EmploymentType || '', Tenure: tenure(e.JoiningDate, e.ExitDate) });
      if (e.CandidateAppNo) { const c = (await this.read('Hiring', 'Candidates')).find(x => x.AppNo === e.CandidateAppNo); if (c) { f.Address = c.Address || ''; f.CityState = c.CityState || ''; } }
      const ex = (await this.read('HR_Ops', 'Exit_Records')).filter(r => r.EmpId === e.EmpId).sort((a, b) => (a.CreatedAt < b.CreatedAt ? 1 : -1))[0];
      if (ex) { f.LastWorkingDay = longDate(ex.LastWorkingDay); f.ExitReason = ex.Reason || ''; }
      else if (e.ExitDate) f.LastWorkingDay = longDate(e.ExitDate);
      const tr = (await this.read('Organisation', 'TransferHistory')).filter(t => t.EmpId === e.EmpId).sort((a, b) => (a.Date < b.Date ? 1 : -1))[0];
      if (tr) Object.assign(f, { PreviousPosition: P(tr.FromPosition).PositionName || tr.FromPosition, NewPosition: P(tr.ToPosition).PositionName || tr.ToPosition,
        PreviousStore: ST(tr.FromStore).StoreName || tr.FromStore, NewStore: ST(tr.ToStore).StoreName || tr.ToStore, TransferDate: longDate(tr.Date), TransferReason: tr.Reason || '' });
    }
    const sal = await this.salaryOf(ref);
    if (sal) Object.assign(f, { CTC: inr(sal.AnnualCTC), MonthlyGross: inr(sal.MonthlyEarnings), MonthlyNet: inr(sal.MonthlyNet), SalaryEffectiveFrom: longDate(sal.EffectiveFrom) });
    Object.keys(f).forEach(k => { if (f[k] === '' || f[k] === undefined || f[k] === null) delete f[k]; });
    return f;
  }

  async fileTabs() {
    await this.ensureTab('Settings', 'Document_Types', ['Code', 'Name', 'AppliesTo', 'CandidateForm', 'Active', 'Order']);
    await this.ensureTab('Organisation', 'Files', ['FileId', 'Ref', 'DocType', 'FileName', 'Mime', 'Size', 'Thumb', 'Note', 'UploadedBy', 'UploadedAt', 'Status', 'DeletedAt']);
  }
  async docTypes() {
    await this.fileTabs();
    let rows = (await this.read('Settings', 'Document_Types')).map(clean);
    if (!rows.length) { rows = DEFAULT_DOCS.map((d, i) => ({ ...d, Order: i + 1 })); await this.rewriteTab('Settings', 'Document_Types', rows); }
    return rows.sort((a, b) => Number(a.Order) - Number(b.Order));
  }
  // Calls the Apps Script upload helper in the client's Google account
  async helper(op, payload) {
    const c = await this.companyMap();
    if (!c.UploadUrl) throw new Error('File storage is not set up yet (Settings → File storage).');
    const res = await fetch(c.UploadUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ...payload, op, secret: c.UploadSecret }) });
    const txt = await res.text(); let j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('Upload helper did not answer correctly. Check the Web app URL and that access is "Anyone".'); }
    if (!j.ok) throw new Error('Upload helper: ' + j.error + (j.error === 'Not authorised' ? ' (the secret in the script does not match Settings → File storage)' : ''));
    return j;
  }
  async storeFiles(ref, path, files, by, note) {
    await this.fileTabs();
    const now = new Date().toISOString(), rows = [];
    for (const f of files) {
      const r = await this.helper('upload', { path, name: f.name, mime: f.mime, data: f.data });
      rows.push({ FileId: r.fileId, Ref: ref, DocType: f.docType, FileName: f.name, Mime: f.mime, Size: r.size || b64size(f.data),
        Thumb: f.docType === 'PHOTO' && /^data:image\/(jpeg|png);base64,/.test(f.thumb || '') && f.thumb.length < 30000 ? f.thumb : '', Note: note || '',
        UploadedBy: by, UploadedAt: now, Status: 'Active', DeletedAt: '' });
    }
    if (rows.length) await this.append('Organisation', 'Files', rows);
    return rows;
  }
  // Move a candidate's files to the new employee's folder
  async moveCandidateFiles(appNo, empId) {
    await this.fileTabs();
    const files = (await this.read('Organisation', 'Files')).filter(f => f.Ref === appNo && f.Status !== 'Deleted');
    if (!files.length) return 0;
    const c = await this.companyMap();
    if (c.UploadUrl) { try { await this.helper('move', { path: 'Employees/' + empId, fileIds: files.map(f => f.FileId) }); } catch (e) { /* files stay in candidate folder; records still move */ } }
    await this.upsertMany('Organisation', 'Files', ['FileId'], files.map(f => ({ ...clean(f), Ref: empId, Note: ((f.Note ? f.Note + ' · ' : '') + 'from ' + appNo) })));
    return files.length;
  }
  // Deletes files of rejected candidates after the retention period
  async purgeRejected(by) {
    await this.fileTabs();
    const c = await this.companyMap(), days = Number(c.FileRetentionDays || 90);
    if (!c.UploadUrl) return { message: 'File storage not set up', deleted: 0 };
    const cutoff = new Date(Date.now() - days * 864e5).toISOString();
    const old = new Set((await this.read('Hiring', 'Candidates')).filter(x => ['Rejected', 'Offer Rejected'].includes(x.Status) && (x.UpdatedAt || x.CreatedAt || '') < cutoff).map(x => x.AppNo));
    const files = (await this.read('Organisation', 'Files')).filter(f => old.has(f.Ref) && f.Status !== 'Deleted').slice(0, 40);
    if (!files.length) return { message: 'Nothing to clean up', deleted: 0 };
    await this.helper('trash', { fileIds: files.map(f => f.FileId) });
    const now = new Date().toISOString();
    await this.upsertMany('Organisation', 'Files', ['FileId'], files.map(f => ({ ...clean(f), Status: 'Deleted', DeletedAt: now, Thumb: '' })));
    await this.log('Files', 'CLEANUP', 'Rejected candidates\' files deleted', `${files.length} files older than ${days} days`, by);
    return { message: `${files.length} files of rejected candidates deleted`, deleted: files.length };
  }

  async log(module, recordId, action, remarks, doneBy) {
    try {
      await this.append('ActivityLog', 'Activity_Log', [{ Timestamp: new Date().toISOString(), Module: module, RecordId: recordId, Action: action, Remarks: remarks, DoneBy: doneBy }]);
    } catch (e) { /* logging must never break the main action */ }
  }

  // ── Sessions (signed tokens, no storage needed) ──
  async sessionKey() {
    if (!this._sKey) {
      const sa = JSON.parse(this.env.GOOGLE_SA_KEY);
      const raw = await crypto.subtle.digest('SHA-256', enc.encode('session:' + sa.private_key));
      this._sKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    }
    return this._sKey;
  }
  async makeSession(user) {
    const payload = b64urlStr(JSON.stringify({ u: user.Username, r: user.Role, n: user.FullName, e: user.EmpId || '', exp: Date.now() + SESSION_HOURS * 3600000 }));
    const sig = await crypto.subtle.sign('HMAC', await this.sessionKey(), enc.encode(payload));
    return payload + '.' + b64url(sig);
  }
  async verifySession(auth) {
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const [payload, sig] = auth.slice(7).split('.');
    if (!payload || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await this.sessionKey(), b64urlToBuf(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlToBuf(payload)));
    return data.exp > Date.now() ? data : null;
  }
}

// ───────────────────────── Actions ─────────────────────────
const ROLES = { SUPER: 'SuperAdmin', ADMIN: 'Admin', HR: 'HR', MANAGER: 'Manager' };

const ACTIONS = {
  ping: { fn: async () => ({ message: 'HR API online', time: new Date().toISOString() }) },

  // Checks Google access and lists the spreadsheets found in Registry
  setupCheck: {
    fn: async function () {
      const reg = await this.getRegistry(true);
      const users = await this.read('Settings', 'Users');
      return { googleAccess: true, spreadsheets: Object.keys(reg), userCount: users.length };
    }
  },

  // One-time: creates the first Super Admin. Works only while Users is empty.
  bootstrapSuperAdmin: {
    write: true,
    fn: async function (p) {
      const users = await this.read('Settings', 'Users');
      if (users.length) throw new Error('Already set up. Log in instead.');
      if (!p.username || !p.password || p.password.length < 8) throw new Error('Username and a password of at least 8 characters are required');
      const { hash, salt } = await hashPassword(p.password);
      await this.append('Settings', 'Users', [{
        Username: p.username.trim().toLowerCase(), PasswordHash: hash, Salt: salt,
        Role: ROLES.SUPER, FullName: p.fullName || 'Super Admin', StoreCodes: 'ALL',
        Active: 'Yes', CreatedAt: new Date().toISOString()
      }]);
      return { message: 'Super Admin created' };
    }
  },

  login: {
    fn: async function (p) {
      const users = await this.read('Settings', 'Users');
      const u = users.find(x => String(x.Username).toLowerCase() === String(p.username || '').trim().toLowerCase());
      if (!u || u.Active !== 'Yes' || !(await checkPassword(p.password || '', u.Salt, u.PasswordHash))) {
        throw new Error('Invalid username or password');
      }
      const company = await this.companyMap();
      return { token: await this.makeSession(u), role: u.Role, fullName: u.FullName, stores: u.StoreCodes, empId: u.EmpId || '', company: company.CompanyName || '', logo: company.BrandLogo || '', modules: await this.modules() };
    }
  },

  me: { auth: true, fn: async function (p, user) { const c = await this.companyMap(); return { username: user.u, role: user.r, fullName: user.n, modules: await this.modules(), company: c.CompanyName || '', logo: c.BrandLogo || '' }; } },

  // Public: name + logo for the login page
  getBrandPublic: { fn: async function () { const c = await this.companyMap(); return { companyName: c.CompanyName || '', logo: c.BrandLogo || '' }; } },

  // ── Settings ──
  getSettings: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN],
    fn: async function (p, user) {
      const company = {};
      (await this.read('Settings', 'Company')).forEach(r => company[r.Key] = r.Value);
      const stores = (await this.read('Settings', 'Stores')).map(clean);
      await this.ensureColumns('Settings', 'Users', ['EmpId']);
      const users = (await this.read('Settings', 'Users')).map(u => ({
        Username: u.Username, Role: u.Role, FullName: u.FullName, StoreCodes: u.StoreCodes, Active: u.Active, CreatedAt: u.CreatedAt, EmpId: u.EmpId || ''
      })).filter(u => user.r === ROLES.SUPER || u.Role !== ROLES.SUPER);           // C&B's login is not shown to the client
      const employees = (await this.read('Organisation', 'Employees')).filter(e => !GONE(e.Status))
        .map(e => ({ EmpId: e.EmpId, FullName: e.FullName, PositionCode: e.PositionCode, StoreCode: e.StoreCode }));
      return { company, stores, users, employees };
    }
  },

  saveCompany: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      const allowed = ['InterviewPassPct', 'CompanyName', 'EmpIdPrefix', 'EmpIdDigits', 'EmpIdNextNumber', 'EmpIdPerStore', 'SameStructureAllStores', 'ProbationDays'];
      if (user.r === ROLES.SUPER) allowed.push('StoreLimit');
      const rows = await this.read('Settings', 'Company');
      for (const [k, v] of Object.entries(p.values || {})) {
        if (!allowed.includes(k)) continue;
        if (rows.find(r => r.Key === k)) await this.update('Settings', 'Company', 'Key', k, { Value: v });
        else await this.append('Settings', 'Company', [{ Key: k, Value: v }]);
      }
      await this.log('Settings', 'Company', 'Updated', Object.keys(p.values || {}).join(', '), user.u);
      return { message: 'Saved' };
    }
  },

  saveStore: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      const s = p.store || {};
      if (!s.StoreCode || !s.StoreName) throw new Error('Store code and name are required');
      s.StoreCode = String(s.StoreCode).trim().toUpperCase();
      const stores = await this.read('Settings', 'Stores');
      const exists = stores.find(r => r.StoreCode === s.StoreCode);
      if (exists) {
        await this.update('Settings', 'Stores', 'StoreCode', s.StoreCode, s);
      } else {
        const company = {}; (await this.read('Settings', 'Company')).forEach(r => company[r.Key] = r.Value);
        const limit = Number(company.StoreLimit || 0);
        const activeStores = stores.filter(r => r.Type === 'Store' && r.Active !== 'No').length;
        if (s.Type === 'Store' && limit && activeStores >= limit) throw new Error(`Store limit reached (${limit}). Contact your Super Admin to increase it.`);
        await this.append('Settings', 'Stores', [{ Active: 'Yes', UsesCommonStructure: 'Yes', ...s }]);
      }
      await this.log('Settings', s.StoreCode, exists ? 'Store updated' : 'Store added', s.StoreName, user.u);
      return { message: 'Saved' };
    }
  },

  saveUser: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN], write: true,
    fn: async function (p, user) {
      const u = p.user || {};
      const username = String(u.Username || '').trim().toLowerCase();
      if (!username) throw new Error('Username is required');
      const users = await this.read('Settings', 'Users');
      const exists = users.find(x => String(x.Username).toLowerCase() === username);
      if (exists && exists.Role === ROLES.SUPER) {
        // The single C&B Super Admin: only its own name / password can change, never its role or active state
        if (user.r !== ROLES.SUPER) throw new Error('This user cannot be changed');
        u.Role = ROLES.SUPER; u.Active = 'Yes';
      } else if (u.Role && ![ROLES.ADMIN, ROLES.HR, ROLES.MANAGER].includes(u.Role)) throw new Error('You cannot assign the role ' + u.Role);
      await this.ensureColumns('Settings', 'Users', ['EmpId']);
      const changes = { FullName: u.FullName, Role: u.Role, StoreCodes: u.StoreCodes, Active: u.Active, EmpId: u.EmpId };
      Object.keys(changes).forEach(k => changes[k] === undefined && delete changes[k]);
      if (u.Password) {
        if (u.Password.length < 8) throw new Error('Password must be at least 8 characters');
        const { hash, salt } = await hashPassword(u.Password);
        changes.PasswordHash = hash; changes.Salt = salt;
      }
      if (exists) {
        await this.update('Settings', 'Users', 'Username', exists.Username, changes);
      } else {
        if (!u.Password) throw new Error('Password is required for a new user');
        await this.append('Settings', 'Users', [{ Username: username, Active: 'Yes', StoreCodes: 'ALL', CreatedAt: new Date().toISOString(), ...changes }]);
      }
      await this.log('Settings', username, exists ? 'User updated' : 'User added', u.Role || '', user.u);
      return { message: 'Saved' };
    }
  },

  // ── Organisation structure ──
  getOrg: {
    auth: true,
    fn: async function () {
      const positions = (await this.read('Organisation', 'Positions')).map(clean);
      const stores = (await this.read('Settings', 'Stores')).map(clean).filter(s => s.Active !== 'No');
      const company = {}; (await this.read('Settings', 'Company')).forEach(r => company[r.Key] = r.Value);
      const emps = await this.read('Organisation', 'Employees');
      const filled = {};
      emps.filter(e => !GONE(e.Status)).forEach(e => { const k = e.PositionCode + '|' + e.StoreCode; filled[k] = (filled[k] || 0) + 1; });
      return { positions, stores, sameStructure: company.SameStructureAllStores !== 'No', filled };
    }
  },

  savePosition: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const x = p.position || {};
      const positions = await this.read('Organisation', 'Positions');
      const isNew = !x.PositionCode || !positions.find(r => r.PositionCode === x.PositionCode);
      if (!x.PositionName) throw new Error('Position name is required');
      if (isNew) {
        if (!x.PositionCode) {
          let n = positions.length + 1, code;
          do { code = 'P-' + String(n++).padStart(3, '0'); } while (positions.find(r => r.PositionCode === code));
          x.PositionCode = code;
        }
        x.PositionCode = String(x.PositionCode).trim().toUpperCase();
      }
      // Parent checks: must exist, must not create a loop
      if (x.ParentPositionCode) {
        const parent = positions.find(r => r.PositionCode === x.ParentPositionCode);
        if (!parent) throw new Error('Parent position not found');
        let cur = parent, guard = 0;
        while (cur && guard++ < 50) {
          if (cur.PositionCode === x.PositionCode) throw new Error('A position cannot report to itself or to its own team');
          cur = positions.find(r => r.PositionCode === cur.ParentPositionCode);
        }
        x.Level = Number(parent.Level || 1) + 1;
      } else {
        const top = positions.find(r => !r.ParentPositionCode && r.Active !== 'No' && r.PositionCode !== x.PositionCode);
        if (top) throw new Error(`Only one top position is allowed (${top.PositionName}). Choose who this position reports to.`);
        x.Level = 1;
      }
      const row = {
        PositionCode: x.PositionCode, PositionName: x.PositionName.trim(), Level: x.Level,
        ParentPositionCode: x.ParentPositionCode || '', Branch: x.Branch || 'Sales', Department: x.Department || '',
        StoreCode: x.StoreCode || 'ALL', ApprovedHeadcount: Number(x.ApprovedHeadcount || 1), Active: x.Active || 'Yes'
      };
      if (isNew) await this.append('Organisation', 'Positions', [row]);
      else {
        await this.update('Organisation', 'Positions', 'PositionCode', row.PositionCode, row);
        // keep children's levels correct if this one moved
        const all = await this.read('Organisation', 'Positions');
        const fix = async (code, lvl) => {
          for (const c of all.filter(r => r.ParentPositionCode === code)) {
            if (Number(c.Level) !== lvl + 1) await this.update('Organisation', 'Positions', 'PositionCode', c.PositionCode, { Level: lvl + 1 });
            await fix(c.PositionCode, lvl + 1);
          }
        };
        await fix(row.PositionCode, row.Level);
      }
      await this.log('Organisation', row.PositionCode, isNew ? 'Position added' : 'Position updated', row.PositionName, user.u);
      return { message: 'Saved', positionCode: row.PositionCode };
    }
  },

  deactivatePosition: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const positions = await this.read('Organisation', 'Positions');
      if (positions.some(r => r.ParentPositionCode === p.positionCode && r.Active !== 'No')) throw new Error('Move or deactivate the positions under it first');
      const emps = await this.read('Organisation', 'Employees');
      if (emps.some(e => e.PositionCode === p.positionCode && !GONE(e.Status))) throw new Error('Employees are still in this position');
      await this.update('Organisation', 'Positions', 'PositionCode', p.positionCode, { Active: 'No' });
      await this.log('Organisation', p.positionCode, 'Position deactivated', '', user.u);
      return { message: 'Deactivated' };
    }
  },

  // ── Employees ──
  getEmployees: {
    auth: true,
    fn: async function () {
      const employees = (await this.read('Organisation', 'Employees')).map(clean);
      const positions = (await this.read('Organisation', 'Positions')).map(clean).filter(p => p.Active !== 'No');
      const stores = (await this.read('Settings', 'Stores')).map(clean).filter(s => s.Active !== 'No');
      return { employees, positions, stores, lists: await this.lists() };
    }
  },

  saveEmployee: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const e = normEmp(p.employee || {});
      const ctx = await this.empContext();
      const existing = e.EmpId && ctx.employees.find(x => x.EmpId === e.EmpId);
      validateEmp(e, ctx, existing);
      const now = new Date().toISOString();
      if (existing) {
        const moved = ['StoreCode', 'PositionCode', 'ReportingManagerId'].some(k => (e[k] || '') !== (existing[k] || ''));
        await this.update('Organisation', 'Employees', 'EmpId', e.EmpId, { ...e, UpdatedAt: now });
        if (moved) await this.append('Organisation', 'TransferHistory', [{
          EmpId: e.EmpId, Date: now.slice(0, 10), FromStore: existing.StoreCode, ToStore: e.StoreCode,
          FromPosition: existing.PositionCode, ToPosition: e.PositionCode, FromManager: existing.ReportingManagerId,
          ToManager: e.ReportingManagerId, Reason: p.reason || '', DoneBy: user.u
        }]);
        await this.log('Organisation', e.EmpId, moved ? 'Employee moved' : 'Employee updated', e.FullName, user.u);
        return { message: 'Saved', empId: e.EmpId };
      }
      const ids = await this.nextEmpIds([e.StoreCode], ctx);
      e.EmpId = e.EmpId || ids[0];
      if (ctx.employees.find(x => x.EmpId === e.EmpId)) throw new Error('Employee ID already exists: ' + e.EmpId);
      await this.append('Organisation', 'Employees', [{ ...e, CreatedAt: now, UpdatedAt: now }]);
      await this.log('Organisation', e.EmpId, 'Employee added', e.FullName, user.u);
      return { message: 'Saved', empId: e.EmpId };
    }
  },

  importEmployees: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const rows = (p.rows || []).map(normEmp).filter(r => r.FullName);
      if (!rows.length) throw new Error('No rows to import');
      const ctx = await this.empContext();
      const taken = new Set(ctx.employees.map(x => x.EmpId));
      const errors = [];
      // IDs: keep the ones given, generate the rest
      const need = rows.filter(r => !r.EmpId);
      const gen = await this.nextEmpIds(need.map(r => r.StoreCode), ctx);
      need.forEach((r, i) => r.EmpId = gen[i]);
      rows.forEach((r, i) => { if (taken.has(r.EmpId)) errors.push(`Row ${i + 1}: ID ${r.EmpId} already exists`); taken.add(r.EmpId); });
      const all = { ...ctx, employees: ctx.employees.concat(rows) };
      rows.forEach((r, i) => { try { validateEmp(r, all, null); } catch (err) { errors.push(`Row ${i + 1} (${r.FullName}): ${err.message}`); } });
      if (errors.length) throw new Error('Nothing imported. Fix these first:\n' + errors.slice(0, 15).join('\n') + (errors.length > 15 ? `\n…and ${errors.length - 15} more` : ''));
      const now = new Date().toISOString();
      await this.append('Organisation', 'Employees', rows.map(r => ({ ...r, CreatedAt: now, UpdatedAt: now })));
      await this.log('Organisation', 'IMPORT', 'Employees imported', rows.length + ' rows', user.u);
      return { message: `${rows.length} employees imported`, count: rows.length };
    }
  },

  // ── Roles & Responsibilities ──
  getRoles: {
    auth: true,
    fn: async function () {
      const positions = (await this.read('Organisation', 'Positions')).map(clean).filter(p => p.Active !== 'No');
      const summaries = (await this.read('Library', 'Role_Summary')).map(clean);
      const duties = (await this.read('Library', 'Role_Responsibilities')).map(clean);
      return { positions, summaries, duties };
    }
  },

  saveRole: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const code = String(p.positionCode || '').toUpperCase();
      const positions = await this.read('Organisation', 'Positions');
      if (!positions.find(x => x.PositionCode === code)) throw new Error('Unknown position: ' + code);
      const version = await this.writeRole(code, p.summary || {}, p.duties || []);
      await this.log('Library', code, 'Role document saved', 'v' + version, user.u);
      return { message: 'Saved as version ' + version, version };
    }
  },

  importRoles: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const positions = await this.read('Organisation', 'Positions');
      const codes = new Set(positions.map(x => x.PositionCode));
      const sums = (p.summaries || []).filter(x => x.PositionCode);
      const duties = (p.duties || []).filter(x => x.PositionCode && x.Responsibility);
      const bad = [...new Set(sums.concat(duties).map(x => String(x.PositionCode).toUpperCase()).filter(c => !codes.has(c)))];
      if (bad.length) throw new Error('Nothing imported. Unknown position codes: ' + bad.join(', '));
      const all = [...new Set(sums.concat(duties).map(x => String(x.PositionCode).toUpperCase()))];
      // Build everything in memory, then write each tab once (stays within Cloudflare's call limit)
      const existing = (await this.read('Library', 'Role_Summary')).map(clean);
      const summaryRows = existing.filter(r => !all.includes(r.PositionCode));
      for (const code of all) {
        const old = existing.find(r => r.PositionCode === code);
        const sm = sums.find(x => String(x.PositionCode).toUpperCase() === code) || old || {};
        summaryRows.push(roleRow(code, sm, old ? Number(old.Version || 0) + 1 : 1));
      }
      const withDuties = new Set(duties.map(x => String(x.PositionCode).toUpperCase()));
      const dutyRows = (await this.read('Library', 'Role_Responsibilities')).map(clean).filter(r => !withDuties.has(r.PositionCode));
      withDuties.forEach(code => duties.filter(x => String(x.PositionCode).toUpperCase() === code)
        .forEach((d, i) => dutyRows.push({ PositionCode: code, SlNo: i + 1, Responsibility: String(d.Responsibility).trim(), Frequency: d.Frequency || 'Daily' })));
      await this.rewriteTab('Library', 'Role_Summary', summaryRows);
      await this.rewriteTab('Library', 'Role_Responsibilities', dutyRows);
      await this.log('Library', 'IMPORT', 'Role documents imported', all.length + ' positions', user.u);
      return { message: `Role documents imported for ${all.length} positions` };
    }
  },

  // ── KPI setup ──
  getKpiSetup: {
    auth: true,
    fn: async function () {
      const positions = (await this.read('Organisation', 'Positions')).map(clean).filter(p => p.Active !== 'No');
      const params = (await this.read('Performance', 'KPI_Parameters')).map(clean).filter(k => k.Active !== 'No');
      let bands = (await this.read('Performance', 'Rating_Bands')).map(clean);
      if (!bands.length) bands = DEFAULT_BANDS;
      return { positions, params, bands };
    }
  },

  saveKpiParam: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const positions = await this.read('Organisation', 'Positions');
      const k = normKpi(p.param || {}, positions);
      const all = (await this.read('Performance', 'KPI_Parameters')).map(clean);
      const origKey = p.originalName ? k.PositionCode + '|' + p.originalName : null;
      const key = x => x.PositionCode + '|' + x.KpiName;
      if (all.find(x => key(x) === key(k) && key(x) !== origKey && x.Active !== 'No')) throw new Error('This position already has a KPI with that name');
      const rest = all.filter(x => key(x) !== (origKey || key(k)) && key(x) !== key(k));
      rest.push(k);
      await this.rewriteTab('Performance', 'KPI_Parameters', rest);
      await this.log('Performance', k.PositionCode, origKey ? 'KPI updated' : 'KPI added', k.KpiName, user.u);
      return { message: 'Saved' };
    }
  },

  removeKpiParam: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const all = (await this.read('Performance', 'KPI_Parameters')).map(clean);
      const left = all.filter(x => !(x.PositionCode === p.positionCode && x.KpiName === p.kpiName));
      await this.rewriteTab('Performance', 'KPI_Parameters', left);
      await this.log('Performance', p.positionCode, 'KPI removed', p.kpiName, user.u);
      return { message: 'Removed' };
    }
  },

  importKpiParams: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const positions = await this.read('Organisation', 'Positions');
      const errors = [], rows = [];
      (p.rows || []).forEach((r, i) => { try { rows.push(normKpi(r, positions)); } catch (e) { errors.push(`Row ${i + 1}: ${e.message}`); } });
      const byPos = {};
      rows.forEach(r => (byPos[r.PositionCode] = byPos[r.PositionCode] || []).push(r));
      Object.entries(byPos).forEach(([code, list]) => {
        const total = list.reduce((a, b) => a + Number(b.WeightPct), 0);
        if (Math.abs(total - 100) > 0.01) errors.push(`${code}: weights add up to ${total}%, must be 100%`);
        const names = list.map(x => x.KpiName.toLowerCase());
        if (new Set(names).size !== names.length) errors.push(`${code}: the same KPI name appears twice`);
      });
      if (errors.length) throw new Error('Nothing imported. Fix these first:\n' + errors.slice(0, 15).join('\n'));
      const keep = (await this.read('Performance', 'KPI_Parameters')).map(clean).filter(x => !byPos[x.PositionCode]);
      await this.rewriteTab('Performance', 'KPI_Parameters', keep.concat(rows));
      await this.log('Performance', 'IMPORT', 'KPI parameters imported', `${rows.length} KPIs, ${Object.keys(byPos).length} positions`, user.u);
      return { message: `${rows.length} KPIs imported for ${Object.keys(byPos).length} positions` };
    }
  },

  saveBands: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const bands = (p.bands || []).map(b => ({ Band: String(b.Band || '').trim(), MinScore: Number(b.MinScore), MaxScore: Number(b.MaxScore), Meaning: b.Meaning || '' }))
        .filter(b => b.Band).sort((a, b) => b.MinScore - a.MinScore);
      if (!bands.length) throw new Error('Add at least one band');
      if (bands.some(b => isNaN(b.MinScore) || isNaN(b.MaxScore) || b.MinScore > b.MaxScore)) throw new Error('Each band needs a valid min and max score');
      await this.rewriteTab('Performance', 'Rating_Bands', bands);
      await this.log('Performance', 'BANDS', 'Rating bands saved', bands.map(b => b.Band).join(','), user.u);
      return { message: 'Saved' };
    }
  },

  // ── KPI monthly cycle ──
  getKpiMonth: {
    auth: true,
    fn: async function (p, user) {
      const month = checkMonth(p.month), ss = 'KPI_' + month.slice(0, 4);
      const ctx = await this.kpiContext(month, user);
      const entries = (await this.read(ss, 'KPI_Entries')).filter(e => e.Month === month && ctx.team.has(e.EmpId)).map(clean);
      const summaries = (await this.read(ss, 'KPI_Summary')).filter(e => e.Month === month && ctx.team.has(e.EmpId)).map(clean);
      return { month, cycle: ctx.cycle, employees: ctx.employees, params: ctx.params, bands: ctx.bands, entries, summaries, positions: ctx.positions };
    }
  },

  saveKpiEntries: {
    auth: true, write: true,
    fn: async function (p, user) {
      const month = checkMonth(p.month), ss = 'KPI_' + month.slice(0, 4);
      const ctx = await this.kpiContext(month, user);
      if (ctx.cycle.Status === 'Locked') throw new Error(`${month} is locked. Ask an Admin to unlock it.`);
      const isHR = [ROLES.SUPER, ROLES.ADMIN, ROLES.HR].includes(user.r);
      const oldEntries = (await this.read(ss, 'KPI_Entries')).filter(e => e.Month === month);
      const oldSums = (await this.read(ss, 'KPI_Summary')).filter(e => e.Month === month);
      const now = new Date().toISOString(), entryRows = [], sumRows = [], errors = [];
      for (const item of p.items || []) {
        const emp = ctx.employees.find(e => e.EmpId === item.EmpId);
        if (!emp) { errors.push(`${item.EmpId}: not in your team`); continue; }
        const prev = oldSums.find(x => x.EmpId === emp.EmpId);
        if (prev && prev.Status === 'Approved') { errors.push(`${emp.FullName}: already approved`); continue; }
        if (prev && prev.Status === 'Submitted' && !isHR) { errors.push(`${emp.FullName}: already submitted to HR`); continue; }
        const kpis = ctx.params.filter(k => k.PositionCode === emp.PositionCode);
        if (!kpis.length) { errors.push(`${emp.FullName}: no KPIs set for this position`); continue; }
        const rows = kpis.map(k => {
          const old = oldEntries.find(e => e.EmpId === emp.EmpId && e.KpiName === k.KpiName) || {};
          const mayEdit = isHR || k.EnteredBy !== 'HR';
          const given = item.actuals && Object.prototype.hasOwnProperty.call(item.actuals, k.KpiName) ? item.actuals[k.KpiName] : undefined;
          let actual = old.Actual === undefined ? '' : old.Actual;
          if (mayEdit && given !== undefined) actual = given === '' || given === null ? '' : Number(given);
          if (actual !== '' && isNaN(actual)) throw new Error(`${emp.FullName} – ${k.KpiName}: actual must be a number`);
          const sc = kpiScore(k, actual);
          return { Month: month, EmpId: emp.EmpId, PositionCode: emp.PositionCode, KpiName: k.KpiName, Target: Number(k.Target), Actual: actual,
            AchievementPct: sc.ach, WeightPct: Number(k.WeightPct), Score: sc.score,
            EnteredBy: actual === old.Actual ? (old.EnteredBy || '') : user.u, EnteredAt: actual === old.Actual ? (old.EnteredAt || '') : now };
        });
        const filled = rows.every(r => r.Actual !== '');
        const mgrFilled = rows.every((r, i) => r.Actual !== '' || kpis[i].EnteredBy === 'HR');
        const total = round2(rows.reduce((a, r) => a + (r.Score || 0), 0));
        let status = prev ? prev.Status : 'Draft';
        if (status === 'Returned') status = 'Draft';
        if (p.submit && status === 'Draft') {
          if (!mgrFilled) { errors.push(`${emp.FullName}: fill all KPIs before submitting`); }
          else status = 'Submitted';
        }
        entryRows.push(...rows);
        sumRows.push({ Month: month, EmpId: emp.EmpId, StoreCode: emp.StoreCode, TotalScore: filled ? total : '', Band: filled ? bandOf(total, ctx.bands) : '',
          ManagerRemarks: item.remarks !== undefined ? item.remarks : (prev ? prev.ManagerRemarks : ''), Status: status,
          SubmittedBy: status === 'Submitted' && (!prev || prev.Status !== 'Submitted') ? user.u : (prev ? prev.SubmittedBy : ''),
          SubmittedAt: status === 'Submitted' && (!prev || prev.Status !== 'Submitted') ? now : (prev ? prev.SubmittedAt : ''),
          ApprovedBy: '', ApprovedAt: '' });
      }
      if (entryRows.length) {
        await this.upsertMany(ss, 'KPI_Entries', ['Month', 'EmpId', 'KpiName'], entryRows);
        await this.upsertMany(ss, 'KPI_Summary', ['Month', 'EmpId'], sumRows);
        await this.log('Performance', month, p.submit ? 'KPIs submitted' : 'KPIs saved', `${sumRows.length} employees`, user.u);
      }
      return { message: `${sumRows.length} saved` + (errors.length ? `, ${errors.length} skipped` : ''), errors };
    }
  },

  approveKpi: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const month = checkMonth(p.month), ss = 'KPI_' + month.slice(0, 4);
      const ctx = await this.kpiContext(month, user);
      if (ctx.cycle.Status === 'Locked') throw new Error(`${month} is locked.`);
      const sums = (await this.read(ss, 'KPI_Summary')).filter(e => e.Month === month);
      const now = new Date().toISOString(), out = [], errors = [];
      for (const id of p.empIds || []) {
        const sm = sums.find(x => x.EmpId === id);
        if (!sm || sm.Status !== 'Submitted') { errors.push(`${id}: not submitted`); continue; }
        if (p.decision === 'approve') {
          if (sm.TotalScore === '' || sm.TotalScore === undefined) { errors.push(`${id}: some KPIs are still empty (HR fields?)`); continue; }
          out.push({ ...clean(sm), Status: 'Approved', ApprovedBy: user.u, ApprovedAt: now });
        } else {
          out.push({ ...clean(sm), Status: 'Returned', ManagerRemarks: (p.remarks ? 'HR: ' + p.remarks + ' | ' : '') + (sm.ManagerRemarks || '') });
        }
      }
      if (out.length) {
        await this.upsertMany(ss, 'KPI_Summary', ['Month', 'EmpId'], out);
        await this.log('Performance', month, p.decision === 'approve' ? 'KPIs approved' : 'KPIs returned', `${out.length} employees`, user.u);
      }
      return { message: `${out.length} ${p.decision === 'approve' ? 'approved' : 'returned'}` + (errors.length ? `, ${errors.length} skipped` : ''), errors };
    }
  },

  setKpiCycle: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const month = checkMonth(p.month);
      if (p.status === 'Open' && ![ROLES.SUPER, ROLES.ADMIN].includes(user.r)) throw new Error('Only an Admin can unlock a month');
      if (p.status === 'Open' && !p.reason) throw new Error('Give a reason for unlocking');
      const now = new Date().toISOString();
      await this.upsertMany('Performance', 'KPI_Cycles', ['Month'], [{ Month: month, Status: p.status, OpenedAt: now, LockedAt: p.status === 'Locked' ? now : '', LockedBy: p.status === 'Locked' ? user.u : '' }]);
      await this.log('Performance', month, p.status === 'Locked' ? 'Month locked' : 'Month unlocked', p.reason || '', user.u);
      return { message: `${month} ${p.status === 'Locked' ? 'locked' : 'unlocked'}` };
    }
  },

  getKpiReport: {
    auth: true,
    fn: async function (p, user) {
      const to = checkMonth(p.to), from = checkMonth(p.from || p.to);
      if (from > to) throw new Error('"From" month is after "To" month');
      const ctx = await this.kpiContext(to, user);
      const includeAll = p.include === 'submitted';
      const reg = await this.getRegistry();
      const summaries = [], entries = [];
      for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
        if (!reg['KPI_' + y]) continue;
        (await this.read('KPI_' + y, 'KPI_Summary')).forEach(r => {
          if (r.Month >= from && r.Month <= to && ctx.team.has(r.EmpId) && (r.Status === 'Approved' || (includeAll && r.Status === 'Submitted'))) summaries.push(clean(r));
        });
        if (p.empId) (await this.read('KPI_' + y, 'KPI_Entries')).forEach(r => {
          if (r.EmpId === p.empId && r.Month >= from && r.Month <= to) entries.push(clean(r));
        });
      }
      return { from, to, summaries, entries, employees: ctx.employees, positions: ctx.positions, bands: ctx.bands };
    }
  },

  // ── Policy library (written in the app) ──
  getPolicies: {
    auth: true,
    fn: async function () {
      await this.ensureColumns('Library', 'Documents', POLICY_EXTRA);
      const policies = (await this.read('Library', 'Documents')).map(clean);
      const positions = (await this.read('Organisation', 'Positions')).map(clean).filter(p => p.Active !== 'No').map(p => ({ PositionCode: p.PositionCode, PositionName: p.PositionName }));
      return { policies, positions };
    }
  },

  savePolicy: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      await this.ensureColumns('Library', 'Documents', POLICY_EXTRA);
      const all = await this.read('Library', 'Documents');
      const x = p.policy || {};
      if (!String(x.Title || '').trim()) throw new Error('Title is required');
      const old = x.DocCode && all.find(d => d.DocCode === x.DocCode);
      const row = policyRow(x, old, all, user.u);
      await this.upsertMany('Library', 'Documents', ['DocCode'], [row]);
      await this.log('Library', row.DocCode, old ? 'Policy updated' : 'Policy added', `${row.Title} v${row.Version}`, user.u);
      return { message: `Saved as version ${row.Version}`, docCode: row.DocCode };
    }
  },

  importPolicies: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      await this.ensureColumns('Library', 'Documents', POLICY_EXTRA);
      const all = (await this.read('Library', 'Documents')).slice();
      const rows = [];
      (p.rows || []).filter(r => String(r.Title || '').trim()).forEach(r => {
        const old = r.DocCode && all.find(d => d.DocCode === String(r.DocCode).trim().toUpperCase());
        const row = policyRow(r, old, all.concat(rows), user.u);
        rows.push(row);
      });
      if (!rows.length) throw new Error('No policies with a title found');
      await this.upsertMany('Library', 'Documents', ['DocCode'], rows);
      await this.log('Library', 'IMPORT', 'Policies imported', rows.length + ' policies', user.u);
      return { message: `${rows.length} policies imported` };
    }
  },

  // ═════════════ HIRING ═════════════
  // Public: data for the candidate registration form
  getApplyForm: {
    fn: async function () {
      const company = await this.companyMap(), mods = await this.modules();
      if (!mods.includes('HIRING')) return { closed: true, companyName: company.CompanyName || '', logo: company.BrandLogo || '' };
      const positions = (await this.read('Organisation', 'Positions')).filter(p => p.Active !== 'No' && p.ParentPositionCode)
        .map(p => ({ PositionCode: p.PositionCode, PositionName: p.PositionName, StoreCode: p.StoreCode }));
      const stores = (await this.read('Settings', 'Stores')).filter(s => s.Active !== 'No')
        .map(s => ({ StoreCode: s.StoreCode, StoreName: s.StoreName, Type: s.Type }));
      let uploads = [];
      if (company.UploadUrl && mods.includes('FILES')) uploads = (await this.docTypes()).filter(d => CANDIDATE_FORM_DOCS.includes(d.Code) && d.CandidateForm !== 'Hidden' && d.Active !== 'No')
        .map(d => ({ Code: d.Code, Name: d.Name, Required: d.CandidateForm === 'Mandatory' }));
      const form = (await this.applyForm()).filter(f => f.Setting !== 'Hidden')
        .map(f => ({ Code: f.Code, Label: f.Label, Section: f.Section, Type: f.Type, Options: f.Options, Hint: f.Hint, Required: f.Setting === 'Mandatory' }));
      const L = await this.lists();
      return { companyName: company.CompanyName || '', logo: company.BrandLogo || '', positions, stores, uploads, form, lists: { SOURCE: L.SOURCE } };
    }
  },

  // Public: candidate submits the QR form
  applyCandidate: {
    write: true,
    fn: async function (p) {
      if (p.website) return { appNo: '' };            // spam trap field, real people leave it empty
      return this.createCandidate(p.candidate || {}, 'Self (QR form)', p.files, { hr: false });
    }
  },

  addCandidate: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) { return this.createCandidate(p.candidate || {}, user.u, p.files, { hr: true, allowIncomplete: !!p.allowIncomplete }); }
  },

  getHiring: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function () {
      const company = await this.companyMap();
      const T = (tab) => this.read('Hiring', tab).then(r => r.map(clean));
      const [candidates, schedule, tokens, scores, offers, questions] = await Promise.all(
        ['Candidates', 'Interview_Schedule', 'Interview_Tokens', 'HR_Status', 'Selection_Offer', 'Interview_Questions'].map(T));
      const positions = (await this.read('Organisation', 'Positions')).filter(p => p.Active !== 'No').map(clean);
      const stores = (await this.read('Settings', 'Stores')).filter(s => s.Active !== 'No').map(clean);
      const employees = (await this.read('Organisation', 'Employees')).filter(e => !GONE(e.Status))
        .map(e => ({ EmpId: e.EmpId, FullName: e.FullName, PositionCode: e.PositionCode, StoreCode: e.StoreCode }));
      const form = await this.applyForm(), lists = await this.lists();
      return { form, lists, candidates, schedule, tokens, scores, offers, questions, positions, stores, employees,
        passPct: Number(company.InterviewPassPct || 60), idFormat: { prefix: company.EmpIdPrefix, digits: company.EmpIdDigits } };
    }
  },

  getCandidateTimeline: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function (p) {
      const rows = (await this.read('ActivityLog', 'Activity_Log')).filter(r => r.RecordId === p.appNo).map(clean);
      return { timeline: rows.sort((a, b) => (a.Timestamp < b.Timestamp ? 1 : -1)) };
    }
  },

  updateCandidate: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const c = await this.candidate(p.appNo);
      const ch = {}, form = await this.applyForm();
      if (p.changes) {
        const changed = {};                          // only check values that really changed (old data stays as it is)
        Object.keys(p.changes).forEach(k => { if (String(p.changes[k] ?? '').trim() !== String(c[k] ?? '').trim()) changed[k] = p.changes[k]; });
        const typed = checkAnswers(form, changed, true);
        const custom = form.filter(f => f.System !== 'Yes').map(f => f.Code);
        if (custom.length) await this.ensureColumns('Hiring', 'Candidates', custom.concat(['Incomplete']));
        CAND_FIELDS.concat(custom).forEach(k => { if (k in changed) ch[k] = String(typed[k] ?? '').trim(); });
        if (ch.Name !== undefined && !ch.Name) throw new Error('Name is required');
      }
      if (ch.Phone !== undefined && !/^\d{10}$/.test(ch.Phone)) throw new Error('Phone must be 10 digits');
      if (ch.DOB) ch.DOB = normDate(ch.DOB);
      if (ch.PositionCode) await this.position(ch.PositionCode);
      if (p.status) {
        const allowed = { New: ['Shortlisted', 'Hold', 'Rejected'], Shortlisted: ['Hold', 'Rejected'], '1st Call Done': ['Hold', 'Rejected'],
          '2nd Call Done': ['Hold', 'Rejected'], 'Interview Scheduled': ['Hold', 'Rejected'], Hold: ['New', 'Rejected'], Rejected: ['New'] };
        if (!(allowed[c.Status] || []).includes(p.status)) throw new Error(`Cannot move from "${c.Status}" to "${p.status}" here`);
        ch.Status = p.status;
        if (p.status === 'Rejected') await this.recordRejection(c, 'Pre Interview', p.note, user.u, p.reason);
      }
      if (p.note) ch.Remarks = p.note;
      ch.UpdatedAt = new Date().toISOString();
      if (p.reason && p.status) ch.Remarks = p.reason + (p.note ? ' — ' + p.note : '');
      await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, ch);
      await this.log('Hiring', c.AppNo, p.status ? 'Status: ' + p.status : 'Details updated', [p.reason, p.note].filter(Boolean).join(' — ') || (p.status ? '' : 'Changed: ' + Object.keys(ch).filter(k => k !== 'UpdatedAt').join(', ')), user.u);
      if (p.changes) await this.refreshIncomplete(c.AppNo);
      return { message: 'Saved' };
    }
  },

  // step 1 = first call, 2 = second call, 3 = interview scheduled
  logCall: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const c = await this.candidate(p.appNo), step = Number(p.step);
      const okFrom = { 1: ['Shortlisted', '1st Call Done'], 2: ['1st Call Done', '2nd Call Done'], 3: ['Shortlisted', '1st Call Done', '2nd Call Done', 'Interview Scheduled'] };
      if (!okFrom[step]) throw new Error('Unknown step');
      if (!okFrom[step].includes(c.Status)) throw new Error(`Not allowed while the candidate is "${c.Status}"`);
      if (!p.date) throw new Error('Date is required');
      const now = new Date().toISOString();
      const sch = clean((await this.read('Hiring', 'Interview_Schedule')).find(x => x.AppNo === c.AppNo) || { AppNo: c.AppNo, CreatedAt: now });
      sch.Candidate = c.Name; sch.PositionCode = c.PositionCode;
      const status = { 1: '1st Call Done', 2: '2nd Call Done', 3: 'Interview Scheduled' }[step];
      if (step === 1) { sch.Call1Date = p.date; sch.Call1Remarks = p.remarks || ''; }
      if (step === 2) { sch.Call2Date = p.date; sch.Call2Remarks = p.remarks || ''; }
      if (step === 3) { sch.InterviewDate = p.date; sch.InterviewRemarks = p.remarks || ''; }
      sch.Step = Math.max(Number(sch.Step || 0), step); sch.Status = status;
      await this.upsertMany('Hiring', 'Interview_Schedule', ['AppNo'], [sch]);
      await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, { Status: status, UpdatedAt: now });
      await this.log('Hiring', c.AppNo, status, `${p.date}${p.remarks ? ' · ' + p.remarks : ''}`, user.u);
      return { message: status };
    }
  },

  // Interview questions: PositionCode 'ALL' + Round 'HR' = HR round for everyone; position + 'Round 2' = assessor round
  saveQuestions: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const code = String(p.positionCode || '').toUpperCase(), round = p.round === 'HR' ? 'HR' : 'Round 2';
      if (code !== 'ALL') await this.position(code);
      const keep = (await this.read('Hiring', 'Interview_Questions')).map(clean).filter(q => !(q.PositionCode === code && q.Round === round));
      const qs = (p.questions || []).filter(q => String(q.Question || '').trim()).map((q, i) => questionRow(code, round, i, q));
      await this.rewriteTab('Hiring', 'Interview_Questions', keep.concat(qs));
      await this.log('Hiring', code, 'Interview questions saved', `${round}: ${qs.length}`, user.u);
      return { message: `${qs.length} questions saved` };
    }
  },

  importQuestions: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const positions = await this.read('Organisation', 'Positions');
      const rows = (p.rows || []).filter(r => String(r.Question || '').trim());
      const bad = [...new Set(rows.map(r => String(r.PositionCode || '').trim().toUpperCase()).filter(c => c !== 'ALL' && !positions.find(x => x.PositionCode === c)))];
      if (bad.length) throw new Error('Nothing imported. Unknown position codes: ' + bad.join(', '));
      const groups = {};
      rows.forEach(r => { const code = String(r.PositionCode).trim().toUpperCase(); const round = /hr/i.test(r.Round) ? 'HR' : 'Round 2'; (groups[code + '|' + round] = groups[code + '|' + round] || []).push(r); });
      const keep = (await this.read('Hiring', 'Interview_Questions')).map(clean).filter(q => !groups[q.PositionCode + '|' + q.Round]);
      const add = [];
      Object.entries(groups).forEach(([k, list]) => { const [code, round] = k.split('|'); list.forEach((q, i) => add.push(questionRow(code, round, i, q))); });
      await this.rewriteTab('Hiring', 'Interview_Questions', keep.concat(add));
      await this.log('Hiring', 'IMPORT', 'Interview questions imported', `${add.length} questions`, user.u);
      return { message: `${add.length} questions imported for ${Object.keys(groups).length} rounds` };
    }
  },

  saveHrScore: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const c = await this.candidate(p.appNo);
      if (!['Interview Scheduled', 'Interviewed'].includes(c.Status)) throw new Error('Schedule the interview first');
      const qs = (await this.read('Hiring', 'Interview_Questions')).filter(q => q.PositionCode === 'ALL' && q.Round === 'HR');
      if (!qs.length) throw new Error('No HR round questions set. Add them under Interview questions.');
      const res = scoreAnswers(qs, p.scores || {});
      const prev = clean((await this.read('Hiring', 'HR_Status')).find(x => x.AppNo === c.AppNo) || { AppNo: c.AppNo });
      prev.HR = JSON.stringify({ ...res, remarks: p.remarks || '', by: user.n || user.u, at: new Date().toISOString() });
      prev.PositionCode = c.PositionCode; prev.UpdatedAt = new Date().toISOString();
      await this.upsertMany('Hiring', 'HR_Status', ['AppNo'], [prev]);
      const r2 = (await this.read('Hiring', 'Interview_Questions')).some(q => q.PositionCode === c.PositionCode && q.Round === 'Round 2');
      if (!r2 && c.Status !== 'Interviewed') await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, { Status: 'Interviewed', UpdatedAt: new Date().toISOString() });
      await this.log('Hiring', c.AppNo, 'HR round scored', `${res.total}/${res.max}`, user.u);
      return { message: `HR round saved: ${res.total}/${res.max}` };
    }
  },

  createInterviewToken: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const c = await this.candidate(p.appNo);
      if (!['Interview Scheduled', 'Interviewed'].includes(c.Status)) throw new Error('Schedule the interview first');
      if (!String(p.assessorName || '').trim()) throw new Error('Assessor name is required');
      const qs = (await this.read('Hiring', 'Interview_Questions')).filter(q => q.PositionCode === c.PositionCode && q.Round === 'Round 2');
      if (!qs.length) throw new Error('No Round 2 questions for this position. Add them under Interview questions.');
      const now = new Date(), tokens = (await this.read('Hiring', 'Interview_Tokens')).map(clean);
      const replaced = tokens.filter(t => t.AppNo === c.AppNo && t.Status === 'Pending').map(t => ({ ...t, Status: 'Replaced' }));
      const token = randomHex(16);
      const row = { AppNo: c.AppNo, Candidate: c.Name, PositionCode: c.PositionCode, Token: token, AssessorName: p.assessorName.trim(),
        AssessorPosition: p.assessorPosition || '', CreatedAt: now.toISOString(), ExpiresAt: new Date(now.getTime() + 24 * 3600e3).toISOString(),
        Status: 'Pending', CompletedAt: '', SuggestedPosition: '', SuggestionReason: '' };
      await this.upsertMany('Hiring', 'Interview_Tokens', ['Token'], replaced.concat([row]));
      await this.log('Hiring', c.AppNo, 'Round 2 link created', `Assessor: ${row.AssessorName}`, user.u);
      return { token, expiresAt: row.ExpiresAt };
    }
  },

  // Public (token): assessor opens the Round 2 form
  getInterviewByToken: {
    fn: async function (p) {
      const t = await this.liveToken(p.token);
      const c = await this.candidate(t.AppNo);
      const qs = (await this.read('Hiring', 'Interview_Questions')).filter(q => q.PositionCode === c.PositionCode && q.Round === 'Round 2').map(clean)
        .sort((a, b) => Number(String(a.QuestionId).slice(1)) - Number(String(b.QuestionId).slice(1)));
      const positions = (await this.read('Organisation', 'Positions')).filter(x => x.Active !== 'No' && x.ParentPositionCode);
      const role = (await this.read('Library', 'Role_Summary')).find(r => r.PositionCode === c.PositionCode) || {};
      const duties = (await this.read('Library', 'Role_Responsibilities')).filter(d => d.PositionCode === c.PositionCode).map(d => d.Responsibility);
      const hr = parseJSON(((await this.read('Hiring', 'HR_Status')).find(x => x.AppNo === c.AppNo) || {}).HR);
      const company = await this.companyMap();
      return {
        companyName: company.CompanyName || '', assessorName: t.AssessorName, expiresAt: t.ExpiresAt,
        candidate: { Name: c.Name, AppNo: c.AppNo, Qualification: c.Qualification, Experience: c.Experience, Occupation: c.Occupation, CityState: c.CityState, Gender: c.Gender },
        position: { PositionCode: c.PositionCode, PositionName: (positions.find(x => x.PositionCode === c.PositionCode) || {}).PositionName || c.PositionCode, JobPurpose: role.JobPurpose || '', duties },
        questions: qs.map(q => ({ QuestionId: q.QuestionId, Question: q.Question, MaxScore: Number(q.MaxScore || 10) })),
        hrRound: hr ? { total: hr.total, max: hr.max } : null,
        otherPositions: positions.filter(x => x.PositionCode !== c.PositionCode).map(x => ({ PositionCode: x.PositionCode, PositionName: x.PositionName }))
      };
    }
  },

  // Public (token): assessor submits Round 2
  submitInterviewScore: {
    write: true,
    fn: async function (p) {
      const t = await this.liveToken(p.token);
      const c = await this.candidate(t.AppNo);
      const qs = (await this.read('Hiring', 'Interview_Questions')).filter(q => q.PositionCode === c.PositionCode && q.Round === 'Round 2');
      const res = scoreAnswers(qs, p.scores || {});
      const now = new Date().toISOString();
      const prev = clean((await this.read('Hiring', 'HR_Status')).find(x => x.AppNo === c.AppNo) || { AppNo: c.AppNo });
      prev.Assigned = JSON.stringify({ ...res, remarks: p.remarks || '', by: t.AssessorName, byPosition: t.AssessorPosition, at: now });
      prev.PositionCode = c.PositionCode; prev.UpdatedAt = now;
      await this.upsertMany('Hiring', 'HR_Status', ['AppNo'], [prev]);
      await this.upsertMany('Hiring', 'Interview_Tokens', ['Token'], [{ ...clean(t), Status: 'Completed', CompletedAt: now,
        SuggestedPosition: String(p.suggestedPosition || '').toUpperCase(), SuggestionReason: p.suggestionReason || '' }]);
      await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, { Status: 'Interviewed', UpdatedAt: now });
      await this.log('Hiring', c.AppNo, 'Round 2 scored', `${res.total}/${res.max} by ${t.AssessorName}`, t.AssessorName);
      return { message: 'Thank you. The score has been submitted.' };
    }
  },

  // decision: select | probation | reject | newRole
  decideCandidate: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const c = await this.candidate(p.appNo);
      if (!['Interview Scheduled', 'Interviewed'].includes(c.Status)) throw new Error(`Not allowed while the candidate is "${c.Status}"`);
      const sc = clean((await this.read('Hiring', 'HR_Status')).find(x => x.AppNo === c.AppNo) || { AppNo: c.AppNo });
      const hr = parseJSON(sc.HR), r2 = parseJSON(sc.Assigned);
      const now = new Date().toISOString(), d = p.decision;
      if (d === 'select' || d === 'probation') {
        if (!hr) throw new Error('Score the HR round first');
        const status = d === 'select' ? 'Selected' : 'Selected (Probation)';
        const total = (hr ? hr.total : 0) + (r2 ? r2.total : 0), max = (hr ? hr.max : 0) + (r2 ? r2.max : 0);
        await this.append('Hiring', 'Selected_Candidates', [{ AppNo: c.AppNo, Name: c.Name, Phone: c.Phone, PositionCode: c.PositionCode, Source: c.Source,
          HRScore: hr ? `${hr.total}/${hr.max}` : '', AssignedScore: r2 ? `${r2.total}/${r2.max}` : '', TotalScore: max ? Math.round(total / max * 1000) / 10 + '%' : '',
          DecisionDate: now.slice(0, 10), DecisionBy: user.u, Remarks: (d === 'probation' ? 'On probation. ' : '') + (p.remarks || '') }]);
        await this.upsertMany('Hiring', 'Selection_Offer', ['AppNo'], [{ AppNo: c.AppNo, Name: c.Name, PositionCode: c.PositionCode, NoticePeriod: c.NoticePeriod || '',
          EstDOJ: '', Call1Date: '', OfferLetterKey: '', Status: 'Pending', JoiningDate: '', CreatedAt: now, UpdatedAt: now }]);
        await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, { Status: status, UpdatedAt: now });
        await this.log('Hiring', c.AppNo, status, p.remarks || '', user.u);
        return { message: status };
      }
      if (d === 'reject') {
        await this.recordRejection(c, 'Post Interview', p.remarks, user.u, p.reason);
        const why = [p.reason, p.remarks].filter(Boolean).join(' — ');
        await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, { Status: 'Rejected', Remarks: why || c.Remarks, UpdatedAt: now });
        await this.log('Hiring', c.AppNo, 'Rejected after interview', why, user.u);
        return { message: 'Rejected' };
      }
      if (d === 'newRole') {
        const pos = await this.position(p.newPosition);
        if (pos.PositionCode === c.PositionCode) throw new Error('Choose a different position');
        const pending = (await this.read('Hiring', 'Interview_Tokens')).filter(t => t.AppNo === c.AppNo && t.Status === 'Pending').map(t => ({ ...clean(t), Status: 'Replaced' }));
        if (pending.length) await this.upsertMany('Hiring', 'Interview_Tokens', ['Token'], pending);
        await this.upsertMany('Hiring', 'HR_Status', ['AppNo'], [{ ...sc, Assigned: '', PositionCode: pos.PositionCode, UpdatedAt: now }]);
        await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, { PositionCode: pos.PositionCode, Status: 'Interview Scheduled', UpdatedAt: now });
        await this.log('Hiring', c.AppNo, 'Moved to new role', `${c.PositionCode} → ${pos.PositionCode}${p.remarks ? ' · ' + p.remarks : ''}`, user.u);
        return { message: 'Moved to ' + pos.PositionName + '. Run Round 2 for the new role.' };
      }
      throw new Error('Unknown decision');
    }
  },

  // step: sent | accepted | declined (optional) + details
  updateOffer: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const c = await this.candidate(p.appNo);
      const off = clean((await this.read('Hiring', 'Selection_Offer')).find(x => x.AppNo === c.AppNo) || null);
      if (!off || !off.AppNo) throw new Error('No offer record for this candidate');
      if (['Joined', 'Declined'].includes(off.Status)) throw new Error('This offer is closed');
      const now = new Date().toISOString(), ch = {};
      ['NoticePeriod', 'Call1Date'].forEach(k => { if (p.changes && k in p.changes) ch[k] = String(p.changes[k] || ''); });
      if (p.changes && p.changes.EstDOJ !== undefined) ch.EstDOJ = p.changes.EstDOJ ? normDate(p.changes.EstDOJ) : '';
      let candStatus = null;
      if (p.step === 'sent') { if (off.Status !== 'Pending') throw new Error('Offer already sent'); ch.Status = 'Offer Sent'; candStatus = 'Offer Sent'; if (!ch.Call1Date && !off.Call1Date) ch.Call1Date = now.slice(0, 10); }
      if (p.step === 'accepted') { if (off.Status !== 'Offer Sent') throw new Error('Mark the offer as sent first'); ch.Status = 'Accepted'; candStatus = 'Offer Accepted'; }
      if (p.step === 'declined') { ch.Status = 'Declined'; candStatus = 'Offer Rejected'; }
      await this.upsertMany('Hiring', 'Selection_Offer', ['AppNo'], [{ ...off, ...ch, UpdatedAt: now }]);
      if (candStatus) await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, { Status: candStatus, UpdatedAt: now });
      await this.log('Hiring', c.AppNo, candStatus || 'Offer details updated', p.remarks || [ch.NoticePeriod && 'Notice ' + ch.NoticePeriod, ch.EstDOJ && 'Expected joining ' + ch.EstDOJ].filter(Boolean).join(' · '), user.u);
      return { message: candStatus || 'Saved' };
    }
  },

  markJoined: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const c = await this.candidate(p.appNo);
      if (c.Status !== 'Offer Accepted') throw new Error('Only candidates who accepted the offer can be marked joined');
      const ctx = await this.empContext();
      const e = normEmp({ EmpId: p.empId || '', FullName: c.Name, Gender: c.Gender, DOB: c.DOB, Phone: c.Phone, Email: c.Email,
        StoreCode: p.storeCode, PositionCode: c.PositionCode, ReportingManagerId: p.reportingManagerId, JoiningDate: p.joiningDate,
        EmploymentType: p.employmentType || 'Permanent', Status: 'Probation', CandidateAppNo: c.AppNo });
      if (!e.JoiningDate) throw new Error('Joining date is required');
      if (ctx.employees.find(x => x.CandidateAppNo === c.AppNo)) throw new Error('An employee record already exists for this candidate');
      validateEmp(e, ctx, null);
      if (!e.EmpId) e.EmpId = (await this.nextEmpIds([e.StoreCode], ctx))[0];
      if (ctx.employees.find(x => x.EmpId === e.EmpId)) throw new Error('Employee ID already exists: ' + e.EmpId);
      const now = new Date().toISOString();
      await this.append('Organisation', 'Employees', [{ ...e, CreatedAt: now, UpdatedAt: now }]);
      const off = clean((await this.read('Hiring', 'Selection_Offer')).find(x => x.AppNo === c.AppNo) || { AppNo: c.AppNo, Name: c.Name, PositionCode: c.PositionCode, CreatedAt: now });
      await this.upsertMany('Hiring', 'Selection_Offer', ['AppNo'], [{ ...off, Status: 'Joined', JoiningDate: e.JoiningDate, UpdatedAt: now }]);
      await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, { Status: 'Joined', UpdatedAt: now });
      await this.letterTabs();
      const candSal = (await this.read('Organisation', 'Salary')).find(x => x.Ref === c.AppNo);
      if (candSal) await this.upsertMany('Organisation', 'Salary', ['Ref'], [{ ...clean(candSal), Ref: e.EmpId, EffectiveFrom: e.JoiningDate, UpdatedAt: now }]);
      if ((await this.modules()).includes('FILES')) try { await this.moveCandidateFiles(c.AppNo, e.EmpId); } catch (err) { /* never block joining */ }
      const obOn = (await this.modules()).includes('ONBOARDING');
      const ob = obOn ? await this.startChecklist('Onboarding', e, null) : null;
      await this.log('Hiring', c.AppNo, 'Joined', `Employee ${e.EmpId}`, user.u);
      await this.log('Organisation', e.EmpId, 'Employee added (joined)', `${e.FullName} from ${c.AppNo}`, user.u);
      return { message: `Joined as ${e.EmpId}.${obOn ? ' Onboarding started.' : ''}`, empId: e.EmpId, recordId: ob ? ob.RecordId : '' };
    }
  },

  // ═════════════ ONBOARDING & EXIT ═════════════
  getLifecycle: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function () {
      const out = {};
      for (const kind of ['Onboarding', 'Exit']) {
        out[kind] = {
          template: await this.checklistTemplate(kind),
          records: (await this.read('HR_Ops', kind + '_Records')).map(clean),
          items: (await this.read('HR_Ops', kind + '_Items')).map(clean)
        };
      }
      const employees = (await this.read('Organisation', 'Employees')).map(e => ({ EmpId: e.EmpId, FullName: e.FullName, PositionCode: e.PositionCode,
        StoreCode: e.StoreCode, JoiningDate: e.JoiningDate, Status: e.Status, ExitDate: e.ExitDate, CandidateAppNo: e.CandidateAppNo || '' }));
      const positions = (await this.read('Organisation', 'Positions')).map(p => ({ PositionCode: p.PositionCode, PositionName: p.PositionName }));
      return { onboarding: out.Onboarding, exit: out.Exit, employees, positions, lists: await this.lists() };
    }
  },

  startOnboarding: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      throw new Error('Onboarding starts automatically when a candidate is marked Joined in Hiring.');
      const e = (await this.read('Organisation', 'Employees')).find(x => x.EmpId === p.empId);
      if (!e || e.Status === 'Exited') throw new Error('Employee not found');
      const r = await this.startChecklist('Onboarding', e, null);
      await this.log('HR_Ops', r.RecordId, 'Onboarding started', e.FullName, user.u);
      return { message: 'Onboarding started', recordId: r.RecordId };
    }
  },

  startExit: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const e = (await this.read('Organisation', 'Employees')).find(x => x.EmpId === p.empId);
      if (!e || GONE(e.Status)) throw new Error('Employee not found or already exited');
      if (!p.lastWorkingDay) throw new Error('Last working day is required');
      const lwd = normDate(p.lastWorkingDay);
      await this.ensureColumns('HR_Ops', 'Exit_Records', ['Reason', 'PrevStatus']);
      const r = await this.startChecklist('Exit', e, { LastWorkingDay: lwd, Reason: p.reason || '', PrevStatus: e.Status });
      await this.update('Organisation', 'Employees', 'EmpId', e.EmpId, { Status: 'Notice Period', ExitDate: lwd, UpdatedAt: new Date().toISOString() });
      await this.log('HR_Ops', r.RecordId, 'Exit started', `${e.FullName} · LWD ${lwd}${p.reason ? ' · ' + p.reason : ''}`, user.u);
      return { message: 'Exit started', recordId: r.RecordId };
    }
  },

  saveChecklist: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const kind = p.kind === 'Exit' ? 'Exit' : 'Onboarding';
      const rec = (await this.read('HR_Ops', kind + '_Records')).find(r => r.RecordId === p.recordId);
      if (!rec) throw new Error('Record not found');
      if (rec.Status === 'Completed') throw new Error('Already completed');
      if (rec.Status === 'Cancelled') throw new Error('This checklist was cancelled');
      const old = (await this.read('HR_Ops', kind + '_Items')).filter(i => i.RecordId === rec.RecordId);
      const okVals = kind === 'Exit' ? ['', 'Done', 'NA'] : ['', 'Yes', 'NA'];
      const now = new Date().toISOString();
      const rows = (p.items || []).map(it => {
        if (!okVals.includes(it.Status || '')) throw new Error('Invalid status ' + it.Status);
        const o = old.find(x => x.ItemId === it.ItemId) || {};
        const changed = (o.Status || '') !== (it.Status || '') || (o.Remarks || '') !== (it.Remarks || '');
        return { RecordId: rec.RecordId, ItemId: it.ItemId, Status: it.Status || '', Remarks: it.Remarks || '',
          DoneBy: changed ? user.u : (o.DoneBy || ''), DoneAt: changed ? now : (o.DoneAt || '') };
      });
      if (rows.length) await this.upsertMany('HR_Ops', kind + '_Items', ['RecordId', 'ItemId'], rows);
      await this.log('HR_Ops', rec.RecordId, kind + ' checklist saved', `${rows.filter(r => r.Status).length} items marked`, user.u);
      return { message: 'Saved' };
    }
  },

  completeChecklist: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const kind = p.kind === 'Exit' ? 'Exit' : 'Onboarding';
      const rec = clean((await this.read('HR_Ops', kind + '_Records')).find(r => r.RecordId === p.recordId) || null);
      if (!rec || !rec.RecordId) throw new Error('Record not found');
      if (rec.Status === 'Completed') throw new Error('Already completed');
      if (rec.Status === 'Cancelled') throw new Error('This checklist was cancelled');
      const tpl = await this.checklistTemplate(kind);
      const items = (await this.read('HR_Ops', kind + '_Items')).filter(i => i.RecordId === rec.RecordId);
      const missing = items.filter(i => !i.Status && (tpl.find(t => t.ItemId === i.ItemId) || {}).Mandatory !== 'No');
      if (missing.length) throw new Error(`${missing.length} mandatory items are still open`);
      const now = new Date().toISOString();
      await this.upsertMany('HR_Ops', kind + '_Records', ['RecordId'], [{ ...rec, Status: 'Completed', CompletedAt: now }]);
      if (kind === 'Exit') {
        await this.update('Organisation', 'Employees', 'EmpId', rec.EmpId, { Status: 'Exited', ExitDate: rec.LastWorkingDay || now.slice(0, 10), UpdatedAt: now });
        const users = await this.read('Settings', 'Users');
        const linked = users.filter(u => u.EmpId === rec.EmpId && u.Active !== 'No');
        for (const u of linked) await this.update('Settings', 'Users', 'Username', u.Username, { Active: 'No' });
        await this.log('Organisation', rec.EmpId, 'Employee exited', `${rec.EmployeeName}${linked.length ? ' · login disabled' : ''}`, user.u);
      }
      await this.log('HR_Ops', rec.RecordId, kind + ' completed', rec.EmployeeName, user.u);
      return { message: kind === 'Exit' ? 'Exit completed. Employee marked Exited.' : 'Onboarding completed' };
    }
  },

  // Cancel an open onboarding / exit (e.g. employee decided to stay). The record is kept, marked Cancelled.
  cancelChecklist: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const kind = p.kind === 'Exit' ? 'Exit' : 'Onboarding', tab = kind + '_Records';
      const reason = String(p.reason || '').trim(); if (!reason) throw new Error('Choose the reason for cancelling');
      const rec = clean((await this.read('HR_Ops', tab)).find(r => r.RecordId === p.recordId) || null);
      if (!rec || !rec.RecordId) throw new Error('Record not found');
      if (['Completed', 'Cancelled'].includes(rec.Status)) throw new Error('This checklist is already ' + rec.Status.toLowerCase());
      await this.ensureColumns('HR_Ops', tab, ['CancelReason', 'CancelledBy', 'CancelledAt']);
      const now = new Date().toISOString(), why = reason + (p.note ? ' — ' + String(p.note).trim() : '');
      await this.upsertMany('HR_Ops', tab, ['RecordId'], [{ ...rec, Status: 'Cancelled', CancelReason: why, CancelledBy: user.u, CancelledAt: now }]);
      const e = (await this.read('Organisation', 'Employees')).find(x => x.EmpId === rec.EmpId);
      let message = kind + ' cancelled';
      if (e && kind === 'Exit' && e.Status === 'Notice Period') {
        const back = ['Probation', 'Confirmed'].includes(rec.PrevStatus) ? rec.PrevStatus : (e.ProbationEndDate && String(e.ProbationEndDate) > now.slice(0, 10) ? 'Probation' : 'Confirmed');
        await this.update('Organisation', 'Employees', 'EmpId', e.EmpId, { Status: back, ExitDate: '', UpdatedAt: now });
        message += `. ${e.FullName} is back to ${back}.`;
      }
      if (e && kind === 'Onboarding' && e.CandidateAppNo && !GONE(e.Status)) {
        // Hired person did not actually join: keep the record as "Did not join", out of headcount and attrition
        await this.update('Organisation', 'Employees', 'EmpId', e.EmpId, { Status: 'Did not join', ExitDate: '', UpdatedAt: now });
        const users = (await this.read('Settings', 'Users')).filter(u => u.EmpId === e.EmpId && u.Active !== 'No');
        for (const u of users) await this.update('Settings', 'Users', 'Username', u.Username, { Active: 'No' });
        const cand = (await this.read('Hiring', 'Candidates')).find(c => c.AppNo === e.CandidateAppNo);
        if (cand) await this.update('Hiring', 'Candidates', 'AppNo', cand.AppNo, { Status: 'Offer Rejected', Remarks: 'Did not join: ' + why, UpdatedAt: now });
        const off = (await this.read('Hiring', 'Selection_Offer')).find(o => o.AppNo === e.CandidateAppNo);
        if (off) await this.upsertMany('Hiring', 'Selection_Offer', ['AppNo'], [{ ...clean(off), Status: 'Declined', UpdatedAt: now }]);
        await this.log('Organisation', e.EmpId, 'Did not join', `${e.FullName} · ${why}${users.length ? ' · login disabled' : ''}`, user.u);
        if (cand) await this.log('Hiring', cand.AppNo, 'Did not join', why, user.u);
        message += `. ${e.FullName} is marked "Did not join"${cand ? ' and the candidate is back in Hiring as Offer Rejected' : ''}.`;
      }
      await this.log('HR_Ops', rec.RecordId, kind + ' cancelled', `${rec.EmployeeName} · ${why}`, user.u);
      return { message };
    }
  },

  saveChecklistTemplate: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const kind = p.kind === 'Exit' ? 'Exit' : 'Onboarding', pre = kind === 'Exit' ? 'EX' : 'OB';
      const items = (p.items || []).filter(i => String(i.Item || '').trim() && String(i.Section || '').trim());
      if (!items.length) throw new Error('Add at least one item');
      const used = new Set(items.map(i => i.ItemId).filter(Boolean));
      let n = 1;
      const rows = items.map(i => {
        let id = i.ItemId;
        if (!id) { do { id = `${pre}-N-${n++}`; } while (used.has(id)); used.add(id); }
        return { Section: i.Section.trim(), ItemId: id, Item: i.Item.trim(), Mandatory: i.Mandatory === 'No' ? 'No' : 'Yes', Active: i.Active === 'No' ? 'No' : 'Yes' };
      });
      await this.rewriteTab('HR_Ops', kind + '_Template', rows);
      await this.log('HR_Ops', kind.toUpperCase() + '_TEMPLATE', 'Template saved', `${rows.length} items`, user.u);
      return { message: 'Template saved. New records will use it.' };
    }
  },

  // ═════════════ LETTERS ═════════════
  getLetterSetup: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function () {
      await this.letterTabs();
      const company = await this.companyMap();
      const brand = {}; BRAND_KEYS.forEach(k => brand[k] = company[k] || '');
      const saved = (await this.read('Settings', 'Letter_Templates')).map(clean);
      const templates = LETTER_TYPES.map(t => ({ ...t, ...(saved.find(s => s.Type === t.Type) || {}), isDefault: !saved.find(s => s.Type === t.Type) }))
        .concat(saved.filter(s => !LETTER_TYPES.find(t => t.Type === s.Type)).map(s => ({ ...s, Ref: 'employee', custom: true })));
      const components = (await this.read('Settings', 'Salary_Components')).map(clean).sort((a, b) => Number(a.Order) - Number(b.Order));
      return { brand, templates, components, fields: LETTER_FIELDS };
    }
  },

  saveBranding: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      const vals = {};
      for (const k of BRAND_KEYS) if (p.values && k in p.values) {
        const v = String(p.values[k] ?? '');
        if (v.length > 48000) throw new Error(`${k.replace('Brand', '')} is too large. Use a smaller image.`);
        vals[k] = v;
      }
      await this.setCompany(vals);
      await this.log('Settings', 'BRANDING', 'Letterhead updated', Object.keys(vals).join(', '), user.u);
      return { message: 'Saved' };
    }
  },

  saveLetterTemplate: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      await this.letterTabs();
      const type = String(p.type || '').trim();
      if (!/^[a-z0-9_]+$/.test(type)) throw new Error('Letter type code: small letters, numbers and _ only');
      if (!String(p.title || '').trim()) throw new Error('Title is required');
      if (String(p.body || '').length > 45000 || String(p.customHtml || '').length > 45000) throw new Error('Template is too long');
      if (p.reset) {
        const left = (await this.read('Settings', 'Letter_Templates')).map(clean).filter(t => t.Type !== type);
        await this.rewriteTab('Settings', 'Letter_Templates', left);
        await this.log('Settings', type, 'Letter template reset to default', '', user.u);
        return { message: 'Reset to default wording' };
      }
      await this.upsertMany('Settings', 'Letter_Templates', ['Type'], [{ Type: type, Title: p.title.trim(), Body: p.body || '', CustomHTML: p.customHtml || '',
        Ref: p.ref === 'candidate' ? 'candidate' : 'employee', UpdatedBy: user.u, UpdatedAt: new Date().toISOString() }]);
      await this.log('Settings', type, 'Letter template saved', p.title, user.u);
      return { message: 'Saved' };
    }
  },

  saveSalaryComponents: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      await this.letterTabs();
      const rows = (p.components || []).filter(c => String(c.Name || '').trim()).map((c, i) => ({
        Name: String(c.Name).trim(), Type: ['Earning', 'Deduction', 'Employer'].includes(c.Type) ? c.Type : 'Earning', Order: i + 1, Active: c.Active === 'No' ? 'No' : 'Yes' }));
      const names = rows.map(r => r.Name.toLowerCase());
      if (new Set(names).size !== names.length) throw new Error('Component names must be unique');
      await this.rewriteTab('Settings', 'Salary_Components', rows);
      await this.log('Settings', 'SALARY', 'Salary components saved', rows.length + ' components', user.u);
      return { message: 'Saved' };
    }
  },

  // ref = AppNo (candidate) or EmpId
  getSalary: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function (p) {
      await this.letterTabs();
      const components = (await this.read('Settings', 'Salary_Components')).map(clean).filter(c => c.Active !== 'No').sort((a, b) => a.Order - b.Order);
      return { components, salary: await this.salaryOf(p.ref) };
    }
  },

  saveSalary: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      await this.letterTabs();
      const ref = String(p.ref || '');
      const isCand = ref.startsWith('APP-');
      if (isCand) await this.candidate(ref);
      else if (!(await this.read('Organisation', 'Employees')).find(e => e.EmpId === ref)) throw new Error('Employee not found');
      const comps = (await this.read('Settings', 'Salary_Components')).filter(c => c.Active !== 'No');
      if (!comps.length) throw new Error('Set up salary components first (Settings → Salary components)');
      const amounts = {};
      comps.forEach(c => { const v = p.amounts ? p.amounts[c.Name] : ''; if (v !== '' && v !== undefined && v !== null) { if (isNaN(Number(v)) || Number(v) < 0) throw new Error(c.Name + ': enter a valid amount'); amounts[c.Name] = Number(v); } });
      const row = salaryRow(ref, amounts, comps, p.effectiveFrom, user.u);
      await this.upsertMany('Organisation', 'Salary', ['Ref'], [row]);
      await this.log(isCand ? 'Hiring' : 'Organisation', ref, 'Salary saved', `CTC ${row.AnnualCTC}`, user.u);
      return { message: `Saved · CTC ₹${Number(row.AnnualCTC).toLocaleString('en-IN')} per year`, salary: row };
    }
  },

  // Everything a letter needs: template, branding, known fields, salary
  getLetterData: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function (p) {
      await this.letterTabs();
      const type = String(p.type || '');
      const saved = (await this.read('Settings', 'Letter_Templates')).find(s => s.Type === type);
      const def = LETTER_TYPES.find(t => t.Type === type);
      if (!saved && !def) throw new Error('Unknown letter type: ' + type);
      const tpl = { ...(def || { Ref: 'employee' }), ...(saved ? clean(saved) : {}) };
      const company = await this.companyMap();
      const brand = {}; BRAND_KEYS.forEach(k => brand[k] = company[k] || '');
      const fields = await this.letterFields(tpl.Ref, p.ref, company);
      const salary = await this.salaryOf(p.ref);
      const prev = (await this.read('Library', 'Letters_Issued')).filter(l => l.Ref === p.ref && l.Type === type).map(l => ({ LetterNo: l.LetterNo, IssuedOn: l.IssuedOn, IssuedBy: l.IssuedBy }));
      const components = (await this.read('Settings', 'Salary_Components')).map(clean).sort((x, y) => x.Order - y.Order);
      return { template: tpl, brand, fields, salary, components, previous: prev };
    }
  },

  issueLetter: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      await this.letterTabs();
      if (!p.type || !p.ref) throw new Error('Letter type and person are required');
      const company = await this.companyMap(), year = new Date().getFullYear(), key = 'LetterNext_' + year;
      const n = Number(company[key] || 1);
      const prefix = (company.BrandLetterPrefix || 'HR').trim();
      const code = (LETTER_TYPES.find(t => t.Type === p.type) || {}).Code || p.type.slice(0, 3).toUpperCase();
      const letterNo = `${prefix}/${code}/${year}/${String(n).padStart(3, '0')}`;
      await this.setCompany({ [key]: n + 1 });
      const now = new Date().toISOString();
      const snapshot = JSON.stringify({ title: p.title || '', body: p.body || '', customHtml: p.customHtml || '', fields: { ...(p.fields || {}), LetterNo: letterNo }, salary: p.salary || null });
      if (snapshot.length > 48000) throw new Error('Letter is too long to store');
      await this.append('Library', 'Letters_Issued', [{ LetterNo: letterNo, Type: p.type, Ref: p.ref, Name: (p.fields || {}).Name || '', Title: p.title || '', IssuedOn: now, IssuedBy: user.u, Snapshot: snapshot }]);
      await this.log(String(p.ref).startsWith('APP-') ? 'Hiring' : 'Organisation', p.ref, 'Letter issued', `${p.title || p.type} · ${letterNo}`, user.u);
      return { letterNo, issuedOn: now };
    }
  },

  getLettersIssued: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function (p) {
      await this.letterTabs();
      const rows = (await this.read('Library', 'Letters_Issued')).filter(l => !p.ref || l.Ref === p.ref)
        .map(l => ({ LetterNo: l.LetterNo, Type: l.Type, Ref: l.Ref, Name: l.Name, Title: l.Title, IssuedOn: l.IssuedOn, IssuedBy: l.IssuedBy }));
      return { letters: rows.sort((a, b) => (a.IssuedOn < b.IssuedOn ? 1 : -1)) };
    }
  },

  getIssuedLetter: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function (p) {
      const l = (await this.read('Library', 'Letters_Issued')).find(x => x.LetterNo === p.letterNo);
      if (!l) throw new Error('Letter not found');
      const company = await this.companyMap();
      const brand = {}; BRAND_KEYS.forEach(k => brand[k] = company[k] || '');
      const components = (await this.read('Settings', 'Salary_Components')).map(clean).sort((x, y) => x.Order - y.Order);
      return { letter: { ...clean(l), Snapshot: undefined }, snapshot: parseJSON(l.Snapshot), brand, components };
    }
  },

  // ═════════════ REPORTS ═════════════
  // One call returns everything the reports page needs. Managers get only their own team and no hiring data.
  getReportData: {
    auth: true,
    fn: async function (p, user) {
      const isHR = [ROLES.SUPER, ROLES.ADMIN, ROLES.HR].includes(user.r);
      const yNow = new Date().getFullYear(), pre = [['Settings', 'Company'], ['Settings', 'Stores'], ['Organisation', 'Employees'], ['Organisation', 'Positions'], ['Organisation', 'TransferHistory'],
        ['Library', 'Role_Summary'], ['Performance', 'KPI_Parameters'], ['Performance', 'Rating_Bands']];
      for (let y = yNow - 2; y <= yNow + 1; y++) pre.push(['KPI_' + y, 'KPI_Summary'], ['KPI_' + y, 'KPI_Entries']);
      if (isHR) pre.push(...['Candidates', 'Interview_Schedule', 'Selection_Offer', 'Rejected_Candidates'].map(t => ['Hiring', t]),
        ...['Onboarding', 'Exit'].flatMap(k => [['HR_Ops', k + '_Template'], ['HR_Ops', k + '_Records'], ['HR_Ops', k + '_Items']]), ['Library', 'Letters_Issued']);
      await this.prefetch(pre);
      const company = await this.companyMap();
      const brand = {}; BRAND_KEYS.forEach(k => brand[k] = company[k] || '');
      let employees = (await this.read('Organisation', 'Employees')).map(clean).filter(e => e.Status !== 'Did not join');
      if (!isHR) {
        if (!user.e) throw new Error('Your login is not linked to an employee. Ask Admin to link it in Settings → Users.');
        employees = employees.filter(e => e.ReportingManagerId === user.e);
      }
      const team = new Set(employees.map(e => e.EmpId));
      const positions = (await this.read('Organisation', 'Positions')).map(clean);
      const stores = (await this.read('Settings', 'Stores')).map(clean);
      const transfers = (await this.read('Organisation', 'TransferHistory')).filter(t => team.has(t.EmpId)).map(clean);
      const roles = (await this.read('Library', 'Role_Summary')).map(r => ({ PositionCode: r.PositionCode, JobPurpose: r.JobPurpose }));
      // KPI: summaries for the range, entries for one month
      const reg = await this.getRegistry();
      const kFrom = /^\d{4}-\d{2}$/.test(p.kpiFrom || '') ? p.kpiFrom : '0000-00', kTo = /^\d{4}-\d{2}$/.test(p.kpiTo || '') ? p.kpiTo : '9999-99';
      const kpiSummaries = [], kpiEntries = [];
      const y1 = Math.max(Number(kFrom.slice(0, 4)), new Date().getFullYear() - 2), y2 = Math.min(Number(kTo.slice(0, 4)), new Date().getFullYear() + 1);
      for (let y = y1; y <= y2; y++) {
        if (!reg['KPI_' + y]) continue;
        (await this.read('KPI_' + y, 'KPI_Summary')).forEach(r => { if (r.Month >= kFrom && r.Month <= kTo && team.has(r.EmpId) && ['Approved', 'Submitted'].includes(r.Status)) kpiSummaries.push(clean(r)); });
        if (p.entriesMonth && p.entriesMonth.startsWith(String(y)))
          (await this.read('KPI_' + y, 'KPI_Entries')).forEach(r => { if (r.Month === p.entriesMonth && team.has(r.EmpId)) kpiEntries.push(clean(r)); });
      }
      const kpiParams = (await this.read('Performance', 'KPI_Parameters')).map(clean).filter(k => k.Active !== 'No');
      let bands = (await this.read('Performance', 'Rating_Bands')).map(clean); if (!bands.length) bands = DEFAULT_BANDS;
      const out = { brand, companyName: company.CompanyName || '', isHR, employees, positions, stores, transfers, roles, kpiSummaries, kpiEntries, kpiParams, bands };
      if (isHR) {
        const H = t => this.read('Hiring', t).then(r => r.map(clean));
        out.candidates = (await H('Candidates')).map(c => ({ AppNo: c.AppNo, Name: c.Name, PositionCode: c.PositionCode, Source: c.Source, Status: c.Status, Date: c.Date, StoreCode: c.StoreCode }));
        out.schedule = (await H('Interview_Schedule')).map(s => ({ AppNo: s.AppNo, Call1Date: s.Call1Date, Call2Date: s.Call2Date, InterviewDate: s.InterviewDate }));
        out.offers = (await H('Selection_Offer')).map(o => ({ AppNo: o.AppNo, Status: o.Status, CreatedAt: o.CreatedAt, JoiningDate: o.JoiningDate }));
        out.rejected = (await H('Rejected_Candidates')).map(r => ({ AppNo: r.AppNo, Stage: r.Stage, Reason: r.Reason || '' }));
        for (const kind of ['Onboarding', 'Exit']) out[kind.toLowerCase()] = {
          template: await this.checklistTemplate(kind),
          records: (await this.read('HR_Ops', kind + '_Records')).map(clean),
          items: (await this.read('HR_Ops', kind + '_Items')).map(i => ({ RecordId: i.RecordId, ItemId: i.ItemId, Status: i.Status }))
        };
        try { await this.letterTabs(); out.letters = (await this.read('Library', 'Letters_Issued')).map(l => ({ LetterNo: l.LetterNo, Ref: l.Ref, Title: l.Title, IssuedOn: l.IssuedOn })); } catch (e) { out.letters = []; }
      }
      return out;
    }
  },

  // ═════════════ FILES (uploads) ═════════════
  getFileSetup: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function (p, user) {
      const c = await this.companyMap();
      const out = { docTypes: await this.docTypes(), configured: !!c.UploadUrl, retentionDays: Number(c.FileRetentionDays || 90) };
      if (user.r === ROLES.SUPER) {
        let secret = c.UploadSecret;
        if (!secret) { secret = randomHex(16); await this.setCompany({ UploadSecret: secret }); }
        Object.assign(out, { uploadUrl: c.UploadUrl || '', uploadSecret: secret, folderId: '' });
      }
      return out;
    }
  },

  saveStorageSettings: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      const url = String(p.uploadUrl || '').trim();
      if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('Paste the Web app URL ending in /exec (from Deploy > Manage deployments)');
      const days = Number(p.retentionDays || 90);
      if (isNaN(days) || days < 7 || days > 3650) throw new Error('Keep files of rejected candidates for 7 to 3650 days');
      const vals = { UploadUrl: url, FileRetentionDays: days };
      if (p.newSecret) vals.UploadSecret = randomHex(16);
      await this.setCompany(vals);
      await this.log('Settings', 'STORAGE', 'File storage settings saved', p.newSecret ? 'new secret created' : '', user.u);
      return { message: p.newSecret ? 'New secret created — paste it into the upload script and deploy again.' : 'Saved' };
    }
  },

  testStorage: {
    auth: true, roles: [ROLES.SUPER],
    fn: async function () {
      const r = await this.helper('ping', {});
      return { message: `Connected · files go to "${r.folder}" in Google Drive` };
    }
  },

  saveDocTypes: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      await this.fileTabs();
      const rows = [], seen = new Set();
      (p.docTypes || []).forEach((d, i) => {
        const name = String(d.Name || '').trim(); if (!name) return;
        let code = String(d.Code || '').trim().toUpperCase() || name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
        if (seen.has(code)) throw new Error('Duplicate document: ' + name); seen.add(code);
        const sys = SYSTEM_DOCS.find(s => s.Code === code);
        rows.push({ Code: code, Name: name, AppliesTo: sys ? sys.AppliesTo : (['Candidate', 'Employee', 'Both'].includes(d.AppliesTo) ? d.AppliesTo : 'Employee'),
          CandidateForm: CANDIDATE_FORM_DOCS.includes(code) ? (['Mandatory', 'Optional', 'Hidden'].includes(d.CandidateForm) ? d.CandidateForm : 'Optional') : '',
          Active: d.Active === 'No' && !sys ? 'No' : 'Yes', Order: i + 1 });
      });
      SYSTEM_DOCS.forEach(s => { if (!seen.has(s.Code)) rows.push({ ...s, Order: rows.length + 1 }); });
      await this.rewriteTab('Settings', 'Document_Types', rows);
      await this.log('Settings', 'DOCTYPES', 'Document types saved', rows.length + ' types', user.u);
      return { message: 'Saved' };
    }
  },

  uploadFile: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      const ref = String(p.ref || '');
      const isCand = ref.startsWith('APP-');
      const person = isCand ? await this.candidate(ref) : (await this.read('Organisation', 'Employees')).find(e => e.EmpId === ref);
      if (!person) throw new Error('Person not found: ' + ref);
      const types = await this.docTypes();
      const f = { ...(p.file || {}), docType: String(p.docType || '').toUpperCase() };
      if (!types.find(t => t.Code === f.docType && t.Active !== 'No')) throw new Error('Unknown document type');
      checkFile(f);
      const rows = await this.storeFiles(ref, (isCand ? 'Candidates/' : 'Employees/') + ref, [f], user.u, p.note || '');
      if (p.link && p.link.recordId && p.link.itemId) {
        const kind = p.link.kind === 'Exit' ? 'Exit' : 'Onboarding';
        await this.ensureColumns('HR_Ops', kind + '_Items', ['FileId']);
        const it = (await this.read('HR_Ops', kind + '_Items')).find(i => i.RecordId === p.link.recordId && i.ItemId === p.link.itemId);
        if (it) await this.upsertMany('HR_Ops', kind + '_Items', ['RecordId', 'ItemId'], [{ ...clean(it), FileId: rows[0].FileId }]);
      }
      await this.log(isCand ? 'Hiring' : 'Organisation', ref, 'File uploaded', `${f.docType}: ${f.name}`, user.u);
      if (isCand) await this.refreshIncomplete(ref);
      return { message: 'Uploaded', file: { ...rows[0], Thumb: undefined } };
    }
  },

  listFiles: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function (p) {
      await this.fileTabs();
      const refs = [p.ref, p.alsoRef].filter(Boolean);
      const files = (await this.read('Organisation', 'Files')).filter(f => refs.includes(f.Ref) && f.Status !== 'Deleted').map(f => ({ ...clean(f), Thumb: undefined }));
      return { files: files.sort((a, b) => a.UploadedAt < b.UploadedAt ? 1 : -1), docTypes: await this.docTypes() };
    }
  },

  // Streams the file itself (not JSON) to Admin / HR
  getFile: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR],
    fn: async function (p, user) {
      await this.fileTabs();
      const f = (await this.read('Organisation', 'Files')).find(x => x.FileId === p.fileId && x.Status !== 'Deleted');
      if (!f) throw new Error('File not found');
      const token = await this.googleToken();
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.FileId)}?alt=media`, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error('Could not read the file from Google Drive (' + res.status + ')');
      this.log('Files', f.Ref, 'File viewed', `${f.DocType}: ${f.FileName}`, user.u);
      return { __raw: new Response(res.body, { headers: { 'Content-Type': f.Mime || 'application/octet-stream', 'Content-Disposition': `inline; filename="${String(f.FileName).replace(/"/g, '')}"`, 'Cache-Control': 'no-store' } }) };
    }
  },

  deleteFile: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
      await this.fileTabs();
      const f = (await this.read('Organisation', 'Files')).find(x => x.FileId === p.fileId && x.Status !== 'Deleted');
      if (!f) throw new Error('File not found');
      await this.helper('trash', { fileIds: [f.FileId] });
      await this.upsertMany('Organisation', 'Files', ['FileId'], [{ ...clean(f), Status: 'Deleted', DeletedAt: new Date().toISOString() }]);
      await this.log('Files', f.Ref, 'File deleted', `${f.DocType}: ${f.FileName}`, user.u);
      return { message: 'Deleted' };
    }
  },

  // Small photo thumbnails for lists (all roles). Only photos — never documents.
  getPhotos: {
    auth: true,
    fn: async function () {
      if (!(await this.modules()).includes('FILES')) return { photos: {} };
      await this.fileTabs();
      const out = {};
      (await this.read('Organisation', 'Files')).filter(f => f.DocType === 'PHOTO' && f.Status !== 'Deleted' && f.Thumb)
        .sort((a, b) => a.UploadedAt < b.UploadedAt ? -1 : 1).forEach(f => out[f.Ref] = f.Thumb);
      return { photos: out };
    }
  },

  runFileCleanup: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) { return this.purgeRejected(user.u); }
  },

  // ── Start fresh: clears ALL client data. Keeps only the C&B Super Admin, the spreadsheet list and the file-upload connection. ──
  resetAllData: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      const company = await this.companyMap();
      const expect = String(company.CompanyName || '').trim() || 'RESET';
      if (String(p.confirm || '').trim() !== expect) throw new Error(`Type ${company.CompanyName ? 'the company name' : 'RESET'} exactly to confirm`);
      const reg = await this.getRegistry(true), done = [];
      // 1. Uploaded documents → Drive trash (before the Files list is cleared)
      let trashed = 0;
      if (company.UploadUrl) {
        const ids = (await this.read('Organisation', 'Files').catch(() => [])).filter(f => f.Status !== 'Deleted' && f.FileId).map(f => f.FileId);
        for (let i = 0; i < ids.length; i += 200) { try { const r = await this.helper('trash', { fileIds: ids.slice(i, i + 200) }); trashed += Number(r.trashed || 0); } catch (e) { /* keep going */ } }
      }
      // 2. Every data row in every spreadsheet (headers stay) — one request per spreadsheet
      for (const [mod, id] of Object.entries(reg)) {
        if (!id) continue;
        const titles = [...await this.tabTitles(id, true)].filter(t => !(mod === 'Settings' && ['Registry', 'Company', 'Users'].includes(t)));
        if (!titles.length) continue;
        await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchClear`,
          { method: 'POST', body: JSON.stringify({ ranges: titles.map(t => `'${t.replace(/'/g, "''")}'!A2:ZZ`) }) });
        done.push(`${mod} (${titles.length} tabs)`);
      }
      // 3. Users: only the C&B Super Admin stays
      const keepUsers = (await this.read('Settings', 'Users')).filter(u => u.Role === ROLES.SUPER).map(clean);
      await this.rewriteTab('Settings', 'Users', keepUsers);
      // 4. Company settings back to defaults; keep the file-upload connection and the store limit
      const keep = {}; ['UploadUrl', 'UploadSecret', 'FileRetentionDays', 'StoreLimit'].forEach(k => { if (company[k] !== undefined && company[k] !== '') keep[k] = company[k]; });
      const fresh = { CompanyName: String(p.newCompanyName || '').trim(), EmpIdPrefix: 'EMP-', EmpIdDigits: 5, EmpIdNextNumber: 1, EmpIdPerStore: 'No',
        ProbationDays: 90, SameStructureAllStores: 'Yes', InterviewPassPct: 60, ...keep };
      await this.rewriteTab('Settings', 'Company', Object.entries(fresh).map(([Key, Value]) => ({ Key, Value })));
      // 5. Forget everything held in memory
      this.cache.clear(); this.done = new Map(); this.registry = null;
      await this.log('Settings', 'RESET', 'All client data cleared', `${done.join(', ')} · ${trashed} files to Drive trash · ${keepUsers.length} login kept`, user.u);
      return { message: `All data cleared. ${trashed ? trashed + ' uploaded files moved to the Drive trash. ' : ''}Only the C&B login is left.`, cleared: done };
    }
  },

  getModules: {
    auth: true, roles: [ROLES.SUPER],
    fn: async function () { return { modules: await this.modules(), all: Object.entries(MODULES).map(([k, m]) => ({ key: k, ...m })) }; }
  },

  saveModules: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      const on = new Set((p.modules || []).filter(m => MODULES[m]));
      Object.entries(MODULES).forEach(([k, m]) => { if (on.has(k) && m.needs) m.needs.forEach(n => on.add(n)); });   // switch on what a module needs
      const list = Object.keys(MODULES).filter(k => on.has(k));
      await this.setCompany({ Modules: list.length ? list.join(',') : 'NONE' });
      await this.log('Settings', 'MODULES', 'Modules saved', list.join(', ') || 'none', user.u);
      return { message: 'Saved', modules: list };
    }
  },

  getFormSetup: {
    auth: true, roles: [ROLES.SUPER],
    fn: async function () {
      return { form: await this.applyForm(), lists: await this.lists(), listNames: Object.fromEntries(Object.entries(LIST_DEFS).map(([k, d]) => [k, d.name])),
        types: FORM_TYPES, locked: FORM_LOCKED };
    }
  },

  saveApplyForm: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      const cur = await this.applyForm(), defs = defaultForm(), rows = [], seen = new Set();
      (p.form || []).forEach(q => {
        const label = String(q.Label || '').trim(); if (!label) return;
        const sys = defs.find(d => d.Code === q.Code);
        let code = sys ? sys.Code : String(q.Code || '').trim();
        if (!code || !cur.find(c => c.Code === code)) code = 'Q_' + label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24);
        let k = code, n = 2; while (seen.has(k) || (!sys && defs.find(d => d.Code === k))) k = code + '_' + n++; code = k;
        seen.add(code);
        const type = sys ? sys.Type : (FORM_TYPES.includes(q.Type) ? q.Type : 'Text');
        let setting = ['Mandatory', 'Optional', 'Hidden'].includes(q.Setting) ? q.Setting : 'Optional';
        if (FORM_LOCKED.includes(code)) setting = 'Mandatory';
        const opts = String(q.Options || '').split(',').map(x => x.trim()).filter(Boolean);
        if (type === 'Dropdown' && setting !== 'Hidden' && opts.length < 2) throw new Error(`"${label}": give at least 2 options, separated by commas`);
        rows.push({ Code: code, Label: label.slice(0, 200), Section: String(q.Section || 'Other').trim().slice(0, 60), Type: type, Options: type === 'Dropdown' ? opts.join(', ') : '',
          Setting: setting, Order: rows.length + 1, Hint: String(q.Hint || '').slice(0, 120), System: sys ? 'Yes' : 'No' });
      });
      defs.forEach(d => { if (!seen.has(d.Code)) rows.push({ ...d, Setting: FORM_LOCKED.includes(d.Code) ? 'Mandatory' : 'Hidden', Order: rows.length + 1 }); });
      const custom = rows.filter(r => r.System !== 'Yes').map(r => r.Code);
      if (custom.length) await this.ensureColumns('Hiring', 'Candidates', custom.concat(['Incomplete']));
      await this.rewriteTab('Settings', 'Apply_Form', rows);
      await this.log('Settings', 'APPLY_FORM', 'Apply form saved', rows.filter(r => r.Setting !== 'Hidden').length + ' questions shown', user.u);
      return { message: 'Saved' };
    }
  },

  saveLists: {
    auth: true, roles: [ROLES.SUPER], write: true,
    fn: async function (p, user) {
      await this.formTabs();
      const rows = [];
      Object.keys(LIST_DEFS).forEach(k => {
        const vals = [...new Set(((p.lists || {})[k] || []).map(v => String(v).trim()).filter(v => v && v.toLowerCase() !== 'other'))];
        if (!vals.length) throw new Error(LIST_DEFS[k].name + ': keep at least one value');
        vals.forEach((v, i) => rows.push({ List: k, Value: v.slice(0, 80), Order: i + 1 }));
      });
      await this.rewriteTab('Settings', 'Lists', rows);
      await this.log('Settings', 'LISTS', 'Lists saved', rows.length + ' values', user.u);
      return { message: 'Saved' };
    }
  },

  changeMyPassword: {
    auth: true, write: true,
    fn: async function (p, user) {
      const users = await this.read('Settings', 'Users');
      const me = users.find(x => x.Username === user.u);
      if (!me || !(await checkPassword(p.oldPassword || '', me.Salt, me.PasswordHash))) throw new Error('Current password is wrong');
      if (!p.newPassword || p.newPassword.length < 8) throw new Error('New password must be at least 8 characters');
      const { hash, salt } = await hashPassword(p.newPassword);
      await this.update('Settings', 'Users', 'Username', user.u, { PasswordHash: hash, Salt: salt });
      return { message: 'Password changed' };
    }
  }
};


// ───────────────────────── Helpers ─────────────────────────
const CANDIDATE_FORM_DOCS = ['PHOTO', 'RESUME', 'AADHAR'];
const SYSTEM_DOCS = [
  { Code: 'PHOTO', Name: 'Photo', AppliesTo: 'Both', CandidateForm: 'Optional', Active: 'Yes' },
  { Code: 'RESUME', Name: 'Resume', AppliesTo: 'Both', CandidateForm: 'Optional', Active: 'Yes' },
  { Code: 'AADHAR', Name: 'Aadhar (masked)', AppliesTo: 'Both', CandidateForm: 'Optional', Active: 'Yes' },
  { Code: 'CHECKLIST', Name: 'Checklist proof', AppliesTo: 'Employee', CandidateForm: '', Active: 'Yes' }
];
const DEFAULT_DOCS = SYSTEM_DOCS.concat([
  { Code: 'PAN', Name: 'PAN card', AppliesTo: 'Employee', CandidateForm: '', Active: 'Yes' },
  { Code: 'CERTIFICATES', Name: 'Educational certificates', AppliesTo: 'Both', CandidateForm: '', Active: 'Yes' },
  { Code: 'BANK', Name: 'Bank proof (passbook / cheque)', AppliesTo: 'Employee', CandidateForm: '', Active: 'Yes' },
  { Code: 'OFFER_SIGNED', Name: 'Signed offer letter', AppliesTo: 'Both', CandidateForm: '', Active: 'Yes' },
  { Code: 'APPOINTMENT_SIGNED', Name: 'Signed appointment letter', AppliesTo: 'Employee', CandidateForm: '', Active: 'Yes' },
  { Code: 'OTHER', Name: 'Other', AppliesTo: 'Both', CandidateForm: '', Active: 'Yes' }
]);
const FILE_TYPES = { 'application/pdf': [0x25, 0x50, 0x44, 0x46], 'image/jpeg': [0xFF, 0xD8, 0xFF], 'image/png': [0x89, 0x50, 0x4E, 0x47] };
function b64size(b64) { const s = String(b64 || ''); return Math.floor(s.length * 3 / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0); }
// Type, size and real content check (first bytes must match the type)
function checkFile(f) {
  if (!f || !f.data || !f.name) throw new Error('No file received');
  if (!FILE_TYPES[f.mime]) throw new Error(`${f.name}: only PDF, JPG and PNG files are allowed`);
  if (b64size(f.data) > 5 * 1024 * 1024) throw new Error(`${f.name}: larger than 5 MB`);
  let head;
  try { head = atob(String(f.data).slice(0, 12)); } catch (e) { throw new Error(`${f.name}: file could not be read`); }
  if (!FILE_TYPES[f.mime].every((b, i) => head.charCodeAt(i) === b)) throw new Error(`${f.name}: the file content is not a real ${f.mime.split('/')[1].toUpperCase()}`);
  f.name = String(f.name).replace(/[\\\/:*?"<>|#%]+/g, '_').slice(0, 120);
}

const BRAND_KEYS = ['BrandLogo', 'BrandSignature', 'BrandColor', 'BrandFont', 'BrandHeader', 'BrandFooter', 'BrandSignatoryName', 'BrandSignatoryDesignation',
  'BrandLetterPrefix', 'BrandMargin', 'BrandWatermark', 'BrandLogoAlign'];
const LETTER_FIELDS = {
  'Company': ['CompanyName', 'CompanyAddress', 'SignatoryName', 'SignatoryDesignation', 'Today', 'LetterNo'],
  'Person': ['Salutation', 'Name', 'FirstName', 'EmpId', 'AppNo', 'Phone', 'Email', 'Address', 'CityState'],
  'Job': ['Position', 'Department', 'StoreName', 'StoreCity', 'ReportingManager', 'ReportingManagerPosition', 'EmploymentType', 'JoiningDate', 'ExpectedJoiningDate', 'NoticePeriod', 'ProbationDays', 'ProbationEndDate', 'Tenure'],
  'Interview': ['InterviewDate', 'InterviewTime', 'InterviewPlace'],
  'Salary': ['CTC', 'MonthlyGross', 'MonthlyNet', 'SalaryEffectiveFrom', 'SalaryTable'],
  'Move / exit': ['PreviousPosition', 'NewPosition', 'PreviousStore', 'NewStore', 'TransferDate', 'TransferReason', 'LastWorkingDay', 'ExitReason'],
  'Typed on the letter screen': ['AnyNewName — e.g. {{WarningReason}}, {{NewProbationEndDate}}']
};
const LETTER_TYPES = [
  { Type: 'interview_call', Code: 'INT', Ref: 'candidate', Title: 'Interview Call Letter', Body:
`Dear {{Salutation}} {{Name}},

Thank you for applying for the position of **{{Position}}** at {{CompanyName}}.

We are pleased to invite you for an interview as per the details below:

- **Date:** {{InterviewDate}}
- **Time:** {{InterviewTime}}
- **Venue:** {{InterviewPlace}}

Please bring a copy of your resume, one passport-size photograph and your ID proof. Kindly report 10 minutes before the scheduled time.

We look forward to meeting you.` },
  { Type: 'offer', Code: 'OFR', Ref: 'candidate', Title: 'Offer Letter', Body:
`Dear {{Salutation}} {{Name}},

With reference to your application and the subsequent interview, we are pleased to offer you the position of **{{Position}}** at {{CompanyName}}, {{StoreName}}.

## Terms of the offer
1. Your expected date of joining is **{{ExpectedJoiningDate}}**.
2. Your annual Cost to Company (CTC) will be **₹{{CTC}}**. The salary break-up is given below.
3. You will be on probation for **{{ProbationDays}} days** from the date of joining.
4. Your working hours, weekly off and other terms will be as per company policy.

{{SalaryTable}}

Please sign and return a copy of this letter as a token of your acceptance. This offer is valid for 7 days from the date of this letter.

We welcome you to the {{CompanyName}} family.` },
  { Type: 'appointment', Code: 'APT', Ref: 'employee', Title: 'Appointment Letter', Body:
`Dear {{Salutation}} {{Name}},

We are pleased to appoint you as **{{Position}}** at {{CompanyName}}, {{StoreName}}, with effect from **{{JoiningDate}}**. Your employee ID is **{{EmpId}}**.

## Terms of appointment
1. **Reporting:** You will report to {{ReportingManager}} ({{ReportingManagerPosition}}).
2. **Probation:** You will be on probation until {{ProbationEndDate}}. On successful completion, your services will be confirmed in writing.
3. **Compensation:** Your annual CTC is ₹{{CTC}}, as per the break-up below.
4. **Notice period:** During probation, either party may end the employment with 7 days' notice; after confirmation, 30 days' notice is required.
5. **Conduct:** You will follow the company's Code of Conduct and all policies as amended from time to time.

{{SalaryTable}}

Please sign the duplicate copy of this letter as your acceptance of the above terms.` },
  { Type: 'confirmation', Code: 'CNF', Ref: 'employee', Title: 'Confirmation Letter', Body:
`Dear {{Salutation}} {{Name}},

We are pleased to inform you that, on successful completion of your probation period, your services as **{{Position}}** ({{EmpId}}) are confirmed with effect from **{{ProbationEndDate}}**.

All other terms and conditions of your appointment remain unchanged.

We appreciate your contribution and wish you continued success with {{CompanyName}}.` },
  { Type: 'probation_extension', Code: 'PRX', Ref: 'employee', Title: 'Probation Extension Letter', Body:
`Dear {{Salutation}} {{Name}},

Your probation period as **{{Position}}** ({{EmpId}}) was due to end on {{ProbationEndDate}}. Following a review of your performance, your probation is extended until **{{NewProbationEndDate}}**.

Areas for improvement during this period:
{{ImprovementAreas}}

Your reporting manager, {{ReportingManager}}, will support you and review your progress. All other terms of your appointment remain unchanged.` },
  { Type: 'transfer', Code: 'TRF', Ref: 'employee', Title: 'Promotion / Transfer Letter', Body:
`Dear {{Salutation}} {{Name}},

We are pleased to inform you that with effect from **{{TransferDate}}**, you are moved from **{{PreviousPosition}}** at {{PreviousStore}} to **{{NewPosition}}** at {{NewStore}}.

Reason: {{TransferReason}}

You will report to {{ReportingManager}} ({{ReportingManagerPosition}}). {{SalaryChangeNote}}

All other terms and conditions of your employment remain unchanged. We wish you success in your new role.` },
  { Type: 'warning', Code: 'WRN', Ref: 'employee', Title: 'Warning Letter', Body:
`Dear {{Salutation}} {{Name}},

This letter is a formal warning regarding the following:

{{WarningReason}}

This is not in line with the company's Code of Conduct and policies. You are advised to correct this immediately. Any repetition may lead to further disciplinary action as per the Disciplinary Action Policy.

Please sign the copy of this letter as acknowledgement of receipt.` },
  { Type: 'experience', Code: 'EXP', Ref: 'employee', Title: 'Experience Certificate', Body:
`## TO WHOMSOEVER IT MAY CONCERN

This is to certify that **{{Salutation}} {{Name}}** (Employee ID {{EmpId}}) was employed with {{CompanyName}} from **{{JoiningDate}}** to **{{LastWorkingDay}}** ({{Tenure}}).

At the time of leaving, {{FirstName}} was working as **{{Position}}** at {{StoreName}}.

During this period, we found {{FirstName}} sincere and hardworking. We wish {{FirstName}} all the best for the future.` },
  { Type: 'relieving', Code: 'RLV', Ref: 'employee', Title: 'Relieving Letter', Body:
`Dear {{Salutation}} {{Name}},

This is with reference to your resignation. We confirm that you are relieved from your duties as **{{Position}}** (Employee ID {{EmpId}}) at {{CompanyName}} at the close of business on **{{LastWorkingDay}}**.

We confirm that you have handed over all company property and that your full and final settlement has been completed.

We thank you for your contribution and wish you success in your future endeavours.` }
];
function longDate(d) {
  if (!d) return '';
  const x = new Date(String(d).length === 10 ? d + 'T00:00:00' : d);
  if (isNaN(x)) return String(d);
  return x.getDate() + ' ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][x.getMonth()] + ' ' + x.getFullYear();
}
function tenure(from, to) {
  if (!from) return '';
  const a = new Date(from), b = to ? new Date(to) : new Date();
  let m = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth(); if (b.getDate() < a.getDate()) m--;
  if (m < 0) m = 0;
  const y = Math.floor(m / 12); m %= 12;
  return [y ? y + (y > 1 ? ' years' : ' year') : '', m ? m + (m > 1 ? ' months' : ' month') : ''].filter(Boolean).join(' ') || 'less than a month';
}
function inr(n) { return Number(n || 0).toLocaleString('en-IN'); }
function salaryRow(ref, amounts, comps, effectiveFrom, by) {
  let earn = 0, ded = 0, emp = 0;
  comps.forEach(c => { const v = Number(amounts[c.Name] || 0); if (c.Type === 'Deduction') ded += v; else if (c.Type === 'Employer') emp += v; else earn += v; });
  return { Ref: ref, Components: JSON.stringify(amounts), MonthlyEarnings: earn, MonthlyDeductions: ded, MonthlyEmployer: emp, MonthlyNet: earn - ded,
    AnnualCTC: (earn + emp) * 12, EffectiveFrom: effectiveFrom ? normDate(effectiveFrom) : new Date().toISOString().slice(0, 10), UpdatedBy: by, UpdatedAt: new Date().toISOString() };
}

const HR_ROLES = ['SuperAdmin', 'Admin', 'HR'];
const CAND_FIELDS = ['Name', 'Phone', 'DOB', 'PositionCode', 'Source', 'Referrer', 'ExpectedSalary', 'ResumeKey', 'WhyJoin', 'WhyHire', 'WeekendOK', 'Value90Days',
  'OwnVehicle', 'Remarks', 'Email', 'CurrentSalary', 'ReferrerEmpId', 'SourceDetail', 'PhotoKey', 'AadharKey', 'CityState', 'Address', 'Occupation',
  'Qualification', 'Experience', 'NoticePeriod', 'Gender', 'StoreCode'];
function parseJSON(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function randomHex(n) { return [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join(''); }
function questionRow(code, round, i, q) {
  const max = Number(q.MaxScore || 10);
  if (isNaN(max) || max <= 0) throw new Error('Max score must be a positive number');
  return { PositionCode: code, Round: round, QuestionId: 'Q' + (i + 1), Question: String(q.Question).trim(), Type: 'score', MaxScore: max, Options: '' };
}
function scoreAnswers(qs, scores) {
  if (!qs.length) throw new Error('No questions found');
  const out = {}; let total = 0, max = 0;
  qs.forEach(q => {
    const m = Number(q.MaxScore || 10), v = scores[q.QuestionId];
    if (v === undefined || v === '' || v === null) throw new Error('Score every question');
    const n = Number(v);
    if (isNaN(n) || n < 0 || n > m) throw new Error(`"${q.Question}": score must be 0 to ${m}`);
    out[q.QuestionId] = n; total += n; max += m;
  });
  return { scores: out, total: Math.round(total * 100) / 100, max };
}
function defaultTemplate(kind) {
  const src = kind === 'Exit' ? [
    ['1. Resignation & Notice', ['Resignation letter received', 'Exit interview conducted']],
    ['2. Access Revocation', ['Store access revoked', 'Biometric removed', 'Email deactivated', 'WhatsApp group removed']],
    ['3. Asset Return', ['Uniform returned', 'Store keys returned', 'ID card returned', 'Company device returned (if any)']],
    ['4. IT & Systems', ['POS access removed', 'Attendance app removed', 'System credentials revoked']],
    ['5. Finance & Payroll', ['Last working day confirmed', 'Payroll notified', 'Leave encashment calculated']],
    ['6. Pending Dues', ['Advance / loan deducted', 'Pending dues cleared']],
    ['7. FnF Settlement', ['FnF calculated', 'FnF amount approved by management']],
    ['8. FnF Payment', ['FnF payment processed', 'Payment slip issued']],
    ['9. Gratuity', ['Gratuity eligibility checked', 'Gratuity paid if applicable']],
    ['10. PF / ESI', ['PF withdrawal form filled', 'ESI settlement done']],
    ['11. Experience Letter', ['Experience letter issued']],
    ['12. Relieving Letter', ['Relieving letter issued']],
    ['13. Feedback & Closure', ['Reason for exit documented', 'Would rehire noted']]
  ] : [
    ['1. Documentation', ['Job application form filled', 'Certificates verified', 'Aadhar copy collected', 'PAN copy collected', 'Passport photo collected', 'Photo uploaded in HR software']],
    ['2. HR Orientation', ['Employment terms explained', 'Salary & benefits briefed', 'Leave policy explained', 'Attendance system enrolled']],
    ['3. IT & Systems', ['Email ID created', 'Added to WhatsApp group', 'Attendance app installed', 'POS / billing access given']],
    ['4. Uniform & Grooming', ['Uniform size noted', 'Uniform issued', 'Grooming standards explained']],
    ['5. Floor Induction', ['Store layout walkthrough', 'Department-wise product briefing', 'Customer handling SOP explained']],
    ['6. Buddy Assignment', ['Buddy / mentor assigned', 'Introduced to team', 'First-day feedback taken']],
    ['7. Compliance', ['Code of conduct signed', 'NDA signed (if applicable)', 'Emergency contact collected']]
  ];
  const pre = kind === 'Exit' ? 'EX' : 'OB', rows = [];
  src.forEach(([sec, items], si) => items.forEach((it, ii) => rows.push({ Section: sec, ItemId: `${pre}-${si + 1}-${ii + 1}`, Item: it,
    Mandatory: /if any|if applicable/.test(it) ? 'No' : 'Yes', Active: 'Yes' })));
  return rows;
}

const POLICY_EXTRA = ['Content', 'UpdatedBy', 'UpdatedAt'];
const POLICY_CATS = ['HR Policy', 'SOP', 'Code of Conduct', 'Compliance', 'Operations', 'Customer Service', 'Other'];
function policyRow(x, old, all, by) {
  let code = String(x.DocCode || '').trim().toUpperCase();
  if (!code) { let n = all.length + 1; do { code = 'POL-' + String(n++).padStart(3, '0'); } while (all.find(d => d.DocCode === code)); }
  const contentChanged = !old || String(old.Content || '') !== String(x.Content || '') || old.Title !== x.Title;
  return {
    DocCode: code, Title: String(x.Title).trim(), Category: POLICY_CATS.includes(x.Category) ? x.Category : (x.Category || 'HR Policy'),
    Version: old ? Number(old.Version || 0) + (contentChanged ? 1 : 0) : 1,
    EffectiveDate: x.EffectiveDate ? normDate(x.EffectiveDate) : (old ? old.EffectiveDate : new Date().toISOString().slice(0, 10)),
    ReviewEvery: x.ReviewEvery || '1 year', Owner: x.Owner || '', ApprovedBy: x.ApprovedBy || '',
    AppliesTo: String(x.AppliesTo || 'ALL').toUpperCase().replace(/\s+/g, ''), AckNeeded: 'No', FileKey: '',
    Active: x.Active || 'Yes', Content: String(x.Content || ''), UpdatedBy: by, UpdatedAt: new Date().toISOString()
  };
}

function checkMonth(m) { if (!/^\d{4}-\d{2}$/.test(m || '')) throw new Error('Month must look like 2026-10'); return m; }
function round2(n) { return Math.round(n * 100) / 100; }
// Achievement % (capped) and weighted score for one KPI
function kpiScore(k, actual) {
  if (actual === '' || actual === null || actual === undefined) return { ach: '', score: '' };
  const a = Number(actual), t = Number(k.Target), cap = Number(k.ScoreCapPct || 100);
  let ach;
  if (k.Direction === 'Lower is better') {
    if (t > 0) ach = a <= t ? 100 : (t / a) * 100;
    else ach = [100, 70, 40, 0][Math.min(Math.max(Math.round(a), 0), 3)];
  } else ach = t > 0 ? (a / t) * 100 : (a > 0 ? 100 : 0);
  ach = Math.max(0, Math.min(ach, cap));
  return { ach: round2(ach), score: round2(ach * Number(k.WeightPct) / 100) };
}
function bandOf(total, bands) {
  const b = [...bands].sort((x, y) => Number(y.MinScore) - Number(x.MinScore)).find(x => total >= Number(x.MinScore));
  return b ? b.Band : '';
}

const DEFAULT_BANDS = [
  { Band: 'A', MinScore: 90, MaxScore: 999, Meaning: 'Outstanding' },
  { Band: 'B', MinScore: 75, MaxScore: 89.99, Meaning: 'Good' },
  { Band: 'C', MinScore: 60, MaxScore: 74.99, Meaning: 'Needs improvement' },
  { Band: 'D', MinScore: 0, MaxScore: 59.99, Meaning: 'Poor - action plan needed' }
];
const KPI_CATS = ['Sales', 'Operations', 'Customer', 'People', 'Learning', 'Discipline'];
function normKpi(x, positions) {
  const k = {
    PositionCode: String(x.PositionCode || '').trim().toUpperCase(), KpiName: String(x.KpiName || '').trim(),
    Category: x.Category || 'Operations', Definition: x.Definition || '', Unit: x.Unit || '%',
    Direction: /lower/i.test(x.Direction || '') ? 'Lower is better' : 'Higher is better',
    Target: Number(x.Target), WeightPct: Number(String(x.WeightPct).replace('%', '')),
    ScoreCapPct: Number(String(x.ScoreCapPct || 100).replace('%', '')), EnteredBy: x.EnteredBy || 'Reporting Manager',
    EvidenceNeeded: x.EvidenceNeeded || 'No', Active: 'Yes'
  };
  if (!positions.find(p => p.PositionCode === k.PositionCode && p.Active !== 'No')) throw new Error('Unknown position code: ' + k.PositionCode);
  if (!k.KpiName) throw new Error('KPI name is required');
  if (!KPI_CATS.includes(k.Category)) throw new Error('Category must be one of: ' + KPI_CATS.join(', '));
  if (isNaN(k.Target)) throw new Error(`${k.KpiName}: target must be a number`);
  if (isNaN(k.WeightPct) || k.WeightPct <= 0 || k.WeightPct > 100) throw new Error(`${k.KpiName}: weight must be between 1 and 100`);
  if (isNaN(k.ScoreCapPct) || k.ScoreCapPct < 100) throw new Error(`${k.KpiName}: score cap must be 100 or more`);
  return k;
}
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

const EMP_FIELDS = ['EmpId', 'FullName', 'Gender', 'DOB', 'Phone', 'Email', 'StoreCode', 'PositionCode', 'ReportingManagerId', 'JoiningDate', 'EmploymentType', 'Status', 'ProbationEndDate', 'CandidateAppNo', 'ExitDate'];
// Accepts DD-MM-YYYY, DD/MM/YYYY or YYYY-MM-DD; stores YYYY-MM-DD
function normDate(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new Error('Date not understood: ' + s + ' (use DD-MM-YYYY)');
}
function normEmp(x) {
  const e = {};
  EMP_FIELDS.forEach(k => e[k] = x[k] === undefined || x[k] === null ? '' : String(x[k]).trim());
  ['DOB', 'JoiningDate', 'ProbationEndDate', 'ExitDate'].forEach(k => e[k] = normDate(e[k]));
  e.StoreCode = e.StoreCode.toUpperCase(); e.PositionCode = e.PositionCode.toUpperCase();
  e.Status = e.Status || 'Probation'; e.EmploymentType = e.EmploymentType || 'Permanent';
  return e;
}
function validateEmp(e, ctx, existing) {
  if (!e.FullName) throw new Error('Full name is required');
  if (!ctx.stores.find(s => s.StoreCode === e.StoreCode)) throw new Error('Unknown store code: ' + e.StoreCode);
  const pos = ctx.positions.find(p => p.PositionCode === e.PositionCode);
  if (!pos) throw new Error('Unknown position code: ' + e.PositionCode);
  if (e.Phone && !/^\d{10}$/.test(e.Phone)) throw new Error('Phone must be 10 digits');
  if (pos.ParentPositionCode) {
    if (!e.ReportingManagerId) throw new Error('Reporting manager is required');
    if (e.ReportingManagerId === e.EmpId) throw new Error('An employee cannot report to themselves');
    const mgr = ctx.employees.find(x => x.EmpId === e.ReportingManagerId);
    if (!mgr || GONE(mgr.Status)) throw new Error('Reporting manager not found: ' + e.ReportingManagerId);
  }
  if (e.Status === 'Probation' && !e.ProbationEndDate && e.JoiningDate) {
    const d = new Date(e.JoiningDate); d.setDate(d.getDate() + Number(ctx.company.ProbationDays || 90));
    e.ProbationEndDate = d.toISOString().slice(0, 10);
  }
}

function roleRow(code, x, version) {
  return {
    PositionCode: code, JobPurpose: x.JobPurpose || '', Authority: x.Authority || '',
    Qualification: x.Qualification || '', Experience: x.Experience || '', Skills: x.Skills || '',
    WorkingConditions: x.WorkingConditions || '', NextPosition: String(x.NextPosition || '').toUpperCase(),
    PromotionCriteria: x.PromotionCriteria || '', Version: version, ApprovedBy: x.ApprovedBy || ''
  };
}
function clean(r) { const o = { ...r }; delete o._row; return o; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function b64url(buf) {
  let s = ''; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str) { return b64url(enc.encode(str)); }
function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function pemToBuf(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? b64urlToBuf(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
  return { hash: b64url(bits), salt: b64url(salt) };
}
async function checkPassword(password, saltB64, expected) {
  if (!saltB64 || !expected) return false;
  const { hash } = await hashPassword(password, saltB64);
  return hash === expected;
}

function rowsOf(values) {
  values = values || [];
  if (!values.length) return [];
  const head = values[0];
  return values.slice(1).map((row, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, c) => o[h] = row[c] === undefined ? '' : row[c]);
    return o;
  });
}

// ── Apply form: built-in questions (System = Yes) ──
const FORM_HEAD = ['Code', 'Label', 'Section', 'Type', 'Options', 'Setting', 'Order', 'Hint', 'System'];
const FORM_LOCKED = ['Name', 'Phone', 'PositionCode'];
const FORM_TYPES = ['Text', 'Long text', 'Number', 'Date', 'Email', 'Dropdown', 'Yes/No'];
function defaultForm() {
  const A = 'About you', J = 'The job', E = 'Education & experience', Q = 'A few questions';
  return [
    ['Name', 'Full name', A, 'Text', '', 'Mandatory'], ['Phone', 'Mobile number', A, 'Phone', '', 'Mandatory', '10 digits'],
    ['Gender', 'Gender', A, 'Dropdown', 'Male, Female, Other', 'Optional'], ['DOB', 'Date of birth', A, 'Date', '', 'Optional'],
    ['Email', 'Email', A, 'Email', '', 'Optional'], ['CityState', 'City / State', A, 'Text', '', 'Optional', 'e.g. Belagavi, Karnataka'],
    ['Address', 'Address', A, 'Text', '', 'Optional'],
    ['PositionCode', 'Position applying for', J, 'Position', '', 'Mandatory'], ['StoreCode', 'Preferred location', J, 'Store', '', 'Optional'],
    ['Source', 'How did you hear about us?', J, 'Source', '', 'Optional'],
    ['Qualification', 'Highest qualification', E, 'Text', '', 'Optional', 'e.g. 12th, B.Com'], ['Experience', 'Experience', E, 'Text', '', 'Optional', 'e.g. 2 years in retail'],
    ['Occupation', 'Current occupation', E, 'Text', '', 'Optional', 'e.g. Sales at XYZ, Student'], ['CurrentSalary', 'Current salary (₹/month)', E, 'Number', '', 'Optional'],
    ['ExpectedSalary', 'Expected salary (₹/month)', E, 'Number', '', 'Optional'], ['NoticePeriod', 'Notice period', E, 'Text', '', 'Optional', 'e.g. Immediate, 15 days'],
    ['WhyJoin', 'Why do you want to join us?', Q, 'Long text', '', 'Optional'], ['WhyHire', 'Why should we hire you?', Q, 'Long text', '', 'Optional'],
    ['Value90Days', 'What will you achieve in your first 90 days?', Q, 'Long text', '', 'Optional'],
    ['WeekendOK', 'Can you work on weekends?', Q, 'Yes/No', '', 'Optional'], ['OwnVehicle', 'Do you have your own vehicle?', Q, 'Yes/No', '', 'Optional'],
    ['ResumeKey', 'Resume link', Q, 'Text', '', 'Optional', 'Google Drive / LinkedIn link']
  ].map((f, i) => ({ Code: f[0], Label: f[1], Section: f[2], Type: f[3], Options: f[4], Setting: f[5], Order: i + 1, Hint: f[6] || '', System: 'Yes' }));
}
// Cleans and checks typed answers. Throws on a wrong value (not on a missing one).
function checkAnswers(form, c, partial) {
  const out = { ...c };
  form.forEach(f => {
    if (partial && !(f.Code in c)) return;
    let v = String(c[f.Code] ?? '').trim(); if (!v) { out[f.Code] = ''; return; }
    const bad = m => { throw new Error(`${f.Label}: ${m}`); };
    if (f.Type === 'Number') { v = v.replace(/[,₹\s]/g, ''); if (!/^\d+(\.\d+)?$/.test(v)) bad('enter a number'); }
    else if (f.Type === 'Email') { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) bad('enter a valid email'); }
    else if (f.Type === 'Date') { v = normDate(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) bad('enter a valid date'); }
    else if (f.Type === 'Yes/No') { if (!['Yes', 'No'].includes(v)) bad('choose Yes or No'); }
    else if (f.Type === 'Dropdown') { const o = String(f.Options || '').split(',').map(x => x.trim()); if (!o.includes(v)) bad('choose one of the options'); }
    out[f.Code] = v.slice(0, f.Type === 'Long text' ? 2000 : 300);
  });
  return out;
}
// Editable dropdown lists (Settings → Lists). "Other" with a typed value is always allowed in the app.
const LIST_DEFS = {
  SOURCE: { name: 'Candidate sources', values: ['Walk-in', 'Employee Reference', 'Advertisement', 'Online / Social media'] },
  REJECT_REASON: { name: 'Rejection reasons', values: ['Not reachable', 'Did not attend interview', 'Salary expectation too high', 'Not suitable for the role', 'Did not clear interview', 'Candidate not interested', 'Location not suitable'] },
  EXIT_REASON: { name: 'Exit reasons', values: ['Better opportunity', 'Higher studies', 'Relocation', 'Personal / family reasons', 'Health reasons', 'Absconding', 'Terminated', 'Retirement'] },
  TRANSFER_REASON: { name: 'Transfer / promotion reasons', values: ['Promotion', 'Transfer', 'Store requirement', 'Performance', 'Employee request', 'Re-designation'] },
  EMPLOYMENT_TYPE: { name: 'Employment types', values: ['Permanent', 'Contract', 'Trainee'] },
  CANCEL_REASON: { name: 'Checklist cancellation reasons', values: ['Employee decided to stay', 'Did not turn up', 'Backed out after joining', 'Joining postponed'] }
};

// Not part of the workforce any more (left, or hired but never joined)
function GONE(status) { return status === 'Exited' || status === 'Did not join'; }

// ── Modules a client can have switched on (Settings → Modules, C&B only) ──
const MODULES = {
  ROLES: { name: 'Roles & responsibilities', desc: 'Role summaries, responsibilities and RACI' },
  HIRING: { name: 'Hiring', desc: 'QR apply form, pipeline, interviews, offers, Mark Joined' },
  ONBOARDING: { name: 'Onboarding', desc: 'Onboarding checklists — start automatically on Mark Joined', needs: ['HIRING'] },
  EXIT: { name: 'Exit', desc: 'Exit checklists, cancel exit' },
  KPI: { name: 'KPIs', desc: 'KPI setup, monthly entry and approval' },
  POLICIES: { name: 'Policies', desc: 'HR policy library' },
  LETTERS: { name: 'Letters & salary', desc: 'Offer / appointment / other letters, salary structure' },
  REPORTS: { name: 'Reports', desc: 'Reports for the modules that are on' },
  FILES: { name: 'Document uploads', desc: 'Photos, candidate and employee documents, checklist attachments' }
};
const MODULE_ACTIONS = {
  ROLES: ['getRoles', 'saveRole', 'importRoles'],
  HIRING: ['applyCandidate', 'addCandidate', 'getHiring', 'getCandidateTimeline', 'updateCandidate', 'logCall', 'saveQuestions', 'importQuestions', 'saveHrScore',
    'createInterviewToken', 'getInterviewByToken', 'submitInterviewScore', 'decideCandidate', 'updateOffer', 'markJoined', 'getFormSetup', 'saveApplyForm'],
  EXIT: ['startExit'],
  KPI: ['getKpiSetup', 'saveKpiParam', 'removeKpiParam', 'importKpiParams', 'saveBands', 'getKpiMonth', 'saveKpiEntries', 'approveKpi', 'setKpiCycle', 'getKpiReport'],
  POLICIES: ['getPolicies', 'savePolicy', 'importPolicies'],
  LETTERS: ['getLetterSetup', 'saveBranding', 'saveLetterTemplate', 'saveSalaryComponents', 'getSalary', 'saveSalary', 'getLetterData', 'issueLetter', 'getLettersIssued', 'getIssuedLetter'],
  REPORTS: ['getReportData'],
  FILES: ['getFileSetup', 'saveStorageSettings', 'testStorage', 'saveDocTypes', 'uploadFile', 'listFiles', 'getFile', 'deleteFile', 'runFileCleanup']
};
const ACTION_MODULE = {}; Object.entries(MODULE_ACTIONS).forEach(([m, list]) => list.forEach(a => ACTION_MODULE[a] = m));
// Which module(s) an action needs; any one of the list is enough
function moduleFor(action, body) {
  if (['saveChecklist', 'completeChecklist', 'cancelChecklist', 'saveChecklistTemplate'].includes(action)) return [body.kind === 'Exit' ? 'EXIT' : 'ONBOARDING'];
  if (action === 'getLifecycle') return ['ONBOARDING', 'EXIT'];
  return ACTION_MODULE[action] ? [ACTION_MODULE[action]] : null;
}

// Google's per-minute limit already retried: don't try other ways, tell the user
function BUSY(e) { return /Google Sheets is busy/.test(String(e && e.message || e)); }
