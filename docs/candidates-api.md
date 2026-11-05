# Candidates and Hot List: Eureka App 4 additions

Migration `0140_candidate_profile_fields.sql`, module `apps/api/src/modules/candidates` (and the Hot
List export in `apps/api/src/modules/hotlist`), vocabularies in `packages/shared/src/candidates.ts`.
Tests: `apps/api/test/candidate-fields.api.int.test.ts`, `candidate-fields.db.int.test.ts`,
`apps/web/src/sales/CandidateFields.test.tsx`.

## Hot List visibility (CA-1)

`HOTLIST_VISIBILITY` is `"team"` (it was `"everyone"` under OD-01). The migration runner writes it
to `authz.policy_setting`; the API serves the Hot List from the caller's `hotlist:read` scope under
RLS:

| Who | Sees on the Hot List |
|---|---|
| Recruiter, lead | Their team's candidates, plus every candidate "Open to all teams" or shared with their team (CA-5) in an active status |
| Manager, associate director | Their hierarchy's teams, plus Open to all teams and candidates shared with those teams |
| Interview coach (interview prep team) | Candidates of the teams they coach |
| Location incharge / ops admin | Candidates of their location |
| CEO | Everyone (the offshore office manager is an associate director since 0090) |
| HR, Accounts, Immigration, Documents team, BU head, org admin | No Hot List (they keep the Candidates list where they hold `candidate:read`) |
| Interview coordinator (support) | No Hot List and no Candidates list (`candidate:read` dropped, 0141); the Interviews board shows each interview's candidate name through `authz.interview_candidate_name` |

Phones stay masked outside the caller's own scope. Every Hot List page is audited (`hotlist.read`,
filter summary only) under either policy. The open function `authz.hotlist_page` is kept and takes
the same filters, so going back to `"everyone"` is a catalog change.

**Recruiter entry rights.** Under the team policy the Hot List a Sales user sees is exactly the set
`submission:create` / `placement:create` cover (team or hierarchy, plus Open to all teams while
active), so a recruiter can log submissions, interviews and placements for any Hot List candidate
they see. No grant changed; `engine.test.ts` ("recruiter entry rights") and the API test keep the
two in step.

**Adding to the Hot List.** There is no membership table: a candidate is on the Hot List while its
status is in `HOTLIST_STATUSES`. New candidates start "In training", so adding one is the
`in_training -> active` transition (`POST /candidates/:id/transition`, `candidate:update`); the
profile header shows it as "Add to Hot List". `candidate:update` covers recruiter (own), lead (team),
manager / AD (hierarchy) and the CEO (org).

The gap list's "narrow `interview_coordinator`'s org-wide candidate read" does not apply on this
branch's base: that role does not exist here (interview prep is the interview coach, `coached` scope).

## Filters (CA-2)

`GET /api/v1/hotlist` and `GET /api/v1/candidates` take, in addition to `status`, `technology`,
`visibility`, `search`:

| Query | Values | Matches |
|---|---|---|
| `locationId` | location id | the candidate's office location |
| `visa` | `VISA_CATEGORIES` key | the marketed visa |
| `documents` | `pending`, `partial`, `complete`, `none` | the documents status (`none`: not recorded) |
| `resume` | `yes`, `no` | a current uploaded resume or a resume link |
| `stay` | `guest_house`, `remote` | guest house location set / Remote |
| `priority` | `P1`, `P2`, `P3` | the priority (0290) |
| `teamId` | team id | the candidate's team (the sheet's "Lead") |
| `recruiterId` | user id | the recruiter |
| `inPerson` | `yes`, `no` | in-person recorded as yes / no (not recorded matches neither) |
| `ghLocationId` | location id | that guest house |
| `sort` | `default`, `priority`, `days`, `name` | order: id; P1 first; longest in market first (no start date last); name |

Paging stays keyset: with a sort the cursor is still the last row's id, and the next page starts
after that row's (sort key, id). Both list paths (scoped SQL in `candidates.service.ts`, open
`authz.hotlist_page`) order the same way.

