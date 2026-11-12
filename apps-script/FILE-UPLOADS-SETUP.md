# File uploads — setup (once per client, ~10 minutes)

## A. Update GitHub (drag these into the repo, same places)
- `docs/` — whole folder (new: `assets/files.js`; changed: apply, settings, hiring, employees, lifecycle, reports, app.css)
- `worker/src/index.js`
- `wrangler.toml` (adds the daily clean-up schedule)
- `apps-script/` folder (Upload.gs + this guide)
Commit → wait for the green tick in Actions.

## B. Get the secret
App → **Settings → Files** → copy the **Secret**.

## C. Create the upload script (in the CLIENT's Google account)
1. script.google.com → **New project** → name it "HR Upload".
2. Delete the sample code, paste all of `Upload.gs`.
3. Line 15 `FOLDER_ID` = the HR System folder ID (the one from Setup.gs).
   Line 16 `SECRET` = the secret from step B.
4. **Deploy → New deployment** → ⚙ → **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   → **Deploy** → **Authorize access** → choose the account → Advanced → Go to HR Upload → Allow.
5. Copy the **Web app URL** (ends in `/exec`).

## D. Connect
App → **Settings → Files** → paste the URL → **Save** → **Test connection** → should say *Connected*.
Then set Photo / Resume / Aadhar to Mandatory, Optional or Hidden → **Save document types**.

## Test checklist
1. Open the QR apply form on a phone → the 3 document fields show as you set them.
2. Submit without a mandatory file → "Please attach: …".
3. Submit with a photo + resume → in Hiring, the candidate shows a photo; Documents lists both; **View** opens them.
4. Employees → open someone → **Documents** → upload PAN → View works.
5. Onboarding → open a checklist → **📎 Attach** on an item → **View** appears.
6. Log in as a Manager → photos show in Employees, but no Documents section.
7. Google Drive → *HR System Files* → Candidates / Employees folders are there.

## Notes
- If you change the code in Upload.gs: **Deploy → Manage deployments → ✎ → Version: New version → Deploy** (the URL stays the same).
- **New secret** in Settings stops uploads until the new secret is pasted into Upload.gs and a new version is deployed.
- Rejected candidates' files are deleted automatically every night (after the days set in Settings); **Run clean-up now** does it immediately.
- When a candidate is marked Joined, their files move to Employees/<EmpId> automatically.
