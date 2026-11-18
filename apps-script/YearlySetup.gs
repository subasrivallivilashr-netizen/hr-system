/**
 * HR Management System — yearly spreadsheets (KPI_<year>, ActivityLog_<year>)
 * Prepared by Consulting & Beyond (C&B)
 *
 * The app keeps KPI entries and the activity log in one spreadsheet per year and finds them in Settings > Registry.
 * This script creates next year's files before 1 January so KPI entry and the log keep working.
 *
 * Run it from the client's Google account that owns the HR spreadsheets:
 *   1. createNextYear()        — creates next year's files now (safe to run again: existing years are skipped)
 *   2. installYearlyTrigger()  — checks on the 1st of every month and creates next year's files from November on
 *
 * How a new year is made: last year's file is copied (same tabs and columns), the data rows are cleared,
 * the same people (including the app's service account) get edit access, and the new file is added to Registry.
 */

const SETTINGS_ID = '';            // Settings spreadsheet ID. Leave empty: Setup.gs remembers it (or open this script from the Settings sheet).
const YEARLY_BOOKS = {             // used only when there is no earlier year to copy from
  KPI: { KPI_Entries: ['Month', 'EmpId', 'PositionCode', 'KpiName', 'Target', 'Actual', 'AchievementPct', 'WeightPct', 'Score', 'EnteredBy', 'EnteredAt'],
    KPI_Summary: ['Month', 'EmpId', 'StoreCode', 'TotalScore', 'Band', 'ManagerRemarks', 'Status', 'SubmittedBy', 'SubmittedAt', 'ApprovedBy', 'ApprovedAt'] },
  ActivityLog: { Activity_Log: ['Timestamp', 'Module', 'RecordId', 'Action', 'Remarks', 'DoneBy'] }
};

function createNextYear() { return createYear_(new Date().getFullYear() + 1); }
function createThisYear() { return createYear_(new Date().getFullYear()); }

// Monthly check (installed by installYearlyTrigger): makes sure this year and — from November — next year exist.
function yearlyCheck() {
  const now = new Date(), done = [];
  try {
    done.push.apply(done, createYear_(now.getFullYear()));
    if (now.getMonth() >= 10) done.push.apply(done, createYear_(now.getFullYear() + 1));
    if (done.length) notify_('HR System: yearly spreadsheets created', 'Created and registered:\n\n' + done.join('\n') + '\n\nNothing else to do.');
  } catch (e) {
    notify_('HR System: ACTION NEEDED — yearly spreadsheets', 'Creating the yearly spreadsheets failed:\n\n' + e.message +
      '\n\nOpen the Settings sheet > Extensions > Apps Script and run createNextYear, or contact Consulting & Beyond (C&B).');
    throw e;
  }
}

function installYearlyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'yearlyCheck').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('yearlyCheck').timeBased().onMonthDay(1).atHour(6).create();
  Logger.log('Monthly check installed: runs on the 1st of every month around 6 AM.');
}

// ── internals ──
function settings_() {
  const id = SETTINGS_ID || PropertiesService.getScriptProperties().getProperty('SETTINGS_ID');   // set by Setup.gs
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Settings spreadsheet not known: run setup() first, or open this script from the Settings sheet.');
  return active;
}

function registry_() {
  const sh = settings_().getSheetByName('Registry');
  if (!sh) throw new Error('Registry tab not found in the Settings spreadsheet.');
  const v = sh.getDataRange().getValues(), head = v[0].map(String), rows = {};
  const kc = head.indexOf('Key'), ic = head.indexOf('SpreadsheetId');
  if (kc < 0 || ic < 0) throw new Error('Registry must have Key and SpreadsheetId columns.');
  for (let r = 1; r < v.length; r++) if (v[r][kc]) rows[String(v[r][kc])] = String(v[r][ic]);
  return { sh, head, rows };
}

function createYear_(year) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const reg = registry_(), done = [];
    Object.keys(YEARLY_BOOKS).forEach(mod => {
      const key = mod + '_' + year;
      if (reg.rows[key]) { Logger.log(key + ' already exists — skipped'); return; }
      let src = null;                                   // nearest earlier year to copy from
      for (let y = year - 1; y >= year - 5 && !src; y--) if (reg.rows[mod + '_' + y]) src = { year: y, id: reg.rows[mod + '_' + y] };
      const file = src ? copyFrom_(src, mod, year) : createFresh_(mod, year);
      const row = reg.head.map(h => ({ Key: key, SpreadsheetId: file.getId(), Name: file.getName(), Year: year, CreatedAt: new Date().toISOString() })[h] || '');
      reg.sh.appendRow(row);
      reg.rows[key] = file.getId();
      done.push(key + ' → ' + file.getName() + ' (' + file.getUrl() + ')');
      Logger.log('Created ' + key + ': ' + file.getUrl());
    });
    SpreadsheetApp.flush();
    return done;
  } finally { lock.releaseLock(); }
}

function copyFrom_(src, mod, year) {
  const old = DriveApp.getFileById(src.id);
  const name = old.getName().indexOf(String(src.year)) >= 0 ? old.getName().split(String(src.year)).join(String(year)) : old.getName() + ' ' + year;
  const parents = old.getParents(), folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const copy = old.makeCopy(name, folder);
  const ss = SpreadsheetApp.openById(copy.getId());
  ss.getSheets().forEach(sh => {                        // keep the heading row, clear everything below it
    const last = sh.getMaxRows();
    if (last > 1) sh.getRange(2, 1, last - 1, sh.getMaxColumns()).clearContent();
  });
  const me = Session.getEffectiveUser().getEmail();
  old.getEditors().forEach(u => { const e = u.getEmail(); if (e && e !== me) try { copy.addEditor(e); } catch (x) { Logger.log('Could not share with ' + e + ': ' + x.message); } });
  old.getViewers().forEach(u => { const e = u.getEmail(); if (e && e !== me && copy.getEditors().every(z => z.getEmail() !== e)) try { copy.addViewer(e); } catch (x) {} });
  return copy;
}

function createFresh_(mod, year) {
  const books = YEARLY_BOOKS[mod], names = Object.keys(books);
  const ss = SpreadsheetApp.create('HR ' + mod + ' ' + year);
  names.forEach((t, i) => {
    const sh = i === 0 ? ss.getSheets()[0].setName(t) : ss.insertSheet(t);
    sh.getRange(1, 1, 1, books[t].length).setValues([books[t]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  const file = DriveApp.getFileById(ss.getId());
  const sf = DriveApp.getFileById(settings_().getId()), parents = sf.getParents();
  if (parents.hasNext()) file.moveTo(parents.next());
  // share like the Settings sheet (it is shared with the app's service account)
  sf.getEditors().forEach(u => { const e = u.getEmail(); if (e && e !== Session.getEffectiveUser().getEmail()) try { file.addEditor(e); } catch (x) {} });
  return file;
}

function notify_(subject, body) {
  try { MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body + '\n\n— HR Management System · Prepared by Consulting & Beyond (C&B)'); } catch (e) { Logger.log(subject + '\n' + body); }
}
