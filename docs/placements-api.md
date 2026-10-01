# Placements, lookups and per-record actions: API contract (Phase 2)

Shared by the backend (`apps/api`) and web (`apps/web`) builders. JSON, RFC 9457
problems with the code in `detail`, CSRF header on writes, cursor pagination
like `/submissions`. Design references: B2.2 (`placement`, `placement_contact`,
`assignment`), B2.6 (placement state machine), B3, B4 (grants), FR-PLC-01..07.

## Rules

| ID | Rule |
|---|---|
| PL-1 | A placement is created from a **selected** submission the caller can update (`placement:create` scope via the submission's actor snapshot, like interviews). One active placement per submission. |
| PL-2 | Snapshots (candidate, recruiter, team, location, client, vendor) are set by the database from the submission; the client never sends them. |
| PL-3 | `is_first_placement` is computed by the database (no earlier placement for the person that reached `joined` or is not `backout`); never client-set. |
| PL-4 | States: `confirmed → paperwork → bgc → ready → joined`; `backout` from any state before `joined`; `bgc_failed` from any state including `joined` (needs `placement.bgc_status:update`). Forward steps cannot be skipped. All changes go through a definer function (NULL-safe). |
| PL-5 | Side effects in the same transaction: creating a placement moves the candidate to `confirmation`; `joined` moves it to `placed` and opens an `assignment` (assignment_no = next per person); `backout` or `bgc_failed` before joining moves it back to `active`; `bgc_failed` after `joined` ends the open assignment (end_reason `bgc_failed`) and moves the candidate to `bench`. |
| PL-6 | `rate` is returned only when `rate:read` covers the placement's actor snapshot (same rule as submissions). Rates and contact emails/phones are never written to the audit log. |
| PL-7 | Notifications to HR, Accounts and Immigration are recorded as `outbox_event` rows (type `placement.created`, `placement.state_changed`) in the same transaction; delivery is a later worker job. |
| PL-8 | `Idempotency-Key` header is required on `POST /placements` (design B3); a repeat with the same key and body returns the first response. |
| PL-9 | Every write is audited. |

## Endpoints

- `GET /api/v1/placements?status=&candidateId=&recruiterId=&from=&to=&cursor=&limit=` (`placement:read`) returns
  `{ items: [Placement], nextCursor }`
- `GET /api/v1/placements/:id` returns `Placement` including `contacts` and, where the caller holds `assignment:read` on it, `assignment`.
- `POST /api/v1/placements` (`placement:create`, header `Idempotency-Key`) with
  `{ submissionId, placementType: "c2c"|"w2"|"1099", rate?, workMode: "onsite"|"remote"|"hybrid", projectCity?, projectState?, tentativeStart: "YYYY-MM-DD", implementationPartnerId?, contacts?: [{ kind: "vendor_poc"|"invoicing_poc"|"client_manager", name, email?, phone? }] }`
  returns 201 `{ id, isFirstPlacement }`.
- `PATCH /api/v1/placements/:id/status` with `{ to, reason? }` (`placement:update`; `bgc_failed` needs `placement.bgc_status:update`) returns `{ id, status }`.

`Placement` = `{ id, status, placementType, workMode, projectCity, projectState, tentativeStart, isFirstPlacement, rate?, candidate: {id,name}, recruiter: {id,name}, team: {id,name}, location: {id,name}, client: {id,name}, vendor: {id,name}|null, submissionId, createdAt, statusChangedAt, allowedTransitions: string[], contacts?: [...], assignment?: { assignmentNo, startDate, endDate, endReason } }`

### Lookups (for pickers; replace raw-ID inputs)
- `GET /api/v1/lookups` (any signed-in user) returns
  `{ technologies: [{id,name}], clients: [{id,name}], vendors: [{id,name}], locations: [{id,name}], coaches: [{id,name}] }` (active rows only; coaches = active users holding `interview_coach`).

### Per-record allowed actions
To stop the UI offering actions the server will refuse, read endpoints include what the caller may do on that record:
- `GET /api/v1/candidates/:id` adds `actions: { edit, transition: string[], visibility, rating, logSubmission }` (booleans, and the allowed target statuses).
- Submission items add `actions: { transition: string[], createInterview, createPlacement }`.
- Placement items carry `allowedTransitions`.
These are hints computed by the engine; the server still enforces every rule.

## Error codes
`submission_not_selected`, `placement_exists`, `invalid_transition`, `reason_required`, `idempotency_key_required`, `idempotency_key_reused` (same key, different body), `not_permitted`, plus the existing validation errors.

## Implementation notes (backend, 2026-09-30)

Built in migration `0022_placements.sql`, `apps/api/src/modules/placements`, `apps/api/src/modules/lookups`,
and `packages/shared/src/authz/{state-machines,actions}.ts`. Deviations and precisions:

- **PL-1 authorization.** Creating needs `placement:create` **and** `submission:update` on the submission's
  actor snapshot (like interviews), and the candidate must be visible for `placement:create` (the
  Open-to-all-teams rule applies, as for `submission:create`). Order of checks: 404 submission not visible,
  403 not placeable, 422 `submission_not_selected`, 409 `placement_exists`, 422 `candidate_not_available`,
  403 candidate no longer visible.
- **Candidate status at creation.** The candidate must be `active` or `full_of_interviews`
  (new code `candidate_not_available`, 422). A candidate moved to `confirmation` by hand must be moved back
  to `active` first. `full_of_interviews → confirmation` is a new edge, used only by placements.
- **Open placement locks the candidate.** While a placement is `confirmed`..`ready`, manual candidate
  transitions are refused with 422 `placement_open`, and `actions.transition` is `[]`.
- **Reasons.** `reason` is required (non-blank) for `backout` and `bgc_failed` (`reason_required`), optional
  otherwise, max 500 characters; stored on the placement, never in the audit (only `reasonGiven: true`).
- **`bgc_failed`** needs `placement:update` and `placement.bgc_status:update` (Manager, AD).
- **Side effects of backing out** move the candidate to `active` only if it is still in `confirmation`; a
  candidate terminated meanwhile stays terminated. `joined` requires the candidate in `confirmation`.
- **Assignment** `startDate` is the day the placement is marked `joined` (not `tentativeStart`);
  `assignmentNo` is the next number per person.
- **Assignment visibility** follows `assignment:read`, not `placement:read`: the `assignment` key is present
  only when `assignment:read` covers the placement's actor snapshot (recruiter, team, location) or its
  candidate, and omitted otherwise (e.g. Location Ops Admin). The database policy (migration 0023) also
  requires the placement itself to be visible, so Immigration (`assignment:read` without `placement:read`)
  sees no assignments.
- **Audit.** `placement.status` records the `from` status read under the row lock by
  `authz.transition_placement` (which returns `from_status, to_status, candidate_from, candidate_to`), never
  the API's earlier read. Candidate status changes caused by a placement (creation → `confirmation`,
  `joined` → `placed`, backout/`bgc_failed` → `active`, `bgc_failed` after joining → `bench`) are audited as
  `candidate.transition` on the candidate, `{ from, to, via: "placement" }`; none is written when the
  candidate did not move (e.g. terminated meanwhile).
