# Admin and team API contract (Phase 1)

Shared contract for the admin backend (`apps/api/src/modules/admin`) and the
Users & Access screens (`apps/web`). JSON over HTTPS. Errors use RFC 9457
problem details. Writes need the session cookie and `x-csrf-token`.

## Decisions and assumptions (least privilege)

| ID | Rule |
|---|---|
| AD-1 | Everything under `/api/v1/admin/*` requires `access:manage` (org scope; only `org_admin` holds it). `org_admin` still has no data permissions. |
| AD-2 | Nobody can change their own roles, status or reporting line (403 `self_change`). |
| AD-3 | Granting a **restricted role** needs a second approver: another `access:manage` holder who is neither the grantee nor the requester. Restricted roles are `org_admin` and every role that holds a permission in `RESTRICTED_PERMISSIONS` (HR, Accounts, Immigration). Other roles apply immediately. |
| AD-4 | Revoking a role, or deactivating a user, is immediate and needs no approval. Least privilege: removing access is never slowed down. |
| AD-5 | Deactivation sets `status = 'inactive'`, ends open role, team and coach rows (`valid` upper bound = now), revokes all sessions and bumps `access_version`. Reactivation restores the status only. Roles must be granted again. |
| AD-6 | Location-bound roles (`location_incharge`, `location_ops_admin`) require `locationId`; other roles reject it. |
| AD-7 | Every change writes an `audit_event` in the same transaction. Role requests are stored in `role_request` with requester, approver and decision time. A pending request expires after 7 days. |
| AD-8 | Moving a recruiter between teams (OD-07) needs `team:move_member` covering **both** teams in the actor's scope. Their candidates stay with the old team and go to `reassignTo`, which must be an active member or the lead of the old team. It defaults to the old team's lead. It all runs in one transaction in a definer function. |
| AD-9 | Team lead changes and reporting lines are admin-only (`access:manage`) and keep the existing invariants (the closure rebuild and the cycle check). |

## Endpoints

### Metadata
`GET /api/v1/admin/meta` returns
`{ roles: [{ key, label, restricted, locationBound }], locations: [{ id, name }] }`

### Users
- `GET /api/v1/admin/users?search=&status=active|inactive&cursor=&limit=` (default 50, max 200) returns
  `{ items: [{ id, email, displayName, designation, status, primaryLocation: {id,name}|null, manager: {id,displayName}|null, roles: [{ key, label, locationId, locationName }], teams: [{ id, name, asLead: boolean }] }], nextCursor }`
- `POST /api/v1/admin/users` with `{ email, displayName, designation?, primaryLocationId? }` returns 201 `{ id }`. A duplicate email is a 409. The email must be in `GOOGLE_HOSTED_DOMAIN` when that is set (422).
- `POST /api/v1/admin/users/:id/deactivate` returns 204 (AD-5).
- `POST /api/v1/admin/users/:id/reactivate` returns 204.
- `PUT /api/v1/admin/users/:id/manager` with `{ managerId: uuid | null }` returns 204 (AD-2, AD-9). A cycle is a 422.

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
  `{ items: [{ id, name, location: {id,name}|null, lead: {id,displayName}, members: [{ id, displayName }] }] }`
- `POST /api/v1/admin/teams` with `{ name, leadId, locationId? }` returns 201 `{ id }`.
- `PUT /api/v1/admin/teams/:id/lead` with `{ leadId }` returns 204.
- `POST /api/v1/admin/teams/:id/members` with `{ userId }` returns 204. A user who is already in another team gets a 409; use the move endpoint instead.
- `POST /api/v1/teams/:id/move-member` with `{ userId, toTeamId, reassignTo? }` (permission `team:move_member`, AD-8) returns 200 `{ movedCandidates: number, reassignedTo: { id, displayName } }`.

## Error codes (`detail` field)
`self_change`, `second_approver_required`, `restricted_role`, `location_required`, `location_not_allowed`, `already_member`, `not_in_scope`, `invalid_reassign_target`, `cycle`.

Added during implementation:
- 409: `email_exists`, `role_already_held`, `request_pending`, `request_not_pending`, `request_expired`, `last_admin`
- 422: `email_domain`, `unknown_role`, `invalid_manager`, `invalid_lead`, `user_inactive`, `not_a_member`, `same_team`, `lead_of_team`

## Implementation notes

- Every admin write goes through a SECURITY DEFINER function in `authz` (migration 0013) that re-checks `access:manage`, self-change and the second approver inside the database. `eureka_app` has no write privilege on org tables.
- Self-change (AD-2) also covers changes that would widen the actor's own scope: making someone report to yourself, making yourself a lead, or adding yourself to a team.
- The grantee cannot reject their own pending request; the requester can withdraw theirs.
- `authz.move_team_member` takes the source team too (from the route), so a concurrent move cannot change what is being moved.
- Changing a team's lead moves the old lead's candidates in that team to the new lead (keeps the recruiter/team invariant).
- `DELETE /admin/users/:id/roles/:role` without `locationId` revokes the role at every location.
- Moving members needs `team:move_member`, which `org_admin` does not hold (least privilege: moves reassign candidates, which is business data). The Teams tab shows the action disabled for admins; managers and associate directors will move members from a team view (Phase 2).
