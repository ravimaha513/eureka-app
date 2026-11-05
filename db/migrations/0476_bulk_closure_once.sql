-- Bulk operations without per-row round trips (R-12; docs/backend-audit C-03, D-04).
--
-- 1. Reporting closure rebuilt once per bulk transaction (C-03; docs/admin-api.md
--    AD-9, bulk import, team members bulk; docs/roles-api.md "Org chart").
--    The statement trigger eureka.rebuild_reporting_closure used to rebuild the
--    whole closure (and run the whole-org cycle check) after every statement on
--    reporting_line: an org-chart batch of 100 moves did 200+ rebuilds under the
--    global advisory lock. Now a bulk flow calls authz.reporting_closure_defer()
--    first: for the rest of that transaction the statement trigger only takes
--    the lock and records "closure pending" in authz.reporting_closure_pending,
--    and a cheap per-row check (eureka.reporting_line_cycle_guard: walk up from
--    the new manager) still refuses a loop on the statement that closes it, so
--    the per-row 'cycle' report is unchanged. authz.reporting_closure_flush()
--    at the end of the flow rebuilds once (same body: whole-org cycle check,
--    closure, access_version bump) and ends the deferral, so later statements
--    of the transaction see a current closure. The deferred constraint trigger
--    reporting_closure_at_commit rebuilds at commit if anything is still
--    pending, so the closure is right after commit even when a flow forgets
--    to flush or a session sets the flag itself. The pending marker lives in a
--    table the app cannot write (as authz.employment_team_context, 0150), so
--    the commit-time rebuild cannot be skipped from the app.
--    Without the deferral nothing changes: every statement rebuilds as before.
--
-- 2. authz.set_batch_students (D-04; docs/training-api.md TR-8): the bulk add of
--    students in one call. Same rules as authz.set_batch_student (0390) per
--    candidate, but the scope sets are computed once and the candidates are
--    locked in id order (two overlapping bulk adds cannot deadlock). Returns
--    one row per distinct candidate, in request order: 'added' (also when
--    already in the batch, as before) or 'skipped' (candidate_not_eligible).

-- ---------- 1. closure ----------
SET ROLE authz_definer;
-- Transaction-scoped marker: a reporting_line change whose closure rebuild is still due.
CREATE TABLE authz.reporting_closure_pending (
  xact xid8 PRIMARY KEY
);
REVOKE ALL ON authz.reporting_closure_pending FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON authz.reporting_closure_pending TO eureka_owner;
RESET ROLE;

SET ROLE eureka_owner;

-- The rebuild itself (body of the statement trigger up to 0476): whole-org cycle
-- check, closure, access_version once per transaction. Clears the pending marker.
CREATE FUNCTION eureka.reporting_closure_rebuild() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.reporting_closure'));
  IF EXISTS (
    WITH RECURSIVE up(u, path) AS (
      SELECT rl.user_id, ARRAY[rl.user_id] FROM eureka.reporting_line rl WHERE rl.valid @> pg_catalog.now()
      UNION ALL
      SELECT rl.manager_id, up.path || rl.manager_id
      FROM up JOIN eureka.reporting_line rl ON rl.user_id = up.u AND rl.valid @> pg_catalog.now()
      WHERE NOT rl.manager_id = ANY(up.path) AND pg_catalog.array_length(up.path,1) < 64
    )
    SELECT 1 FROM up JOIN eureka.reporting_line rl ON rl.user_id = up.u AND rl.valid @> pg_catalog.now()
    WHERE rl.manager_id = ANY(up.path)
  ) THEN
    RAISE EXCEPTION 'reporting line cycle detected' USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM eureka.reporting_closure;
  INSERT INTO eureka.reporting_closure (ancestor_id, descendant_id, depth)
  WITH RECURSIVE c(anc, des, d) AS (
    SELECT rl.manager_id, rl.user_id, 1 FROM eureka.reporting_line rl WHERE rl.valid @> pg_catalog.now()
    UNION ALL
    SELECT rl.manager_id, c.des, c.d + 1
    FROM c JOIN eureka.reporting_line rl ON rl.user_id = c.anc AND rl.valid @> pg_catalog.now()
    WHERE c.d < 64
  )
  SELECT anc, des, pg_catalog.min(d) FROM c GROUP BY anc, des;

  DELETE FROM authz.reporting_closure_pending p WHERE p.xact = pg_catalog.pg_current_xact_id();

  -- Bump access_version for everyone: org changes are rare, correctness first.
  IF pg_catalog.current_setting('eureka.access_bumped', true) IS DISTINCT FROM pg_catalog.txid_current()::text THEN
    UPDATE eureka.app_user SET access_version = access_version + 1;
    PERFORM pg_catalog.set_config('eureka.access_bumped', pg_catalog.txid_current()::text, true);
  END IF;
END $$;

-- Rebuilds when this transaction has a pending change; otherwise nothing.
CREATE FUNCTION eureka.reporting_closure_settle() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE x xid8 := pg_catalog.pg_current_xact_id_if_assigned();
BEGIN
  IF x IS NOT NULL AND EXISTS (SELECT 1 FROM authz.reporting_closure_pending p WHERE p.xact = x) THEN
    PERFORM eureka.reporting_closure_rebuild();
  END IF;
END $$;

-- Deferred constraint trigger: the rebuild still due at commit.
CREATE FUNCTION eureka.reporting_closure_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM eureka.reporting_closure_settle();
  RETURN NULL;
END $$;

