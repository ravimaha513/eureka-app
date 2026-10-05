# Training batches, courses and progress: API contract (Phase 3c)

Migration `0065_training.sql`, `apps/api/src/modules/training`, `apps/web/src/training`,
`packages/shared/src/authz/training.ts`. JSON, RFC 9457 problems with the code in `detail`, CSRF header on
writes, `If-Match` (row version) on PATCH. Extends the training batches of migrations 0026/0032
(`eureka.batch`, `candidate.batch_id`) instead of duplicating them: a **student** is a candidate whose
`batch_id` points at the batch. Reference screens: Training Batches cards, batch detail with View Courses /
View Students, per-student, per-course and per-module progress.

## Permissions and grants

| Permission | Granted to (scope) | Why |
|---|---|---|
| `training:read` | Location Incharge, Location Ops Admin (location); Interview Coach (coached); Recruiter (own), Lead (team), Manager and AD (hierarchy), Offshore Manager and CEO (org) | Location roles run training at their location; coaches train; Sales follow the progress of candidates they already own; leadership reads all. |
| `training:manage` | Location Incharge, Location Ops Admin (location) | Course library, batches (create, edit, status, delete), courses of a batch, students. |
| `training.progress:update` | Location Incharge, Location Ops Admin (location); Interview Coach (coached) | Marking modules complete. |

None is restricted (no PII beyond names already visible to these roles). HR, Accounts, Immigration, Documents
Team, BU Head and Org Admin get nothing (least privilege; ask if HR should read progress). Sales leadership keep
planning batches through the 0026 endpoints (`/api/v1/batches`); the training screens' management actions need
`training:manage`.

## Rules

