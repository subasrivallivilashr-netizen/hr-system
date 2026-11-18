# Yearly spreadsheets (KPI_<year>, ActivityLog_<year>)
Prepared by Consulting & Beyond (C&B)

KPI entries and the activity log live in one spreadsheet per year, found through Settings > Registry.
`YearlySetup.gs` creates next year's files and keeps doing it every year.

## One-time setup (per client, in the client's Google account that owns the HR spreadsheets)
1. Open the **Settings** spreadsheet > **Extensions > Apps Script**.
2. Add a script file named `YearlySetup` and paste `YearlySetup.gs`. Save.
3. Choose `createNextYear` > **Run** > allow the permissions. Next year's two files are created and registered.
4. Choose `installYearlyTrigger` > **Run**. From now on the 1st of every month is checked; from November, next year's files are created and an email is sent to the account owner.

## What a new year looks like
- A copy of last year's file (same tabs and columns), data rows cleared, same folder.
- The same editors as last year's file, including the app's service account.
- Two new Registry rows: `KPI_<year>` and `ActivityLog_<year>`.
- The app switches to the new files on 1 January by itself.

## Checks
- Settings > Registry has the two new rows.
- In Drive, both files show the service account under Share.
- Running `createNextYear` again changes nothing (existing years are skipped).
