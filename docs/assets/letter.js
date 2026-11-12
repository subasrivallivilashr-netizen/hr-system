// Shared letter renderer: branding + template + fields → printable A4 HTML
const LETTER_FONTS = { 'Inter': "Inter, 'Segoe UI', Arial, sans-serif", 'Georgia (serif)': "Georgia, 'Times New Roman', serif", 'Arial': 'Arial, Helvetica, sans-serif', 'Times New Roman': "'Times New Roman', Times, serif", 'Calibri': "Calibri, Carlito, Arial, sans-serif" };
function mdToHtml(txt) {
  const inline = t => t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let html = '', list = null; const close = () => { if (list) { html += `</${list}>`; list = null; } };
  String(txt || '').split(/\r?\n/).forEach(line => {
    const l = line.trim(); let m;
    if (!l) { close(); return; }
    if (/^<.+>$/.test(l)) { close(); html += l; return; }            // already HTML (e.g. salary table)
    if ((m = l.match(/^#{1,3}\s+(.*)/))) { close(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = l.match(/^[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else { close(); html += `<p>${inline(l)}</p>`; }
  });
  close(); return html;
}
const inrFmt = n => Number(n || 0).toLocaleString('en-IN');
function salaryTableHtml(salary, components) {
  if (!salary || !salary.Components) return '<p><i>[Salary not entered]</i></p>';
  const amt = salary.Components, rows = (type, label) => {
    const list = (components || []).filter(c => c.Type === type && amt[c.Name] !== undefined && amt[c.Name] !== '');
    if (!list.length) return '';
    return `<tr class="sec"><td colspan="3">${label}</td></tr>` + list.map(c => `<tr><td>${esc(c.Name)}</td><td class="r">${inrFmt(amt[c.Name])}</td><td class="r">${inrFmt(amt[c.Name] * 12)}</td></tr>`).join('');
  };
  return `<table class="sal"><thead><tr><th>Component</th><th class="r">Monthly (₹)</th><th class="r">Annual (₹)</th></tr></thead><tbody>
    ${rows('Earning', 'Earnings')}<tr class="tot"><td>Gross salary</td><td class="r">${inrFmt(salary.MonthlyEarnings)}</td><td class="r">${inrFmt(salary.MonthlyEarnings * 12)}</td></tr>
    ${rows('Deduction', 'Deductions')}${Number(salary.MonthlyDeductions) ? `<tr class="tot"><td>Net take-home</td><td class="r">${inrFmt(salary.MonthlyNet)}</td><td class="r">${inrFmt(salary.MonthlyNet * 12)}</td></tr>` : ''}
    ${rows('Employer', 'Employer contributions')}<tr class="grand"><td>Cost to Company (CTC)</td><td class="r">${inrFmt(Number(salary.MonthlyEarnings) + Number(salary.MonthlyEmployer))}</td><td class="r">${inrFmt(salary.AnnualCTC)}</td></tr></tbody></table>`;
}
function fillFields(text, fields, mark) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    if (k in fields && fields[k] !== '') return esc(fields[k]);
    return mark ? `<span class="missing">[${k}]</span>` : '';
  });
}
function placeholdersIn(text) { return [...new Set([...String(text || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]))]; }
function letterStyles(brand) {
  const c = brand.BrandColor || '#1f3864', font = LETTER_FONTS[brand.BrandFont] || LETTER_FONTS.Inter, mg = Number(brand.BrandMargin || 18);
  return `.page{width:210mm;min-height:297mm;background:#fff;margin:0 auto;padding:${mg}mm ${mg}mm ${mg + 12}mm;box-sizing:border-box;position:relative;font-family:${font};color:#1c2230;font-size:10.5pt;line-height:1.45;box-shadow:0 4px 24px rgba(0,0,0,.12)}
  .page h3{color:${c};font-size:11.5pt;margin:12px 0 5px}.page p{margin:0 0 7px}.page ul,.page ol{margin:0 0 7px;padding-left:22px}.page li{margin:1px 0}
  .lh{display:flex;align-items:center;gap:16px;border-bottom:3px solid ${c};padding-bottom:10px;margin-bottom:14px}.lh.center{flex-direction:column;text-align:center;gap:6px}
  .lh img{max-height:62px;max-width:220px}.lh .co{font-size:17pt;font-weight:700;color:${c};line-height:1.2}.lh .addr{font-size:9pt;color:#555;white-space:pre-line}
  .meta{display:flex;justify-content:space-between;font-size:9.5pt;margin-bottom:10px}.ttl{text-align:center;font-weight:700;font-size:12.5pt;letter-spacing:.04em;text-decoration:underline;margin:2px 0 12px;color:${c}}
  .sign{margin-top:16px;break-inside:avoid;page-break-inside:avoid}.sign img{max-height:50px;max-width:180px;display:block;margin:4px 0}.sign .nm{font-weight:700}
  .foot{position:absolute;left:${mg}mm;right:${mg}mm;bottom:8mm;border-top:1px solid #ccc;padding-top:5px;font-size:8.5pt;color:#666;text-align:center;white-space:pre-line}
  .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;overflow:hidden}.wm span{transform:rotate(-30deg);font-size:72pt;font-weight:700;color:${c};opacity:.06;white-space:nowrap}
  table.sal{width:100%;border-collapse:collapse;margin:8px 0 10px;font-size:9pt;break-inside:avoid;page-break-inside:avoid}table.sal th,table.sal td{border:1px solid #cfd5df;padding:2.5px 8px;text-align:left}
  table.sal th{background:${c};color:#fff}table.sal .r{text-align:right}table.sal tr.sec td{background:#f3f5f9;font-weight:600}table.sal tr.tot td{font-weight:600}table.sal tr.grand td{font-weight:700;background:#eef2fa}
  @media print{.page{min-height:0}.foot{position:fixed;bottom:7mm}}
  .missing{background:#fde8e6;color:#b42318;border-radius:3px;padding:0 3px}`;
}
// Returns the inner HTML of one A4 page
function renderLetter({ brand, title, body, customHtml, fields, salary, components, preview }) {
  const f = { ...fields }; if (!f.LetterNo && preview) f.LetterNo = '(number given when issued)';
  const sal = salaryTableHtml(salary, components);
  const bodyHtml = mdToHtml(fillFields(String(body || '').replace(/\{\{\s*SalaryTable\s*\}\}/g, '\n%%SAL%%\n'), f, preview)).replace(/<p>%%SAL%%<\/p>/g, sal);
  const logo = brand.BrandLogo ? `<img src="${brand.BrandLogo}" alt="">` : '';
  const sign = `<div class="sign">For <b>${esc(f.CompanyName || '')}</b>${brand.BrandSignature ? `<img src="${brand.BrandSignature}" alt="">` : '<div style="height:48px"></div>'}<div class="nm">${esc(brand.BrandSignatoryName || '')}</div><div>${esc(brand.BrandSignatoryDesignation || '')}</div></div>`;
  if (customHtml && customHtml.trim()) {
    const extra = { ...f, Logo: logo, Signature: brand.BrandSignature ? `<img src="${brand.BrandSignature}" alt="" style="max-height:55px">` : '', Title: esc(title || ''),
      SignatureBlock: sign, Header: esc(brand.BrandHeader || ''), Footer: esc(brand.BrandFooter || '') };
    return customHtml.replace(/\{\{\s*(Body|SalaryTable|Logo|Signature|SignatureBlock)\s*\}\}/g, (m, k) => k === 'Body' ? bodyHtml : k === 'SalaryTable' ? sal : extra[k])
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => k in extra ? (['Logo', 'Signature', 'SignatureBlock'].includes(k) ? extra[k] : esc(extra[k])) : (preview ? `<span class="missing">[${k}]</span>` : ''));
  }
  const startsWithHeading = /^\s*#/.test(body || '');
  return `${brand.BrandWatermark ? `<div class="wm"><span>${esc(brand.BrandWatermark)}</span></div>` : ''}
    <div class="lh ${brand.BrandLogoAlign === 'center' ? 'center' : ''}">${logo}<div><div class="co">${esc(f.CompanyName || '')}</div><div class="addr">${esc(brand.BrandHeader || '')}</div></div></div>
    <div class="meta"><span>Ref: ${esc(f.LetterNo || '')}</span><span>Date: ${esc(f.Today || '')}</span></div>
    ${startsWithHeading ? '' : `<div class="ttl">${esc(title || '')}</div>`}
    ${bodyHtml}${sign}
    ${brand.BrandFooter ? `<div class="foot">${esc(brand.BrandFooter)}</div>` : ''}`;
}
