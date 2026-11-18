/**
 * HR Management System — first-time setup (creates every spreadsheet the app needs)
 * Prepared by Consulting & Beyond (C&B)
 *
 * Run once per client, signed in to the client's Google account, in the "HR System – Setup" Apps Script project
 * (the same project also holds YearlySetup.gs). The C&B setup wizard fills in the values below.
 *
 *   setup()  creates the spreadsheets in the HR folder, the Registry, the default company settings,
 *            shares the folder with the app's service account, creates the yearly KPI / ActivityLog files
 *            and switches on the yearly check. At the end the log shows the SETTINGS LINK to paste into the wizard.
 *
 * Running it a second time does nothing (it shows the existing Settings link).
 */

const FOLDER_ID = '';        // the HR System folder in the client's Drive
const SA_EMAIL = '';         // the service account email (…@….iam.gserviceaccount.com)
const CLIENT_NAME = '';      // shown in the spreadsheet names
const UPLOAD_SECRET = '';    // the same secret goes into Upload.gs (file uploads); the wizard makes it up

// Spreadsheets, tabs and heading rows (generated from the app's tested schema; do not edit by hand)
const BOOKS = {"Settings":{"Registry":["Key","SpreadsheetId","Name","Year","CreatedAt"],
    "Company":["Key","Value"],
    "Users":["Username","PasswordHash","Salt","Role","FullName","StoreCodes","Active","CreatedAt"],
    "Stores":["StoreCode","StoreName","Type","City","StoreHeadEmpId","UsesCommonStructure","Active"],
    "PageSettings":["Key","Value"]},
  "Organisation":{"Positions":["PositionCode","PositionName","Level","ParentPositionCode","Branch","Department","StoreCode","ApprovedHeadcount","Active","LineType"],
    "Employees":["EmpId","FullName","Gender","DOB","Phone","Email","StoreCode","PositionCode","ReportingManagerId","JoiningDate","EmploymentType","Status","ProbationEndDate","CandidateAppNo","ExitDate","CreatedAt","UpdatedAt"],
    "TransferHistory":["EmpId","Date","FromStore","ToStore","FromPosition","ToPosition","FromManager","ToManager","Reason","DoneBy"]},
  "Hiring":{"Candidates":["AppNo","Name","Phone","DOB","PositionCode","Source","Referrer","Status","Date","ExpectedSalary","ResumeKey","WhyJoin","WhyHire","WeekendOK","Value90Days","OwnVehicle","Remarks","DaysIn","CreatedAt","UpdatedAt","Email","CurrentSalary","ReferrerEmpId","SourceDetail","PhotoKey","AadharKey","IsDuplicatePhone","CityState","Address","Occupation","Qualification","Experience","NoticePeriod","Gender","StoreCode"],
    "Interview_Schedule":["AppNo","Candidate","PositionCode","Call1Date","Call1Remarks","Call2Date","Call2Remarks","InterviewDate","InterviewRemarks","Step","Status","CreatedAt"],
    "Interview_Tokens":["AppNo","Candidate","PositionCode","Token","AssessorName","AssessorPosition","CreatedAt","ExpiresAt","Status","CompletedAt","SuggestedPosition","SuggestionReason"],
    "Interview_Questions":["PositionCode","Round","QuestionId","Question","Type","MaxScore","Options"],
    "HR_Status":["AppNo","HR","Assigned","UpdatedAt","PositionCode"],
    "Selection_Offer":["AppNo","Name","PositionCode","NoticePeriod","EstDOJ","Call1Date","OfferLetterKey","Status","JoiningDate","CreatedAt","UpdatedAt"],
    "Selected_Candidates":["AppNo","Name","Phone","PositionCode","Source","HRScore","AssignedScore","TotalScore","DecisionDate","DecisionBy","Remarks"],
    "Rejected_Candidates":["AppNo","Name","Phone","PositionCode","Source","Stage","RejectionDate","RejectedBy","Remarks"]},
  "HR_Ops":{"Onboarding_Template":["Section","ItemId","Item","Mandatory","Active"],
    "Onboarding_Records":["RecordId","EmpId","EmployeeName","PositionCode","JoiningDate","Status","CreatedAt","CompletedAt"],
    "Onboarding_Items":["RecordId","ItemId","Status","Remarks","DoneBy","DoneAt"],
    "Exit_Template":["Section","ItemId","Item","Mandatory","Active"],
    "Exit_Records":["RecordId","EmpId","EmployeeName","PositionCode","LastWorkingDay","Status","CreatedAt","CompletedAt"],
    "Exit_Items":["RecordId","ItemId","Status","Remarks","DoneBy","DoneAt"]},
  "Performance":{"KPI_Parameters":["PositionCode","KpiName","Category","Definition","Unit","Direction","Target","WeightPct","ScoreCapPct","EnteredBy","EvidenceNeeded","Active"],
    "Rating_Bands":["Band","MinScore","MaxScore","Meaning"],
    "KPI_Cycles":["Month","Status","OpenedAt","LockedAt","LockedBy"]},
  "Library":{"Role_Summary":["PositionCode","JobPurpose","Authority","Qualification","Experience","Skills","WorkingConditions","NextPosition","PromotionCriteria","Version","ApprovedBy"],
    "Role_Responsibilities":["PositionCode","SlNo","Responsibility","Frequency"],
    "RACI":["ActivityCode","ProcessArea","Activity","Frequency","PositionCode","RACI"],
    "Documents":["DocCode","Title","Category","Version","EffectiveDate","ReviewEvery","Owner","ApprovedBy","AppliesTo","AckNeeded","FileKey","Active"],
    "Acknowledgements":["DocCode","Version","EmpId","Token","SentAt","AckAt"],
    "Training_Plan":["PositionCode","DocCode","Order","DueDays","Mandatory","HasQuiz"],
    "Quiz_Questions":["DocCode","QNo","Question","OptionA","OptionB","OptionC","OptionD","Correct","Marks","PassMarkPct"],
    "Quiz_Results":["DocCode","EmpId","Token","Score","MaxScore","Passed","Attempt","SubmittedAt"]}};

