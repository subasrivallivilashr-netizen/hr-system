// Organisation chart export: structure → tree → layout → one SVG page, used for preview, PDF (print), PNG and draw.io.
// Nothing here changes the structure data; customisations live in the user's own export settings.
const OrgChart = (() => {
  const PAPER = { A4: [1123, 794], A3: [1587, 1123], A2: [2245, 1587] };      // landscape, px at 96 dpi
  const MM = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };
  const W = 140, GX = 16, GY = 34, IND = 22, DGAP = 56, F = 'Arial, Helvetica, sans-serif';
  const ICONS = [['', 'No icon'], ['👔', 'Leadership'], ['🧑‍💼', 'Manager'], ['📈', 'Sales'], ['🛍️', 'Retail floor'], ['🏢', 'Office'], ['📣', 'Marketing'],
    ['🤝', 'CRM'], ['🛒', 'Purchase'], ['📦', 'Warehouse'], ['🚚', 'Logistics'], ['🧾', 'Accounts'], ['💰', 'Finance'], ['👥', 'HR'], ['⚙️', 'Operations'],
    ['🔬', 'Research'], ['💻', 'IT'], ['📊', 'MIS / reports'], ['🛡️', 'Security'], ['🧵', 'Tailoring'], ['🧹', 'Housekeeping'], ['🎓', 'Training'],
    ['📞', 'Telecalling'], ['💳', 'Billing'], ['🔧', 'Maintenance'], ['⚖️', 'Legal / audit'], ['🎯', 'Projects']];
  const SUGGEST = [[/chairman|director|ceo|\bmd\b|jmd|owner|founder|management/i, '👔'], [/marketing|digital/i, '📣'], [/crm|customer|greeter/i, '🤝'],
    [/purchase|buying|procure/i, '🛒'], [/warehouse|inventory|stock/i, '📦'], [/logistic|transport|driver|delivery/i, '🚚'], [/account|cash|petty|payment|payroll/i, '🧾'],
    [/finance/i, '💰'], [/human|\bhr\b|recruit/i, '👥'], [/operation|admin/i, '⚙️'], [/research|r&d|developement|development/i, '🔬'], [/\bit\b|cctv|edp|computer/i, '💻'],
    [/mis\b/i, '📊'], [/security/i, '🛡️'], [/tailor/i, '🧵'], [/house ?keeping|cleaning/i, '🧹'], [/training/i, '🎓'], [/tele/i, '📞'], [/bill|cashier/i, '💳'],
    [/electric|maintenance/i, '🔧'], [/audit|legal|statutory/i, '⚖️'], [/project/i, '🎯'], [/sales/i, '📈'], [/store manager|manager/i, '🧑‍💼']];
  const SWATCH = ['#fff3c4', '#f8d0d0', '#d6e6f8', '#fde3c0', '#dff1df', '#ece3f7', '#dcefee', '#f1f1f1'];
  const KIND_NAME = { leader: 'Leadership', division: 'Division', dept: 'Department', manager: 'Manager', team: 'Team', advisory: 'Advisory' };
  const LEVEL = { leader: ['#fff3c4', '#c9a227'], division: ['#f8d0d0', '#c26b6b'], dept: ['#d6e6f8', '#5f88bf'], manager: ['#fde3c0', '#d08a33'], team: ['#fdf9ec', '#7a7a7a'], advisory: ['#f1f1f1', '#8a8a8a'] };
  const BRANCH = { Management: ['#fff3c4', '#c9a227'], Sales: ['#dff1df', '#4c8a4c'], 'Non-sales': ['#fde3c0', '#c27f2a'], Other: ['#ece3f7', '#7d63a8'] };
  const DEFAULTS = { paper: 'A3', orient: 'L', store: 'ALL', root: '', levels: 0, hc: true, names: false, codes: false, dotted: true, groups: true,
    colours: 'level', lines: 'dashed', teams: 'stacked', legend: true, title: '', subtitle: true, logo: 'left', over: {} };

  const x = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cv = document.createElement('canvas').getContext('2d');
  const tw = (t, font) => { cv.font = font; return cv.measureText(t).width; };
  function wrap(text, font, max, lines) {
    const words = String(text).split(/\s+/).filter(Boolean), out = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (tw(t, font) <= max || !cur) cur = t; else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    if (out.length > lines) { const keep = out.slice(0, lines); let last = keep[lines - 1] + '…'; while (tw(last, font) > max && last.length > 2) last = last.slice(0, -2) + '…'; keep[lines - 1] = last; return keep; }
    return out.map(l => { let t = l; while (tw(t, font) > max && t.length > 2) t = t.slice(0, -2) + '…'; return t; });
  }
  const suggestIcon = label => (SUGGEST.find(([re]) => re.test(label)) || [])[1] || '';

  // ── 1. Tree ──
  function build(D, o) {
    const over = o.over || {}, ov = k => over[k] || {};
    const store = o.store || 'ALL';
    const vis = D.positions.filter(p => store === 'ALL' || p.StoreCode === 'ALL' || p.StoreCode === store);
    const codes = new Set(vis.map(p => p.PositionCode));
    const nStores = Math.max(1, D.stores.filter(s => s.Type === 'Store').length);
    const people = D.people.filter(e => store === 'ALL' || e.StoreCode === store);
    const hidden = [], all = [];
    const order = (key, arr) => {
      const saved = over['@' + key] || [];
      return arr.map((n, i) => ({ n, i, s: saved.indexOf(n.key) })).sort((a, b) => (a.s < 0 ? 1e3 + a.i : a.s) - (b.s < 0 ? 1e3 + b.i : b.s)).map(z => z.n);
    };
    const tot = { f: 0, a: 0 };
    function posNode(p, depth, parent) {
      const k = p.PositionCode, n = { key: k, uid: k, kind: 'pos', p, depth, parent, children: [], dotted: [] };
      const approved = Number(p.ApprovedHeadcount || 0) * (store === 'ALL' && p.StoreCode === 'ALL' ? nStores : 1);
      const names = people.filter(e => e.PositionCode === k).map(e => e.Name);
      n.f = names.length; n.a = approved; n.names = names; tot.f += n.f; tot.a += n.a;
      all.push(n);
      const kids = vis.filter(c => c.ParentPositionCode === k);
      if (o.levels && depth >= o.levels) { n.more = kids.length; return n; }
      const reg = [], dot = [];
      kids.forEach(c => {
        if (ov(c.PositionCode).hide) { hidden.push({ key: c.PositionCode, label: c.PositionName }); return; }
        if (c.LineType === 'Dotted') { if (o.dotted) dot.push(c); else hidden.push({ key: c.PositionCode, label: c.PositionName, dottedOff: true }); }
        else reg.push(c);
      });
      n.dotted = order(k + ':dot', dot.map(c => posNode(c, depth + 1, n)));
      let items = [];
      if (o.groups) {
        const same = reg.filter(c => (c.Branch || '') === (p.Branch || '')), other = reg.filter(c => (c.Branch || '') !== (p.Branch || ''));
        items = same.map(c => posNode(c, depth + 1, n));
        const BR = ['Management', 'Sales', 'Non-sales'], bi = v => (BR.indexOf(v) + 1) || 9;
        [...new Set(other.map(c => c.Branch || 'Other'))].sort((p1, p2) => bi(p1) - bi(p2)).forEach(b => {
          const bk = 'B:' + b;
          if (ov(bk).hide) { hidden.push({ key: bk, label: b + ' (group)' }); return; }
          const g = { key: bk, uid: k + '>' + bk, kind: 'division', label: b.toUpperCase(), branch: b, parent: n, children: [], dotted: [] };
          all.push(g);
          const inB = other.filter(c => (c.Branch || 'Other') === b), gi = [];
          inB.filter(c => !c.Department).forEach(c => gi.push(posNode(c, depth + 1, g)));
          [...new Set(inB.filter(c => c.Department).map(c => c.Department))].forEach(dp => {
            const dk = 'D:' + b + ':' + dp;
            if (ov(dk).hide) { hidden.push({ key: dk, label: dp + ' (department)' }); return; }
            const d = { key: dk, uid: g.uid + '>' + dk, kind: 'dept', label: dp.toUpperCase(), branch: b, parent: g, children: [], dotted: [] };
            all.push(d);
            d.children = order(d.uid, inB.filter(c => c.Department === dp).map(c => posNode(c, depth + 1, d)));
            gi.push(d);
          });
          g.children = order(g.uid, gi);
          items.push(g);
        });
      } else items = reg.map(c => posNode(c, depth + 1, n));
      n.children = order(k, items);
      return n;
    }
    let tops = o.root && codes.has(o.root) ? vis.filter(p => p.PositionCode === o.root) : vis.filter(p => !p.ParentPositionCode || !codes.has(p.ParentPositionCode));
    tops = tops.filter(p => { if (ov(p.PositionCode).hide) { hidden.push({ key: p.PositionCode, label: p.PositionName }); return false; } return true; });
    const roots = order('#root', tops.map(p => posNode(p, 1, null)));
    // kinds and box text
    all.forEach(n => {
      if (n.kind === 'pos') n.kind = n.p.LineType === 'Dotted' ? 'advisory' : n.p.Branch === 'Management' ? 'leader' : n.children.length ? 'manager' : 'team';
      const v = ov(n.key);
      n.label = v.label || (n.p ? n.p.PositionName : n.label);
      n.icon = v.icon || '';
      n.note = v.note || '';
      n.color = v.color || '';
    });
    return { roots, all, hidden, tot };
  }

  // ── 2. Box text and size ──
  const FONT = { lbl: 'bold 11.5px ' + F, sm: '10px ' + F, note: 'italic 9.5px ' + F };
  function lines(n, o) {
    const L = [], big = ['division', 'dept', 'leader'].includes(n.kind);
    wrap((n.icon ? n.icon + ' ' : '') + n.label, FONT.lbl, W - 12, 2).forEach(t => L.push({ t, f: 'lbl', b: big || n.kind === 'manager' }));
    if (n.p) {
      if (o.codes) L.push({ t: n.p.PositionCode, f: 'sm', c: '#666' });
      if (o.names) {
        const nm = n.names.length ? n.names.join(', ') : (n.a ? 'Vacant' : '');
        if (nm) wrap(nm, FONT.sm, W - 12, 2).forEach(t => L.push({ t, f: 'sm', c: n.names.length ? '#222' : '#b42318' }));
      }
      if (o.hc) L.push({ t: `${n.f} / ${n.a}`, f: 'sm', c: n.f < n.a ? '#b42318' : n.f > n.a ? '#b26a00' : '#1a7f4b', b: true });
      if (n.more) L.push({ t: `+ ${n.more} more below`, f: 'note', c: '#666' });
    }
    if (n.note) wrap(n.note, FONT.note, W - 12, 2).forEach(t => L.push({ t, f: 'note', c: '#555' }));
    return L;
  }
  const LH = { lbl: 13.5, sm: 12, note: 11.5 };

  // ── 3. Layout (contours per row so nothing overlaps) ──
  function layout(T, o) {
    T.all.forEach(n => { n.L = lines(n, o); });
    const H = Math.max(38, ...T.all.map(n => 10 + n.L.reduce((s, l) => s + LH[l.f], 0)));
    const RH = H + GY;
    const shift = (c, dx, dr) => { const out = []; c.forEach((v, r) => { if (v) out[r + dr] = { l: v.l + dx, r: v.r + dx }; }); return out; };
    const merge = (a, b) => { const out = a.slice(); b.forEach((v, r) => { if (!v) return; out[r] = out[r] ? { l: Math.min(out[r].l, v.l), r: Math.max(out[r].r, v.r) } : v; }); return out; };
    const need = (base, c, dr, gap) => { let req = -Infinity; c.forEach((v, r) => { const bv = base[r + dr]; if (v && bv) req = Math.max(req, bv.r + gap - v.l); }); return req; };
    function lay(n) {
      let cont = [{ l: 0, r: W }];
      const reg = n.children;
      if (reg.length) {
        const leaves = reg.every(c => !c.children.length && !c.dotted.length);
        if (reg.length === 1) { const c = lay(reg[0]); n.mode = 'single'; reg[0].dx = 0; reg[0].dr = 1; cont = merge(cont, shift(c, 0, 1)); }
        else if (leaves && o.teams === 'stacked' && n.kind !== 'division') {
          n.mode = 'stack';
          reg.forEach((c, i) => { lay(c); c.dx = IND; c.dr = 1 + i; cont = merge(cont, [...Array(1 + i)].concat([{ l: IND, r: IND + W }])); });
        } else {
          n.mode = 'side';
          const cs = reg.map(lay); let m = [], xs = [];
          cs.forEach((c, i) => { const xi = i ? need(m, c, 0, GX) : 0; xs.push(xi); m = merge(m, shift(c, xi, 0)); });
          const mid = (xs[0] + xs[xs.length - 1]) / 2;
          reg.forEach((c, i) => { c.dx = xs[i] - mid; c.dr = 1; });
          cont = merge(cont, shift(m, -mid, 1));
        }
      }
      if (n.dotted.length) {
        const cs = n.dotted.map(lay); let dr = 0, dx = W + DGAP; const rows = [];
        cs.forEach(c => { rows.push(dr); dx = Math.max(dx, need(cont, c, dr, DGAP)); dr += c.length; });
        n.dotted.forEach((c, i) => { c.dx = dx; c.dr = rows[i]; cont = merge(cont, shift(cs[i], dx, rows[i])); });
      }
      return cont;
    }
    let m = [], xs = [];
    T.roots.forEach((r, i) => { const c = lay(r); const xi = i ? need(m, c, 0, GX * 3) : 0; xs.push(xi); m = merge(m, shift(c, xi, 0)); });
    const minL = Math.min(0, ...m.filter(Boolean).map(v => v.l)), maxR = Math.max(W, ...m.filter(Boolean).map(v => v.r));
    function place(n, px, row) { n.x = px; n.y = row * RH; n.row = row; [...n.children, ...n.dotted].forEach(c => place(c, px + c.dx, row + c.dr)); }
    T.roots.forEach((r, i) => place(r, xs[i] - minL, 0));
    // connector lines
    const E = [];
    T.all.forEach(n => {
      if (n.x === undefined) return;
      const cx = n.x + W / 2, by = n.y + H;
      n.children.forEach(c => {
        if (n.mode === 'stack') { const sx = n.x + IND / 2; E.push({ a: n, b: c, pts: [[sx, by], [sx, c.y + H / 2], [c.x, c.y + H / 2]] }); }
        else { const my = by + GY / 2, ccx = c.x + W / 2; E.push({ a: n, b: c, pts: Math.abs(ccx - cx) < 0.5 ? [[cx, by], [ccx, c.y]] : [[cx, by], [cx, my], [ccx, my], [ccx, c.y]] }); }
      });
      if (n.dotted.length === 1 && n.dotted[0].dr === 0) { const c = n.dotted[0]; E.push({ a: n, b: c, dot: true, pts: [[n.x + W, n.y + H / 2], [c.x, c.y + H / 2]] }); }
      else n.dotted.forEach(c => { const sx = c.x - 20; E.push({ a: n, b: c, dot: true, pts: [[n.x + W, n.y + H / 2], [sx, n.y + H / 2], [sx, c.y + H / 2], [c.x, c.y + H / 2]] }); });
    });
    const rowsN = m.length;
    return { H, w: maxR - minL, h: rowsN ? (rowsN - 1) * RH + H : H, E };
  }

  function colourOf(n, o) {
    let c;
    if (o.colours === 'plain') c = ['division', 'dept'].includes(n.kind) ? ['#f1f1f1', '#555'] : ['#ffffff', '#555'];
    else if (o.colours === 'branch') { const b = n.branch || (n.p && n.p.Branch) || 'Other'; c = n.kind === 'advisory' ? LEVEL.advisory : (BRANCH[b] || BRANCH.Other); }
    else c = LEVEL[n.kind];
    return n.color ? [n.color, c[1]] : c;
  }

  // ── 4. Page ──
  function page(D, o, A) {
    o = Object.assign({}, DEFAULTS, o);
    const T = build(D, o), Lo = layout(T, o);
    let [PW, PH] = PAPER[o.paper] || PAPER.A3; if (o.orient === 'P') [PW, PH] = [PH, PW];
    const M = 30, headH = 70;
    const legendItems = !o.legend ? [] : (o.colours === 'branch' ? ['Management', 'Sales', 'Non-sales'].map(b => [b, BRANCH[b]]).concat(T.all.some(n => n.kind === 'advisory') ? [['Advisory', LEVEL.advisory]] : [])
      : o.colours === 'level' ? Object.keys(LEVEL).filter(k => T.all.some(n => n.kind === k && n.x !== undefined)).map(k => [KIND_NAME[k], LEVEL[k]]) : []);
    const hasDot = Lo.E.some(e => e.dot);
    const legendH = legendItems.length || (o.legend && hasDot) ? 22 : 0;
    const top = M + headH + 10 + legendH, bottom = PH - M - 30, availW = PW - 2 * M, availH = bottom - top;
    const s = Math.min(availW / Math.max(Lo.w, 1), availH / Math.max(Lo.h, 1), 1.6);
    const ox = M + (availW - Lo.w * s) / 2, oy = top;
    const date = new Date(), ds = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const storeName = o.store === 'ALL' ? (D.sameStructure ? 'All stores' : 'Common structure') : ((D.stores.find(z => z.StoreCode === o.store) || {}).StoreName || o.store) + ' store';
    const title = o.title || ((D.companyName || 'Company') + ' — Organisation Structure');
    const sub = o.subtitle ? `${storeName} · As on ${ds}${o.hc ? ` · Headcount ${T.tot.f} / ${T.tot.a}` : ''}` : '';
    const dash = o.lines === 'dashed' ? '5 4' : '';
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}" font-family="${F}">`);
    out.push(`<defs><marker id="ar" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3.5 L0,7z" fill="#333"/></marker><marker id="ard" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3.5 L0,7z" fill="#888"/></marker></defs>`);
    out.push(`<rect width="${PW}" height="${PH}" fill="#fff"/>`);
    // header
    let tx = PW / 2, logoBox = null;
    if (o.logo !== 'off' && A.logo) {
      const lh = 54, lw = Math.min(170, lh * A.logo.w / A.logo.h);
      const lx = o.logo === 'right' ? PW - M - lw : M;
      logoBox = { x: lx, y: M + 4, w: lw, h: lh };
      out.push(`<image x="${lx}" y="${M + 4}" width="${lw}" height="${lh}" preserveAspectRatio="xMidYMid meet" href="${x(A.logo.src)}" xlink:href="${x(A.logo.src)}"/>`);
    }
    out.push(`<text x="${tx}" y="${M + 30}" text-anchor="middle" font-size="22" font-weight="bold" fill="#111">${x(title)}</text>`);
    if (sub) out.push(`<text x="${tx}" y="${M + 52}" text-anchor="middle" font-size="12.5" fill="#646767">${x(sub)}</text>`);
    out.push(`<rect x="${M}" y="${M + headH}" width="${PW - 2 * M}" height="3" fill="#f2ac3c"/>`);
    // legend
    const legend = [];
    if (legendH) {
      let lx = PW - M; const ly = M + headH + 12;
      const items = legendItems.map(([t, c]) => ({ t, c, w: 16 + tw(t, '11px ' + F) + 14 }));
      if (hasDot) items.push({ t: 'Dotted line', dot: true, w: 30 + tw('Dotted line', '11px ' + F) + 14 });
      const total = items.reduce((a, i) => a + i.w, 0); lx -= total;
      items.forEach(i => {
        if (i.dot) out.push(`<line x1="${lx}" y1="${ly + 5}" x2="${lx + 24}" y2="${ly + 5}" stroke="#888" stroke-dasharray="2 3" stroke-width="1.3"/><text x="${lx + 30}" y="${ly + 9}" font-size="11" fill="#444">${x(i.t)}</text>`);
        else out.push(`<rect x="${lx}" y="${ly}" width="11" height="11" fill="${i.c[0]}" stroke="${i.c[1]}"/><text x="${lx + 16}" y="${ly + 9.5}" font-size="11" fill="#444">${x(i.t)}</text>`);
        legend.push({ x: lx, y: ly, t: i.t, c: i.c, dot: i.dot, w: i.w });
        lx += i.w;
      });
    }
    // chart
    out.push(`<g transform="translate(${ox.toFixed(2)},${oy.toFixed(2)}) scale(${s.toFixed(4)})">`);
    Lo.E.forEach(e => out.push(`<polyline points="${e.pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${e.dot ? '#888' : '#333'}" stroke-width="1.1" ${e.dot ? 'stroke-dasharray="2 3"' : dash ? `stroke-dasharray="${dash}"` : ''} marker-end="url(#${e.dot ? 'ard' : 'ar'})"/>`));
    const boxes = T.all.filter(n => n.x !== undefined);
    boxes.forEach(n => {
      const [fill, stroke] = colourOf(n, o), H = Lo.H;
      const heavy = ['division', 'dept'].includes(n.kind);
      out.push(`<g class="ocb" data-id="${x(n.uid)}" style="cursor:pointer"><rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="${heavy ? 1.5 : 1}" ${n.kind === 'advisory' ? 'stroke-dasharray="4 2"' : ''}/>`);
      if (o.sel && o.sel === n.uid) out.push(`<rect x="${n.x - 4}" y="${n.y - 4}" width="${W + 8}" height="${H + 8}" rx="5" fill="none" stroke="#2563eb" stroke-width="2.5"/>`);
      const th = n.L.reduce((a, l) => a + LH[l.f], 0); let y = n.y + (H - th) / 2;
      n.L.forEach(l => { y += LH[l.f]; out.push(`<text x="${n.x + W / 2}" y="${(y - 3).toFixed(1)}" text-anchor="middle" font-size="${l.f === 'lbl' ? 11.5 : l.f === 'sm' ? 10 : 9.5}" ${l.b ? 'font-weight="bold"' : ''} ${l.f === 'note' ? 'font-style="italic"' : ''} fill="${l.c || '#111'}">${x(l.t)}</text>`); });
      out.push('</g>');
    });
    out.push('</g>');
    // footer (always on)
    const fy = PH - M - 22;
    out.push(`<line x1="${M}" y1="${fy}" x2="${PW - M}" y2="${fy}" stroke="#e7e3d8"/>`);
    let fx = M;
    if (A.cb) { const ch = 18, cw = ch * A.cb.w / A.cb.h; out.push(`<image x="${M}" y="${fy + 6}" width="${cw}" height="${ch}" href="${x(A.cb.src)}" xlink:href="${x(A.cb.src)}"/>`); fx = M + cw + 8; }
    const gen = `Generated from HR System · ${ds} ${date.toTimeString().slice(0, 5)}`;
    out.push(`<text x="${fx}" y="${fy + 19}" font-size="11" fill="#646767">Powered by Consulting &amp; Beyond (C&amp;B)</text>`);
    out.push(`<text x="${PW / 2}" y="${fy + 19}" text-anchor="middle" font-size="11" fill="#646767">${x(gen)}</text>`);
    out.push(`<text x="${PW - M}" y="${fy + 19}" text-anchor="end" font-size="11" fill="#646767">Page 1 of 1</text>`);
    out.push('</svg>');
    return { svg: out.join(''), T, Lo, PW, PH, s, ox, oy, M, headH, title, sub, logoBox, legend, fy, gen, o, mm: o.orient === 'P' ? [...(MM[o.paper] || MM.A3)].reverse() : (MM[o.paper] || MM.A3) };
  }

  // ── 5. Exports ──
  async function toPng(pg, scale = 2) {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pg.svg);
    await img.decode();
    const c = document.createElement('canvas'); c.width = pg.PW * scale; c.height = pg.PH * scale;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    return new Promise(ok => c.toBlob(ok, 'image/png'));
  }

  // draw.io (diagrams.net) file: every box, line, the logos and texts stay editable
  function toDrawio(pg, A) {
    const { T, Lo, s, ox, oy } = pg, H = Lo.H, cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    let id = 2; const ids = new Map();
    const P = (px, py) => [+(ox + px * s).toFixed(1), +(oy + py * s).toFixed(1)];
    const img = src => String(src).replace(/^data:([^;,]+);base64,/, 'data:$1,');
    const vtx = (val, style, gx, gy, gw, gh) => { const i = 'c' + id++; cells.push(`<mxCell id="${i}" value="${x(val)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${gx.toFixed(1)}" y="${gy.toFixed(1)}" width="${gw.toFixed(1)}" height="${gh.toFixed(1)}" as="geometry"/></mxCell>`); return i; };
    const fs = v => Math.max(6, Math.round(v * s * 10) / 10);
    T.all.filter(n => n.x !== undefined).forEach(n => {
      const [fill, stroke] = colourOf(n, pg.o), [gx, gy] = P(n.x, n.y);
      const html = n.L.map(l => { const t = x(l.t), st = `font-size:${fs(l.f === 'lbl' ? 11.5 : 10)}px;${l.c ? 'color:' + l.c + ';' : ''}${l.f === 'note' ? 'font-style:italic;' : ''}`; return `<span style="${st}">${l.b ? '<b>' + t + '</b>' : t}</span>`; }).join('<br>');
      ids.set(n.uid, vtx(html, `rounded=1;arcSize=4;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};fontFamily=Arial;fontSize=${fs(11)};fontColor=#111111;${n.kind === 'advisory' ? 'dashed=1;' : ''}${['division', 'dept'].includes(n.kind) ? 'strokeWidth=1.5;' : ''}`, gx, gy, W * s, H * s));
    });
    Lo.E.forEach(e => {
      const a = e.pts[0], b = e.pts[e.pts.length - 1];
      const ex = ((a[0] - e.a.x) / W).toFixed(3), ey = ((a[1] - e.a.y) / H).toFixed(3), nx = ((b[0] - e.b.x) / W).toFixed(3), ny = ((b[1] - e.b.y) / H).toFixed(3);
      const mid = e.pts.slice(1, -1).map(p => { const [qx, qy] = P(p[0], p[1]); return `<mxPoint x="${qx}" y="${qy}"/>`; }).join('');
      const style = `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;endSize=4;strokeColor=${e.dot ? '#888888' : '#333333'};${e.dot ? 'dashed=1;dashPattern=2 3;' : pg.o.lines === 'dashed' ? 'dashed=1;' : ''}exitX=${ex};exitY=${ey};exitDx=0;exitDy=0;entryX=${nx};entryY=${ny};entryDx=0;entryDy=0;`;
      cells.push(`<mxCell id="c${id++}" style="${style}" edge="1" parent="1" source="${ids.get(e.a.uid)}" target="${ids.get(e.b.uid)}"><mxGeometry relative="1" as="geometry">${mid ? `<Array as="points">${mid}</Array>` : ''}</mxGeometry></mxCell>`);
    });
    const { M, PW, PH, headH } = pg;
    if (pg.logoBox && A.logo) vtx('', `shape=image;html=1;imageAspect=1;aspect=fixed;image=${img(A.logo.src)};`, pg.logoBox.x, pg.logoBox.y, pg.logoBox.w, pg.logoBox.h);
    vtx(`<b>${x(pg.title)}</b>`, 'text;html=1;align=center;verticalAlign=middle;fontFamily=Arial;fontSize=22;fontColor=#111111;', PW / 2 - 400, M + 10, 800, 30);
    if (pg.sub) vtx(x(pg.sub), 'text;html=1;align=center;verticalAlign=middle;fontFamily=Arial;fontSize=12;fontColor=#646767;', PW / 2 - 400, M + 40, 800, 18);
    vtx('', 'rounded=0;html=1;fillColor=#f2ac3c;strokeColor=none;', M, M + headH, PW - 2 * M, 3);
    pg.legend.forEach(l => {
      if (l.dot) vtx('', 'endArrow=none;html=1;dashed=1;dashPattern=2 3;strokeColor=#888888;shape=line;', l.x, l.y, 24, 10);
      else vtx('', `rounded=0;html=1;fillColor=${l.c[0]};strokeColor=${l.c[1]};`, l.x, l.y, 11, 11);
      vtx(x(l.t), 'text;html=1;align=left;verticalAlign=middle;fontFamily=Arial;fontSize=11;fontColor=#444444;', l.x + (l.dot ? 30 : 16), l.y - 3, l.w, 16);
    });
    vtx('', 'line;html=1;strokeColor=#e7e3d8;', M, pg.fy - 2, PW - 2 * M, 4);
    let fx = M;
    if (A.cb) { const ch = 18, cw = ch * A.cb.w / A.cb.h; vtx('', `shape=image;html=1;imageAspect=1;aspect=fixed;image=${img(A.cb.src)};`, M, pg.fy + 6, cw, ch); fx = M + cw + 8; }
    vtx('Powered by Consulting &amp; Beyond (C&amp;B)', 'text;html=1;align=left;verticalAlign=middle;fontFamily=Arial;fontSize=11;fontColor=#646767;', fx, pg.fy + 6, 300, 18);
    vtx(x(pg.gen), 'text;html=1;align=center;verticalAlign=middle;fontFamily=Arial;fontSize=11;fontColor=#646767;', PW / 2 - 200, pg.fy + 6, 400, 18);
    vtx('Page 1 of 1', 'text;html=1;align=right;verticalAlign=middle;fontFamily=Arial;fontSize=11;fontColor=#646767;', PW - M - 150, pg.fy + 6, 150, 18);
    return `<mxfile host="HR System"><diagram id="org" name="Organisation"><mxGraphModel grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${PW}" pageHeight="${PH}" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
  }

  return { page, toPng, toDrawio, build, suggestIcon, ICONS, SWATCH, DEFAULTS, PAPER };
})();