| ID | Rule |
|---|---|
| TR-1 | Batches are created and changed only through definer functions (`authz.create_batch`, `authz.set_batch_status`, `authz.update_batch`, `authz.delete_batch`); the write guard (0032, replaced) lets the definer change status and the details (name, trainer, dates, size, cover; `start_month` follows `start_date`) and delete; location, technology, creator and creation time never change; every update bumps `row_version`. |
| TR-2 | **Batch-level coverage** of a training permission (`authz.training_batch_ids(perm)`, mirrored by `trainingBatchCovered`): an org grant covers every batch, a location grant the batches at its location, a **coached** grant the batches where the user is the **trainer** (`batch.trainer_id`). Own, team and hierarchy grants cover no batch. |
| TR-3 | The Training Batches screen lists batches covered at batch level for `training:read`, plus batches holding at least one candidate the caller owns under `training:read` (own/team/hierarchy, coached teams, location, org; never Open to all teams). Students, their names and their progress are listed in full with batch-level coverage, otherwise only the owned students; `students` on a card counts what the caller may see (`authz.training_batches()`, `authz.training_batch_students()`). Not listed = 404 everywhere in `/training/batches/:id…`. |
| TR-4 | Courses are an org catalog: every `training:read` holder reads every course and module. Each course has an **owning location**; training managers of that location (or org) create, edit, archive, delete and reorder its modules (RLS on `course`/`course_module`). Modules: title ≤ 160, duration 1–10000 minutes, up to 10 `https://` resource links (no spaces or control characters, CHECK in the table). A course used by a batch, or a module with completions, cannot be deleted (409 `course_in_use`, `module_in_use`); archive it instead. Archived courses cannot be newly assigned (422 `course_archived`). Courses of a batch (`batch_course`, ordered) are written by managers covering the batch, only while it is planned or in training (422 `batch_closed`). Unassigning a course keeps its completions (they reappear if it is assigned again). |
| TR-5 | Create: `training:manage` and the location in the caller's scope (403 `location_not_in_scope`); `startDate` sets the 0026 `start_month`; one batch per location, technology and month (409 `batch_exists`). **Display name**: the optional `name`, else `"<technology> <Mon YYYY>"` (`batchDisplayName`). Card status labels: planned = "Not started", in_training = "In training", completed, cancelled. |
| TR-6 | Edit (PATCH, `If-Match: "<rowVersion>"`, 428 without, 412 when stale): name, trainer, start and end date (end ≥ start, 422 `invalid_dates`), planned size, cover colour and icon. The trainer must be an active user holding `training.progress:update` (422 `invalid_trainer`). Status changes as in 0032 (planned → in_training → completed; planned/in_training → cancelled). |
| TR-7 | Delete only while the batch has no students (409 `batch_has_students`: cancel instead). The batch's course list and any progress of former students go with it. Card hint `actions.delete`. |
| TR-8 | Students are added and removed by managers covering the batch (`authz.set_batch_student`). The candidate must be at the batch's location (one answer, 422 `candidate_not_eligible`, also for an unknown id); adding needs an open batch (422 `batch_closed`); adding a candidate from another batch moves them. The candidate column guard lets only this definer path change `batch_id` without `candidate:update`; Sales keep editing `batch_id` on profiles they own. Every change is on the candidate timeline (`candidate.batch_changed`, actor = manager). Removing keeps the student's completions. The add dialog lists candidates at the batch location that the caller can read (`/eligible-students`, max 50). |
| TR-9 | **Progress formula** (`trainingProgress`, weighted by module duration): course % = ⌊100 × Σ minutes of completed modules of the course ÷ Σ minutes of all its modules⌋; overall % = ⌊100 × Σ completed minutes over all assigned courses ÷ Σ minutes of all their modules⌋. Rounded down, so 100 % means every module is done; a course without modules is 0 % and adds nothing; no modules at all is 0 %. Completions of modules of unassigned courses are ignored. |
| TR-10 | Module completion (`authz.set_module_progress`, PUT with `{ completed }`): `training.progress:update` covering the batch at batch level (location roles at their location, the trainer); the candidate is a current student (422 `not_in_batch`), the module belongs to a course assigned to the batch (422 `module_not_in_batch`), the batch is planned or in training (422 `batch_closed`). One row per (batch, student, module) records who marked it and when (server-set); un-ticking deletes it. Idempotent. Rows are readable with batch-level `training:read` coverage or when the candidate is owned under `training:read` (RLS, InitPlan + hashed owned-candidate set, rule 3). |
| TR-11 | Profile card `GET /api/v1/candidates/:id/training`: the candidate must be readable (404) and covered by `training:read` through the candidate (own/team/hierarchy/coached teams/location/org) or its batch (else 403; the web card hides itself on 403/404). Returns the batch, overall % and per-course %. |
| TR-12 | `actions` on batches (`manage`, `delete`, `updateProgress`) and `canEdit`/`canCreate` on courses are UI hints computed by the engine; every write is checked again in the database. |
| TR-13 | Audit (rule 5): ids, codes, counts, dates and changed field names only (`batch.created`, `batch.updated`, `batch.status`, `batch.deleted`, `training.course_created/updated/deleted`, `training.module_created/updated/deleted`, `training.modules_reordered`, `training.batch_course_added/removed`, `training.batch_courses_reordered`, `training.student_added/removed`, `training.progress`). Never titles, descriptions, names or links. No outbox events. |

## Endpoints

All under `/api/v1/training` unless noted.

