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
`{ ids, priority }` runs `PATCH /candidates/:id { priority }` per record, like the other bulk actions.

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

`team_assigned_at` is server-managed: set on insert and whenever `team_id` changes, refused from any
client (`candidate_profile_guard`), backfilled from the last assignment events.

**Marketing status values** ("Active/Remote", "Active/All Teams", "N/A") are a derived label
(`marketingStatusLabel`), not new statuses: "All Teams" mirrors `visibility`, "Remote" mirrors the stay,
"N/A" is a candidate still in training. The status machine and every access rule are unchanged.

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

## Technologies

The load seed uses the spec list (Java, DE/PY, Python Developer, .NET, DevOps, AI/ML, Networking,
Service Now, Business Analyst, Others, Data Science, PY AI, Salesforce Administrator, Python Full
Stack). Migration 0140 adds any of these that are missing (case-insensitive) to a database that already
holds technologies; a fresh database is left to the seed scripts. ".NET" keeps its existing spelling
(the import mapping targets it).
