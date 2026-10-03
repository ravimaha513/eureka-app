# Paperwork checklists, BGC and templates: API contract (Phase 3)

Migration `0044_paperwork_bgc.sql`, `apps/api/src/modules/paperwork`, `apps/web/src/paperwork`,
`packages/shared/src/authz/{state-machines,actions}.ts`. JSON, RFC 9457 problems with the code in
`detail`, CSRF header on writes. Design references: B2.4 (`checklist_template`, `checklist_item`,
`bgc`), B2.6 (placement state machine), B4.4 ("Documents, BGC, work authorization"), FR-BGC-01..03,
FR-PLC-06, implementation plan Phase 3 "Paperwork and onboarding checklists per placement type".

## Rules

| ID | Rule |
|---|---|
| PW-1 | Paperwork and BGC are visible with `document:read` over the placement's actor snapshot (recruiter, team, location) or its owned candidate (never the Open-to-all-teams rule). Items stay readable wherever the placement is (0035), so the placement drawer shows progress to every `placement:read` holder; notes, reasons, history and BGC details need `document:read` (the app role has no column privilege on item notes and reasons; it reads them through `authz.checklist_item_texts`, which checks document:read). Immigration and the Documents Team (no `placement:read`) see the paperwork but not the placement record (`placement: null`). |
| PW-2 | Item states: `pending → received → verified`; `pending`/`received → waived`; `received → pending` (returned), `verified`/`waived → pending` (reopened). Waiving, returning and reopening need a reason (≤ 500). |
| PW-3 | Receiving, notes and the document link need `document:upload` or `document:verify` over the placement; every other status change, the owner role, the assignee and the due date need `document:verify`. |
| PW-4 | The assignee is an active user who currently holds the item's owner role (re-checked when the owner role changes). The due date is between 2000-01-01 and 2100-12-31; an item is overdue when it is `pending`/`received` and past its due date. |
| PW-5 | `document_id` references `eureka.document` (0043). A link is accepted only for a document of the item's candidate, filed on no placement or on this placement, whose file is `pending` or `clean`, and that the caller can read (candidate readable, `document:read` over it, `document.restricted:read` for restricted documents); otherwise 422 `invalid_document`, the same answer for every case. `null` unlinks. |
| PW-6 | One BGC record per placement (design B2.4 columns), created on the first write as `not_started`. Writes need `bgc:update` over the placement (HR). |
| PW-7 | BGC states: `not_started → initiated → in_progress → cleared | failed`, `initiated → cleared | failed`, and `cleared → failed` after the fact (FR-PLC-06). `failed` is final and needs a reason. Moving to `initiated` defaults `initiatedOn` to today, `cleared`/`failed` default `completedOn`. |
| PW-8 | BGC status never changes the placement by itself. `failPlacement: true` (with the record ending `failed`) also moves the placement to `bgc_failed` in the same transaction **by calling `authz.transition_placement`**, which applies the placement rules unchanged (`placement:update` + `placement.bgc_status:update`, allowed states, reason, candidate/assignment side effects, outbox). Today no single role holds both rights, so HR records the result and a Manager/AD marks the placement (open question). Placement transitions do not require a BGC record (no gating; open question). |
| PW-9 | Writes go only through definer functions (`authz.update_checklist_item`, `authz.update_bgc`) that re-check visibility (404), permission (403) and the state machine (422). The server sets status timestamps, who changed it, `version` and the snapshots; every change writes a history row (`checklist_item_event`, `bgc_event`). `expectedVersion` (optional) refuses lost updates with 409 `version_mismatch`. |
| PW-10 | Templates are versioned: publishing appends version n+1 of (kind, placement type); versions are immutable; a placement copies the latest paperwork version of its type at creation and keeps it (`templateVersion`). Read with `document:read` at org scope, publish with `document:verify` at org scope (HR, Immigration, Documents Team; open question). No template content ships. |
| PW-11 | Audit (rule 5): field names, statuses, role keys, ids and dates only; never notes, reasons, the BGC company or education text. |

