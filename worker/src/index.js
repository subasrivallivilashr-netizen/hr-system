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
    const id = env.HUB.idFromName('main');
    const res = await env.HUB.get(id).fetch(request);
    const out = new Response(res.body, res);
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    return out;
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
    this.cache = new Map();          // key -> {at, rows}
    this.writeChain = Promise.resolve();
    this.gToken = null; this.gTokenExp = 0;
    this.registry = null; this.registryAt = 0;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
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
      const run = () => handler.fn.call(this, body, user);
      const result = handler.write ? await this.serialWrite(run) : await run();
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
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Google Sheets error ' + res.status + ': ' + (j.error && j.error.message || ''));
    return j;
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

  async fetchTab(ssId, tab) {
    const j = await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent(tab)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
    const values = j.values || [];
    if (!values.length) return [];
    const head = values[0];
    return values.slice(1).map((row, i) => {
      const o = { _row: i + 2 };
      head.forEach((h, c) => o[h] = row[c] === undefined ? '' : row[c]);
      return o;
    });
  }

  // Cached read: (module, tab) -> array of row objects
  async read(module, tab) {
    const key = module + '/' + tab;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.rows;
    const rows = await this.fetchTab(await this.ssId(module), tab);
    this.cache.set(key, { at: Date.now(), rows });
    return rows;
  }

  async headers(module, tab) {
    this.headCache = this.headCache || new Map();
    const hk = module + '/' + tab;
    if (this.headCache.has(hk)) return this.headCache.get(hk);
    const id = await this.ssId(module);
    const j = await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!1:1`);
    const h = (j.values && j.values[0]) || [];
    this.headCache.set(hk, h);
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
    let employees = emps.filter(e => e.Status !== 'Exited' && (!e.JoiningDate || e.JoiningDate <= monthEnd));
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
  async createCandidate(c, by) {
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
    Object.assign(row, { AppNo: appNo, Name: name, Phone: phone, PositionCode: pos.PositionCode, Status: 'New', Date: now.slice(0, 10),
      DOB: c.DOB ? normDate(c.DOB) : '', IsDuplicatePhone: dup ? 'Yes' : 'No', CreatedAt: now, UpdatedAt: now, Source: row.Source || 'Walk-in' });
    await this.append('Hiring', 'Candidates', [row]);
    await this.log('Hiring', appNo, 'Applied', `${pos.PositionName} · ${by}`, by);
    return { appNo, duplicate: dup ? { AppNo: dup.AppNo, Name: dup.Name, Date: dup.Date } : null };
  }
  async recordRejection(c, stage, remarks, by) {
    await this.append('Hiring', 'Rejected_Candidates', [{ AppNo: c.AppNo, Name: c.Name, Phone: c.Phone, PositionCode: c.PositionCode,
      Source: c.Source, Stage: stage, RejectionDate: new Date().toISOString().slice(0, 10), RejectedBy: by, Remarks: remarks || '' }]);
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
    const open = recs.find(r => r.EmpId === e.EmpId && r.Status !== 'Completed');
    if (open) { if (kind === 'Exit') throw new Error('An exit is already in progress for this employee'); return clean(open); }
    if (kind === 'Onboarding' && recs.find(r => r.EmpId === e.EmpId)) throw new Error('Onboarding already completed for this employee');
    const tpl = (await this.checklistTemplate(kind)).filter(t => t.Active !== 'No');
    const now = new Date().toISOString();
    const rec = { RecordId: (kind === 'Exit' ? 'EX-' : 'OB-') + e.EmpId + '-' + now.slice(0, 10).replace(/-/g, ''), EmpId: e.EmpId, EmployeeName: e.FullName,
      PositionCode: e.PositionCode, Status: 'In Progress', CreatedAt: now, CompletedAt: '', ...(kind === 'Exit' ? extra : { JoiningDate: e.JoiningDate }) };
    await this.append('HR_Ops', kind + '_Records', [rec]);
    await this.append('HR_Ops', kind + '_Items', tpl.map(t => ({ RecordId: rec.RecordId, ItemId: t.ItemId, Status: '', Remarks: '', DoneBy: '', DoneAt: '' })));
    return rec;
  }

  // Creates a tab (with headings) if it does not exist yet
  async ensureTab(module, tab, headers) {
    this.tabsOk = this.tabsOk || new Set();
    if (this.tabsOk.has(module + '/' + tab)) return;
    const id = await this.ssId(module);
    const meta = await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
    if (!(meta.sheets || []).find(s => s.properties.title === tab)) {
      await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, { method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab, gridProperties: { rowCount: 1000, columnCount: Math.max(12, headers.length) } } } }] }) });
      await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!A1?valueInputOption=RAW`,
        { method: 'PUT', body: JSON.stringify({ values: [headers] }) });
      if (this.headCache) this.headCache.delete(module + '/' + tab);
      this.cache.delete(module + '/' + tab);
    }
    this.tabsOk.add(module + '/' + tab);
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
      return { token: await this.makeSession(u), role: u.Role, fullName: u.FullName, stores: u.StoreCodes, empId: u.EmpId || '', company: company.CompanyName || '' };
    }
  },

  me: { auth: true, fn: async (p, user) => ({ username: user.u, role: user.r, fullName: user.n }) },

  // ── Settings ──
  getSettings: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN],
    fn: async function () {
      const company = {};
      (await this.read('Settings', 'Company')).forEach(r => company[r.Key] = r.Value);
      const stores = (await this.read('Settings', 'Stores')).map(clean);
      await this.ensureColumns('Settings', 'Users', ['EmpId']);
      const users = (await this.read('Settings', 'Users')).map(u => ({
        Username: u.Username, Role: u.Role, FullName: u.FullName, StoreCodes: u.StoreCodes, Active: u.Active, CreatedAt: u.CreatedAt, EmpId: u.EmpId || ''
      }));
      const employees = (await this.read('Organisation', 'Employees')).filter(e => e.Status !== 'Exited')
        .map(e => ({ EmpId: e.EmpId, FullName: e.FullName, PositionCode: e.PositionCode, StoreCode: e.StoreCode }));
      return { company, stores, users, employees };
    }
  },

  saveCompany: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN], write: true,
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
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN], write: true,
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
      const validRoles = user.r === ROLES.SUPER ? Object.values(ROLES) : [ROLES.ADMIN, ROLES.HR, ROLES.MANAGER];
      if (u.Role && !validRoles.includes(u.Role)) throw new Error('You cannot assign the role ' + u.Role);
      const users = await this.read('Settings', 'Users');
      const exists = users.find(x => String(x.Username).toLowerCase() === username);
      if (exists && exists.Role === ROLES.SUPER && user.r !== ROLES.SUPER) throw new Error('Only a Super Admin can change a Super Admin');
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
      emps.filter(e => e.Status !== 'Exited').forEach(e => { const k = e.PositionCode + '|' + e.StoreCode; filled[k] = (filled[k] || 0) + 1; });
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
      if (emps.some(e => e.PositionCode === p.positionCode && e.Status !== 'Exited')) throw new Error('Employees are still in this position');
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
      return { employees, positions, stores };
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
      const company = await this.companyMap();
      const positions = (await this.read('Organisation', 'Positions')).filter(p => p.Active !== 'No' && p.ParentPositionCode)
        .map(p => ({ PositionCode: p.PositionCode, PositionName: p.PositionName, StoreCode: p.StoreCode }));
      const stores = (await this.read('Settings', 'Stores')).filter(s => s.Active !== 'No')
        .map(s => ({ StoreCode: s.StoreCode, StoreName: s.StoreName, Type: s.Type }));
      return { companyName: company.CompanyName || '', positions, stores };
    }
  },

  // Public: candidate submits the QR form
  applyCandidate: {
    write: true,
    fn: async function (p) {
      if (p.website) return { appNo: '' };            // spam trap field, real people leave it empty
      return this.createCandidate(p.candidate || {}, 'Self (QR form)');
    }
  },

  addCandidate: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) { return this.createCandidate(p.candidate || {}, user.u); }
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
      const employees = (await this.read('Organisation', 'Employees')).filter(e => e.Status !== 'Exited')
        .map(e => ({ EmpId: e.EmpId, FullName: e.FullName, PositionCode: e.PositionCode, StoreCode: e.StoreCode }));
      return { candidates, schedule, tokens, scores, offers, questions, positions, stores, employees,
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
      const ch = {};
      CAND_FIELDS.forEach(k => { if (p.changes && k in p.changes) ch[k] = String(p.changes[k] ?? '').trim(); });
      if (ch.Phone !== undefined && !/^\d{10}$/.test(ch.Phone)) throw new Error('Phone must be 10 digits');
      if (ch.DOB) ch.DOB = normDate(ch.DOB);
      if (ch.PositionCode) await this.position(ch.PositionCode);
      if (p.status) {
        const allowed = { New: ['Shortlisted', 'Hold', 'Rejected'], Shortlisted: ['Hold', 'Rejected'], '1st Call Done': ['Hold', 'Rejected'],
          '2nd Call Done': ['Hold', 'Rejected'], 'Interview Scheduled': ['Hold', 'Rejected'], Hold: ['New', 'Rejected'], Rejected: ['New'] };
        if (!(allowed[c.Status] || []).includes(p.status)) throw new Error(`Cannot move from "${c.Status}" to "${p.status}" here`);
        ch.Status = p.status;
        if (p.status === 'Rejected') await this.recordRejection(c, 'Pre Interview', p.note, user.u);
      }
      if (p.note) ch.Remarks = p.note;
      ch.UpdatedAt = new Date().toISOString();
      await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, ch);
      await this.log('Hiring', c.AppNo, p.status ? 'Status: ' + p.status : 'Details updated', p.note || (p.status ? '' : 'Changed: ' + Object.keys(ch).filter(k => k !== 'UpdatedAt').join(', ')), user.u);
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
        await this.recordRejection(c, 'Post Interview', p.remarks, user.u);
        await this.update('Hiring', 'Candidates', 'AppNo', c.AppNo, { Status: 'Rejected', Remarks: p.remarks || c.Remarks, UpdatedAt: now });
        await this.log('Hiring', c.AppNo, 'Rejected after interview', p.remarks || '', user.u);
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
      const ob = await this.startChecklist('Onboarding', e, null);
      await this.log('Hiring', c.AppNo, 'Joined', `Employee ${e.EmpId}`, user.u);
      await this.log('Organisation', e.EmpId, 'Employee added (joined)', `${e.FullName} from ${c.AppNo}`, user.u);
      return { message: `Joined as ${e.EmpId}. Onboarding started.`, empId: e.EmpId, recordId: ob.RecordId };
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
        StoreCode: e.StoreCode, JoiningDate: e.JoiningDate, Status: e.Status, ExitDate: e.ExitDate }));
      const positions = (await this.read('Organisation', 'Positions')).map(p => ({ PositionCode: p.PositionCode, PositionName: p.PositionName }));
      return { onboarding: out.Onboarding, exit: out.Exit, employees, positions };
    }
  },

  startOnboarding: {
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
    fn: async function (p, user) {
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
      if (!e || e.Status === 'Exited') throw new Error('Employee not found or already exited');
      if (!p.lastWorkingDay) throw new Error('Last working day is required');
      const lwd = normDate(p.lastWorkingDay);
      await this.ensureColumns('HR_Ops', 'Exit_Records', ['Reason']);
      const r = await this.startChecklist('Exit', e, { LastWorkingDay: lwd, Reason: p.reason || '' });
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
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN], write: true,
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
    auth: true, roles: [ROLES.SUPER, ROLES.ADMIN, ROLES.HR], write: true,
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
    if (!mgr || mgr.Status === 'Exited') throw new Error('Reporting manager not found: ' + e.ReportingManagerId);
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