Saved views (`POST/PATCH /hotlist/views`) and `POST /hotlist/export` accept the same keys (the export
is ordered by `sort` too). The export adds the columns Visa, Documents and Stay, and (0290) Lead
and In person. Unknown values are 422.

List rows add `statusLabel`, `stay`, `ghLocation` (`{ id?, name }`), `visaCategory`,
`documentsStatus`, `hasResume`, `inPersonOk`, `team.lead` (the lead's name), and (Candidates list
and team Hot List) `teamAssignedAt`.

`GET /api/v1/hotlist/filter-options` (`hotlist:read`): `{ teams: [{ id, name, lead }], recruiters:
[{ id, name }], guestHouses: [{ id, name }] }` for the filter selects (current recruiter-role
holders; locations of kind `gh`). `POST /api/v1/hotlist/bulk/priority` (`candidate:update`)
`{ ids, priority }` applies the rules of `PATCH /candidates/:id { priority }` per record, like the other bulk actions.

Hot List bulk actions (`/hotlist/bulk/{visibility,status,priority}`, up to 100 ids, R-12): one read of
all ids under the caller's `candidate:read` scope sorts them in memory into `not_found` (not visible),
`forbidden` (visible, not owned under the action's permission) and, for status, `invalid_transition`;
the rest are written in one transaction, each under its own savepoint, through the same definer
function or guarded UPDATE as the single-record endpoint, with the same per-record audit row
(`candidate.visibility`, `candidate.transition`, `candidate.updated`). A record whose write fails is
rolled back to its savepoint, audit row included, and reported with the single endpoint's code
(`invalid_teams`, `placement_open`, `invalid_transition`, `forbidden`, `not_found`, else `failed`);
the others still commit. Response `{ succeeded, failed, results: [{ id, ok, error? }] }` in request
order, plus one `hotlist.bulk` summary audit row (`action, value, requested, succeeded, failed`).

## Profile fields (CA-3)

`PATCH /api/v1/candidates/:id` (candidate:update over the candidate, as before) also takes:

| Field | Type | Notes |
|---|---|---|
| `ghLocation` | location id, `"remote"` or null | guest house or Remote; never both (`candidate_stay` check) |
| `marketingLocations` | up to 5 strings (`"Dallas, TX"`), `[]`/null clears | |
| `linkedinUrl` | `https://…linkedin.com/…` or null | |
| `resumeUrl` | `https://…` or null | a link; uploaded files stay under `/resumes` |
| `eligibility` | subset of `in_person`, `hybrid`, `remote`, `relocation`, `travel`; `[]`/null clears | |
| `visaCategory` | `VISA_CATEGORIES` key or null | the visa the candidate is marketed on |

`in_person_ok` stays as it was; eligibility is the fuller list. Links and marketing locations are
audited as `true` flags only (rule 5); the marketing email and VITEL number are now flagged the same way.

`GET /api/v1/candidates/:id` adds: `statusLabel`, `stay`, `ghLocation`, `visaCategory`,
`documentsStatus`, `eligibility`, `marketingLocations`, `teamAssignedAt` (date added to the current
team), `confirmations` (times the candidate reached confirmation, from `candidate_event`), `hasResume`,
`canEditCompliance`; and, for owners of the candidate only (not through Open to all teams),
`linkedinUrl`, `resumeUrl` and `companies`.

`dobMasked` (`•• / •• / <year>`) follows the DOB rule (audit A-10): only callers holding the restricted
`candidate.dob:read` over the candidate (HR, Immigration) get it; everyone else, owners included, gets `null`.

`team_assigned_at` is server-managed: set on insert and whenever `team_id` changes, refused from any
client (`candidate_profile_guard`), backfilled from the last assignment events.

**Marketing status values** ("Active/Remote", "Active/All Teams", "N/A") are a derived label
(`marketingStatusLabel`), not new statuses: "All Teams" mirrors `visibility`, "Remote" mirrors the stay,
"N/A" is a candidate still in training. The status machine and every access rule are unchanged.

## Optimistic concurrency (If-Match)

`PATCH /candidates/:id`, `PUT /candidates/:id/compliance`, `/recruiter`, `/technical-rating`, `/visibility` and
`POST /candidates/:id/transition` accept an **optional** `If-Match: "<rowVersion>"` (`W/"3"` and a bare `3` work too)
with the `rowVersion` of `GET /candidates/:id`:

- no header (or `*`): the write runs as before, unchecked;
- a version the candidate no longer has: **412 `stale`**, nothing written (an unparsable header can never match: 412);
- 404 / 403 still come first.

Every one of these responses now carries the new `rowVersion` (additive). Direct updates check with
`AND row_version = $n`; the definer paths (compliance, visibility, transition) lock the row first with
`authz.candidate_version_lock` (0475). The Hot List bulk actions and other internal callers send no version.
A required header (428) is a later, breaking step.

## Company links and documents status (CA-4)

New permission `candidate.compliance:update`: HR, Accounts, Immigration and the Documents team, at
org scope.

- `PUT /api/v1/candidates/:id/compliance` with any of `everifyCompanyId`, `offerLetterCompanyId`,
  `form1099CompanyId` (company id or null) and `documentsStatus` (`pending`, `partial`, `complete` or
  null). Omitted keys keep their value. Read-before-write: 404 if the candidate is not readable,
  403 without the permission over it. The write goes through `authz.set_candidate_compliance`, which
  re-checks the scope; a link that changes must name an active company (422 `invalid_company`).
  Audited as `candidate.compliance` with ids and the status key only.
- `GET /api/v1/candidate-companies`: active companies (`id`, `name`, `location`) for the picker.

Company names on the profile come from `authz.candidate_companies` (owners and compliance editors);
the company rows themselves stay under `company:read`. The compliance columns cannot be written
directly by the API role, even by the owning team (`candidate_profile_guard`).

## Selected teams (CA-5)

Migration `0240_candidate_team_share.sql`. A lead sees only their own team's candidates (Hot List and
Candidates list) unless a candidate is Open to all teams or shared with the lead's team.
`visibility` gains `selected_teams`: the candidate's own team and hierarchy keep seeing it as before,
and the Sales users of the picked teams see it under exactly the Open-to-all-teams rule (active / full
of interviews only; `candidate:read`, `hotlist:read`, `submission:create`, `placement:create`;
phones masked; no actor names or history before it was shared; no ownership rights).

