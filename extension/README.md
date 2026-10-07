Version 0.6.27 reads native and custom dropdown choices for supported saved-fact Gemini answers. Final Submit stays manual.

Version 0.6.22 adds Mark completed beside each unfinished application. It records your submission, removes local retry work and updates Completed without inventing an employer receipt. Completed and Confirmed are separate totals. Reload the existing extension to retain its records.

Version 0.6.21 adds full-length application questions, employer field limits, and a focused popup with counts and unfinished jobs. The server uses relevant approved experience and the public posting to draft complex answers. Final Submit remains manual.

Version 0.6.21 opens supported application entry tabs before autofill. Job descriptions and empty loading pages cannot become Ready for Submit. Intermediate Next steps remain manual; final Submit remains manual. Existing embedded-form and dashboard reconnection fixes are included.

Version 0.6.19 fills the matching Greenhouse application embedded on trivago careers. Frame access requires the exact saved employer and job identity in both the parent page and embedded form; unrelated frames remain blocked. Existing attempts remain recorded, and final Submit stays manual.

Version 0.6.19 distinguishes foreground Open & autofill from background preparation, brings existing browser windows forward, displays progress/errors beside each job, explains unavailable postings and employer limits, and keeps AI research from delaying browser controls. Final Submit remains manual.

Version 0.6.19 lets the job list and connection checks respond independently of long form and AI operations. Popup requests time out with a retry message instead of showing Loading indefinitely.

Version 0.6.19 records distinct manual Submit clicks with stable IDs, retries only failed tracking requests, and never blocks or repeats employer submission actions. French-language form exclusion follows the account preference.

Version 0.6.19: autofill-only mode fills new fields as they appear and refreshes saved answers. You control Next and Submit. Native Submit clicks are never cancelled or replayed; repeated manual clicks remain available. Tracking failure does not block the employer form. Earlier release notes describing click interception are superseded.

# ApplyPilot Local for Windows Chrome and Edge

Version 0.6.19 recognizes combined first-and-last-name prompts from your saved full name. It also fixes saved-answer refill stalls when reopening an existing form, prioritizes visible field labels over generic input identifiers, and reconnects forms that loaded before they were linked. It preserves approved answers when unapproved captures disagree, waits briefly for delayed employer forms, and gives Gemini enough time to return an answer. Existing edits and submission-attempt guards remain intact. Final Submit stays with you. Update the existing extension folder and reload the same installation to retain its records.

1. Start the local backend using `../start-local.ps1 -Install`, or deploy the updated hosted backend/dashboard.
2. In your usual signed-in browser profile, open `chrome://extensions` or `edge://extensions`, enable Developer mode, click Load unpacked, and select this directory.
3. Open the extension popup. Select This PC for localhost:8080 or Hosted ApplyPilot for the existing Netlify/Railway service.
4. Open ApplyPilot and sign in. Complete the profile/resume at the backend's `/setup` page and select My Windows browser. Keep the signed-in dashboard tab open.
5. Automatic mode is on by default. Every 30 seconds it picks up explicitly queued jobs for profiles in My Windows browser mode. Found jobs stay unstarted until queued. Signed-in Railway, Cloudflare Pages and legacy Netlify dashboards can sync. Open manually is an optional override; Continue automatically resumes a selected blocked application. Stop automation persists across restarts.

The extension uses the current browser's cookies and login state; it never copies them. It fills routine native fields and exact-answer ARIA dropdown, radio, and checkbox controls, advances recognized intermediate steps, and always stops on the completed final form. Review it and click Submit yourself. The extension records that trusted click before allowing employer navigation so the same application is never replayed. It does not solve CAPTCHA or MFA, enter payment information, accept legal attestations, answer demographic questions, or invent applicant facts. Mandatory unknowns and unresolved required custom controls stop automation; unresolved optional widgets do not. Use Remember an answer to explicitly save an exact routine answer for this applicant.

Blocked tabs remain open while other eligible jobs continue. An empty queue stays enabled and checks for newly discovered jobs. Browser startup preserves Stop; otherwise new eligible jobs resume when the signed-in dashboard is available. Existing interrupted or blocked applications wait for explicit continuation. A recorded submission attempt is never replayed automatically. Keep the PC awake and Chrome and the signed-in dashboard open.

