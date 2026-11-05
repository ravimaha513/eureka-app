-- Database least privilege for the API role (security review G-01, G-03; roadmap R-07). The table-wide
-- INSERT/UPDATE that 0003 gave eureka_app on person and candidate, and 0060 on job INSERT, become
-- column allow-lists, so a column added later is not writable by the API until a migration grants it
-- (fail closed), and server-managed columns without a guard (person.created_at, the encrypted DOB
-- columns, candidate.created_at / updated_at / row_version, ...) are not writable at all (rule 4).
-- The lists come from every INSERT/UPDATE apps/api issues on these tables
-- (candidates.service.ts create / bulk create / updateProfile / setRecruiter / setRating,
-- jobs.service.ts insert; dev seeds use subsets). Definer functions run as authz_definer with their
-- own column grants and are unaffected. G-02 (worker EXECUTE on authz.transition_candidate) is in
-- db/functions/authz/transition_candidate.sql.

SET ROLE eureka_owner;

-- person: the API only inserts (candidate create); it never updates a person row.
REVOKE INSERT, UPDATE ON eureka.person FROM eureka_app;
GRANT INSERT (id, first_name, last_name, phone_e164, personal_email) ON eureka.person TO eureka_app;

-- candidate INSERT: the create columns. The server-managed columns that the BEFORE INSERT guards
-- (candidate_insert_guard, candidate_profile_guard) already refuse or overwrite, with tests pinning
-- that answer (marketing_status, visibility, technical_rating, bench_since, row_version,
-- documents_status, team_assigned_at, created_at), stay granted so the guards keep answering; every
-- other column (updated_at, contact, profile and compliance columns) is now refused by privilege.
REVOKE INSERT, UPDATE ON eureka.candidate FROM eureka_app;
GRANT INSERT (person_id, technology_id, team_id, recruiter_id, location_id, batch_id,
              marketing_status, visibility, technical_rating, bench_since, row_version, documents_status, team_assigned_at,
              created_at)
  ON eureka.candidate TO eureka_app;

-- candidate UPDATE: the profile fields (updateProfile), recruiter_id (setRecruiter) and
-- technical_rating (setRating). team_id, visibility, marketing_status, location_id, documents_status,
-- everify_company_id and team_assigned_at stay granted only so that candidate_column_guard /
-- candidate_profile_guard keep refusing them with their own codes (pinned by rls, candidate-fields and
-- employees-gaps tests); the API changes them through definer functions only.
GRANT UPDATE (priority, marketing_email, vitel_number, marketing_start_date, in_person_ok, technology_id, batch_id,
              marketing_locations, linkedin_url, resume_url, eligibility, visa_category, gh_location_id, gh_remote,
              recruiter_id, technical_rating,
              team_id, visibility, marketing_status, location_id, documents_status, everify_company_id, team_assigned_at)
  ON eureka.candidate TO eureka_app;

-- job INSERT (jobs.service.ts insert); UPDATE was already column-limited (0060).
REVOKE INSERT ON eureka.job FROM eureka_app;
GRANT INSERT (kind, title, category, experience_level, employment_type, work_mode, status, deadline, work_hours,
              pay_amount, pay_frequency, pay_currency, client_id, company_id, location, skills, requirements,
              description, hiring_manager_id, published_to_portal)
  ON eureka.job TO eureka_app;

RESET ROLE;
