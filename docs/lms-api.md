# LMS (Training) API contract

Source: PopulousHR reference screens (Trainings, Courses, batch detail, student progress, My Training).
This is the contract the DB/API work and the web work are both built against. If you must change it, edit this
file in the same commit and say so in your report.

Everything else in the reference deck (jobs, applicants, applications, chat, DataHub, companies, facilities,
dashboards, auth, settings) is out of scope: other tracks own it. Eureka's existing `eureka.batch` (candidate
sales cohorts) is unrelated; LMS tables are all prefixed `lms_` and the API uses "training batch".

## Model (migration 0054, schema `eureka`)

| Table | Columns / rules |
|---|---|
| `lms_course` | id, title (1..160), description (<=2000), created_by, created_at, archived_at. |
| `lms_module` | id, course_id, position (unique per course), title, duration_minutes (0..6000). Ordered lessons of a course. |
| `lms_batch` | id, name (1..120), year (int), start_date, end_date (>= start), status (`not_started`/`in_progress`/`completed`, derived from dates and progress at read time, not stored), created_by, created_at, archived_at. |
| `lms_batch_course` | batch_id, course_id (PK pair), position. Courses assigned to a batch. |
| `lms_enrollment` | batch_id, user_id (PK pair), enrolled_at. Students of a batch (any active `app_user`). |
| `lms_module_progress` | batch_id, user_id, module_id (PK triple), percent (0..100), completed_at, updated_at. Only rows for enrolled students and modules of courses assigned to that batch. |

Derived at read time: module percent (0 when no row), course percent (duration-weighted mean over modules; plain mean if
all durations are 0; 0 for a course without modules), student percent (mean of course percents), batch counts
(students, courses, total hours).

## Permissions (catalog, `packages/shared/src/authz/catalog.ts`)

- `lms:manage`: create/edit/archive courses, modules, batches; assign courses; enroll or remove students; see every
  student's progress. Granted at org scope to `hr`, `associate_hr`, `interview_coach` (the trainer role).
- `lms:learn`: see own enrollments and update own module progress. Granted at `own` scope to every role except `org_admin` (which holds no data permissions, HANDOFF rule 7).
- Staff with `lms:manage` can also read everything. A learner can never see another learner's progress or a batch
  they are not enrolled in (404, not 403: read-before-write rule).
- Writes to `lms_*` only through SECURITY DEFINER functions that re-check permission in the database; app role has
  SELECT only under RLS. Follow every rule in `docs/HANDOFF.md` ("Rules the reviews kept enforcing"). Audit events
  carry ids and counts only (rule 5).

## Endpoints (all under `/api/v1/lms`, session + CSRF like the rest)

Staff (`lms:manage`):

| Method and path | Body / query | Result |
|---|---|---|
| `GET /courses?q=&archived=` | | `{items:[{id,title,description,moduleCount,totalMinutes,archivedAt,version}]}` (`version` feeds the PATCH `If-Match`; web sends it when present) |
| `POST /courses` | `{title,description?}` | 201 course |
| `GET /courses/:id` | | course + `modules:[{id,position,title,durationMinutes}]` |
| `PATCH /courses/:id` | `{title?,description?,archived?}` + `If-Match` version | course |
| `PUT /courses/:id/modules` | `{modules:[{id?,title,durationMinutes}]}` (full ordered list; ids kept, others created/removed) | course |
| `GET /batches?status=&q=` | | `{items:[{id,name,year,startDate,endDate,status,studentCount,courseCount,createdByName}]}` |
| `POST /batches` | `{name,startDate,endDate,year?}` | 201 batch |
| `GET /batches/:id` | | batch + `courses:[{id,title,moduleCount,totalMinutes}]` (summary header numbers) |
| `PATCH /batches/:id` | `{name?,startDate?,endDate?,archived?}` | batch |
| `DELETE /batches/:id` | | 204; only a batch with no progress rows, else 409 `batch_has_progress` (archive instead) |
| `PUT /batches/:id/courses` | `{courseIds:[uuid]}` (full set, ordered) | batch |
| `GET /batches/:id/students?q=` | | `{items:[{userId,name,email,percent,courses:[{courseId,title,percent,modules:[{moduleId,title,durationMinutes,percent}]}]}]}` |
| `POST /batches/:id/students` | `{userIds:[uuid]}` (max 100) | 200 `{added:n}` |
| `DELETE /batches/:id/students/:userId` | | 204 |
| `PUT /batches/:id/students/:userId/progress/:moduleId` | `{percent}` | progress row (staff override) |
| `GET /students/lookup?q=` | | `{items:[{userId,name,email}]}` active users, for the Add Student picker (name/email only, max 20) |

