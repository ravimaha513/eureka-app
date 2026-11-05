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
| PW-6 | One BGC record per placement (design B2.4 columns), created on the first write as `not_started`. Writes need `bgc:update` over the placement (HR and CEO org-wide; Manager and AD in their hierarchy); holders of `placement.bgc_status:update` without it may only set `status: initiated` (with `reason` when re-initiating), offered as "Mark BGC initiated" in the placement drawer's Status row. `completed_on` is server-set when the check clears or fails and `helped_by` is retired; neither is exposed by the API. The drawer saves `notes` in place in its Notes block. |
| PW-7 | BGC states: `not_started → initiated → in_progress → cleared | failed`, `initiated → cleared | failed`, `cleared → failed` after the fact (FR-PLC-06), and `cleared → initiated` to re-open it (the vendor asks for more documents, also after joining; needs a reason, resets `initiatedOn` to today and clears `completedOn` unless given; the placement and assignment are untouched). `failed` is final and needs a reason. `authz.update_bgc` now lives in `db/functions/authz/update_bgc.sql`. Moving to `initiated` defaults `initiatedOn` to today, `cleared`/`failed` default `completedOn`. Moving to `cleared` needs `actualStart` (the placement's actual start date, migration 0450) unless the placement already has one (`actual_start_required`); it stays editable while cleared, can't be emptied, is kept on re-initiation, and is rejected on any other status (`invalid_change`). |
| PW-8 | BGC status never changes the placement by itself. `failPlacement: true` (with the record ending `failed`) also moves the placement to `bgc_failed` in the same transaction **by calling `authz.transition_placement`**, which applies the placement rules unchanged (`placement:update` + `placement.bgc_status:update`, allowed states, reason, candidate/assignment side effects, outbox). The placement records the fixed reason "Background check failed (see the BGC record)"; the BGC's own free-text reason stays on the BGC record, readable only under `document:read` (0053). Today no single role holds both rights, so HR records the result and a Manager/AD marks the placement (open question). Placement transitions do not require a BGC record (no gating; open question). |
| PW-9 | Writes go only through definer functions (`authz.update_checklist_item`, `authz.update_bgc`) that re-check visibility (404), permission (403) and the state machine (422). The server sets status timestamps, who changed it, `version` and the snapshots; every change writes a history row (`checklist_item_event`, `bgc_event`). `expectedVersion` (optional) refuses lost updates with 409 `version_mismatch`. |
| PW-10 | Templates are versioned: publishing appends version n+1 of (kind, placement type); versions are immutable; a placement copies the latest paperwork version of its type at creation and keeps it (`templateVersion`). Read with `document:read` at org scope, publish with `document:verify` at org scope (HR, Immigration, Documents Team; open question). No template content ships. |
| PW-11 | Audit (rule 5): field names, statuses, role keys, ids and dates only; never notes, reasons, the BGC company or education text. |
| PW-12 | Employment and address history are rows (`eureka.bgc_entry`, migration 0460): one per employer or address, with whole months (`YYYY-MM`, no end = still there), `verification` (`pending`/`verified`/`unverified`) and optional notes. Read under the check's `document:read` scope; written with `bgc:update` through `authz.save_bgc_entry` / `authz.delete_bgc_entry`; up to 50 rows per kind; nothing changes on a backed-out placement. Personal data: the audit (`bgc.entry.create`/`.update`/`.delete`) and `bgc_event` (`employment_history`/`address_history`) carry the row id, kind and changed field names only. |

Concurrency vocabulary (audit B-03, migration 0478 review): paperwork items, the BGC, BGC history rows (PATCH and `DELETE ?expectedVersion=`) and document metadata edits take the version **in the body** (`expectedVersion`), and every definer function enforces it when sent (`IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM <row>.version` after `FOR UPDATE`; covered by API tests). A mismatch stays **409 `version_mismatch`** here. Newer routes (jobs, facilities, interviews, employment) use the `If-Match: "<rowVersion>"` header with **412 `stale`** (428 where required). The difference is deliberate for now: changing these status codes would break existing clients. Omitting the version keeps last-write-wins on both styles.

## Endpoints

- `GET /api/v1/paperwork?view=outstanding|overdue|all&ownerRole=&mine=true&bgcStatus=&placementStatus=&placementType=&cursor=&limit=` (`document:read`)
  returns `{ items: [QueueRow], nextCursor }`, ordered by the soonest open due date. `outstanding` (default): open items, or a
  BGC not finished on an open placement. `ownerRole`/`mine` count only matching items and drop placements without any.
- `GET /api/v1/paperwork/placements/:id` (`document:read`) returns `QueueRow & { items: [Item], bgc: Bgc }`; 404 outside the scope.
- `PATCH /api/v1/paperwork/items/:id` (`document:upload`) with any of
  `{ status, reason, ownerRole, assigneeId|null, dueOn|null, notes|null, documentId|null, expectedVersion }` returns `Item`.
- `GET /api/v1/paperwork/items/:id/history` (`document:read`) returns `{ items: [{ at, actor, from, to, changed, details, reason }] }`.
- `PATCH /api/v1/paperwork/placements/:id/bgc` (`bgc:update`, or `placement.bgc_status:update` for `status: initiated` only) with any of
  `{ status, reason, bgcCompany, initiatedOn, actualStart, educationLevel, employmentYears, addressYears, notes, failPlacement, expectedVersion }` returns `Bgc`.
- `POST /api/v1/paperwork/placements/:id/bgc/entries` (`bgc:update`) with `{ kind: "employment", employer, title?, startMonth, endMonth?, verification?, notes? }`
  or `{ kind: "address", street?, city, region?, postalCode?, country, startMonth, endMonth?, verification?, notes? }` returns 201 `Bgc`.
- `PATCH /api/v1/paperwork/placements/:id/bgc/entries/:entryId` (`bgc:update`) with any fields of that row's kind plus `expectedVersion` returns `Bgc`;
  a field of the other kind is 422 `invalid_change`.
- `DELETE /api/v1/paperwork/placements/:id/bgc/entries/:entryId?expectedVersion=` (`bgc:update`) returns `Bgc`.
- `GET /api/v1/paperwork/templates` (`document:read` at org scope) returns `{ canPublish, templates: [{ kind, placementType, version, publishedAt, publishedBy, items: [{ docType, ownerRole, required }] }] }`.
- `POST /api/v1/paperwork/templates` (`document:verify` at org scope) with `{ kind, placementType, items, expectedVersion }` returns 201 `{ kind, placementType, version }`.

`QueueRow` = `{ placementId, candidate: {id,name}, recruiter: {id,name}, placement: { status, placementType, tentativeStart, actualStart|null, client } | null, checklist: { total, open, requiredOpen, overdue, nextDue }, bgc: { status } }`

`Item` = `{ id, docType, ownerRole, required, status, statusReason, statusChangedAt, assignee: {id,name}|null, dueOn, overdue, notes, documentId, version, templateVersion, actions: { transition, editNotes, assign } }`

`Bgc` = `{ status, bgcCompany, initiatedOn, educationLevel, employmentYears, addressYears, employment: [Entry], addresses: [Entry], notes, statusReason, statusChangedAt, version|null, history, actions: { update, transition, failPlacement } }`

`Entry` = `{ id, kind, employer, title, street, city, region, postalCode, country, startMonth, endMonth|null, verification, notes, version }`, newest first (current rows on top).

`GET /api/v1/placements/:id` adds to each checklist entry `{ id, dueOn, overdue }` and, where `document:read` covers the placement, `bgc: { status, actions: { transition } }` (key omitted otherwise).

## Error codes

`invalid_transition`, `reason_required`, `invalid_change`, `invalid_assignee`, `invalid_owner_role`, `invalid_due_date`,
`invalid_helper`, `invalid_document`, `placement_closed` (backed-out placement: `PAPERWORK_LOCKED_PLACEMENT_STATUSES` in `packages/shared` state-machines.ts, mirrored by the definers' `pl.status = 'backout'`; parity in `test/state-machine-parity.db.int.test.ts`), `invalid_checklist_template`, `too_many_entries` (422); `version_mismatch` (409);
`not_permitted` (403); not found (404, also `entry_not_found`). With `failPlacement`, the placement codes of `authz.transition_placement` apply too.

## Dev seed

`apps/api/src/db/dev-pipeline.ts` (local development only) publishes fictional sample templates (`sample_form_a` …) as the
dev HR user and records some progress. Nothing else ships template content.

## Overdue reminder (migration 0052)

The worker job `paperwork-overdue` (daily, 07:30 America/New_York) calls `authz.emit_paperwork_overdue(day)`, which emits
`checklist.item_overdue` for each `pending`/`received` item whose `due_on` is before the day, on a placement that was not
backed out, exactly once per item and due date (`eureka.notification_ledger`); changing the due date re-arms it.
Payload `{ checklistItemId, placementId, daysOverdue, assigneeId? }`; recipients and rendering are in `docs/notifications.md`
(recruiter, team lead, the lead's manager, and the assignee when they hold `documents_team`). No names, document types,
dates or notes reach the email or inbox.


Follow-up (review of 0044, not fixed): `checklist_item.document_id` is in the app role's column grant, so a `placement:read` holder without `document:read` could select the id (only the id; the document row, its type and download stay refused by `document_read` RLS). No API returns it to them. Moving it behind `authz.checklist_item_texts` would close it.

### BGC history years (migrations 0160, 0400)

`employmentYears` and `addressYears` take a whole number of years, **1-50** (or `null`), in the API schema
(`BGC_HISTORY_YEARS_MIN` / `_MAX` in `@eureka/shared`) and as table CHECKs; anything else is 422 (`invalid_change` from the
database). The web form has typed number inputs with a "years" unit. From 0160 to 0400 only 3, 5, 7 or 10 were accepted
(earlier 0-50 values were rounded up then); 0400 widened the CHECKs without rewriting any row.

Since 0460 the rows (PW-12) replace these numbers for new checks; the web page shows the years read-only while a check has no
rows of that kind, and no longer edits them. The API still accepts them.

## Web: the paperwork page

The candidate name in the work queue (and its Open button) opens `/paperwork/<placementId>`, which replaced the drawer: tabs for
Documents (upload, view, download, and edit: title, type, replacement file; docs/documents-api.md), Checklist (item updates and history), Background check (status with a progress bar,
check details, employment and address rows with a coverage bar and gap warnings, notes) and Activity (the check's history),
plus a summary rail with "Needs attention" links. The tab is kept in `?tab=`.