| Who | Reached by a share with team X |
|---|---|
| Lead of X | yes |
| Recruiters (members) of X | yes |
| Manager / AD above X's lead | yes (X is in their hierarchy) |
| Other teams, location roles, coaches | no (location roles and coaches keep their own scope) |

- `PUT /api/v1/candidates/:id/visibility` takes `{ "visibility": "selected_teams", "teamIds": [...] }`
  (1-50 distinct team ids; `teamIds` only with `selected_teams`, else 422). The candidate's own team is
  dropped from the picks; none left is 422 `teams_required`, an unknown team 422 `invalid_team`.
  `team` / `all_teams` clear the picks. Same rights as before (`candidate.visibility:update`: lead
  over their team, manager / AD over their hierarchy, CEO, location roles over their location).
  The write goes through `authz.set_candidate_visibility`, which re-checks read (404) and
  ownership (403). Audited as `candidate.visibility` with the team ids only.
- `POST /api/v1/hotlist/bulk/visibility` takes the same `teamIds` with `selected_teams`; each
  candidate drops its own team from the picks, and a row left with none (or naming a team that is
  gone) fails with `invalid_teams`. The Hot List bulk bar shows the team picker for this option.
- `GET /api/v1/candidate-share-teams` (`candidate.visibility:update`): `{ items: [{ id, name, lead }] }`
  for the picker.
