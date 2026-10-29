# Lookups API

Reference lists for pickers (`apps/api/src/modules/lookups`). JSON over HTTPS; errors are RFC 9457
problem details; writes need the session cookie and `x-csrf-token`. Reading the lists
(`GET /api/v1/lookups`, who sees which list) is documented in `docs/placements-api.md` "Lookups".

## Add a technology (migration 0250, 2026-10-29)

`POST /api/v1/lookups/technologies` — any active signed-in user.

Body `{ name }`: trimmed, inner whitespace collapsed, 1–60 characters, no control characters;
other keys are refused (422).

`200 { id, name, created }`:
- a new row → `created: true`, audit `technology.created` (entity id only, no name);
- a name that already exists in any case → that row, `created: false` (no duplicate, no audit).

Errors: 401 no session; 403 caller not an active user; 409 the name matches a retired
(`active = false`) technology, which only an admin can bring back; 422 bad name.

The only write path is `authz.create_technology(text)` (`db/functions/authz/create_technology.sql`,
SECURITY DEFINER, EXECUTE to `eureka_app`); `eureka_app` still has SELECT only on
`eureka.technology`. Adds are serialised with a transaction advisory lock so two people adding
the same name in different case get one row.

Web: every technology picker (`LookupPicker`, `apps/web/src/lookups.tsx`) ends with
"Add a new technology…"; with an empty list it shows the add field directly instead of the
paste-an-ID input. The new row joins the cached lookups and becomes the selection.

Why: a database built from scratch (staging, rebuilt 2026-10-15) had no technologies, because
seeds run only in dev and 0140 only topped up databases that already had some.
