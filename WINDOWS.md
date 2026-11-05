# ApplyPilot on your Windows PC

ApplyPilot runs on your own computer (`http://localhost:8080` by default, reachable only from this PC) and applies through your own signed-in Chrome or Edge with the ApplyPilot helper extension. No AI service is called per application: answers come from your saved profile facts and saved answers, and anything unknown stops that job as a blocker while other eligible jobs continue.

## 1. One-time setup

1. Install **Node.js 24 or newer** from https://nodejs.org (LTS installer, defaults are fine).
2. Download this repository (green **Code → Download ZIP** on GitHub, or `git clone`) to a folder such as `C:\ApplyPilot`.
3. Double-click **`ApplyPilot.cmd`**. The first run installs dependencies, creates `.env.local` with a private registration code (shown once, also saved in that file), builds the helper package and opens `http://localhost:8080/setup`.
   If port 8080 is already used by another program (for example a Docker service), ApplyPilot leaves that program alone and tells you. Start it on a free port instead: `ApplyPilot.cmd start -Port 8088`. The port is saved in `.env.local`, so later double-clicks reuse it.
4. Create your local account with that registration code.
5. Optional: run `ApplyPilot.cmd shortcut` to put an ApplyPilot icon on your desktop.

## 2. Install the browser helper (0.7.2)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `extension` folder inside the ApplyPilot folder. (`web\applypilot-local.zip` is the same helper packaged for sharing; unzip it first if you use it instead.)
3. Approve the site access Chrome/Edge asks for (employer application sites, `linkedin.com/jobs`, `indeed.com`).
4. Open the helper's popup, choose **This PC (localhost)** and set **Local port** to the port ApplyPilot runs on (8080 unless you used `-Port`).
5. Stay signed in to LinkedIn and Indeed in this same browser profile. ApplyPilot never signs in for you.

After updating ApplyPilot, run `ApplyPilot.cmd restart`, then press **Reload** on the helper in `chrome://extensions`.

## 3. Set up your profile

On the dashboard (`http://localhost:<port>/assistant`, for example `http://localhost:8088/assistant`):

1. **Profile**: name, email, phone, location (for example Thornhill, Ontario, Canada), resume, consent, and **My Windows browser** as the execution mode.
2. **Search scope**: roles (Cloud, DevOps, SRE, Platform), remote only, the places you may work from (Canada / Thornhill), work authorization you actually hold, B2B/C2C preference with employee fallback off, and `minimumAnnualCAD` (for example 60000).
3. **Saved answers**: answer the screening questions you want reused. Unknown questions are never guessed. The job stops with the question listed, and once you save the answer the next job reuses it.
4. **Import** (optional): **Import profile and history** accepts a JSON file (format below). From a terminal: `ApplyPilot.cmd import -File C:\path\to\applypilot-import.json`.
5. **Submitted-application email** (optional): enter an address under notification settings. This needs a configured sender (`RESEND_API_KEY`, `BLOCKER_EMAIL_FROM`) and an HTTPS `PUBLIC_ORIGIN`, so on a purely local install with no sender configured, summaries are saved but not sent.

## 4. Run it

* **Start ApplyPilot / Stop ApplyPilot** on the dashboard (or Start/Stop in the helper popup) is one remembered switch. When running, it discovers jobs, queues eligible ones and applies one at a time. When stopped, there is no discovery, no new queueing and no new applications, even after a restart. An application already open in your browser is left as it is.
* Leave the dashboard tab open; the helper uses it to talk to the local server.
* `ApplyPilot.cmd status`, `ApplyPilot.cmd stop`, `ApplyPilot.cmd restart` control the program itself. The log is at `data\applypilot.log`.
* Change the port any time with `ApplyPilot.cmd restart -Port <port>` (1024–65535), then set the same port in the helper popup. The helper trusts and talks only to that one localhost port.

## Where jobs come from

| Source | How it reaches the queue |
|---|---|
| Direct employer sites (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, BambooHR, Recruitee boards) | Automatic: saved searches scan employer boards every few minutes; eligible matches queue automatically while ApplyPilot is running. |
| Employer career pages and links you paste | The job funnel follows them to a supported application form. Unsupported custom forms are recorded as blockers. |
| LinkedIn | On a LinkedIn **Jobs search** page you are viewing, click **Add N Easy Apply jobs to ApplyPilot**. Only Easy Apply cards you have not applied to are added. |
| Indeed | On an Indeed **job search** page you are viewing, click **Add N Indeed Apply jobs to ApplyPilot** ("Easily apply" cards only). |

LinkedIn and Indeed offer no job-search access for personal tools, so ApplyPilot does not crawl them in the background or page through results. You add jobs one results page at a time. Each added job is then checked on its own page before any form opens: remote, title in scope, explicitly allowed from your location, B2B/C2C, and pay against your minimum when posted. External "apply on company site" jobs are skipped with a request for the employer link.

Openings on each board are spaced at least 2 minutes apart and capped at 25 per day. A board-reported limit pauses that board for 12 hours. Sign-in, MFA, CAPTCHA and "verify you are human" pages always wait for you.

## Duplicate and uncertain-attempt protection

* The same job is tracked once (LinkedIn/Indeed by their job id; employer boards by their posting).
* The same employer role found on LinkedIn, Indeed and the employer's own site is applied to at most once.
* Each job gets at most one Submit. If the result is unclear (no confirmation for this exact job), it is never retried automatically; check it yourself.
* Imported history blocks repeats by company + title and, when given, by job link. That includes **uncertain** past attempts.

## Import file format

```json
{
  "profile": {
    "name": "…", "email": "…", "phone": "…", "location": "Thornhill, Ontario, Canada",
    "answers": { "Are you legally entitled to work in Canada?": "Yes" }
  },
  "applications": [
    { "company": "Initech", "title": "Cloud Engineer", "status": "submitted",
      "url": "https://jobs.lever.co/initech/…", "appliedAt": "2026-10-20", "confirmation": "Thanks for applying" },
    { "company": "Hooli", "title": "DevOps Engineer", "status": "uncertain",
      "url": "https://www.indeed.com/viewjob?jk=…", "notes": "Browser closed after Submit" }
  ]
}
```

`status` is one of `submitted`, `uncertain` (or `attempted`), `interview`, `screening`, `rejected` or `offer`. Only values in the file are used. Existing profile values and saved answers are kept, and differing imported values are reported, not applied. A new profile created by import starts without consent; confirm consent and add your resume on the dashboard.

## Before relying on it unattended

The LinkedIn/Indeed page readers are built from synthetic test pages. Do one supervised run on one LinkedIn and one Indeed job with **automatic submission off**: confirm that fields fill and the form stops before Submit. Then turn automatic submission on.
