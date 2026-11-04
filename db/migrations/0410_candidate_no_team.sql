-- A candidate can be created before their team is decided and given one later.
--
--   1. eureka.candidate.team_id becomes nullable. NULL means "No team yet".
--   2. candidate_insert: a holder of candidate:create may insert a candidate with no
--      team when they are its recruiter. That keeps it visible to them and their
--      reporting line (recruiter scope) until a team is chosen. Org scope needs no
--      recruiter, as before.
--   3. authz.candidate_duplicates: LEFT JOIN team, so a candidate with no team still
--      shows up as a duplicate.
--   4. eureka.candidate_team_invariant (0006): with no team there is no membership to
--      check; the recruiter must then be the creator (insert) or stay as it was (update).
--
-- In db/functions: authz.assign_candidate_team (new), authz.transition_candidate (no
-- team, no Hot List) and eureka.candidate_column_guard (a team is never cleared).
SET ROLE eureka_owner;
ALTER TABLE eureka.candidate ALTER COLUMN team_id DROP NOT NULL;
RESET ROLE;

DROP POLICY candidate_insert ON eureka.candidate;
CREATE POLICY candidate_insert ON eureka.candidate FOR INSERT TO eureka_app WITH CHECK (
  (SELECT authz.has_org('candidate:create'))
  OR team_id = ANY ((SELECT authz.team_ids('candidate:create'))::uuid[])
  OR (recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:create'))::uuid[])
      AND team_id = (SELECT authz.actor_team()))
  OR (team_id IS NULL AND recruiter_id = (SELECT authz.current_user_id())
      AND (SELECT authz.has_perm('candidate:create')))
);

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.candidate_duplicates(p_first text, p_last text, p_email text, p_phone text)
RETURNS TABLE (candidate_id uuid, team_name text, contact_name text, matched_on text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  em text := nullif(pg_catalog.lower(pg_catalog.btrim(p_email)), '');
  ph text := nullif(pg_catalog.btrim(p_phone), '');
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_perm('candidate:create'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF nullif(pg_catalog.btrim(p_first), '') IS NULL OR nullif(pg_catalog.btrim(p_last), '') IS NULL
     OR (em IS NULL AND ph IS NULL) THEN
    RAISE EXCEPTION 'name_and_contact_required' USING ERRCODE = 'check_violation';
  END IF;
  IF (ph IS NOT NULL AND NOT coalesce(ph ~ '^\+[1-9][0-9]{7,14}$', false))
     OR (em IS NOT NULL AND NOT coalesce(pg_catalog.char_length(em) <= 254 AND em ~ '^[^@[:space:]]+@[^@[:space:]]+$', false)) THEN
    RAISE EXCEPTION 'invalid_contact' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  WITH m AS (
    -- person_email_lower, candidate_marketing_email_lower, person_phone (0026)
    SELECT c.id, 'email'::text AS kind FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
     WHERE em IS NOT NULL AND p.personal_email IS NOT NULL AND pg_catalog.lower(p.personal_email::text) = em
    UNION
    SELECT c.id, 'email' FROM eureka.candidate c
     WHERE em IS NOT NULL AND c.marketing_email IS NOT NULL AND pg_catalog.lower(c.marketing_email::text) = em
    UNION
    SELECT c.id, 'phone' FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
     WHERE ph IS NOT NULL AND p.phone_e164 IS NOT NULL AND p.phone_e164 = ph
  ),
  ids AS (
    SELECT m.id, pg_catalog.bool_or(m.kind = 'email') AS by_email, pg_catalog.bool_or(m.kind = 'phone') AS by_phone
    FROM m GROUP BY m.id
  ),
  hits AS (
    -- LATERAL keeps this a primary-key probe per match (a plain join was
    -- planned as a hash join over every candidate).
    SELECT ids.id, c.team_id, c.created_at, ids.by_email, ids.by_phone
    FROM ids CROSS JOIN LATERAL (
      SELECT cd.team_id, cd.created_at FROM eureka.candidate cd WHERE cd.id = ids.id) c
    ORDER BY c.created_at, ids.id
    LIMIT 3
  )
  SELECT CASE WHEN coalesce(authz.candidate_visible(h.id, 'candidate:read'), false) THEN h.id END,
         coalesce(t.name, 'No team yet'), u.display_name,
         pg_catalog.array_remove(ARRAY[CASE WHEN h.by_email THEN 'email' END, CASE WHEN h.by_phone THEN 'phone' END], NULL)
  FROM hits h
  LEFT JOIN eureka.team t ON t.id = h.team_id
  LEFT JOIN eureka.app_user u ON u.id = t.lead_id
  ORDER BY h.created_at, h.id;
END $$;
RESET ROLE;

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.candidate_team_invariant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.team_id IS NULL THEN
    -- No team yet: the recruiter link is what keeps the candidate in its creator's scope.
    IF NEW.recruiter_id IS NOT NULL
       AND NOT coalesce(CASE WHEN TG_OP = 'INSERT' THEN NEW.recruiter_id = authz.current_user_id()
                             ELSE NEW.recruiter_id IS NOT DISTINCT FROM OLD.recruiter_id END, false) THEN
      RAISE EXCEPTION 'recruiter is not a member of the candidate''s team' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.recruiter_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM eureka.team_member tm
       WHERE tm.team_id = NEW.team_id AND tm.user_id = NEW.recruiter_id AND tm.valid @> now()
       UNION ALL
       SELECT 1 FROM eureka.team t WHERE t.id = NEW.team_id AND t.lead_id = NEW.recruiter_id) THEN
    RAISE EXCEPTION 'recruiter is not a member of the candidate''s team' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eureka.candidate_team_invariant() FROM PUBLIC;
RESET ROLE;