Allowed ATS families: Greenhouse, Lever, Workday, Ashby, SmartRecruiters, Workable, BambooHR and Recruitee. Permissions are limited to these domains, the existing dashboard and localhost. Coverage includes top-level native controls, exact-answer ARIA controls (including portal-rendered dropdown menus), recognized Next/Continue/Review actions, exact saved facts, and identifiable resume uploads. Embedded forms, unresolved required widgets, cross-domain SSO, unusual step URLs and unrecognized receipts require manual handling. Static privacy or legal text in a page footer does not block routine filling; an interactive required legal or demographic response still does.

Submitted means the extension observed a recognized receipt after a submission action for the bound job, or the applicant explicitly recorded employer confirmation. No email monitoring is implemented. Extension state is local to the browser profile; do not uninstall it mid-application unless prepared to review ownership and receipt state manually.

The popup environment cannot switch servers while records exist. Use a separate browser profile for another backend. To customize hosting/port, update background.js and manifest.json together. Reload the extension after changing files.

Version 0.6.7's prepare-only final step replaces the earlier automatic final-submit behavior described in older release notes below.

Version 0.6.1 fixes missing-tab queue stalls and resumes routine submissions after a durable attempt record. A timeout or uncertain receipt is never retried automatically. Existing paused forms need explicit continuation. Reload the updated extension in the existing browser profile; keep its stored records. The hosted download is built from the deployed extension source, not an older checked-in ZIP.


0.6.1 opens associated dropdown menus before matching exact saved answers, verifies the displayed selection, reports filled-field progress, and supports guarded dashboard resume. Attempts are never automatically retried. Arbitration and waiver statements require applicant review.


Version 0.6.2 recognizes employer HTTP 500/502/503/504, rate limits, denied access and missing pages. It does not treat them as application forms or confirmations. Newly opened automatic jobs may retry an empty landing page once after a one-minute cooldown, using a fresh GET. Other employer hosts continue during the wait. Existing records, edited/populated forms, form steps, and any possible submission remain paused. Stop automation and browser restart cancel pending retries. No access checks are bypassed. Update by extracting the ZIP over this same directory and reloading the same extension; keep its records.

Version 0.6.7 prepares more routine forms by using accessible labels and descriptions, exact portal dropdown choices, ARIA radios and checkboxes, content-editable fields, and additional safe Next/Continue/Review labels. It ignores static footer boilerplate while still stopping for required legal, demographic, CAPTCHA, MFA, and unknown responses. ApplyPilot never clicks the final Submit button: the applicant clicks it once, and the extension durably records that attempt before replaying the click to the employer page.

Application order follows the server company/platform rotation. Five is a soft rotation target, not an employer quota or permission to repeat a requisition. Final Submit remains manual.


Single-application mode (0.6.25): enable Start autonomous application on the dashboard. Only the selected job progresses; saved facts and approved reusable answers fill the form. The hosted worker starts new forms, or the connected browser can continue an existing local form. Automatic Submit requires this explicit mode, a complete supported form and durable authorization. Missing facts, verification and employer declarations pause the same application. No automatic replay follows an uncertain attempt. The next job is selected only after a real employer receipt. The displayed percentage measures current-step required fields, not hiring probability or submission success. Manual Submit remains the default outside this mode.

## 0.6.25
Support-career batches of up to 20, per-question autosave with durable retry, and automatic reuse of completed factual answers. The helper panel no longer needs Save answers or Fill available answers controls. Batch mode prepares forms and leaves final Submit with the applicant.

## 0.6.26

Saved Website / portfolio facts now fill supported website prompts. LinkedIn and GitHub wording variants include Your profile and profile-link prompts. Each uses its own saved value; company and other people's links are not inferred. Final Submit behavior is unchanged.


## 0.6.27
Reads offered options from native and custom dropdowns, maps supported professional facts to exact choices, and preserves manual edits. Ambiguous options, missing facts and protected declarations stay for review. Canada-only remote incorporated-contract searches remain scoped after refresh.
