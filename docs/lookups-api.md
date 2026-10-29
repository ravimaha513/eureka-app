# Lookups API

Reference lists for pickers (`apps/api/src/modules/lookups`). JSON over HTTPS; errors are RFC 9457
problem details; writes need the session cookie and `x-csrf-token`. Reading the lists
(`GET /api/v1/lookups`, who sees which list) is documented in `docs/placements-api.md` "Lookups".

## Add a technology (migration 0250, 2026-10-29)

`POST /api/v1/lookups/technologies` — `technology:create` (org scope): Sales `lead`, `manager`,
`assoc_director`, `ceo`, plus `bu_head`, `interview_lead` and `org_admin`. Everyone else gets 403; the definer function checks
the permission again.

Body `{ name }`: trimmed, inner whitespace collapsed, 1–60 characters, no control characters;
other keys are refused (422).

`200 { id, name, created }`:
- a new row → `created: true`, audit `technology.created` (entity id only, no name);
- a name that already exists in any case → that row, `created: false` (no duplicate, no audit).

Errors: 401 no session; 403 no `technology:create`; 409 the name matches a retired
(`active = false`) technology, which only an admin can bring back; 422 bad name.

The only write path is `authz.create_technology(text)` (`db/functions/authz/create_technology.sql`,
SECURITY DEFINER, EXECUTE to `eureka_app`); `eureka_app` still has SELECT only on
`eureka.technology`. Adds are serialised with a transaction advisory lock so two people adding
the same name in different case get one row.

Web: the technology picker (`LookupPicker`, `apps/web/src/lookups.tsx`) is always a dropdown,
never a paste-an-ID input, even when the list is empty or failed to load. Callers pass
`canAdd` from `me.capabilities` (`technology:create`); then the dropdown ends with
"Add a new technology…", which opens a name field. The new row joins the cached lookups and
becomes the selection. Without the permission an empty list says to ask a lead or an admin.

Why: a database built from scratch (staging, rebuilt 2026-10-15) had no technologies, because
seeds run only in dev and 0140 only topped up databases that already had some.
