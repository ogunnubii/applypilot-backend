# ApplyPilot

ApplyPilot keeps the existing Node 24 API, SQLite database, discovery service, Playwright worker, dashboard and Manifest V3 extension. Applications use saved applicant facts and exact approved answers. The form worker no longer generates application answers with an AI model; the existing advisory chat remains separate.

## Windows quick start

1. Install Node.js 24 or newer (including npm).
2. Extract or clone this repository, open PowerShell in its directory, and run `./start-local.ps1 -Install`. The script creates a private `.env.local` with random session and registration secrets, starts the API and discovery on localhost:8080, and binds only to 127.0.0.1. It does not launch a separate automation browser.
3. Open **http://localhost:8080/setup** in your normal Chrome or Edge profile. Use the registration code printed on the first run (also stored in `.env.local`) to create an account, or sign in. Save your truthful profile and PDF/DOCX resume. Choose **My Windows browser**.
4. Add real direct application links, or create a discovery search. PDF role extraction needs the existing Poppler `pdftotext` utility; if unavailable, the resume is still stored and attachable, and you can create a search manually.
5. Load `extension/` as an unpacked extension in `chrome://extensions` or `edge://extensions` with Developer mode enabled. Choose **This PC (localhost:8080)** in its popup. Keep the dashboard signed in and open.
6. Review jobs in the dashboard. **Start routine applications** snapshots currently Found and Queued jobs on supported hosts. It can fill, advance and submit routine applications. **Open / fill manually** never enables automatic submission; **Run routine steps** enables one selected job. **Stop automation** stops subsequent automatic actions; a Submit already clicked cannot be recalled.

Your ordinary browser profile supplies its existing site logins. Cookies and passwords are not copied to the backend. Install in each browser profile you intend to use; Chrome and Edge maintain separate extension state.

After Windows/browser restart, rerun the script, reopen the dashboard and sign in if necessary. Reopen blocked applications from the extension; restored tabs are rebound only when their job URL is unambiguous. Automation is stopped on browser startup so uncertain applications can be reviewed. Saved queue items and submission intent remain durable. OS-level automatic startup is not installed.

## What changed

- Persistent local extension records replace session-only bindings. Records contain job IDs, URLs, tab bindings, queue state and submission intent, not cached resumes, applicant answers or bearer tokens.
- Browser ownership on the server prevents a second browser installation from claiming the same local application. Claims use conditional updates; local jobs never automatically fall back to cloud execution.
- Local queues continue after a blocked form. The blocked tab stays available for human action. A 90-second nonresponsive-tab watchdog advances the queue; network/authentication failures stop it with an error. A run is a finite snapshot; newly discovered jobs require another Start.
- A shared allowlist adds Ashby, SmartRecruiters, Workable, BambooHR and Recruitee to Greenhouse, Lever and Workday. This is conservative generic form coverage, not a promise of full vendor-specific support. Unfamiliar custom controls, embedded local forms, SSO/redirects that lose job identity, and ambiguous pages stop for review.
- Native inputs, selects, radios and identified resume uploads use profile facts or exact saved answers. Next/Continue and final submit are separate actions. Both agents have a 15-step bound. Unknown mandatory facts are not inferred.
- CAPTCHA, MFA/passwords, payment fields, sensitive statements and legal attestations require direct user interaction. Legal text can conservatively block a whole page, even after checking a checkbox; the user then submits manually.
- Routine local submission writes intent on the PC and server before clicking. A recognized new employer receipt associated with the same job is required for automatic Submitted status. A click without a recognized receipt remains uncertain, and automatic resubmission is prohibited.
- Missing answers can be saved just for a job or explicitly remembered for the applicant. Exact question matching avoids transferring facts between applicants or guessing related answers.
- The dashboard shows Found, Applying, Submitted, Blocked, Interview, Rejected and Offer with distinct colors and filters. Interview/Rejected/Offer are user-recorded employer outcomes, not inferred from email.
- Cloud startup requeues only interrupted pre-submit work. Interrupted submission stays blocked. The three cloud handoff slots no longer stall the entire queue: the oldest inactive handoff is closed when necessary; saved job state remains.
- Existing normalized-URL uniqueness and event logging remain. Completed employer outcomes and local ownership are protected during duplicate migration.

## Hosted discovery + local Windows execution

