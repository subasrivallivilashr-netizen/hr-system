/**
 * HR Management System — File upload helper
 * Runs inside the CLIENT's Google account and saves files to their Drive.
 * The HR app's API calls this; nobody else can use it without the secret.
 *
 * SETUP (once per client):
 *  1. script.google.com > New project > paste this file.
 *  2. Fill FOLDER_ID (the same HR System folder used for Setup.gs)
 *     and SECRET (copy it from the app: Settings > File storage).
 *  3. Deploy > New deployment > type "Web app"
 *       Execute as: Me      Who has access: Anyone
 *     > Deploy > Authorize > copy the Web app URL.
 *  4. Paste the URL in the app: Settings > File storage > Save > Test connection.
 */
const FOLDER_ID = 'PASTE_FOLDER_ID_HERE';
const SECRET = 'PASTE_SECRET_FROM_THE_APP';
const ROOT_NAME = 'HR System Files';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png'];

function doPost(e) {
  let out;
  try {
    const p = JSON.parse(e.postData.contents);
    if (!SECRET || SECRET.indexOf('PASTE_') === 0 || p.secret !== SECRET) throw new Error('Not authorised');
    out = handle_(p);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: 'HR upload helper is running' })).setMimeType(ContentService.MimeType.JSON);
}

function handle_(p) {
  if (p.op === 'ping') {
    const root = root_();
    return { message: 'Connected', folder: root.getName(), folderId: root.getId() };
  }
  if (p.op === 'upload') {
    if (ALLOWED.indexOf(p.mime) === -1) throw new Error('File type not allowed');
    const bytes = Utilities.base64Decode(p.data);
    if (bytes.length > MAX_BYTES) throw new Error('File is larger than 5 MB');
    const folder = path_(p.path);
    const file = folder.createFile(Utilities.newBlob(bytes, p.mime, cleanName_(p.name)));
    return { fileId: file.getId(), size: bytes.length };
  }
  if (p.op === 'move') {
    const to = path_(p.path);
    (p.fileIds || []).forEach(function (id) { DriveApp.getFileById(id).moveTo(to); });
    return { moved: (p.fileIds || []).length };
  }
  if (p.op === 'trash') {
    let n = 0;
    (p.fileIds || []).forEach(function (id) { try { DriveApp.getFileById(id).setTrashed(true); n++; } catch (err) { } });
    return { trashed: n };
  }
  throw new Error('Unknown operation');
}

function root_() {
  const parent = DriveApp.getFolderById(FOLDER_ID);
  const it = parent.getFoldersByName(ROOT_NAME);
  return it.hasNext() ? it.next() : parent.createFolder(ROOT_NAME);
}

// "Candidates/APP-2026-0001" -> folder (created when missing)
function path_(path) {
  let f = root_();
  String(path || '').split('/').filter(String).forEach(function (part) {
    const name = cleanName_(part);
    const it = f.getFoldersByName(name);
    f = it.hasNext() ? it.next() : f.createFolder(name);
  });
  return f;
}

function cleanName_(s) { return String(s || 'file').replace(/[\\\/:*?"<>|#%]+/g, '_').slice(0, 120); }