- `GET /api/v1/candidates/:id` adds `sharedTeams` (`[{ id, name }]`) for owners only.
- List / Hot List / export filters accept `visibility=selected_teams`; the export column reads
  "Selected teams"; the status label adds "Shared" (`Active/Shared`).

Storage: `eureka.candidate_team_share (candidate_id, team_id, shared_by, shared_at)`, written only by
the definer (guard trigger sets `shared_by` / `shared_at`), readable wherever the candidate is.
`authz.shared_candidate_ids(perm)` lists the candidates shared with a team in the caller's
`team_ids(perm)` or their `actor_team()`; the `candidate_read` policy uses it as an InitPlan set and
the API loads it once per request (`UserAccess.sharedCandidateIds`). Shares count only while
`visibility = 'selected_teams'`. Tests: `apps/api/test/candidate-team-share.{db,api}.int.test.ts`,
`engine.test.ts` ("selected teams"), `apps/web/src/sales/Sales.test.tsx`.

## Setting the recruiter: lead or above

`candidate:assign`: lead (team), manager / AD (hierarchy), CEO (org). A recruiter gets 403, also for
their own candidate; `PATCH /candidates/:id` rejects `recruiterId` (422). `actions.assign` on the
profile is the hint.

- `GET /api/v1/candidates/:id/recruiter-options`: `{ items: [{ id, name }] }`, the active members
  and lead of the candidate's team.
- `PUT /api/v1/candidates/:id/recruiter` with `{ recruiterId }` (`null` unassigns): 422
  `invalid_recruiter` for anyone not in that list. Audited as `candidate.recruiter` (ids only).

## Adding candidates: required, unique contact; lead or above (CA-6)

Migrations `0260_candidate_unique_contact.sql` (trigger) and `0300_candidate_contact_required.sql` (one lock per transaction, import loader policies).

- **Who:** `candidate:create` is a lead (team), manager / AD (hierarchy) or org grant. Recruiters no
  longer hold it, so they get 403 on `POST /api/v1/candidates`, `POST /candidates/duplicate-check`
  and `POST /applications/:id/candidate`, and the web hides "New candidate". A lead can still assign
  one of their recruiters with `recruiterId`. The CEO holds it at org scope.
- **Team:** `POST /api/v1/candidates` takes optional `teamId`, defaulting to the caller's first team
  (403 when they have none, or the team is outside their scope).
  `GET /api/v1/candidate-create-teams` (`candidate:create`) returns
  `{ items: [{ id, name, lead }], defaultTeamId }`: the teams in scope (all for org), own team first;
  `defaultTeamId` is the caller's team when listed, else null. The dialog shows a Team picker when
  there is more than one, starting on "Not yet assigned" (a placeholder: the user must pick a team
  before Create; `defaultTeamId` is no longer preselected), and a note when there are none.
- **Status:** optional `initialStatus` (`in_training`, the default, or `active`). New rows are
  always inserted in training (DB guard); `active` runs `authz.transition_candidate` in the same
  transaction, which re-checks `candidate:update` (403 and nothing created when refused) and
  records the usual status-change timeline entry. The dialog's Status select sends it.
- **Several at once (web only):** the dialog's "Several candidates" tab takes up to 20 rows
  (the duplicate-check limit, 20 per user per minute) typed in, pasted from a sheet or loaded from a
  CSV (First name, Last name, Phone, Email, optional Technology and Location by name), with one team,
  batch and default technology/location. Each row is its own `POST /api/v1/candidates`, so every
  server check applies per row; rows that fail stay in the table with the reason, a 429 stops the run.
- **No team yet (0410):** `teamId: null` creates a candidate with no team; the picker's "No team yet"
  (single mode only) sends it; with Status Active the dialog asks for a team first. Outside org scope the creator becomes the recruiter, so the candidate stays in their and
  their reporting line's scope. Responses show `team: { id: null, name: "No team yet", lead: null }`
  and the profile's `canAssignTeam`. `PUT /api/v1/candidates/:id/team` `{ teamId }` (`candidate:create`
  over the candidate, team in the same scope as the picker; 403 otherwise, 404 not visible, 409
  `team_already_assigned`) sets it once through `authz.assign_candidate_team`: the recruiter stays only
  if they are a member of that team, and the new team's lead is notified (`candidate.assigned`). Moving
  to Active answers 422 `team_required` until then, so the Hot List never has a candidate with no team.
