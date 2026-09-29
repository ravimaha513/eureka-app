-- Worker job ledger and nightly audit export (design A6.4, A5 "Jobs and events",
-- B4.5 worker role, B6 audit-export).
--
-- The job queue is a small table in schema eureka, not pg-boss: pg-boss creates
-- tables at runtime (a partition per queue, daily queue_stats partitions), so
-- the worker would need CREATE on a schema and table ownership. Here the
-- worker owns nothing and holds only the column privileges listed below.
--
-- eureka_worker gets:
--   job_run:       SELECT, INSERT, UPDATE of the status columns (no DELETE)
--   audit_export:  SELECT, INSERT (append-only; no UPDATE, DELETE, TRUNCATE)
--   audit_event:   SELECT, only rows from UTC days that have ended (policy below)
SET ROLE eureka_owner;
SET search_path = eureka, public;

-- ---------- job_run: one row per (job, period); idempotency + status ----------
CREATE TABLE job_run (
  job_name    text        NOT NULL CHECK (job_name ~ '^[a-z][a-z0-9-]{0,62}$'),
  run_key     text        NOT NULL CHECK (length(run_key) BETWEEN 1 AND 100),
  status      text        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempts    integer     NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  detail      jsonb,
  PRIMARY KEY (job_name, run_key),
  CHECK ((status = 'running') = (finished_at IS NULL))
);

-- ---------- audit_export: append-only ledger of export files ----------
CREATE TABLE audit_export (
  export_date date        PRIMARY KEY,               -- the UTC day exported
  object_key  text        NOT NULL UNIQUE,
  row_count   integer     NOT NULL CHECK (row_count >= 0),
  first_seq   bigint,
  last_seq    bigint,
  byte_size   bigint      NOT NULL CHECK (byte_size > 0),
  sha256_hex  text        NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  exported_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((row_count = 0) = (first_seq IS NULL) AND (first_seq IS NULL) = (last_seq IS NULL)),
  CHECK (first_seq IS NULL OR first_seq <= last_seq)
);

-- Rows are evidence: nobody updates or deletes them, including the owner
-- (defense in depth on top of the grants; TRUNCATE is blocked too).
CREATE FUNCTION audit_export_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'audit_export is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE EXECUTE ON FUNCTION audit_export_immutable() FROM PUBLIC;
CREATE TRIGGER audit_export_no_update BEFORE UPDATE OR DELETE ON audit_export
  FOR EACH ROW EXECUTE FUNCTION audit_export_immutable();
CREATE TRIGGER audit_export_no_truncate BEFORE TRUNCATE ON audit_export
  FOR EACH STATEMENT EXECUTE FUNCTION audit_export_immutable();

ALTER TABLE job_run      ENABLE ROW LEVEL SECURITY; ALTER TABLE job_run      FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_export ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_export FORCE ROW LEVEL SECURITY;

RESET ROLE;

-- ---------- grants and policies (worker only; the app role gets nothing) ----------
REVOKE ALL ON eureka.job_run, eureka.audit_export FROM PUBLIC;

GRANT SELECT, INSERT ON eureka.job_run TO eureka_worker;
GRANT UPDATE (status, attempts, started_at, finished_at, detail) ON eureka.job_run TO eureka_worker;
CREATE POLICY job_run_worker_read   ON eureka.job_run FOR SELECT TO eureka_worker USING (true);
CREATE POLICY job_run_worker_insert ON eureka.job_run FOR INSERT TO eureka_worker WITH CHECK (status = 'running');
CREATE POLICY job_run_worker_update ON eureka.job_run FOR UPDATE TO eureka_worker
  USING (status <> 'succeeded') WITH CHECK (true);

GRANT SELECT, INSERT ON eureka.audit_export TO eureka_worker;
CREATE POLICY audit_export_worker_read   ON eureka.audit_export FOR SELECT TO eureka_worker USING (true);
CREATE POLICY audit_export_worker_insert ON eureka.audit_export FOR INSERT TO eureka_worker
  WITH CHECK (export_date < (now() AT TIME ZONE 'UTC')::date);

-- The export reads closed UTC days only: today's rows (still being written)
-- stay invisible to the worker. Every column is needed for the export file.
GRANT SELECT (seq, at, actor_id, action, entity_type, entity_id, changes, request_id, ip)
  ON eureka.audit_event TO eureka_worker;
CREATE POLICY audit_worker_export ON eureka.audit_event FOR SELECT TO eureka_worker
  USING (at < date_trunc('day', now(), 'UTC'));
