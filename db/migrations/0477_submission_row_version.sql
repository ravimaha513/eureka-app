-- Optimistic concurrency for submissions (docs/submissions-api.md "Concurrency", audit R-10 / A-02).
--   * eureka.submission.row_version: 1 on insert (eureka.submission_insert_guard refuses
--     anything else, rule 4), +1 on every UPDATE (status transition, detail edit, any
--     other path) by the new BEFORE UPDATE trigger below, which also overwrites any
--     value a writer tried to set: the column is server-managed.
--   * The API returns it as rowVersion and accepts an optional If-Match on
--     PATCH /submissions/:id and PATCH /submissions/:id/status (412 when stale).
-- No free text, rates or contact data are involved (rule 5).

SET ROLE eureka_owner;

ALTER TABLE eureka.submission
  ADD COLUMN row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1);

CREATE FUNCTION eureka.submission_row_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eureka.submission_row_version() FROM PUBLIC;

CREATE TRIGGER submission_row_version BEFORE UPDATE ON eureka.submission
  FOR EACH ROW EXECUTE FUNCTION eureka.submission_row_version();

RESET ROLE;
