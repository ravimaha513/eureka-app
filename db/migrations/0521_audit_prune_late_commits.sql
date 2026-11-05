-- Security gate (wave 3): eureka.audit_prune_exported (0518) treated every audit row of an exported
-- UTC day whose seq lies in the file's [first_seq, last_seq] as exported. A transaction that began on
-- that day (so its row's `at` is that day) and committed after the export ran can hold a seq inside
-- that range without being in the file, and would be deleted unexported.
-- Now a day is pruned only while the rows of that day in its seq range number at most the file's
-- row_count. A late commit makes the count exceed row_count before any pruning of that day, so the
-- day is skipped (with a WARNING naming the day, no row data) and kept for a re-export. Partial
-- pruning only lowers the count, so batched calls stay correct. Same floors, grants and owner.

SET ROLE eureka_owner;

CREATE OR REPLACE FUNCTION eureka.audit_prune_exported(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer; d record;
BEGIN
  IF p_days IS NULL OR p_days < 365 OR p_days > 36500 THEN
    RAISE EXCEPTION 'audit retention must be between 365 and 36500 days' USING ERRCODE = 'check_violation';
  END IF;
  -- Days past the cut-off whose in-range rows outnumber the file: never pruned; reported.
  FOR d IN
    SELECT e.export_date FROM eureka.audit_export e
     WHERE e.row_count > 0
       AND e.export_date < ((pg_catalog.now() - pg_catalog.make_interval(days => p_days)) AT TIME ZONE 'UTC')::date
       AND (SELECT pg_catalog.count(*) FROM eureka.audit_event x
             WHERE x.seq BETWEEN e.first_seq AND e.last_seq
               AND (x.at AT TIME ZONE 'UTC')::date = e.export_date) > e.row_count
  LOOP
    RAISE WARNING 'audit export % has rows that are not in its file; that day is not pruned', d.export_date;
  END LOOP;
  DELETE FROM eureka.audit_event a WHERE a.seq IN (
    SELECT x.seq FROM eureka.audit_event x
      JOIN eureka.audit_export e ON e.export_date = (x.at AT TIME ZONE 'UTC')::date
                                AND x.seq BETWEEN e.first_seq AND e.last_seq
     WHERE x.at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
       AND (SELECT pg_catalog.count(*) FROM eureka.audit_event y
             WHERE y.seq BETWEEN e.first_seq AND e.last_seq
               AND (y.at AT TIME ZONE 'UTC')::date = e.export_date) <= e.row_count
     ORDER BY x.seq LIMIT 5000);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION eureka.audit_prune_exported(integer) FROM PUBLIC;

-- The owner's delete policy (audit_owner_prune, 0518) is unchanged: it still bounds any owner-run
-- delete to old rows inside an exported day's seq range. It cannot carry the count rule (a policy may
-- not read its own table: "infinite recursion"), so the late-commit refinement lives in this
-- function, the only prune path (worker-only EXECUTE).

RESET ROLE;

GRANT EXECUTE ON FUNCTION eureka.audit_prune_exported(integer) TO eureka_worker;
