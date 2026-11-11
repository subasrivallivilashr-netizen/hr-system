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
    const id = await this.ssId(module);
    const j = await this.gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}!1:1`);
    return (j.values && j.values[0]) || [];
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
    const payload = b64urlStr(JSON.stringify({ u: user.Username, r: user.Role, n: user.FullName, exp: Date.now() + SESSION_HOURS * 3600000 }));
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
      return { token: await this.makeSession(u), role: u.Role, fullName: u.FullName, stores: u.StoreCodes };
    }
  },

  me: { auth: true, fn: async (p, user) => ({ username: user.u, role: user.r, fullName: user.n }) }
};

// ───────────────────────── Helpers ─────────────────────────
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
