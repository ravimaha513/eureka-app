-- Indexes on foreign-key and filter columns that had none (perf review, 2026-10-30).
--
-- Each index was checked against every CREATE INDEX in db/migrations: none of
-- them leads with the listed columns (candidate_visibility leads with
-- visibility, submission_dup with candidate_id, job_team / job_owner /
-- job_hiring_manager are other columns). Column names and NOT NULL come from
-- the defining CREATE TABLE or ADD COLUMN (0002, 0003, 0017, 0060).
--
-- Plain CREATE INDEX: migrations run in a transaction, so CONCURRENTLY is not
-- possible here. The tables are small enough that the share lock is brief;
-- IF NOT EXISTS keeps a re-run harmless.
--
--   1. interview (submission_id): the FK is unindexed; submission detail and
--      the FK check on submission delete scan interview.
--   2. candidate (technology_id, marketing_status): hotlist and pipeline
--      filters by technology and status.
--   3. candidate (gh_location_id) where set: the FK and the location filter;
--      most candidates have no GH location, so the index is partial.
--   4. interview (client_id, starts_at): client-scoped interview lists and
--      reports, ordered by time (interview.client_id, 0017).
--   5. job (client_id, status): client requirement lists by status (job.client_id, 0060).
--   6. job (company_id): the FK (ON DELETE RESTRICT checks scan job) and the
--      internal-opening company filter.
--   7. team_member (team_id): the FK and team membership lookups. The table's
--      only other index is the exclusion constraint on (user_id, valid).
--   8. submission (client_id): the FK and client-scoped submission lists.
--      submission_dup leads with candidate_id, so it does not serve these.
SET search_path = eureka, public;

SET ROLE eureka_owner;
CREATE INDEX IF NOT EXISTS interview_submission ON eureka.interview (submission_id);
CREATE INDEX IF NOT EXISTS candidate_technology_status ON eureka.candidate (technology_id, marketing_status);
CREATE INDEX IF NOT EXISTS candidate_gh_location ON eureka.candidate (gh_location_id) WHERE gh_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interview_client_time ON eureka.interview (client_id, starts_at);
CREATE INDEX IF NOT EXISTS job_client_status ON eureka.job (client_id, status);
CREATE INDEX IF NOT EXISTS job_company ON eureka.job (company_id);
CREATE INDEX IF NOT EXISTS team_member_team ON eureka.team_member (team_id);
CREATE INDEX IF NOT EXISTS submission_client ON eureka.submission (client_id);
RESET ROLE;
