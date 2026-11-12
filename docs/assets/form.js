// Apply-form questions (from Settings → Apply form): render and read them anywhere.
// ctx = { positions, stores, lists }
const isRefSource = v => /refer/i.test(String(v || ''));
function formField(f, value, ctx, opt = {}) {
  const id = (opt.prefix || 'q_') + f.Code, v = value ?? '', req = opt.markRequired !== false && f.Required;
  const lab = `<label for="${id}" class="${req ? 'req' : ''}">${esc(f.Label)}</label>`;
  const ph = f.Hint ? ` placeholder="${esc(f.Hint)}"` : '';
  let input;
  switch (f.Type) {
    case 'Long text': input = `<textarea id="${id}"${ph}>${esc(v)}</textarea>`; break;
    case 'Number': input = `<input id="${id}" inputmode="numeric" value="${esc(v)}"${ph}>`; break;
    case 'Date': input = `<input id="${id}" type="date" value="${esc(String(v).slice(0, 10))}">`; break;
    case 'Email': input = `<input id="${id}" type="email" value="${esc(v)}"${ph}>`; break;
    case 'Phone': input = `<input id="${id}" inputmode="numeric" maxlength="10" value="${esc(v)}"${ph}>`; break;
    case 'Yes/No': input = `<div class="choice">${['Yes', 'No'].map(o => `<label><input type="radio" name="${id}" value="${o}" ${v === o ? 'checked' : ''}> ${o}</label>`).join('')}</div>`; break;
    case 'Dropdown': input = `<select id="${id}"><option value="">—</option>${String(f.Options || '').split(',').map(o => o.trim()).filter(Boolean).map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`; break;
    case 'Position': input = `<select id="${id}"><option value="">— Select —</option>${(ctx.positions || []).map(p => `<option value="${esc(p.PositionCode)}" ${p.PositionCode === v ? 'selected' : ''}>${esc(p.PositionName)}</option>`).join('')}</select>`; break;
    case 'Store': input = `<select id="${id}"><option value="">Any</option>${(ctx.stores || []).filter(s => s.Type !== 'Head Office').map(s => `<option value="${esc(s.StoreCode)}" ${s.StoreCode === v ? 'selected' : ''}>${esc(s.StoreName)}</option>`).join('')}</select>`; break;
    case 'Source': {
      const shown = v === 'Other' ? (opt.rec && opt.rec.SourceDetail) || '' : v;
      input = listSelect(id, (ctx.lists || {}).SOURCE || [], shown, { blank: '— Select —', placeholder: 'Please tell us where' }) +
        `<div id="${id}_ref" class="grid ${isRefSource(v) ? '' : 'hidden'}" style="margin-top:6px"><div><label>Referred by (name)</label><input id="${id}_rn" value="${esc(opt.rec ? opt.rec.Referrer || '' : '')}"></div><div><label>Referrer's employee ID</label><input id="${id}_ri" value="${esc(opt.rec ? opt.rec.ReferrerEmpId || '' : '')}"></div></div>`;
      break;
    }
    default: input = `<input id="${id}" value="${esc(v)}"${ph}>`;
  }
  const wide = ['Long text', 'Source'].includes(f.Type) || f.Code === 'Address';
  return `<div class="ff-q" data-code="${esc(f.Code)}" ${wide ? 'style="grid-column:1/-1"' : ''}>${lab}${input}</div>`;
}
// Groups questions by Section, keeps the configured order
function formSections(form, values, ctx, opt = {}) {
  const secs = []; form.forEach(f => { let s = secs.find(x => x.name === f.Section); if (!s) secs.push(s = { name: f.Section, items: [] }); s.items.push(f); });
  return secs.map((s, i) => `${opt.heading === false ? '' : `<h2 style="margin-top:${i ? 20 : 0}px">${esc(s.name)}</h2>`}<div class="grid">${s.items.map(f => formField(f, (values || {})[f.Code], ctx, opt)).join('')}</div>`).join('');
}
// Reads answers → { Code: value } (+ SourceDetail / Referrer for the Source question)
function readForm(root, form, opt = {}) {
  const out = {}, pre = opt.prefix || 'q_';
  form.forEach(f => {
    const id = pre + f.Code;
    if (f.Type === 'Yes/No') { const c = root.querySelector(`input[name="${id}"]:checked`); out[f.Code] = c ? c.value : ''; return; }
    if (f.Type === 'Source') {
      const sel = root.querySelector('#' + id); if (!sel) return;
      if (sel.value === '__other') { out.Source = 'Other'; out.SourceDetail = root.querySelector('#' + id + '_o').value.trim(); }
      else { out.Source = sel.value; out.SourceDetail = ''; }
      out.Referrer = isRefSource(out.Source) ? root.querySelector('#' + id + '_rn').value.trim() : '';
      out.ReferrerEmpId = isRefSource(out.Source) ? root.querySelector('#' + id + '_ri').value.trim() : '';
      return;
    }
    const el = root.querySelector('#' + id); if (el) out[f.Code] = String(el.value).trim();
  });
  return out;
}
function missingAnswers(form, vals) {
  return form.filter(f => f.Required && !String(vals[f.Code] ?? '').trim() && !(f.Type === 'Source' && vals.Source)).map(f => f.Label);
}
document.addEventListener('change', e => {
  const s = e.target; if (!s.id || !s.matches('select[data-list]')) return;
  const ref = document.getElementById(s.id + '_ref'); if (ref) ref.classList.toggle('hidden', !isRefSource(s.value));
});