const COMPANY_DEFAULTS = { CompanyName: '', EmpIdPrefix: 'EMP-', EmpIdDigits: 5, EmpIdNextNumber: 1, EmpIdPerStore: 'No',
  ProbationDays: 90, SameStructureAllStores: 'Yes', InterviewPassPct: 60 };

function setup() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty('SETTINGS_ID');
  if (existing) { Logger.log('Setup was already done. SETTINGS LINK: https://docs.google.com/spreadsheets/d/' + existing + '/edit'); return; }
  if (!FOLDER_ID || !SA_EMAIL) throw new Error('Fill in FOLDER_ID and SA_EMAIL at the top of Setup.gs first (the setup wizard gives them).');
  if (!/@.+\.iam\.gserviceaccount\.com$/.test(SA_EMAIL)) throw new Error('SA_EMAIL does not look like a service account email: ' + SA_EMAIL);
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const prefix = 'HR ' + (CLIENT_NAME ? CLIENT_NAME + ' ' : '');

  // 1. One spreadsheet per module, with its tabs and heading rows
  const ids = {};
  Object.keys(BOOKS).forEach(mod => {
    const ss = makeBook_(prefix + mod.replace('_', ' '), BOOKS[mod], folder);
    ids[mod] = ss.getId();
    Logger.log('Created ' + mod);
  });

  // 2. Registry (Settings > Registry) and default company settings
  const set = SpreadsheetApp.openById(ids.Settings), now = new Date().toISOString();
  set.getSheetByName('Registry').getRange(2, 1, Object.keys(ids).length, 5)
    .setValues(Object.keys(ids).map(k => [k, ids[k], prefix + k.replace('_', ' '), '', now]));
  const comp = Object.keys(COMPANY_DEFAULTS).map(k => [k, k === 'CompanyName' ? CLIENT_NAME : COMPANY_DEFAULTS[k]]);
  if (UPLOAD_SECRET) comp.push(['UploadSecret', UPLOAD_SECRET], ['FileRetentionDays', 90]);
  set.getSheetByName('Company').getRange(2, 1, comp.length, 2).setValues(comp);
  props.setProperty('SETTINGS_ID', ids.Settings);
  SpreadsheetApp.flush();

  // 3. The app reads and writes through the service account: share the whole folder with it
  folder.addEditor(SA_EMAIL);
  Logger.log('Shared the folder with ' + SA_EMAIL);

  // 4. This year's KPI and ActivityLog files (and next year's in November / December), then the yearly check
  createYear_(new Date().getFullYear());
  if (new Date().getMonth() >= 10) createYear_(new Date().getFullYear() + 1);
  installYearlyTrigger();

  Logger.log('DONE. SETTINGS LINK: https://docs.google.com/spreadsheets/d/' + ids.Settings + '/edit');
}

function makeBook_(name, tabs, folder) {
  const ss = SpreadsheetApp.create(name), names = Object.keys(tabs);
  names.forEach((t, i) => {
    const sh = i === 0 ? ss.getSheets()[0].setName(t) : ss.insertSheet(t);
    sh.getRange(1, 1, 1, tabs[t].length).setValues([tabs[t]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  return ss;
}
