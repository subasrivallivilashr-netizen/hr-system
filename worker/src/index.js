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
      return { token: await this.makeSession(u), role: u.Role, fullName: u.FullName, stores: u.StoreCodes, empId: u.EmpId || '' };
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
      const allowed = ['CompanyName', 'EmpIdPrefix', 'EmpIdDigits', 'EmpIdNextNumber', 'EmpIdPerStore', 'SameStructureAllStores', 'ProbationDays'];
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