Learner (`lms:learn`, own rows only):

| Method and path | Result |
|---|---|
| `GET /me/trainings` | `{items:[{batchId,name,startDate,endDate,status,percent,courseCount}]}` |
| `GET /me/trainings/:batchId` | batch header + `courses:[{...,percent,modules:[{moduleId,title,durationMinutes,percent,completedAt}]}]` |
| `PUT /me/trainings/:batchId/progress/:moduleId` | body `{percent}`; sets own progress; 100 stamps `completedAt`; lowering allowed |

Errors: 422 validation (zod; the repo-wide mapping, 400 only for a malformed uuid in the path), 404 not visible / unknown, 403 visible but not allowed, 409 conflict, 422 domain
(`student_not_found`, `course_not_in_batch`, `course_archived`). Lists are capped (default 25, max 100) with
`limit` and keyset `cursor` where they can exceed 100 rows (students, courses, batches).

## Web (apps/web/src/lms, nav in `nav.ts`)

- Nav section "Training": **Trainings** (`lms:manage`), **Courses** (`lms:manage`), **My Training** (`lms:learn`;
  hide it for users who hold `lms:manage` only if that is how the existing nav treats overlap, otherwise show both).
- Trainings: card grid of batches (placeholder gradient cover, status chip, students, courses, date range, open arrow),
  status filter, "Add Training Batch" dialog, archive/delete.
- Batch detail: breadcrumb, header stats (students, courses, start date, batch year), edit; tabs **View Courses**
  (assigned courses, expandable module list, Add Course picker, remove) and **View Students** (search, progress bar
  per student, expandable per course then per module bars, Add Student picker with lookup, remove).
- Courses: list + create/edit drawer with ordered modules (title, minutes, reorder, remove).
- My Training: list of own batches with progress, detail with per-module progress controls (mark complete / set percent).
- Match the existing shell (`shell/ui.tsx`, dark mode, focus-after-failure in new forms, styles.css tokens).

## As built (migration 0054, `apps/api/src/modules/lms`) - differences and additions

- Validation errors are 422 (ProblemFilter maps zod to 422 everywhere), not 400. Problem `detail` carries the stable code.
- Extra codes: 422 `course_not_found` (unknown id in `courseIds`), `invalid_module` (module id not of this course),
  `invalid_input`; 409 `course_has_progress` (removing a course from a batch that has progress: archive instead);
  412 stale / 428 missing `If-Match` on PATCH /courses/:id. Removing a student deletes their progress; removing a module
  (PUT modules) deletes its progress. Archived courses cannot get modules and cannot be newly assigned.
- Courses carry `version` (list item, detail, and every course response); `If-Match: "<version>"` is required on PATCH and
  optional on PUT modules (when sent it must match). Every course write bumps it.
- Course detail/list items also have `version`; batches add `totalMinutes`, accept `year` and `archived` (list query
  `archived=true|false`, default hides archived); batch detail courses also carry `modules:[{id,position,title,durationMinutes}]`.
- Lists use keyset `nextCursor` (opaque string, pass back as `cursor`; `limit` default 25, max 100) for courses, batches and students.
- Percentages are rounded to integers at each level (computed from unrounded values). Batch status: staff views derive
  `not_started` (today < start), `completed` (today > end, or every student finished every module with at least one student and
  module), else `in_progress`. `/me/trainings` derives it from dates and the caller's own progress (learners cannot see others').
- `/me/trainings` hides archived batches; learner progress writes in an archived batch are 404 (staff override still works).
- Org admin and any role without `lms:learn` get 403 on `/me/*`.
