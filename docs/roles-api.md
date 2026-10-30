# Roles: custom roles, traits and ladders

Decided 2026-10-30 (no production users yet, so no compatibility constraints):
organisation = business units inside one company; org admins create roles by
cloning, never by editing the built-in ones.

## Model

Three things used to be conflated in a role key; they are now separate columns
on `eureka.role`, and code branches on them instead of on the key:

| Concern | Where | Who edits |
|---|---|---|
| What a role may do, at which scope | `eureka.role_permission` (permission × scope) | admin, custom roles only |
| How the system treats holders (traits) | `role.is_sales`, `is_location_bound`, `is_admin`, `is_recruiter`, `is_coach` | admin, custom roles only |
| Where a role sits (ladder) | `role.track`, `role.level`, `role.department_id` | admin, custom roles only |

- **System roles** (`is_system = true`): the 17 roles of `packages/shared/src/authz/catalog.ts`.
  The migration runner re-seeds their label, traits, ladder position and grants on every
  run, so the catalog stays the single source of truth for them. They cannot be edited,
  archived or deleted; they are templates to clone.
- **Custom roles** (`is_system = false`): created by an org admin from a system role (or
  another custom role). Key `c_<slug>` generated from the label. Grants, traits and ladder
  position are editable while the role is not archived. Archiving needs zero active
  holders; nothing is ever deleted, so audit rows keep resolving.
- **Permissions and scopes stay in code** (`PERMISSIONS`, `SCOPES`): the API and RLS
  policies enforce them, so an admin cannot invent one. `eureka.permission` mirrors the
  catalog (key, area, description, `is_restricted`, `is_org_sensitive`) so the database
  can validate grants and compute `role.is_restricted` itself.
- **Restricted roles** (two-person approval when granted, AD-3) are computed, not declared:
  a role is restricted when `is_admin`, or when it holds a restricted permission, or an
  org-sensitive permission at `org` scope. A trigger on `role_permission` keeps
  `role.is_restricted` current, so a custom role that drifts into sensitive territory is
  approved like a built-in one.
- **Business units** are departments (`eureka.department`, AD-12). A role with
  `department_id` can only be granted to users in that department or its
  sub-departments (`role_department_mismatch`); `null` = whole organisation. Scope is
  still role + reporting line, departments never widen access.
- **Ladders**: `track` (free text, e.g. `sales`, `interview_prep`, `operations`) and
  `level` (1 = bottom) order roles for the admin UI and the promotion action; they grant
  nothing. The reporting hierarchy itself (`reporting_line`, `team.lead_id`) stays the
  place where "who sees whom" is defined.

## Traits replacing role-name checks

| Old check | Now |
|---|---|
| `role_key = 'org_admin'` (separation of duties, last-admin guard, deactivation) | `role.is_admin` |
| `role_key = 'recruiter'` (candidate owner defaults, team membership eligibility) | `role.is_recruiter` |
| `role_key IN ('interview_coach','interview_lead')` (coach assignment, trainer guard) | `role.is_coach` |
| `SALES_ROLES.includes(role)` (all-teams rule, jobs, performance subjects) | `role.is_sales` |
| `LOCATION_ROLES.includes(role)` | `role.is_location_bound` |
| Notification recipient role lists (`ARRAY['hr','accounts',…]`) | `notify.<topic>:receive` permissions at `org` scope (table below) |

Notification permissions (`authz.notification_recipients` resolves holders of the
permission for the event's topic; `apps/api/src/worker/notify-types.ts` payload audience
tags are unchanged):

| Permission | Events | System holders |
|---|---|---|
| `notify.placement_hr:receive` | placement.created/state_changed with `notify` ∋ hr | hr |
| `notify.placement_accounts:receive` | … ∋ accounts | accounts |
| `notify.placement_immigration:receive` | … ∋ immigration | immigration |
| `notify.work_authorization:receive` | work_authorization.expiring | hr, immigration |
| `notify.employee_exit:receive` | employee.benched, employee.exited | hr, accounts, immigration, bu_head, ceo |
| `notify.assignment_ending:receive` | assignment.ending_soon | hr, accounts |
| `notify.bench_time:receive` | employee.bench_time | ceo |
| `notify.application:receive` | application.received | hr |
| `notify.interview_request:receive` | interview.requested | interview_coordinator |
| `notify.contract:receive` | contract.created | hr, associate_hr, accounts |
| `notify.birthdays:receive` | staff.birthdays_today | ceo |

The application engine (`packages/shared/src/authz/engine.ts`) no longer reads `GRANTS`
by role key: `UserAccess.roles[]` carries each assignment's grants and traits, loaded
from the database by `AccessService` in one query. The catalog is used at runtime only
to seed and by tests (`assignmentFor(role)` builds an assignment from the catalog).

## Endpoints (`access:manage`)

- `GET /api/v1/admin/roles?includeArchived=` returns `{ items: [{ key, label, description, isSystem,
  restricted, traits: { sales, locationBound, admin, recruiter, coach }, track, level,
  department: {id,name}|null, clonedFrom, holders, archivedAt, grants: { "<permission>": "<scope>" } }] }`
  ordered by track, level, label.
- `GET /api/v1/admin/permissions` returns `{ scopes: [...], items: [{ key, area, description,
  restricted, orgSensitive }] }` from the catalog.
- `POST /api/v1/admin/roles` with `{ label, cloneFrom, description?, departmentId?, track?, level? }`
  returns 201 `{ key }`. Copies grants and traits from `cloneFrom` (404 unknown, 422
  `role_archived`). Label 1–80 characters, unique ignoring case among non-archived roles (409
  `role_exists`). `authz.role_create`; audited as `admin.role.created` `{ key, clonedFrom }`.
