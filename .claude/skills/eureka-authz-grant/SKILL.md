---
name: eureka-authz-grant
description: Add or change a permission, role, scope grant or notification audience in packages/shared/src/authz/catalog.ts. Use when a feature needs a new permission, a role should (or should not) be able to do something, "who can see X", or when reviewing a catalog.ts diff for least-privilege problems.
---

# Eureka authz catalog change

`packages/shared/src/authz/catalog.ts` is the single source of truth for roles, permissions and
scoped grants; `migrate.ts` seeds it into the DB. It is a **hot file**: merge `origin/main`
first, keep the diff small, never reformat. Grep, don't read the whole file.

## Map (grep these)

| Export | Purpose |
|---|---|
| `SCOPES` | `own, team, coached, coached_hierarchy, hierarchy, location, org` |
| `ROLES`, `ROLE_LABELS`, `ROLE_TRAITS`, `ROLE_LADDER` | role definitions |
| `PERMISSIONS` | every permission string (`<area>:<verb>` / `<area>.<sub>:<verb>`) |
| `PERMISSION_AREAS`, `PERMISSION_DESCRIPTIONS` | admin UI grouping and text — every new permission needs both |
| `RESTRICTED_PERMISSIONS`, `ORG_SENSITIVE_PERMISSIONS` | make a role "restricted" (second approver) |
| `GRANTS` | `Record<Role, Grants>`: permission → scope per role |
| `NOTIFY_RECIPIENTS` | `notify.*:receive` audiences |

## Steps

1. `git fetch origin main && git merge origin/main`.
2. Add the permission to `PERMISSIONS`, `PERMISSION_AREAS` (if new area), `PERMISSION_DESCRIPTIONS`.
3. Grant it in `GRANTS` with the **narrowest scope** that meets the requirement.
4. Sensitive data (rates, SSN-like ids, restricted documents, payments)? Add to
   `RESTRICTED_PERMISSIONS` or `ORG_SENSITIVE_PERMISSIONS`.
5. `pnpm docs:grants` to regenerate the grants table if docs reference it.
6. Run `pnpm test:api test/catalog-consistency.int.test.ts --reporter=dot` and
   `pnpm --filter @eureka/shared test`.

## Least-privilege rules (rule 7)

- `org_admin` holds **no business permission** — admin only.
- Roles holding restricted or org-wide-sensitive permissions need a second approver
  (`isRestrictedRole`); don't quietly make a common role restricted.
- The worker role cannot become the API role.
- Don't widen an existing grant's scope to fix one screen; add a narrower permission instead.
- Ask the owner (Ravi) when the right audience is a product decision — see
  `docs/HANDOFF.md` "Open product questions". Don't guess.

## Then

API: `@RequirePermission("<perm>")` on the route. DB: definer functions check the same string
with scope (`authz.has_perm`, `authz.candidate_owned(id, '<perm>')`, …). Web: gate nav/buttons
the same way (`apps/web/src/nav.ts`, small edit).
