# ApplyPilot Local (desktop Chrome pilot)

1. Extract this ZIP into a permanent folder.
2. Open chrome://extensions in desktop Chrome. Enable Developer mode, click Load unpacked, and select the extracted folder containing manifest.json.
3. Keep https://applypilot-jobs.netlify.app/ open and signed in. Pin ApplyPilot Local from Chrome's extensions menu.
4. Open the extension and choose Fill in my browser on a paused Lever or Greenhouse application. This closes its old cloud session and prevents cloud retries.
5. The new employer tab fills saved contact details, exact saved answers, native choices, and an unambiguous resume upload. It rebuilds the form from saved information; unsaved cloud edits do not transfer.
6. Answer missing questions directly, solve any verification yourself, and use Fill this step after moving to another page. Review and submit on the employer page. The extension syncs missing fields and observes confirmation after a submission action.
7. Keep the ApplyPilot dashboard open until the tracker updates. If receipt detection misses a custom confirmation page, use I submitted this application on the dashboard with the employer receipt. Never retry just because the tracker has not updated.

Scope: desktop Chrome, top-level Lever and Greenhouse forms. Embedded forms, Workday, custom controls, browser restart recovery and unattended local submissions are not supported in this pilot. No CAPTCHA solver. No passwords, CAPTCHA tokens or login cookies are collected. The extension reuses the dashboard sign-in without exporting its token. Session bindings are cleared when Chrome exits; jobs remain assigned to local mode to prevent duplicates. Reopen them through the extension only after checking whether they were already submitted. File access is limited to the saved resume provided by ApplyPilot. No new AI service or credits required.

Permission scope: the ApplyPilot dashboard and three employer hostnames only; no access to all websites. Source is independently implemented, inspired by the public extension workflows documented by Simplify and Teal.
