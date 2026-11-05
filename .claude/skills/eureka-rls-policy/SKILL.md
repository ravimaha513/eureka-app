---
name: eureka-rls-policy
description: Write or review Postgres row-level security policies for Eureka tables. Use when creating a new table, adding CREATE POLICY / ALTER POLICY, debugging "user can't see rows" or slow list endpoints, or reviewing any SQL that calls authz.* from a USING / WITH CHECK clause.
---

# Eureka RLS policy

Rule 3: **read policies never call definer functions per row.** A per-row call turns a list
query into N function calls. Make the authz call run once per statement as an InitPlan.

## Pick the pattern by set size

| Set | Pattern |
|---|---|
| Small (user, team, location ids) | `col = ANY ((SELECT authz.x('perm'))::uuid[])` |
| Large (e.g. `owned_candidate_ids`) | `col IN (SELECT pg_catalog.unnest((SELECT authz.x('perm'))))` — InitPlan feeding a hashed SubPlan, one hash probe per row (0034/0038). `= ANY` scans the array linearly per row |
| Parent row visibility | `EXISTS (SELECT 1 FROM eureka.parent p WHERE p.id = child.parent_id)` — by primary key; parent's own RLS applies |

The inner `(SELECT ...)` wrapper is what makes it an InitPlan. `col = ANY (authz.x('perm'))`
without it is evaluated per row.

## New table skeleton

```sql
SET ROLE eureka_owner;
ALTER TABLE eureka.x ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.x FORCE ROW LEVEL SECURITY;
CREATE POLICY x_read ON eureka.x FOR SELECT TO eureka_app USING (
  candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('x:read'))))
);
-- Sensitive table: no INSERT/UPDATE/DELETE policy for eureka_app; writes go through definer fns.
CREATE POLICY definer_insert ON eureka.x FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.x FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
RESET ROLE;
GRANT SELECT ON eureka.x TO eureka_app;
GRANT INSERT, UPDATE (col_a, col_b) ON eureka.x TO authz_definer;
```

Worker access (`eureka_worker`) needs its own narrow policy/grant; the worker role must never be
able to become the API role.

## Verify the plan

```sql
SET ROLE eureka_app;
SELECT set_config('eureka.user_id', '<uuid>', false);
EXPLAIN (COSTS OFF) SELECT * FROM eureka.x;
```

Expect `InitPlan` / `SubPlan` (hashed) once — not `Function Scan` or a filter with the authz call
inside the per-row `Filter:` line.

In tests, `ownedCandidateCalls(admin, userId, sql)` from `apps/api/test/db-harness.ts` counts how
often `authz.owned_candidate_ids` ran: assert `calls === 1` regardless of `rows`. See
`apps/api/test/rls.int.test.ts` for examples.

## Review checklist

- [ ] RLS enabled **and** forced.
- [ ] Every authz call in USING/WITH CHECK wrapped in `(SELECT ...)`.
- [ ] Large sets use `IN (SELECT unnest(...))`, not `= ANY`.
- [ ] No INSERT/UPDATE policy for `eureka_app` on sensitive tables (rule 6).
- [ ] Indexes exist on the policy's filter columns.
- [ ] Tests cover: in-scope user sees row, out-of-scope user sees nothing, calls once per statement.