Back up your persistent database/resume volume and deploy the updated backend and dashboard together. Run `./package-extension.ps1` on Windows before publishing `web/` so its extension download contains the updated build. Retain your existing SESSION_SECRET, REGISTRATION_CODE, PUBLIC_ORIGIN, SERVICE_ORIGIN, DATABASE_PATH and UPLOAD_DIR. Run one API/worker service replica on the shared persistent disk; distributed workers are not supported.

Use the backend's `/setup` page to choose **My Windows browser** for the applicant. Existing applicants default to Cloud to preserve their current behavior. The cloud worker skips queued jobs for Local applicants; hosted discovery continues to save or queue them. Select **Hosted ApplyPilot** in the extension and leave the signed-in Netlify dashboard open. The extension is configured for this repository's existing Netlify and Railway URLs.

The extension and updated backend must be rolled out together: local endpoints now require a per-installation device ID. Legacy local sessions without an intent marker are treated as uncertain on upgrade. Lost/uninstalled browser profiles are not automatically granted a replacement claim; review the employer receipt and use manual confirmation. No cookies, unsaved cloud form edits or CAPTCHA state transfer from cloud to PC.

For a different hosting domain or localhost port, edit the extension environment constants and manifest permissions before loading. Avoid changing servers within a browser profile that already has tracked records; use another profile.

To run the cloud worker locally, use the existing `npm start` with a configured environment and installed Playwright Chromium. Local-only startup does not need a Playwright browser download. The existing Docker/Railway deployment path is retained.

## Verification

`npm ci` then `npm test` runs API/ownership/duplicate tests, restart recovery, exact-answer policy tests, extension background lifecycle/queue tests, DOM form fixtures and the dashboard fixture.

Optional real browser smoke test:
```powershell
$env:TEST_BROWSER_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node checks/browser-smoke.cjs
```
Without TEST_BROWSER_PATH it uses Playwright's installed Chromium. All employer navigation in this test is intercepted with a synthetic page; no real applications are sent. The smoke test exercises real form events, two steps, PDF attachment, a single submit after durable intent, and receipt detection.

The implemented checks do not establish reliability on every live ATS variant. Installed-extension integration, real login/SSO flows and employer-specific receipts still need supervised validation. No production deployment, real job application, paid API call, or migration of the user's live database is part of these tests.

## Data and limitations

Keep `.env*`, resumes and SQLite data private. Back up `data/` using SQLite-safe backup procedures. A standard browser does not run while Windows is off, and the extension needs the authenticated dashboard to sync. Session tokens are not persisted by the extension; session expiry requires sign-in.

Discovery still uses the existing Greenhouse/Lever boards and job feeds. Additional ATS allowlisting is for application handling, not new vendor discovery integrations. Closed or unfamiliar forms and unrecognized receipts require manual review. Only known direct job URL aliases are collapsed; cross-postings with different employer IDs may still require duplicate review.

The extension operates on permitted top-level employer pages only. Custom widgets, nested frames, native passkeys and OS dialogs may require manual completion. The backend does not cryptographically verify employer receipts; it records authenticated extension observations or explicit applicant verification, together with event history.

Chrome restricts remote debugging of its default profile. The extension is the supported normal-profile path rather than attempting to attach Playwright to the user's default data directory: https://developer.chrome.com/blog/remote-debugging-port

## Blocker notifications
Users can enable blocker emails in Applications. Set RESEND_API_KEY and BLOCKER_EMAIL_FROM to a verified sender in the backend hosting variables; PUBLIC_ORIGIN must be the HTTPS website origin. Delivery remains inactive and the dashboard says so until configured. Emails contain the job title, employer, broad blocker category and an authenticated dashboard link, never resumes or application answers. The durable outbox suppresses unchanged blockers and retries transient errors with a stable provider idempotency key for up to 23 hours. Beyond that, uncertain delivery requires operator review. Run a single API replica, as documented above. Existing blocked applications are included when a user opts in. Resolved blockers and disabled preferences are skipped. A held browser session can expire; the link still opens the saved job and offers preparation of a new session when appropriate.

Routine review/next screens continue automatically. Marketing references to certification, signatures, or payment products do not alone require approval; actual declarations, agreement actions, sensitive identifiers, CAPTCHA/MFA, missing facts and uncertain submissions remain gated.
