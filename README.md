# ApplyPilot backend update

Updated source, not a live deployment. The existing Netlify frontend is not included. Node 24 required. The existing open-source Playwright dependency is retained; no external auto-apply repository was copied.

## Changes
- Related DevOps/SRE/cloud/platform titles and Canadian cities now match. US-only remote roles are excluded from Canada searches. This is heuristic matching, not AI ranking; review results before enabling auto-queue.
- DISCOVERY_BOARDS adds up to 12 shared employer Greenhouse/Lever boards to per-search boards and existing Jobicy/Arbeitnow feeds. This is not exhaustive web discovery.
- Resume reuploads preserve boards and auto-queue settings. Concurrent same-process searches share work; database uniqueness prevents duplicate jobs across processes.
- Authenticated /api/status reports the worker heartbeat and queue counts.
- Durable pre-submit marker prevents retrying an application after uncertain submission or worker interruption. Only employer confirmation records successful delivery.
- AI answer cache separates applicants and employer/role context. API calls have timeouts and request store:false.
- Exact approved answers fill native dropdowns. Labelled resume inputs are supported when several upload fields exist.
- /assistant provides login, profile editing, search creation, status, AI advice, and voice input. Phone keyboard dictation is the fallback for unsupported browser speech recognition. Review dictated fields before saving; browser speech services may process audio externally.
- Chat is advisory. Use the search form to create searches and enable queueing. Applicant profiles, resumes and consents are set up through the original dashboard.

## Deploy to the EXISTING Railway service
1. Back up the persistent database/resume volume. Stop the service before copying SQLite files, or use SQLite backup facilities.
2. Replace repository source with these files; retain deployment secrets and persistent data. Do not commit .env, resumes or databases.
3. Keep the Docker deployment and `node start.js`. API and worker must use the SAME persistent disk. Run ONE service replica; distributed workers are not supported.
4. Set PUBLIC_ORIGIN=https://applypilot-jobs.netlify.app and SERVICE_ORIGIN to the actual Railway HTTPS origin without a trailing slash. Retain SESSION_SECRET and REGISTRATION_CODE.
5. Ensure DATABASE_PATH and UPLOAD_DIR point to a mounted persistent volume, e.g. /app/data/applypilot.sqlite and /app/data/resumes.
6. Configure DISCOVERY_BOARDS for relevant employer boards. The Newton example in .env.example does not assert current vacancies. SEARCH_INTERVAL_HOURS defaults to 6.
7. Optional AI: configure OPENAI_API_KEY and OPENAI_MODEL for an accessible model. No model or secret is supplied. CHAT_DAILY_LIMIT defaults to 30 chat requests/account/UTC day; this is NOT a dollar budget and excludes worker answer requests. Use provider spending controls.
8. Redeploy, open the Railway origin followed by /assistant, and sign in with your existing account. The existing Netlify frontend needs no change to use the separate companion page.
9. Verify worker status, run a save-only search, inspect matches, then enable auto-queue for applicant-approved searches. Verify one real employer receipt before expanding use.

The service operates without an open ChatGPT Work session. Hosting and optional AI costs remain separate. This is not unlimited AI or a full replica of a Work agent.

CAPTCHA, sign-in and unfamiliar forms still pause. The browser context closes on pause: complete the application on the employer site and record the receipt in the existing dashboard. Remote human browser takeover is not implemented.

## Tests and limits
`npm test`: isolated temporary SQLite database, mocked job feeds and local HTTP server. Tests cover role/location matching, direct-match queueing, deduplication, authentication/ownership, companion HTML delivery, missing heartbeat, AI consent, and uncertain-submission guards. All JavaScript files syntax-checked.

No live applications or paid AI calls were made. Mobile microphone, live AI responses, dropdown filling and real employer forms require deployment testing. Existing dependency/container versions retained; a fresh Docker build was not tested. Existing Netlify UI has not been changed or deployed.