- **Required:** `POST /api/v1/candidates` needs `phone` (normalized to E.164) and `email` (personal,
  lower-cased); missing either is 422. The hire flow (`POST /applications/:id/candidate`) uses the
  applicant's email and phone, and takes `phone` / `email` in the body when the applicant has none or
  the caller may not read applicant phones; still missing is 422 `phone_required` / `email_required`.
- **Unique:** another candidate with the same personal email (case-insensitive), marketing email or
  phone is 409 `duplicate_contact`, with no override (`confirmDuplicate` is gone: 422 as an unknown
  field). The dialog then calls `POST /candidates/duplicate-check` for the minimal details (team,
  contact, the id only if readable) and links "Open existing profile".
- **Backstop:** trigger `authz.candidate_contact_unique` (BEFORE INSERT on `candidate`, BEFORE UPDATE
  OF `personal_email, phone_e164` on `person`) refuses a personal email or phone another candidate's
  person holds (`duplicate_email` / `duplicate_phone`, unique_violation; the API maps both to 409).
  One transaction advisory lock (0300) serializes concurrent creates; one per value exhausted the lock table on 50k-row bulk inserts. It covers every writer
  (API, imports, seeds). Existing duplicates are left as they are (no unique index), and persons
  without a candidate (employees only) are not checked.

Tests: `candidate-extras.api.int.test.ts` ("duplicate check"), `api.int.test.ts`,
`applications.api.int.test.ts`, `engine.test.ts` ("adding candidates"), web `CandidateExtras.test.tsx`,
`Sales.test.tsx`, `Applications.test.tsx`, e2e `candidate-extras.spec.ts`.

## New batch workflow: bulk add from Excel (CA-6a)

The web "New batch" dialog (Candidates and Training Batches) asks for the batch name, location, technology and month
(`POST /api/v1/training/batches`, month = first day), then lets `candidate:create` holders upload new candidates. The
upload is also on the batch's Students tab while the batch is open.

- `GET /api/v1/batches/candidate-template` (`candidate:create`) → `.xlsx` with `First Name`, `Last Name`, `Phone`,
  `Personal Email`: only what a new candidate must have. Technology and location come from the batch.
- `POST /api/v1/batches/:id/candidates/bulk` (`candidate:create`) `{ dryRun, teamId?, rows: [{ firstName, lastName, phone, email }] }`
  (1-500 rows; `teamId: null` = "No team yet", assigned later as for `POST /candidates`) → 200 `{ dryRun, committed, created, failed, rows: [{ row, firstName, lastName, phone, email, status, error? }] }`.
- All or nothing: one transaction, rolled back when any row fails or on `dryRun`, so the preview is what a real run does.
  Rows are validated in memory, their contacts checked in one call (`authz.candidate_contacts_taken`, 0475, which takes
  the contact lock until the transaction ends) and the rest inserted set-based; `authz.candidate_contact_unique` stays
  the backstop. A taken email is reported before a taken phone, as the trigger does.
- Row errors: `invalid_first_name`, `invalid_last_name`, `missing_country_code`, `trunk_zero`, `invalid` (phone),
  `invalid_email`, `duplicate_in_file`, `duplicate_email`, `duplicate_phone`. Rows name only the value that is taken, not
  whose it is.
- 404 batch not visible; 403 team outside `candidate:create` (same rule as `POST /candidates`); 422 `batch_not_allowed`
  when the batch is completed or cancelled; 429 after 10 calls a minute per user.
