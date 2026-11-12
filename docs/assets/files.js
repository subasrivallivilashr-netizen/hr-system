// File uploads: read + compress in the browser, view, list, photos.
const FILE_MAX = 5 * 1024 * 1024;
const FILE_OK = ['application/pdf', 'image/jpeg', 'image/png'];

function loadImage(file) {
  return new Promise((ok, no) => { const u = URL.createObjectURL(file), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = () => no(new Error(file.name + ': image could not be read')); im.src = u; });
}
function drawJpeg(im, max, q) {
  const s = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas');
  c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
function squareThumb(im, size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const side = Math.min(im.width, im.height), g = c.getContext('2d');
  g.drawImage(im, (im.width - side) / 2, (im.height - side) / 3, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.75);
}
function toB64(file) {
  return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => no(new Error('Could not read ' + file.name)); r.readAsDataURL(file); });
}

// File → { docType, name, mime, data(base64), thumb? }. Photos are shrunk to ~1200px JPEG and get a 96px thumbnail.
async function readUpload(file, docType) {
  if (!FILE_OK.includes(file.type)) throw new Error(file.name + ': only PDF, JPG and PNG files are allowed');
  const out = { docType, name: file.name, mime: file.type };
  if (file.type.startsWith('image/') && (docType === 'PHOTO' || file.size > 1.5 * 1024 * 1024)) {
    const im = await loadImage(file);
    out.data = drawJpeg(im, docType === 'PHOTO' ? 1000 : 1800, 0.82).split(',')[1];
    out.mime = 'image/jpeg'; out.name = file.name.replace(/\.(png|jpe?g)$/i, '') + '.jpg';
    if (docType === 'PHOTO') out.thumb = squareThumb(im, 96);
  } else out.data = await toB64(file);
  if (out.data.length * 0.75 > FILE_MAX) throw new Error(file.name + ': larger than 5 MB');
  return out;
}

// Opens a stored file in a new tab (Admin / HR only — the API checks)
async function openFile(fileId) {
  const w = window.open('', '_blank'); if (w) w.document.write('<p style="font-family:sans-serif">Opening file…</p>');
  try {
    const s = Session.get();
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: 'Bearer ' + s.token }, body: JSON.stringify({ action: 'getFile', fileId }) });
    if ((res.headers.get('content-type') || '').includes('json')) { const d = await res.json(); throw new Error(d.error || 'Could not open'); }
    const url = URL.createObjectURL(await res.blob());
    if (w) w.location.href = url; else location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { if (w) w.close(); uiAlert(e.message); }
}

// Photos (thumbnails) for lists — any role
let PHOTOS = null;
async function loadPhotos(force) { if (!PHOTOS || force) { try { PHOTOS = (await api('getPhotos')).photos || {}; } catch { PHOTOS = {}; } } return PHOTOS; }
function avatar(ref, name, size = 32) {
  const t = PHOTOS && PHOTOS[ref];
  if (t) return `<img class="av" src="${esc(t)}" alt="" style="width:${size}px;height:${size}px">`;
  const ini = String(name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="av av-i" style="width:${size}px;height:${size}px;font-size:${Math.round(size / 2.6)}px">${esc(ini)}</span>`;
}

const fsize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

// Documents box for a candidate or employee. ref = APP-… or EmpId; alsoRef shows older files too.
async function docBox(el, ref, opts = {}) {
  el.innerHTML = '<p class="sub">Loading documents…</p>';
  let d;
  try { d = await api('listFiles', { ref, alsoRef: opts.alsoRef }); }
  catch (e) { el.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
  const kind = String(ref).startsWith('APP-') ? 'Candidate' : 'Employee';
  const types = d.docTypes.filter(t => t.Active !== 'No' && t.Code !== 'CHECKLIST' && (t.AppliesTo === 'Both' || t.AppliesTo === kind || (kind === 'Employee' && t.AppliesTo === 'Candidate')));
  const name = c => (d.docTypes.find(t => t.Code === c) || {}).Name || c;
  el.innerHTML = `
    <div class="files">${d.files.length ? d.files.map(f => `
      <div class="file"><span class="ficon">${f.Mime === 'application/pdf' ? 'PDF' : 'IMG'}</span>
        <div class="fmeta"><b>${esc(name(f.DocType))}</b> · ${esc(f.FileName)}<br><span class="sub">${fsize(Number(f.Size || 0))} · ${esc(String(f.UploadedAt).slice(0, 10))} · ${esc(f.UploadedBy)}${f.Note ? ' · ' + esc(f.Note) : ''}</span></div>
        <button class="sm" data-open="${esc(f.FileId)}">View</button>${opts.readOnly ? '' : `<button class="sm danger" data-del="${esc(f.FileId)}">Delete</button>`}
      </div>`).join('') : '<p class="sub">No documents yet.</p>'}</div>
    ${opts.readOnly ? '' : `<div class="fup"><select class="ft">${types.map(t => `<option value="${esc(t.Code)}">${esc(t.Name)}</option>`).join('')}</select>
      <input type="file" class="ff" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"><button class="btn sm fu" type="button">Upload</button></div>
      <div class="msg fm"></div><p class="sub" style="margin:4px 0 0">PDF, JPG or PNG · up to 5 MB.</p>`}`;
  el.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openFile(b.dataset.open));
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await uiConfirm('Delete this file? It goes to the Drive trash.', { okText: 'Delete', danger: true })) return;
    try { await api('deleteFile', { fileId: b.dataset.del }); await docBox(el, ref, opts); opts.onChange && opts.onChange(); } catch (e) { uiAlert(e.message); }
  });
  const up = el.querySelector('.fu');
  if (up) up.onclick = async () => {
    const file = el.querySelector('.ff').files[0], m = el.querySelector('.fm');
    if (!file) return showMsg(m, 'Choose a file first');
    up.disabled = true; up.textContent = 'Uploading…';
    try {
      const dt = el.querySelector('.ft').value;
      await api('uploadFile', { ref, docType: dt, file: await readUpload(file, dt) });
      if (dt === 'PHOTO') await loadPhotos(true);
      await docBox(el, ref, opts); opts.onChange && opts.onChange();
    } catch (e) { showMsg(m, e.message); up.disabled = false; up.textContent = 'Upload'; }
  };
}