- `GET /batches?status=&cursor=&limit=` (`training:read`) → `{ items: [BatchCard], nextCursor, canCreate }`, newest start month first.
- `POST /batches` (`training:manage`) `{ locationId, technologyId, startDate, endDate?, name?, trainerId?, sizePlanned?, coverColor?, coverIcon? }` → 201 `{ id }`.
- `GET /batches/:id` (`training:read`) → `BatchCard & { assignedCourses: [{ id, title, description, cover, archived, totalMinutes, modules: [{ id, title, durationMinutes, resources }] }] }`.
- `PATCH /batches/:id` (`training:manage`, `If-Match`) any of `{ name|null, trainerId|null, startDate, endDate|null, sizePlanned|null, coverColor, coverIcon }` → `{ id, rowVersion }`.
- `PUT /batches/:id/status` (`training:manage`) `{ to: in_training|completed|cancelled }`; `DELETE /batches/:id` → 204.
- `POST /batches/:id/courses` `{ courseId }` → 201 (409 `course_already_assigned`, 422 `invalid_course`); `DELETE /batches/:id/courses/:courseId` → 204; `PUT /batches/:id/courses/order` `{ courseIds }` (a permutation, else 422 `invalid_order`). All `training:manage`.
- `GET /batches/:id/students?search=` (`training:read`) → `{ items: [{ candidateId, name, technology, status, percent, completedMinutes, totalMinutes, courses: [{ courseId, percent, completedModules, totalModules }], completions: [{ moduleId, completedAt, completedBy }] }], nextCursor: null }`.
- `GET /batches/:id/eligible-students?search=` (`training:manage`) → `{ items: [{ candidateId, name, technology, status, currentBatch }] }`.
- `POST /batches/:id/students` `{ candidateId }` → 201; `DELETE /batches/:id/students/:candidateId` → 204 (`training:manage`).
- `PUT /batches/:id/students/:candidateId/modules/:moduleId` (`training.progress:update`) `{ completed: boolean }` → `{ moduleId, completed, completedAt, completedBy }`.
- `GET /trainers` (`training:manage`) → `{ items: [{ id, name }] }` (active users who may record progress).
- `GET /courses?includeArchived=true` (`training:read`) → `{ items: [{ id, title, description, cover, archived, location, modules, totalMinutes, batches, rowVersion, canEdit }], nextCursor: null, canCreate }`.
- `POST /courses` (`training:manage`) `{ title, description?, coverColor?, coverIcon?, locationId?, modules?: [{ title, durationMinutes, resources? }] }` → 201 `{ id }`; `locationId` defaults to the caller's only managed location (422 `location_required` otherwise).
- `GET /courses/:id`, `PATCH /courses/:id` (`If-Match`; `{ title, description, coverColor, coverIcon, archived }`), `DELETE /courses/:id`.
- `POST /courses/:id/modules`, `PATCH /courses/:id/modules/:moduleId` (`If-Match`), `DELETE /courses/:id/modules/:moduleId`, `PUT /courses/:id/modules/order` `{ moduleIds }`.
- `GET /api/v1/candidates/:id/training` (`training:read`) → `{ batch: null }` or `{ batch: { id, name, status, startDate, endDate }, percent, completedMinutes, totalMinutes, courses: [{ id, title, percent, completedModules, totalModules }] }`.

`BatchCard` = `{ id, name, customName, status, cover: { color, icon }, location, technology, trainer|null, startMonth, startDate, startDateSet, endDate, batchYear, sizePlanned, students, courses, rowVersion, actions: { manage, delete, updateProgress } }`.

Cover colours: `indigo, teal, amber, rose, violet, sky` (theme tint tokens); icons: `book, code, database, cloud, shield, chart, users, cap`.

## Error codes

`invalid_batch`, `invalid_dates`, `invalid_trainer`, `invalid_transition`, `batch_closed`, `course_archived`,
`candidate_not_eligible`, `not_in_batch`, `module_not_in_batch`, `invalid_course`, `invalid_order`, `location_required` (422);
`batch_exists`, `batch_has_students`, `course_in_use`, `module_in_use`, `course_already_assigned` (409);
`stale` (412), `if_match_required` (428); `location_not_in_scope`, `Not permitted` (403); not found (404).

## Notifications

None. A "batch starts in 7 days" reminder was optional and is not built: the existing producers emit typed
events with recipients resolved by the notification registry (`docs/notifications.md`), and a new type would need
a registry entry, a recipient decision (trainer? location roles?) and a once-only marker. Product question below.

## Dev seed

`apps/api/src/db/dev-training.ts` (local only): four fictional courses owned by Dallas, a Dallas Java batch in
training with the fixture coach as trainer, four fixture students and some progress, all written through the app
role as `locD` and `coach`.

## Open product questions

- Course ownership: built as an org catalog edited by the owning location's managers. Should courses be editable
  by any training manager, or by a central role (no org-wide `training:manage` holder exists)?
- May the trainer (coach) also add/remove students or assign courses? Built: no (`training:manage` only).
- Should HR / Associate HR read training progress? Built: no.
- Is a candidate allowed in more than one batch (e.g. a second technology)? Built: one batch per candidate (0026 column).
- Recording progress in completed batches (corrections): built as refused (`batch_closed`).
- Eligible students: any status at the batch location; should placed/terminated candidates be excluded?
- Batch-start reminder (7 days before): wanted, and for whom?