- **Daily row budget** (audit A-01): the file answers "is this contact taken?" for every row, so rows checked against
  existing contacts (the ones that pass the in-memory checks) are charged to the caller, previews included, before the
  check runs: `BULK_CANDIDATE_ROWS_PER_DAY` = **2,000 rows per user per UTC day** (`candidates.service.ts`; change the
  constant to resize it). Stored in `eureka.bulk_candidate_budget` (0475, written only by
  `authz.bulk_candidate_budget_take`), so it holds across API tasks. A file that would pass it gets
  **429 `bulk_budget_exceeded`** and is not charged; 404 / 403 / 422 come first and cost nothing.
- Audit (counts and ids only): `candidate.created` per row with `{ batchId, bulk: true }`, `batch.candidates_added`
  `{ teamId, created, checked, taken }`, and `batch.candidates_checked` `{ rows, failed, checked, taken }` for a preview
  or a refused file (`checked`: rows charged to the budget; `taken`: rows reported `duplicate_email` / `duplicate_phone`).

## Deleting a candidate (CA-7)

`DELETE /api/v1/candidates/:id` → 204. Hard delete, not undoable. Permission
`candidate:delete`: lead (team), manager and associate director (hierarchy), CEO
(org); custom roles can be given it. 404 when the candidate isn't readable, 403
when readable but out of delete scope, 409 `candidate_placed` when the candidate
has a placement or an employee record (contracts, invoices, payments and
employment history are never deleted). The profile's `actions.delete` hints the
button; the server decides.

`authz.delete_candidate` (migration 0330) removes, in one transaction: submissions,
interviews (panel, feedback, feedback deliveries, calendar blocks), assessments,
jobs-portal applications (the applicant account stays), checklist items, BGC,
documents with their access log and file rows, resumes, training progress,
candidate events, non-response records, team shares, notifications about the
candidate, its interviews or applications, import ledger rows, the candidate, and
the person with their work authorizations when no other record uses them.
`audit_event` keeps a `candidate.delete` row (ids only) and earlier audit rows.

The guard triggers that make these tables append-only let `authz_definer` delete
only while `eureka.candidate_purge` holds a row for the current transaction and
backend (written only by `authz_definer`); outside that, definer deletes match no
rows under RLS and the guards still refuse every other writer.

Not removed: stored objects in S3 (resume and document files stay in the bucket,
unreachable once their rows are gone; the API role has no delete on the bucket),
staged import rows (`import_row`), and outbox events (ids only).

## Metrics

`GET /api/v1/candidates/:id/metrics` (`candidate:read`; 404 when the candidate
isn't readable). Counts only, no rates, clients or notes. Each section is present
only with its read permission and counts what the caller could list there (the
activity rule: actor snapshot or candidate owned through scope, never the
all-teams rule), so another team seeing an Open-to-all-teams candidate gets zeros.

- `submissions` (`submission:read`): `total`, `last30Days`, `withInterview`
  (submissions with an interview the caller can see), `clients` (distinct),
  `firstAt`, `lastAt`, `byStatus` (status → count).
- `interviews` (`interview:read`): `total`, `upcoming` (scheduled/rescheduled, in
  the future), `completed` (completed or cleared), `cleared`, `notCleared`
  (completed, not cleared), `cancelled` (cancelled or no invite), `lastAt`,
  `nextAt`, `byRound` (round → count).
- `placements` (`placement:read`): `total`, `active` (confirmed through ready),
  `joined`, `fellThrough` (backout, BGC failed, joining issue).

The profile's Overview tab shows these as the Metrics card, with submission →
interview, interview clear and submission → selection rates.

## Technologies

The load seed uses the spec list (Java, DE/PY, Python Developer, .NET, DevOps, AI/ML, Networking,
Service Now, Business Analyst, Others, Data Science, PY AI, Salesforce Administrator, Python Full
Stack). Migration 0140 adds any of these that are missing (case-insensitive) to a database that already
holds technologies; a fresh database is left to the seed scripts. ".NET" keeps its existing spelling
(the import mapping targets it).
