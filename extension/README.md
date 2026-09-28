# ApplyPilot Local for Windows Chrome and Edge

1. Start the local backend using `../start-local.ps1 -Install`, or deploy the updated hosted backend/dashboard.
2. In your usual signed-in browser profile, open `chrome://extensions` or `edge://extensions`, enable Developer mode, click Load unpacked, and select this directory.
3. Open the extension popup. Select This PC for localhost:8080 or Hosted ApplyPilot for the existing Netlify/Railway service.
4. Open ApplyPilot and sign in. Complete the profile/resume at the backend's `/setup` page and select My Windows browser. Keep the signed-in dashboard tab open.
5. Start routine applications processes current Found/Queued supported jobs. Open / fill manually fills facts without automatically submitting. Run routine steps enables a selected job. Stop automation prevents subsequent steps but cannot recall an already clicked submit.

The extension uses the current browser's cookies and login state; it never copies them. It does not solve CAPTCHA or MFA, enter payment information, accept legal attestations, or invent applicant facts. Mandatory unknowns and custom controls stop automation. Use Remember an answer to explicitly save an exact answer for this applicant.

Blocked tabs remain open while the queue advances. Persistent records survive service-worker/browser restarts, but automation stops on full browser startup. Restart the backend if local, sign back into the dashboard, reopen unfinished jobs, and start another run. A recorded submission attempt is never automatically replayed. Check uncertain applications with the employer and record an actual receipt in the dashboard.

Allowed ATS families: Greenhouse, Lever, Workday, Ashby, SmartRecruiters, Workable, BambooHR and Recruitee. Permissions are limited to these domains, the existing dashboard and localhost. Coverage is conservative: top-level native controls, recognizable Next/Continue and Submit actions, exact saved facts, and identifiable resume uploads. Embedded forms, custom widgets, cross-domain SSO, unusual step URLs and unrecognized receipts require manual handling.

Submitted means the extension observed a recognized receipt after a submission action for the bound job, or the applicant explicitly recorded employer confirmation. No email monitoring is implemented. Extension state is local to the browser profile; do not uninstall it mid-application unless prepared to review ownership and receipt state manually.

The popup environment cannot switch servers while records exist. Use a separate browser profile for another backend. To customize hosting/port, update background.js and manifest.json together. Reload the extension after changing files.
