# ApplyPilot

ApplyPilot keeps the existing Node 24 API, SQLite database, discovery service, Playwright worker, dashboard and Manifest V3 extension. Applications use saved applicant facts and exact approved answers. The form worker no longer generates application answers with an AI model; the existing advisory chat remains separate.

## Windows quick start

1. Install Node.js 24 or newer (including npm).
2. Extract or clone this repository, open PowerShell in its directory, and run `./start-local.ps1 -Install`. The script creates a private `.env.local` with random session and registration secrets, starts the API and discovery on localhost:8080, and binds only to 127.0.0.1. It does not launch a separate automation browser.
3. Open **http://localhost:8080/setup** in your normal Chrome or Edge profile. Use the registration code printed on the first run (also stored in `.env.local`) to create an account, or sign in. Save your truthful profile and PDF/DOCX resume. Choose **My Windows browser**.
4. Add real direct application links, or create a discovery search. PDF role extraction needs the existing Poppler `pdftotext` utility; if unavailable, the resume is still stored and attachable, and you can create a search manually.
5. Load `extension/` as an unpacked extension in `chrome://extensions` or `edge://extensions` with Developer mode enabled. Choose **This PC (localhost:8080)** in its popup. Keep the dashboard signed in and open.
6. Review jobs in the dashboard. **Start routine applications** prepares jobs explicitly queued by searches with **Automatically prepare strong matches** enabled. Review-only Found jobs stay closed until you choose **Prepare automatically** for that job. ApplyPilot fills supported steps and stops at the employer's final Submit control. You review the form and click Submit yourself. **Stop automation** stops subsequent preparation.

Your ordinary browser profile supplies its existing site logins. Cookies and passwords are not copied to the backend. Install in each browser profile you intend to use; Chrome and Edge maintain separate extension state.

After Windows/browser restart, rerun the script, reopen the dashboard and sign in if necessary. Reopen blocked applications from the extension; restored tabs are rebound only when their job URL is unambiguous. Automation is stopped on browser startup so uncertain applications can be reviewed. Saved queue items and submission intent remain durable. OS-level automatic startup is not installed.

## What changed

- Persistent local extension records replace session-only bindings. Records contain job IDs, URLs, tab bindings, queue state and submission intent, not cached resumes, applicant answers or bearer tokens.
- Browser ownership on the server prevents a second browser installation from claiming the same local application. Claims use conditional updates; local jobs never automatically fall back to cloud execution.
- Local queues continue after a blocked form. The blocked tab stays available for human action. A 90-second nonresponsive-tab watchdog advances the queue; network/authentication failures stop it with an error. Periodic automation opens only jobs explicitly queued by an automatic search. Review-only Found jobs stay closed unless you choose **Prepare automatically** for that job.
- A shared allowlist adds Ashby, SmartRecruiters, Workable, BambooHR and Recruitee to Greenhouse, Lever and Workday. Native controls plus exact-answer ARIA dropdowns, radios and checkboxes are supported. Embedded forms, SSO/redirects that lose job identity, and ambiguous pages still stop for review.
- Native inputs, selects, radios, routine custom controls and identified resume uploads use profile facts or exact saved answers. Safe Next/Continue/Review steps can advance automatically, with a 15-step bound. Unknown mandatory facts are not inferred. ApplyPilot never clicks the final Submit control.
- CAPTCHA, MFA/passwords, payment fields, required sensitive questions and legal attestations require direct user interaction. Static privacy or legal footer text no longer blocks unrelated routine fields.
- The applicant's final Submit click writes durable intent on the PC and server before the click is replayed. A recognized new employer receipt associated with the same job is required for Submitted status. A click without a recognized receipt remains uncertain, and resubmission is prohibited.
- Missing answers can be saved just for a job or explicitly remembered for the applicant. Exact question matching avoids transferring facts between applicants or guessing related answers.
- The dashboard shows Found, Applying, Submitted, Blocked, Interview, Rejected and Offer with distinct colors and filters. Interview/Rejected/Offer are user-recorded employer outcomes, not inferred from email.
- Cloud startup requeues only interrupted pre-submit work. Interrupted submission stays blocked. Ready-to-submit cloud sessions are kept for up to 12 hours. When all three live slots are waiting for the applicant's final Submit click, new preparation pauses instead of closing a filled form.
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
Without TEST_BROWSER_PATH it uses Playwright's installed Chromium. All employer navigation in this test is intercepted with a synthetic page; no real applications are sent. The smoke test exercises real form events, two steps, PDF attachment, final-submit interception, durable intent, and receipt detection after the test's trusted click.

The implemented checks do not establish reliability on every live ATS variant. Installed-extension integration, real login/SSO flows and employer-specific receipts still need supervised validation. No production deployment, real job application, paid API call, or migration of the user's live database is part of these tests.

## Data and limitations

Keep `.env*`, resumes and SQLite data private. Back up `data/` using SQLite-safe backup procedures. A standard browser does not run while Windows is off, and the extension needs the authenticated dashboard to sync. Session tokens are not persisted by the extension; session expiry requires sign-in.

Discovery uses Greenhouse, Lever, and Ashby employer boards plus public job feeds. Infrastructure, reliability, cloud, systems, and support searches also scan a curated set of relevant public employer boards. Comparable roles are saved for review; only strong role-family matches in compatible locations are auto-queued. Additional ATS allowlisting is for application handling, not new vendor discovery integrations. Closed or unfamiliar forms and unrecognized receipts require manual review. Only known direct job URL aliases are collapsed; cross-postings with different employer IDs may still require duplicate review.

The extension operates on permitted top-level employer pages only. Custom widgets, nested frames, native passkeys and OS dialogs may require manual completion. The backend does not cryptographically verify employer receipts; it records authenticated extension observations or explicit applicant verification, together with event history.

