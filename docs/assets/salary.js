// Salary editor used in Offers and Employees (Admin / HR only)
async function salaryEditor(el, ref) {
  el.innerHTML = '<p class="sub">Loading salary…</p>';
  let r; try { r = await api('getSalary', { ref }); } catch (e) { el.innerHTML = `<p class="under">${esc(e.message)}</p>`; return; }
  if (!r.components.length) { el.innerHTML = '<p class="sub">No salary components yet. Set them up in <a href="letters.html">Letters → Salary components</a>.</p>'; return; }
  const amt = (r.salary && r.salary.Components) || {}, lbl = { Earning: 'Earnings', Deduction: 'Deductions', Employer: 'Employer contributions' };
  el.innerHTML = ['Earning', 'Deduction', 'Employer'].map(t => { const cs = r.components.filter(c => c.Type === t); return cs.length ? `<div style="font-weight:600;margin:8px 0 2px">${lbl[t]}</div><div class="grid">${cs.map(c => `<div><label style="font-weight:400">${esc(c.Name)} (₹/month)</label><input type="number" min="0" class="salv" data-n="${esc(c.Name)}" data-t="${t}" value="${esc(amt[c.Name] ?? '')}"></div>`).join('')}</div>` : ''; }).join('') +
    `<div class="grid" style="margin-top:6px"><div><label style="font-weight:400">Effective from</label><input type="date" class="salfrom" value="${esc(r.salary ? r.salary.EffectiveFrom : '')}"></div></div>
     <p class="salsum" style="margin:8px 0 0"></p><div class="actions"><button class="btn salsave">Save salary</button><span class="msg salmsg"></span></div>`;
  const f = n => Number(n || 0).toLocaleString('en-IN');
  const sum = () => { let e = 0, d = 0, m = 0; el.querySelectorAll('.salv').forEach(i => { const v = Number(i.value || 0); if (i.dataset.t === 'Deduction') d += v; else if (i.dataset.t === 'Employer') m += v; else e += v; });
    el.querySelector('.salsum').innerHTML = `Gross <b>₹${f(e)}</b>/month · Take-home <b>₹${f(e - d)}</b>/month · <b>CTC ₹${f((e + m) * 12)}</b>/year`; };
  el.querySelectorAll('.salv').forEach(i => i.addEventListener('input', sum)); sum();
  const msgEl = el.querySelector('.salmsg');
  el.querySelector('.salsave').onclick = async () => {
    const amounts = {}; el.querySelectorAll('.salv').forEach(i => amounts[i.dataset.n] = i.value);
    try { const x = await api('saveSalary', { ref, amounts, effectiveFrom: el.querySelector('.salfrom').value }); showMsg(msgEl, x.message, true); }
    catch (e) { showMsg(msgEl, e.message); }
  };
}