- **Idempotency-Key**: printable ASCII, 1–200 characters. Missing or malformed → **400**
  `idempotency_key_required`. Keys are per user and endpoint; the body hash ignores key order. A repeat
  returns the same 201 body; a failed request (any 4xx) does not consume the key.
- **Extra fields** (additive): `Placement.implementationPartner: {id,name}|null`; `team` and `location` may
  be `null` (the actor had no team); `candidate.name` is `null` when the caller cannot read the candidate's
  person row; `assignment` is `null` (not omitted) before joining when the caller may read it. Lookups add
  `implementationPartners: [{id,name}]` (new reference table `implementation_partner`).
- **List filters** `from`/`to` apply to `createdAt`; order is `createdAt` descending.
- **Validation** (422): `rate` > 0 and ≤ 1000 with two decimals (hourly, same bound as submissions);
  `projectCity` ≤ 80 characters; `projectState` 2–40 letters (name or code); `tentativeStart` between
  2000-01-01 and 2100-12-31; up to 10 contacts, contact `name` ≤ 120, `email` valid ≤ 254, `phone` E.164.
  The same limits are table CHECKs.
- **Outbox** rows hold ids, states and the recipient groups only; no worker reads them yet.

### Lookups visibility (least privilege)
`GET /api/v1/lookups` accepts any signed-in user and always returns all six keys, but their content depends on permissions: `technologies` and `locations` for everyone; `coaches` only with `interview:create` or `interview:update`; `clients`, `vendors` and `implementationPartners` only with `submission:read`, `submission:create` or `placement:read`. Withheld lists are `[]` (not missing, not 403); the web pickers then offer a paste-an-ID input, and the server validates every ID on write.
