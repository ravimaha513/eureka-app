# Admin and team API contract (Phase 1)

Shared contract for the admin backend (`apps/api/src/modules/admin`) and the
Users & Access screens (`apps/web`). JSON over HTTPS. Errors use RFC 9457
problem details. Writes need the session cookie and `x-csrf-token`.

## Decisions and assumptions (least privilege)

| ID | Rule |
|---|---|
| AD-1 | Everything under `/api/v1/admin/*` requires `access:manage` (org scope; only `org_admin` holds it). `org_admin` still has no data permissions. |
| AD-2 | Nobody can change their own roles, status or reporting line (403 `self_change`). |
| AD-3 | Granting a **restricted role** needs a second approver: another `access:manage` holder who is neither the grantee nor the requester, while the grantee is active and the requester is still an admin. Restricted roles: `org_admin`, every role holding a permission in `RESTRICTED_PERMISSIONS` (HR, Accounts, Immigration), and every role holding an org-wide sensitive permission (`ORG_SENSITIVE_PERMISSIONS`: rates, invoices, employees, phones, assignment, team moves, documents), which today adds CEO, BU Head, Associate HR and Documents Team. Other roles apply immediately. |
| AD-3a | Separation of duties: an `org_admin` holds no business role, and a user with a business role cannot be made `org_admin` (422 `separation_of_duties`). Use a separate admin account. |
| AD-3b | **Single-admin mode** (migration 0084): when `SINGLE_ADMIN_MODE=on` is set for the migrate task (Terraform `single_admin_mode`, default `off`), restricted roles apply immediately and the requester may approve a pending request (recorded as `applied`). Self-change, grantee approval, org_admin/data-role separation and audit stay. Stored in `authz.policy_setting single_admin_mode`. |
| AD-4 | Revoking a role, or deactivating a user, is immediate and needs no approval. Least privilege: removing access is never slowed down. |
| AD-5 | Deactivation sets `status = 'inactive'`, ends open role, team, coach and reporting-line rows, closes pending role requests for or by the user, revokes all sessions and bumps `access_version`. It is refused while the user leads a team (`lead_of_team`) or has direct reports (`has_reports`). Reactivation restores the status only. Roles, teams and a manager must be set again. |
| AD-6 | Location-bound roles (`location_incharge`, `location_ops_admin`) require `locationId`; other roles reject it. |
| AD-7 | Every change writes an `audit_event` in the same transaction. Role requests are stored in `role_request` with requester, approver and decision time. A pending request expires after 7 days. |
| AD-8 | Moving a recruiter between teams (OD-07) needs `team:move_member` covering **both** teams in the actor's scope. Their candidates stay with the old team and go to `reassignTo`, which must be an active member or the lead of the old team. It defaults to the old team's lead. It all runs in one transaction in a definer function. |
| AD-9 | Team lead changes and reporting lines are admin-only (`access:manage`) and keep the existing invariants (the closure rebuild and the cycle check). |
| AD-10 | Adding people to a team needs `team:add_member`: a lead (`team` scope) adds to the team they lead; a manager or associate director (`hierarchy` scope) adds to any team whose lead is in their reporting subtree. Only active users holding the `recruiter` role and in no team can be added (422 `not_a_recruiter`, 422 `user_inactive`, 409 `already_member`); someone in another team is moved with AD-8. Not yourself. Runs in `authz.team_add_member` (`db/functions/authz/team_add_member.sql`), audited as `team.member_added`. |
| AD-11 | Departments (migration 0220) are descriptive: a department and optional sub-department per user (e.g. Sales → Interview Prep), shown and filtered in Users & Access. Only admins (`access:manage`) create, rename or assign them, through definer functions. Nothing in `authz` or any policy reads a department, so it never grants or widens access; scope stays role + reporting line. |

## Endpoints

### Metadata
`GET /api/v1/admin/meta` returns
`{ roles: [{ key, label, restricted, locationBound }], locations: [{ id, name }] }`

### Locations
- `POST /api/v1/admin/locations` with `{ name, kind, state?, timezone? }` returns 201 `{ id }`. `kind` is one of `training`, `gh`, `office`, `remote`; `timezone` is an IANA name (default `America/New_York`). Only `org_admin` (`access:manage`, org scope) can create one. The write goes through `authz.admin_create_location` (migration 0091) and is audited as `admin.location.created`. A duplicate name is 409 `location_exists`. Locations cannot be edited or deleted here yet.

