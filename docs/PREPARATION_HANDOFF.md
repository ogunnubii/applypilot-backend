# ApplyPilot 2 preparation protection contract

This integration reserves preparation only. It never grants submission authority,
copies applicant documents/answers/contacts, transfers credentials, or releases an
existing protection. Both applications must still honor their own eligibility and
Stop controls. The original account remains in its existing campaign mode.

## Existing authenticated browser transport

AP2 at **http://127.0.0.1:17780** opens the original site's
`/preparation-handoff` in a new window using `window.open`. The original page uses
its existing same-origin sign-in. Its **Connect ApplyPilot 2 for 10 minutes**
button explicitly enables this temporary connection. Stop, closure, expiry or
logout ends useful access. There is no new API key, CORS exception or persistent
cross-account grant. A normal same-origin request is authenticated on every call.

The original window posts only to that exact local origin and accepts messages
only from its captured opener. AP2 must independently check BOTH `event.origin`
against its configured original HTTPS origin AND `event.source` against the
window it opened. Never accept a wildcard origin, arbitrary redirect, unsolicited
response, wrong source_project, mismatched identity or unmatched request ID.

Connect sends:

```json
{"type":"applypilot.handoff.ready","schema_version":2,"source_project":"ogunnubii/applypilot-backend"}
```

Requests use `type: applypilot.handoff.request`, `schema_version: 2`, an `action`
of `ledger` or `reserve`, and a 16–100 character `request_id` containing only
letters, digits, underscores or hyphens. Generate unpredictable request IDs.
Only one request may be outstanding. A reserve request additionally includes
`expected_revision` and `identity` as below.

Responses have `type: applypilot.handoff.response`, `schema_version: 2`,
`source_project`, matching `request_id`, matching `action`, and `ok`. On success
the payload is in `result`; on failure `error` contains a code. Errors, missing
responses and unsupported versions prohibit preparation. If Stop races a committed
reservation, its response is suppressed and the reservation remains protected.
Reconcile with the SAME request ID and immutable identity; never choose another
ID as a retry of that preparation.

The same page offers Preview/Download for an explicit manual ledger export.
Downloading does not reserve jobs. A static export expires after five minutes.

## Schema 2 ledger

Authenticated same-origin `GET /api/preparation-handoff/ledger` returns exactly:

```json
{
  "schema_version": 2,
  "source_project": "ogunnubii/applypilot-backend",
  "revision": 1,
  "generated_at": "2026-01-01T00:00:00.000Z",
  "complete": true,
  "records": [],
  "employer_holds": []
}
```

Each record is `{record_id,status,identity}`. Status is `excluded`, `uncertain`
or `reserved`; the exporter deliberately makes no new employer-receipt claim.
Prior imported outcomes and native completed jobs remain protected conservatively.
Consumers may support `confirmed` from their existing contract. Omitted records
and holds in a later snapshot MUST NOT release protections already imported.

Identity fields are `url`, `employer`, `title`, `location`, `employer_aliases` and,
when derivable from the public URL, `ats`, `tenant`, `requisition_id` together.
Location is `Unknown` when the protected record lacks a verified location.
**Schema 2 permits url:null for protected company/title-only history.** Such
records have no ATS fields and protect the matching employer/title across aliases.
They must not be converted to fabricated URLs or blanket employer bans.
Deleted legacy attempts can have title `Unknown historical role`; their real URL
still protects the requisition. Known identity edits and deleted attempts remain
in a durable original-side protection journal.

Employer holds contain `{employer,reason_code,aliases}`; reason_code is `excluded`
for an employer security hold or `application_limit` for an active quota hold.
An ATS tenant alias identifies ONE employer, never all employers on the ATS.
No free-text notes, receipts, answers, contact fields or credentials are exported.
An incomplete/malformed projection fails with HTTP 409 rather than omitting data.

Every export increments a persistent account-specific revision, including an
unchanged export. Consumers must reject stale timestamps, backwards revisions,
and changed content under a previously imported revision. Limit: 20,000 records.

## Atomic reservation and recheck

Authenticated same-origin `POST /api/preparation-handoff/reserve` body:

```json
{
  "schema_version": 2,
  "request_id": "unpredictable_request_0001",
  "expected_revision": 1,
  "identity": {
    "url": "https://job-boards.greenhouse.io/fictional/jobs/1234",
    "employer": "Fictional Company",
    "title": "Platform Engineer",
    "location": "Canada"
  }
}
```

Candidate identities require a real, supported Greenhouse, Lever or Ashby posting
URL. Client-supplied ATS identity must agree with that URL. Server-derived aliases
are authoritative. A reservation stores only account linkage, request ID,
reservation ID, canonical job identity and timestamp. It has **no expiry or
automatic release** and no endpoint changes it to available again.

The server starts `BEGIN IMMEDIATE`, recomputes the protected projection and checks
the most recent export's digest/revision/five-minute freshness before reserving.
Original preparation claims and AP2 reservations serialize against this database;
database fences cover native queue, browser, attempt and submission reservation
paths. The first claim wins. Exact URL/ATS requisition or employer/title alias
matches, uncertain outcomes and employer holds refuse a new reservation.

Result fields: `schema_version`, `source_project`, `request_id`, canonical
`identity`, `revision`, `checked_at`, `submission_allowed:false`, `decision`,
`reservation_id`, plus `reason_code` when blocked. Decision is `reserved`,
`rechecked` or `blocked`. Block reasons: `protected_application`, `employer_hold`.
No refusal is evidence of employer receipt or of non-receipt.

A committed reservation changes the ledger. **Before rechecking or reconciling a
lost response, obtain/import a new ledger and use its revision with the ORIGINAL
reservation request ID and identity.** Replay returns the same reservation ID
after checking current protections, not a new preparation grant. AP2 must not treat
its own reservation as a local duplicate during reconciliation, but must retain
all other native/imported protections and employer holds. Start employer
preparation only after a fresh accepted response; independently deduplicate local
execution for that reservation. Recheck immediately before later user-driven
submission. A stale response cannot authorize either step.

Common HTTP 409/error codes: `fresh_snapshot_required`, `snapshot_changed`,
`request_identity_conflict`, `invalid_request`, `unsupported_candidate_url`,
`conflicting_identity`, `incomplete_projection`. Refresh/import then recheck where
appropriate. Do not retry an employer submission to resolve a transport failure.

## Validation and deployment checkpoint

`preparation-handoff.test.js` tests minimal projection, URL-less history,
cross-account isolation, deleted attempts, native fences, restart durability,
idempotent recheck, stale revisions, employer holds and two concurrent database
connections. `checks/preparation-handoff-api.test.js` exercises the real server's
authentication, unchanged CORS, preserved jobs/submission state and browser Stop/
origin/opener behavior with fictional data. These tests are not real applications.

AP2 must implement and test this exact version, import a live complete export,
and verify an original-side acknowledgement before opening employer preparation.
Deployment alone does not prove that integration or any employer submission.