## Endpoints

- `GET /api/v1/paperwork?view=outstanding|overdue|all&ownerRole=&mine=true&bgcStatus=&placementStatus=&placementType=&cursor=&limit=` (`document:read`)
  returns `{ items: [QueueRow], nextCursor }`, ordered by the soonest open due date. `outstanding` (default): open items, or a
  BGC not finished on an open placement. `ownerRole`/`mine` count only matching items and drop placements without any.
- `GET /api/v1/paperwork/placements/:id` (`document:read`) returns `QueueRow & { items: [Item], bgc: Bgc }`; 404 outside the scope.
- `PATCH /api/v1/paperwork/items/:id` (`document:upload`) with any of
  `{ status, reason, ownerRole, assigneeId|null, dueOn|null, notes|null, documentId|null, expectedVersion }` returns `Item`.
- `GET /api/v1/paperwork/items/:id/history` (`document:read`) returns `{ items: [{ at, actor, from, to, changed, details, reason }] }`.
- `PATCH /api/v1/paperwork/placements/:id/bgc` (`bgc:update`) with any of
  `{ status, reason, bgcCompany, initiatedOn, completedOn, helpedBy, educationLevel, employmentYears, addressYears, notes, failPlacement, expectedVersion }` returns `Bgc`.
- `GET /api/v1/paperwork/templates` (`document:read` at org scope) returns `{ canPublish, templates: [{ kind, placementType, version, publishedAt, publishedBy, items: [{ docType, ownerRole, required }] }] }`.
- `POST /api/v1/paperwork/templates` (`document:verify` at org scope) with `{ kind, placementType, items, expectedVersion }` returns 201 `{ kind, placementType, version }`.

`QueueRow` = `{ placementId, candidate: {id,name}, recruiter: {id,name}, placement: { status, placementType, tentativeStart, client } | null, checklist: { total, open, requiredOpen, overdue, nextDue }, bgc: { status } }`

`Item` = `{ id, docType, ownerRole, required, status, statusReason, statusChangedAt, assignee: {id,name}|null, dueOn, overdue, notes, documentId, version, templateVersion, actions: { transition, editNotes, assign } }`

`Bgc` = `{ status, bgcCompany, initiatedOn, completedOn, helpedBy, educationLevel, employmentYears, addressYears, notes, statusReason, statusChangedAt, version|null, history, actions: { update, transition, failPlacement } }`

`GET /api/v1/placements/:id` adds to each checklist entry `{ id, dueOn, overdue }` and, where `document:read` covers the placement, `bgc: { status }` (key omitted otherwise).

## Error codes

`invalid_transition`, `reason_required`, `invalid_change`, `invalid_assignee`, `invalid_owner_role`, `invalid_due_date`,
`invalid_helper`, `invalid_document`, `placement_closed` (backed-out placement), `invalid_checklist_template` (422); `version_mismatch` (409);
`not_permitted` (403); not found (404). With `failPlacement`, the placement codes of `authz.transition_placement` apply too.

## Dev seed

`apps/api/src/db/dev-pipeline.ts` (local development only) publishes fictional sample templates (`sample_form_a` …) as the
dev HR user and records some progress. Nothing else ships template content.

## Overdue reminder (migration 0049)

The worker job `paperwork-overdue` (daily, 07:30 America/New_York) calls `authz.emit_paperwork_overdue(day)`, which emits
`checklist.item_overdue` for each `pending`/`received` item whose `due_on` is before the day, on a placement that was not
backed out, exactly once per item and due date (`eureka.notification_ledger`); changing the due date re-arms it.
Payload `{ checklistItemId, placementId, daysOverdue, assigneeId? }`; recipients and rendering are in `docs/notifications.md`
(recruiter, team lead, the lead's manager, and the assignee when they hold `documents_team`). No names, document types,
dates or notes reach the email or inbox.