Chrome restricts remote debugging of its default profile. The extension is the supported normal-profile path rather than attempting to attach Playwright to the user's default data directory: https://developer.chrome.com/blog/remote-debugging-port

## Blocker notifications
Users can enable blocker emails in Applications. Set RESEND_API_KEY and BLOCKER_EMAIL_FROM to a verified sender in the backend hosting variables; PUBLIC_ORIGIN must be the HTTPS website origin. Delivery remains inactive and the dashboard says so until configured. Emails contain the job title, employer, broad blocker category and an authenticated dashboard link, never resumes or application answers. The durable outbox suppresses unchanged blockers and retries transient errors with a stable provider idempotency key for up to 23 hours. Beyond that, uncertain delivery requires operator review. Run a single API replica, as documented above. Existing blocked applications are included when a user opts in. Resolved blockers and disabled preferences are skipped. A held browser session can expire; the link still opens the saved job and offers preparation of a new session when appropriate.

Routine review/next screens continue automatically. Marketing references to certification, signatures, or payment products do not alone require approval; actual declarations, agreement actions, sensitive identifiers, CAPTCHA/MFA, missing facts and uncertain submissions remain gated.

## Answer memory and AI drafts
Both hosted and extension workflows use the same profile-scoped approved answer library. Hosted forms capture answers before advancing and before final review. A receipt after the applicant's Submit click confirms captured history; conflicts and application-specific facts are not silently reused. Historical applications without captured fields cannot reconstruct answers.

AI drafts are opt-in per profile in Setup. Add verified professional background and approve reusable answers. The server needs OPENAI_API_KEY and OPENAI_MODEL with Responses API structured-output support. Requests send the question, job title/company and up to 60 approved ordinary answers to OpenAI, use store:false, time out after 30 seconds, and are capped at 30 requests per user per UTC day. Keys stay on the server. Drafts must cite supplied facts; the dashboard leaves them unsaved until reviewed, while the hosted worker may use a supported draft in a routine application. No CAPTCHA solving, test answering, or guessed personal facts. Missing configuration is shown explicitly. Tests mock the provider; no paid requests are made.

Public company and role drafting can use Gemini URL Context over the exact sanitized public job page. Set GEMINI_API_KEY on the backend and optionally GEMINI_MODEL (defaults to gemini-2.5-flash). Each applicant must separately enable this provider in Profile setup. ApplyPilot sends only the public job-page URL and employer question; it never sends profile data, contact details, resumes, or saved answers, and questions containing identifiers or extra URLs are rejected. URL Context is limited to one application's public job page and produces a cited, application-only draft that is never promoted into the reusable answer library. The dashboard leaves the draft editable for review; the hosted worker may fill a supported public company or role question automatically after the separate profile opt-in. Personal facts, work authorization, sponsorship, salary, availability, legal or demographic questions, assessments, and CAPTCHA remain outside this flow. Free-tier Gemini requests may be reviewed and used to improve Google's products, so this path deliberately excludes applicant information. Gemini API use is limited to adults in supported regions; this private registration-code deployment assumes the applicant is 18 or older and outside the EEA, Switzerland, and UK unless the Gemini project has active billing.

## Found-job pipeline and completion breakdown

The Applications dashboard can enable automatic queueing for every Found job belonging to the signed-in account. Enabling it queues the existing backlog and disables the account's single-job focus. Discovery filters still decide which new roles are found; match rank sets processing order rather than a one-job-per-cycle limit. The durable preference is checked by discovery and every minute by the API. Prior attempts, existing sessions and receipts are held for review, duplicates stay excluded, and closed or unsupported postings receive an explicit blocker. The preference does not grant missing applicant consent or bypass employer verification.

Confirmed receipts retain the historical automatic, applicant-assisted and unknown completion groups. Version 0.6.6 records trusted form interactions without transmitting field contents and classifies the applicant's final Submit click as assisted. Older automatic-submit events remain visible for historical reporting; new hosted and extension runs stop before final Submit. Interview and other later outcomes do not add to these counts.


Employer application limits can be reported from the dashboard using the employer's message. Holds are scoped to the applicant and employer board, preserving other tenants on the same ATS. A stated window uses a conservative hold from the first observation, not a claimed exact employer reset date; repeated reports do not extend it. New queue entries and browser continuation are blocked during the hold. Historical receipts and submission attempts remain intact. Hosted-page and API checks recognize explicit application-limit refusals and never treat them as submission receipts. Update the browser helper to 0.6.6 so routine preparation always stops at final Submit.

ApplyPilot also reserves at most five applications per applicant and company in a rolling 60-day window. The earliest five queued or started requisitions keep their slots; later matches remain in Found until a slot opens. Started requisition history survives application-record deletion, and localized URLs for the same employer requisition are treated as one application. Operators can change the defaults with `SAME_COMPANY_APPLICATION_LIMIT` and `SAME_COMPANY_WINDOW_DAYS`.

## Saved-answer recovery

With automatic queueing enabled, the API checks eligible paused local forms every minute. It can resolve common wording for contact/profile fields (for example, “Please provide a link to your LinkedIn profile”) from approved, non-conflicting saved facts. It never sends those facts to an AI provider. A continuation is requested only when all recorded missing answers are available; prior attempts, receipts, employer limits, withdrawn consent and company limits remain held. Recovery counts describe prepared answers, never submissions. Browser helper 0.6.6 also makes up to four bounded passes to fill newly revealed conditional fields before reporting missing answers. Final Submit remains manual.

The dashboard’s **Your next steps** summary separates prepared forms awaiting a final Submit click from missing answers, employer-site steps, employer limits and browser checks. Each count filters the relevant applications. Design references and attribution are recorded in OPEN_SOURCE_NOTES.md.
