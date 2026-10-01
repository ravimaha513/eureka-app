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
- `GET /api/v1/placements/:id` returns `Placement` including `contacts` and `assignment` (if any).
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