- `PATCH /api/v1/admin/roles/:key` with any of `{ label, description, track, level, departmentId,
  traits }` returns 204. 404 unknown, 422 `system_role` for a system role, `role_archived`,
  `invalid_label`/`invalid_track`/`invalid_level`, 409 `role_exists`. Label, description, track and
  level change freely; `traits` and `departmentId` only while nobody holds the role (422
  `role_in_use`): holders' access facts (location ids, separation of duties, coach assignments)
  depend on them. Turning `locationBound` off while a grant uses the `location` scope is 422
  `location_scope_needs_location`. `authz.role_update`; audited as `admin.role.updated` with the
  changed field names (and the trait values).
- `PUT /api/v1/admin/roles/:key/grants` with `{ grants: { "<permission>": "<scope>" | null } }`
  replaces the whole grant set, returns 204. 422 `unknown_permission`, `invalid_scope`,
  `system_role`, `role_archived`; 422 `role_in_use` when the change would add a restricted
  permission, or an org-sensitive one at `org` scope, while the role has active holders (make
  a new role and move people: their grant then goes through the two-person approval).
  Holders' `access_version` is bumped, so their next request carries the new grants.
  `authz.role_set_grants`; audited as `admin.role.grants_changed` `{ key, added, removed, changed }`
  (permission keys only). Audit rows of roles carry the key in `changes` (`entity_id` is a uuid).
- `POST /api/v1/admin/roles/:key/archive` returns 204; 422 `role_in_use` when anyone holds it,
  `system_role`. Archived roles disappear from pickers, keep their rows; their pending requests
  are rejected. `authz.role_archive`; audited as `admin.role.archived`.
- `POST /api/v1/admin/roles/:key/restore` returns 204; 409 `role_exists` when a live role took the
  label. `authz.role_restore`; audited as `admin.role.restored`.
- `GET /api/v1/admin/meta` `roles[]` now lists every non-archived role with `isSystem`,
  `track`/`level` and `recruiter` (the trait); `POST /admin/role-requests` and the bulk import accept custom keys and labels.
  Granting a department-bound role to a user outside it is 422 `role_department_mismatch`; an
  archived one is 422 `role_archived` (bulk rows: `unknown_role`, archived roles are not offered).
  `DELETE /admin/users/:id/roles/:role` with an unknown key is 422 `unknown_role`.
- Tests: `apps/api/test/admin-roles.api.int.test.ts`; engine: `packages/shared/src/authz/engine.test.ts`
  ("custom roles").

## Web

Users & Access gets a **Roles** tab: a list grouped by track and ordered by level (system
badge, holders, restricted mark), a drawer with traits, ladder position, department and the
permission grid (rows grouped by area, one scope select per row, "off" to remove). "Clone"
on any role opens the create form prefilled. System roles are read-only in the drawer.

## Org chart (Users & Access › Org chart)

Decided 2026-10-30: the reporting hierarchy is edited on a chart, by drag and drop or a
"Reports to" picker, and saved as one batch. A move changes who sees whose work
(`hierarchy` scope follows `reporting_line`); it never changes roles, so it needs one admin
(`access:manage`), not a second approver (AD-3 is about grants). Team membership on the
chart is limited to adding unassigned recruiters to a team; moving someone between teams
stays with `POST /teams/:id/move-member` (`team:move_member`, candidates reassigned).

- Ladder rule: the new manager's highest level should be above the person's, compared
  within a shared track (cross-track moves compare each one's highest level, so an
  Interview Lead may report to an Associate Director). A breach is a **warning**
  (`ladder_level`), returned and audited, never a refusal: the org is the admin's call.
- `GET /api/v1/admin/org-chart` returns `{ people: [{ id, displayName, designation, managerId,
  roles: [{ key, label, track, level }], team: { id, name, asLead }|null, canMove }],
  teams: [{ id, name, leadId }] }` for active users (`canMove` is false for the caller: `self_change`).
- `GET /api/v1/admin/org-chart/preview?userId=&managerId=` returns `{ loses: [{id,displayName}],
  gains: [...], warnings: ["ladder_level"] }`: the managers leaving and joining the person's
  reporting chain (`reporting_closure` ancestors before and after; `managerId` empty = no manager).
- `POST /api/v1/admin/org-chart/apply` with `{ moves: [{ userId, managerId: uuid|null }],
  teamAdds: [{ userId, teamId }] }` (1–100 items in total, each user once) returns 200
  `{ applied, warnings: [{ userId, code }] }`. All or nothing, in order: each move goes through
  `authz.org_chart_move` (ladder check, then `authz.admin_set_manager`: `self_change`, `cycle`,
  `invalid_manager`, `user_inactive`), each team add through `authz.admin_add_team_member`
  (`already_member`, `not_a_recruiter` when the role lacks the recruiter trait). Audited per item as
  `admin.user.manager` `{ managerId, previous, warnings, batch: true }` and `admin.team.member_added`
  `{ userId, batch: true }`. 422 `duplicate_user` when a user appears twice.
- Promotion on the chart is the existing role flow: the web grants the next role on the ladder
  (`POST /admin/role-requests`) and revokes the current one once that is applied; a restricted
  next step stays pending for the second admin and the current role is kept until then.
- Web: `apps/web/src/admin/OrgChartTab.tsx`. Tree by reporting line with a team strip under each
  lead; drag a card onto a new manager or an unassigned recruiter chip onto a team strip; the side
  panel's "Reports to" select (higher-level people only, descendants excluded) and keyboard **M**
  are the accessible path. Drops queue up in a pending list with the Loses/Gains preview and go
  with "Apply changes"; Undo and Discard are local.
