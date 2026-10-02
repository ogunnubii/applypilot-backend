# Open-source research and implementation notes

Reviewed 2026-09-20:

- JobSpy: https://github.com/speedyapply/JobSpy (MIT). Reviewed README and jobspy/__init__.py. Its unified JobPost schema separates source, employer link, location, and job title. Applied the consistent-identity idea to ApplyPilot by canonicalizing Lever application URLs and Greenhouse host aliases. Duplicate records retain their event history but are excluded from the active queue and progress counts.
- Browser Use: https://github.com/browser-use/browser-use (MIT). Reviewed README and browser_use/tools/service.py upload_file action. It treats uploads as an explicit browser operation with a selected element and approved file. ApplyPilot now chooses a unique resume field using label/id/name/context and pauses ambiguous cases with the actual upload labels. This is an independent Node/Playwright implementation, not vendored Python code or an integration of the Browser Use agent.

No source code was copied, no new dependencies installed, and no hosted agent or proxy service enabled. The CAPTCHA visibility correction and duplicate migration are ApplyPilot-specific fixes. Visible challenges continue to pause. Existing applicant consent and uncertain-submission guards remain in place.

Tests cover URL aliases, distinct jobs, ambiguous and cover-letter upload fields, duplicate queue guards, authenticated answers and manual submission confirmation. Tests use synthetic fixtures; they do not claim verified employer submissions.

## Local browser handoff
Simplify (https://simplify.jobs/copilot) and Teal (https://www.tealhq.com/tools/autofill-job-applications) document extension-based autofill and application tracking. ApplyPilot Local independently implements a limited Lever/Greenhouse version using Chrome Manifest V3, native DOM field setters, a dashboard-origin API bridge, local ownership of jobs, and post-submit receipt detection. No third-party source copied; no claim of universal CAPTCHA bypass.

## Reference: ibarrajo/ApplyPilot

Reviewed the [README](https://github.com/ibarrajo/ApplyPilot/blob/e77ec117fa5a9fdbbb1879ace8c780a2ca6378e5/README.md), [worker dashboard](https://github.com/ibarrajo/ApplyPilot/blob/e77ec117fa5a9fdbbb1879ace8c780a2ca6378e5/src/applypilot/apply/dashboard.py), and [human review workflow](https://github.com/ibarrajo/ApplyPilot/blob/e77ec117fa5a9fdbbb1879ace8c780a2ca6378e5/src/applypilot/apply/human_review.py) at commit e77ec117fa5a9fdbbb1879ace8c780a2ca6378e5. This is ibarrajo's fork of Pickle-Pixel/ApplyPilot; its repository carries AGPL-3.0.

Design ideas used here: approved Q&A reuse and explicit separation of waiting-for-answer, waiting-for-applicant and active preparation. Implemented independently for this application's existing Node/SQLite/Chrome architecture: saved-fact recovery with one guarded continuation, and a clickable preparation summary separating final Submit, missing answers, employer-site actions, limits and browser checks. No upstream source code, prompts, styles or dependencies were copied. The reference project's volume and autonomy claims are not evidence of this site's performance.

The existing manual final Submit, user/account boundaries, employer limits, duplicate checks and receipt verification remain in effect. Tests use synthetic forms and records; live recovery counts do not represent new submissions.
