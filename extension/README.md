# ApplyPilot Local for Windows Chrome and Edge

1. Start the local backend using `../start-local.ps1 -Install`, or deploy the updated hosted backend/dashboard.
2. In your usual signed-in browser profile, open `chrome://extensions` or `edge://extensions`, enable Developer mode, click Load unpacked, and select this directory.
3. Open the extension popup. Select This PC for localhost:8080 or Hosted ApplyPilot for the existing Netlify/Railway service.
4. Open ApplyPilot and sign in. Complete the profile/resume at the backend's `/setup` page and select My Windows browser. Keep the signed-in dashboard tab open.
5. Automatic mode is on by default. Every 30 seconds it picks up explicitly queued jobs for profiles in My Windows browser mode. Found jobs stay unstarted until queued. Signed-in Railway, Cloudflare Pages and legacy Netlify dashboards can sync. Open manually is an optional override; Continue automatically resumes a selected blocked application. Stop automation persists across restarts.

The extension uses the current browser's cookies and login state; it never copies them. It does not solve CAPTCHA or MFA, enter payment information, accept legal attestations, or invent applicant facts. Mandatory unknowns and custom controls stop automation. Use Remember an answer to explicitly save an exact answer for this applicant.

Blocked tabs remain open while other eligible jobs continue. An empty queue stays enabled and checks for newly discovered jobs. Browser startup preserves Stop; otherwise new eligible jobs resume when the signed-in dashboard is available. Existing interrupted or blocked applications wait for explicit continuation. A recorded submission attempt is never replayed automatically. Keep the PC awake and Chrome and the signed-in dashboard open.

Allowed ATS families: Greenhouse, Lever, Workday, Ashby, SmartRecruiters, Workable, BambooHR and Recruitee. Permissions are limited to these domains, the existing dashboard and localhost. Coverage is conservative: top-level native controls, recognizable Next/Continue and Submit actions, exact saved facts, and identifiable resume uploads. Embedded forms, custom widgets, cross-domain SSO, unusual step URLs and unrecognized receipts require manual handling.

Submitted means the extension observed a recognized receipt after a submission action for the bound job, or the applicant explicitly recorded employer confirmation. No email monitoring is implemented. Extension state is local to the browser profile; do not uninstall it mid-application unless prepared to review ownership and receipt state manually.

The popup environment cannot switch servers while records exist. Use a separate browser profile for another backend. To customize hosting/port, update background.js and manifest.json together. Reload the extension after changing files.

Version 0.6.1 fixes missing-tab queue stalls and resumes routine submissions after a durable attempt record. A timeout or uncertain receipt is never retried automatically. Existing paused forms need explicit continuation. Reload the updated extension in the existing browser profile; keep its stored records. The hosted download is built from the deployed extension source, not an older checked-in ZIP.


0.6.1 opens associated dropdown menus before matching exact saved answers, verifies the displayed selection, reports filled-field progress, and supports guarded dashboard resume. Attempts are never automatically retried. Arbitration and waiver statements require applicant review.


Version 0.6.2 recognizes employer HTTP 500/502/503/504, rate limits, denied access and missing pages. It does not treat them as application forms or confirmations. Newly opened automatic jobs may retry an empty landing page once after a one-minute cooldown, using a fresh GET. Other employer hosts continue during the wait. Existing records, edited/populated forms, form steps, and any possible submission remain paused. Stop automation and browser restart cancel pending retries. No access checks are bypassed. Update by extracting the ZIP over this same directory and reloading the same extension; keep its records.
