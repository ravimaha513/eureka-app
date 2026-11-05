---
name: eureka-definer-fn
description: Write or change a SQL function in the authz or eureka schema — SECURITY DEFINER write functions, guard triggers, scope helpers, emit functions. Use whenever touching db/functions/**, adding CREATE FUNCTION to a migration, or when an API write to a sensitive table needs a database-side permission and scope re-check.
---

# Eureka SQL function (definer or guard)

## Where the function lives

- Has a file in `db/functions/<schema>/<name>.sql`? Edit **that file only**
  (`db/functions/README.md`). `migrate.ts` re-applies files whose checksum changed.
- New function: create it in your migration, or create a new `db/functions/<schema>/<name>.sql`.
  Moving an existing one: copy `pg_get_functiondef()` from a migrated DB, add owner + grants,
  verify `pg_get_functiondef` and `proacl` match before/after.
- Signature or return type change: `DROP FUNCTION` in a versioned migration first.

## Owners

- `authz.*` write/scope functions: `SET ROLE authz_definer;`
- `eureka.*` trigger guards: `SET ROLE eureka_owner;`

## Template — SECURITY DEFINER write (see `db/functions/authz/create_vendor.sql`)

```sql
-- authz.<name>: current definition (repeatable; db/functions/README.md).
-- <Who calls it, which permission, doc ref>. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.<name>(p_id uuid, p_changes jsonb, p_expected_version integer)
 RETURNS TABLE(...)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  r eureka.<table>%ROWTYPE;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM eureka.<table> x WHERE x.id = p_id FOR UPDATE;
  -- 404 first: not visible to the caller -> same answer as "does not exist"
  IF NOT FOUND OR NOT coalesce(authz.candidate_visible(r.candidate_id, '<area>:read'), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  -- 403: visible but not allowed (permission AND scope)
  IF NOT coalesce(authz.candidate_owned(r.candidate_id, '<area>:write'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'version_mismatch' USING ERRCODE = 'serialization_failure';
  END IF;
  -- validate input -> 'invalid_<x>' USING ERRCODE = 'check_violation' (422)
  ...
END $function$;
REVOKE ALL ON FUNCTION authz.<name>(uuid, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.<name>(uuid, jsonb, integer) TO eureka_app;   -- exactly one role
RESET ROLE;
```

## Template — guard trigger (see `db/functions/eureka/work_authorization_notice_guard.sql`)

Guards make server-managed columns server-managed (rule 4): overwrite `NEW.created_at`,
`NEW.status`, snapshots, `created_by` from `authz.current_user_id()`, and refuse writes not coming
from `authz_definer` with `insufficient_privilege`. Guards are not SECURITY DEFINER.

## Non-negotiables

1. **NULL-safe `IF`** — `IF NOT x` with x NULL skips the branch. Always `coalesce(x, false)`,
   `IS DISTINCT FROM`, or `x IS NULL OR ...`.
2. `REVOKE ALL ... FROM PUBLIC`; pinned `search_path = pg_catalog, pg_temp`; EXECUTE to exactly
   the caller role (`eureka_app` for the API, `eureka_worker` for jobs). Schema-qualify everything
   (`pg_catalog.now()`, `pg_catalog.btrim()`, `eureka.table`).
3. Re-check permission **and** scope in the DB even though the API checks too (rule 6).
4. Error codes map in `apps/api/src/platform/errors.ts`: `P0002`/no_data_found → 404,
   `42501`/insufficient_privilege → 403, `check_violation` → 422. Add the message key to the
   module's `<area>.errors.ts` CODES map.
5. No free text, rates, phones, emails or links into `audit_event` / `outbox_event`.
6. Serialise check-then-insert races with `pg_advisory_xact_lock(hashtext('<key>'))` or `FOR UPDATE`.
7. Never call a definer function per row from an RLS policy (see `eureka-rls-policy`).

## Verify

Add `.db.int.test.ts` cases: allowed user succeeds; out-of-scope user gets `not_found`;
in-scope without permission gets `not_permitted`; NULL inputs don't bypass checks;
`eureka_app` cannot write the table directly. Then the `.api.int.test.ts` 404/403 cases.