### Departments (AD-11)
- `GET /api/v1/admin/departments` returns `{ items: [{ id, name, parentId: uuid|null, userCount }] }` (flat, ordered by name; `userCount` counts active users whose department is exactly this one).
- `POST /api/v1/admin/departments` with `{ name, parentId? }` returns 201 `{ id }`. Two levels only: `parentId` must be a top-level department (422 `invalid_parent`; 404 unknown parent). Names are 1–120 characters, trimmed, no control characters (422 `invalid_name`), unique among siblings ignoring case (409 `department_exists`). `authz.admin_create_department`; audited as `admin.department.created` with `{ parentId }` only.
- `PATCH /api/v1/admin/departments/:id` with `{ name }` returns 204. 404 unknown department. `authz.admin_rename_department`; audited as `admin.department.renamed` without the name.
- `PUT /api/v1/admin/users/:id/department` with `{ departmentId: uuid | null }` returns 204. 404 unknown user or department. Admins may set their own (it grants nothing). `authz.admin_set_user_department`; audited as `admin.user.department` with `{ departmentId, previous }`.
- Departments cannot be deleted or moved yet.

### Users
- `GET /api/v1/admin/users?search=&status=active|inactive&departmentId=<uuid>|none&cursor=&limit=` (default 50, max 200; `departmentId` matches that department and its sub-departments, `none` users without one) returns
  `{ items: [{ id, email, displayName, designation, status, primaryLocation: {id,name}|null, department: { id, name, parent: {id,name}|null }|null, manager: {id,displayName}|null, roles: [{ key, label, locationId, locationName }], teams: [{ id, name, asLead: boolean }] }], nextCursor }`
  (interviews-settings, SD-1/ST-3: plus `contactVisible` and, for `staff.contact:read` holders, each item's `phone`).
- `GET /api/v1/admin/users/summary` returns `{ active, inactive, roles: [{ key, label, count }] }`: active users per role, roles with users only (`docs/interviews-settings-api.md` SD-1).
- `POST /api/v1/admin/users` with `{ email, displayName, designation?, primaryLocationId? }` returns 201 `{ id }`. A duplicate email is a 409. The email must be in `GOOGLE_HOSTED_DOMAIN` when that is set (422).
- `POST /api/v1/admin/users/bulk` with `{ dryRun, rows: [{ email, displayName, designation?, location?, roles? }] }` (1 to 500 rows; `location` is a location name, case-insensitive; `roles` is up to 5 role keys or labels, case-insensitive) returns 200
  `{ dryRun, committed, created, failed, rows: [{ row, email, displayName, status: "ok" | "error", error?, id?, roles: [{ role, label, status: "applied" | "pending_approval" }] }] }`. All or nothing: one transaction, rolled back when `dryRun` is true or any row fails, so a dry run previews exactly what a real run does, role statuses included (`id` is only present when committed). Row errors: `invalid_email`, `email_domain`, `name_required`, `duplicate_in_file`, `unknown_location`, `email_exists`, `unknown_role`, `duplicate_role`, `separation_of_duties` (Org Admin with another role, AD-3a), `location_required` (a location-bound role without a row location; AD-6: such roles are granted at the row's location). Each user is created by `authz.admin_create_user` and audited as `admin.user.created` (`bulk: true`); each role goes through `authz.request_role` like a single grant and is audited as `admin.role.granted` or `admin.role.requested` (`bulk: true`): restricted roles become pending requests for a second admin (AD-3), unless single-admin mode is on. One `admin.user.bulk_created` records the user and role counts.
- `GET /api/v1/admin/users/bulk/template` returns the import template as `.xlsx` (`users-import-template.xlsx`): a "Users" sheet with the columns Email, Name, Designation, Location, Role 1-3 for up to 500 rows, Location and Role dropdowns (role labels, current location names) from a hidden "Lists" sheet, and an "Instructions" sheet. The web reads the file in the browser (the "Users" sheet, else the first) and posts rows as above; CSV with the same headers still works.
- `POST /api/v1/admin/users/:id/deactivate` returns 204 (AD-5).
- `POST /api/v1/admin/users/:id/reactivate` returns 204.
- `PUT /api/v1/admin/users/:id/manager` with `{ managerId: uuid | null }` returns 204 (AD-2, AD-9). A cycle is a 422.
- `PUT /api/v1/admin/users/:id/designation` with `{ designation: string | null }` returns 200 `{ id, designation }` (migration 0111; `authz.set_designation`; not yourself; at most 120 characters, no control characters, 422 `invalid_designation`; audited as `user.designation_changed`). Managers and associate directors change designations in their hierarchy through `PUT /api/v1/users/:id/designation` (`designation:change`, `docs/performance-api.md` PF-7).

### Roles
- `POST /api/v1/admin/role-requests` with `{ userId, role, locationId? }` returns 201 `{ id, status: "applied" | "pending_approval" }`.
- `GET /api/v1/admin/role-requests?status=pending|approved|rejected|expired` returns
  `{ items: [{ id, user: {id,displayName,email}, role, roleLabel, locationId, requestedBy: {id,displayName}, requestedAt, status, decidedBy: {id,displayName}|null, decidedAt }] }`.
  Non-restricted grants are recorded too, with `status: "applied"`; they are listed when no status filter is given.
- `POST /api/v1/admin/role-requests/:id/approve` returns 200 `{ status: "approved" }`. If the approver is the requester or the grantee, the response is 403 `second_approver_required`.
- `POST /api/v1/admin/role-requests/:id/reject` returns 200 `{ status: "rejected" }`.
- `DELETE /api/v1/admin/users/:id/roles/:role?locationId=` returns 204 (AD-4).

### Teams
- `GET /api/v1/admin/teams` returns
  `{ items: [{ id, name, location: {id,name}|null, lead: {id,displayName}, department: { id, name, parent }|null, members: [{ id, displayName }] }] }`
- `POST /api/v1/admin/teams` with `{ name, leadId, locationId? }` returns 201 `{ id }`.
- `PATCH /api/v1/admin/teams/:id` with `{ name }` (1–120 chars, trimmed) renames the team and returns 204. 404 unknown team. The audit row (`admin.team.renamed`) does not carry the name.
- `PUT /api/v1/admin/teams/:id/lead` with `{ leadId }` returns 204.
- `POST /api/v1/admin/teams/:id/members` with `{ userId }` returns 204. A user who is already in another team gets a 409; use the move endpoint instead.
- `GET /api/v1/teams/mine` (permission `team:add_member`, AD-10) returns `{ items: [{ id, name, lead: {id,displayName}, members: [{id,displayName}] }], addable: [{ id, displayName, email }] }`: the caller's teams and the active recruiters in no team.
- `POST /api/v1/teams/:id/members` with `{ userId }` (permission `team:add_member`, AD-10) returns 204. 404 unknown team, 403 `not_in_scope` for a team outside the caller's scope.
- `POST /api/v1/teams/:id/move-member` with `{ userId, toTeamId, reassignTo? }` (permission `team:move_member`, AD-8) returns 200 `{ movedCandidates: number, reassignedTo: { id, displayName } }`.

## Error codes (`detail` field)
`self_change`, `second_approver_required`, `restricted_role`, `location_required`, `location_not_allowed`, `already_member`, `not_in_scope`, `invalid_reassign_target`, `cycle`.

Added during implementation:
- 404: `department_not_found` (as a plain 404)
- 409: `department_exists`, `email_exists`, `role_already_held`, `request_pending`, `request_not_pending`, `request_expired`, `last_admin`, `requester_not_admin`
- 422: `invalid_parent`, `invalid_name`, `invalid_designation`, `email_domain`, `unknown_role`, `invalid_manager`, `invalid_lead`, `user_inactive`, `not_a_member`, `same_team`, `lead_of_team`, `has_reports`, `separation_of_duties`

## Implementation notes

- Every admin write goes through a SECURITY DEFINER function in `authz` (migration 0013) that re-checks `access:manage`, self-change and the second approver inside the database. `eureka_app` has no write privilege on org tables.
- Self-change (AD-2) also covers changes that would widen the actor's own scope: making someone report to yourself, making yourself a lead, or adding yourself to a team.
- The grantee cannot reject their own pending request; the requester can withdraw theirs.
- `authz.move_team_member` takes the source team too (from the route), so a concurrent move cannot change what is being moved.
- Changing a team's lead moves the old lead's candidates in that team to the new lead (keeps the recruiter/team invariant).
- `DELETE /admin/users/:id/roles/:role` without `locationId` revokes the role at every location.
- Moving members needs `team:move_member`, which `org_admin` does not hold (least privilege: moves reassign candidates, which is business data). The Teams tab shows the action disabled for admins; managers and associate directors will move members from a team view (Phase 2).
- The first admins come from the bootstrap CLI (`authz.bootstrap_admins`, migration 0037; infra/README.md "First admin"), never from the API: break-glass only: it refuses while an active `org_admin` exists (and, after a first bootstrap, without `--recover`), creates two so restricted roles can be approved (AD-3), and is executable only by the migration user.