-- While deferred: refuse a new current line whose manager is (transitively) below
-- the user, on the statement that inserts it (the API reports 'cycle' per row).
-- Any new loop runs through an inserted line, so checking inserted lines is enough;
-- the rebuild repeats the whole-org check.
CREATE FUNCTION eureka.reporting_line_cycle_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.reporting_closure'));
  IF NOT coalesce(NEW.valid @> pg_catalog.now(), false) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    WITH RECURSIVE up(u, path) AS (
      SELECT NEW.manager_id, ARRAY[NEW.manager_id]
      UNION ALL
      SELECT rl.manager_id, up.path || rl.manager_id
      FROM up JOIN eureka.reporting_line rl ON rl.user_id = up.u AND rl.valid @> pg_catalog.now()
      WHERE NOT rl.manager_id = ANY(up.path) AND pg_catalog.array_length(up.path,1) < 64
    )
    SELECT 1 FROM up WHERE up.u = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'reporting line cycle detected' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION eureka.reporting_closure_rebuild() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.reporting_closure_settle() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.reporting_closure_commit() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.reporting_line_cycle_guard() FROM PUBLIC;
-- authz.reporting_closure_flush settles; nothing else is callable outside the owner.
GRANT EXECUTE ON FUNCTION eureka.reporting_closure_settle() TO authz_definer;

CREATE TRIGGER reporting_line_cycle AFTER INSERT ON eureka.reporting_line
  FOR EACH ROW
  WHEN (pg_catalog.current_setting('eureka.closure_defer', true) = pg_catalog.pg_current_xact_id()::text)
  EXECUTE FUNCTION eureka.reporting_line_cycle_guard();
CREATE CONSTRAINT TRIGGER reporting_closure_at_commit AFTER INSERT OR UPDATE OR DELETE ON eureka.reporting_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (pg_catalog.current_setting('eureka.closure_defer', true) = pg_catalog.pg_current_xact_id()::text)
  EXECUTE FUNCTION eureka.reporting_closure_commit();
RESET ROLE;

SET ROLE authz_definer;

-- Start deferring the closure rebuild for the rest of this transaction (admin bulk
-- flows: org-chart apply, bulk user import, team members bulk). access:manage only.
CREATE FUNCTION authz.reporting_closure_defer() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM authz.admin_guard(NULL);
  PERFORM pg_catalog.set_config('eureka.closure_defer', pg_catalog.pg_current_xact_id()::text, true);
END $$;

-- End the deferral and rebuild now if anything is pending (once). A loop the
-- per-row check could not see is still refused here as 'cycle'.
CREATE FUNCTION authz.reporting_closure_flush() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.set_config('eureka.closure_defer', '', true);
  BEGIN
    PERFORM eureka.reporting_closure_settle();
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'cycle' USING ERRCODE = 'check_violation';
  END;
END $$;

REVOKE ALL ON FUNCTION authz.reporting_closure_defer() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.reporting_closure_flush() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.reporting_closure_defer() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.reporting_closure_flush() TO eureka_app;

-- ---------- 2. bulk add of students ----------
CREATE FUNCTION authz.set_batch_students(p_batch uuid, p_candidates uuid[])
RETURNS TABLE (candidate_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE b record; found_batch boolean; manager boolean; staff boolean; ids uuid[]; ok uuid[];
BEGIN
  SELECT * INTO b FROM eureka.batch x WHERE x.id = p_batch FOR SHARE;
  found_batch := FOUND;
  manager := coalesce(p_batch = ANY (authz.training_batch_ids('training:manage')), false);
  staff := coalesce(b.location_id = ANY (authz.batch_staff_location_ids()), false);
  IF NOT found_batch OR authz.current_user_id() IS NULL
     OR NOT (staff OR coalesce(p_batch = ANY (authz.training_batch_ids('training:read')), false)) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (manager OR staff) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_candidates IS NULL OR pg_catalog.array_position(p_candidates, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  -- Distinct, first occurrence wins the position.
  SELECT coalesce(pg_catalog.array_agg(d.id ORDER BY d.ord), '{}') INTO ids
    FROM (SELECT DISTINCT ON (u.id) u.id, u.ord FROM pg_catalog.unnest(p_candidates) WITH ORDINALITY AS u(id, ord)
          ORDER BY u.id, u.ord) d;
  -- Deterministic lock order.
  PERFORM 1 FROM eureka.candidate x WHERE x.id = ANY (ids) ORDER BY x.id FOR UPDATE;
  -- One answer for "no such candidate", "not readable by the caller" and "not at this location".
  SELECT coalesce(pg_catalog.array_agg(x.id), '{}') INTO ok FROM eureka.candidate x
   WHERE x.id = ANY (ids)
     AND x.location_id IS NOT DISTINCT FROM b.location_id
     AND coalesce(authz.candidate_visible(x.id, 'candidate:read'), false)
     AND (manager OR coalesce(authz.owns('candidate:read', x.recruiter_id, x.team_id, x.location_id), false));
  IF NOT coalesce(b.status IN ('planned', 'in_training'), false)
     AND EXISTS (SELECT 1 FROM eureka.candidate x WHERE x.id = ANY (ok) AND x.batch_id IS DISTINCT FROM p_batch) THEN
    RAISE EXCEPTION 'batch_closed' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.candidate x SET batch_id = p_batch WHERE x.id = ANY (ok) AND x.batch_id IS DISTINCT FROM p_batch;
  RETURN QUERY
    SELECT u.id, CASE WHEN u.id = ANY (ok) THEN 'added' ELSE 'skipped' END
      FROM pg_catalog.unnest(ids) WITH ORDINALITY AS u(id, ord) ORDER BY u.ord;
END $$;

REVOKE ALL ON FUNCTION authz.set_batch_students(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_batch_students(uuid, uuid[]) TO eureka_app;
RESET ROLE;
