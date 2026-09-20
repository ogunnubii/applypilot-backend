# Open-source research and implementation notes

Reviewed 2026-09-20:

- JobSpy: https://github.com/speedyapply/JobSpy (MIT). Reviewed README and jobspy/__init__.py. Its unified JobPost schema separates source, employer link, location, and job title. Applied the consistent-identity idea to ApplyPilot by canonicalizing Lever application URLs and Greenhouse host aliases. Duplicate records retain their event history but are excluded from the active queue and progress counts.
- Browser Use: https://github.com/browser-use/browser-use (MIT). Reviewed README and browser_use/tools/service.py upload_file action. It treats uploads as an explicit browser operation with a selected element and approved file. ApplyPilot now chooses a unique resume field using label/id/name/context and pauses ambiguous cases with the actual upload labels. This is an independent Node/Playwright implementation, not vendored Python code or an integration of the Browser Use agent.

No source code was copied, no new dependencies installed, and no hosted agent or proxy service enabled. The CAPTCHA visibility correction and duplicate migration are ApplyPilot-specific fixes. Visible challenges continue to pause. Existing applicant consent and uncertain-submission guards remain in place.

Tests cover URL aliases, distinct jobs, ambiguous and cover-letter upload fields, duplicate queue guards, authenticated answers and manual submission confirmation. Tests use synthetic fixtures; they do not claim verified employer submissions.
