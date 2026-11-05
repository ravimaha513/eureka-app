-- authz.request_context: current definition (repeatable; db/functions/README.md).
-- since: 0521
-- Created for migration 0517 (R-25; docs/backend-audit F-03). Change this file, not a new migration.
--
-- Per-request staff authentication in ONE statement on ONE connection
-- (platform/auth.guard.ts). Replaces the session lookup CTE (SessionService.resolve),
-- the access load (AccessService.load) and authz.password_must_change(), which used
-- to take two pool checkouts and five or six round trips before every handler.
--
--   * Session: the same rule as before: not revoked, not past expires_at, seen
--     within p_idle_minutes, user active. last_seen_at is written at most once a
--     minute. No row returned = sign in again (401).
--   * Access: the facts the engine needs, read from current rows on every call
--     (no cache, so a revoked role or team change applies on the very next
--     request). Same subqueries as AccessService.load, returned as json with the
--     same keys (roles, teams, subs, subtree, coached, subtree_coached, shared);
--     test/request-context.db.int.test.ts compares the two for every seeded user.
--   * must_change: authz.password_must_change() for the session's user when
--     p_check_password (PASSWORD_LOGIN=on), else false.
--
-- The scope helpers (authz.shared_candidate_ids and the ones it calls) and
-- password_must_change read the caller from eureka.user_id, so the function sets
-- it to the session's user for its own statements and restores the previous value
-- before returning. VOLATILE, not STABLE: it touches last_seen_at.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.request_context(p_id_hash bytea, p_idle_minutes integer, p_check_password boolean)
 RETURNS TABLE(user_id uuid, auth_time timestamptz, access json, must_change boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  uid uuid;
  authed timestamptz;
  seen timestamptz;
  prev text;
  acc json;
  mc boolean;
BEGIN
  IF p_id_hash IS NULL OR p_idle_minutes IS NULL THEN
    RETURN;
  END IF;
  SELECT s.user_id, s.auth_time, s.last_seen_at INTO uid, authed, seen
  FROM eureka.session s
  JOIN eureka.app_user u ON u.id = s.user_id AND u.status = 'active'
  WHERE s.id_hash = p_id_hash AND s.revoked_at IS NULL AND s.expires_at > pg_catalog.now()
    AND s.last_seen_at > pg_catalog.now() - pg_catalog.make_interval(mins => p_idle_minutes);
  IF uid IS NULL THEN
    RETURN;
  END IF;
  IF seen IS NULL OR seen < pg_catalog.now() - interval '1 minute' THEN
    UPDATE eureka.session s SET last_seen_at = pg_catalog.now() WHERE s.id_hash = p_id_hash;
  END IF;

  prev := pg_catalog.current_setting('eureka.user_id', true);
  PERFORM pg_catalog.set_config('eureka.user_id', uid::text, true);

  SELECT pg_catalog.json_build_object(
    -- Each current role with its grants and traits as stored (docs/roles-api.md).
    'roles', COALESCE((SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
                'role_key', ur.role_key, 'label', r.label, 'location_id', ur.location_id,
                'grants', COALESCE((SELECT pg_catalog.json_object_agg(rp.permission, rp.scope)
                                    FROM eureka.role_permission rp WHERE rp.role_key = ur.role_key), '{}'::json),
                'traits', pg_catalog.json_build_object('sales', r.is_sales, 'locationBound', r.is_location_bound, 'admin', r.is_admin,
                                                       'recruiter', r.is_recruiter, 'coach', r.is_coach)))
              FROM eureka.user_role ur JOIN eureka.role r ON r.key = ur.role_key
              WHERE ur.user_id = uid AND ur.valid @> pg_catalog.now()), '[]'::json),
    -- A lead's team is the one they lead, never one they are a member of (authz.team_ids / actor_team, 0210).
    'teams', ARRAY(SELECT t.id FROM (
               SELECT tl.id, 0 AS k FROM eureka.team tl WHERE tl.lead_id = uid
               UNION ALL
               SELECT tm.team_id, 1 FROM eureka.team_member tm WHERE tm.user_id = uid AND tm.valid @> pg_catalog.now()
                 AND NOT EXISTS (SELECT 1 FROM eureka.team tx WHERE tx.lead_id = uid)) t
             ORDER BY t.k, t.id)::text[],
    'subs', ARRAY(SELECT rc.descendant_id FROM eureka.reporting_closure rc WHERE rc.ancestor_id = uid)::text[],
    'subtree', ARRAY(SELECT t.id FROM eureka.team t WHERE t.lead_id = uid
                     UNION SELECT t.id FROM eureka.team t JOIN eureka.reporting_closure rc ON rc.descendant_id = t.lead_id
                     WHERE rc.ancestor_id = uid)::text[],
    'coached', ARRAY(SELECT ca.team_id FROM eureka.coach_assignment ca WHERE ca.coach_id = uid AND ca.valid @> pg_catalog.now())::text[],
    -- coached_hierarchy (Interview Lead): teams coached by the user or anyone below (authz.coached_team_ids, 0220).
    'subtree_coached', ARRAY(SELECT DISTINCT ca.team_id FROM eureka.coach_assignment ca
                             WHERE ca.valid @> pg_catalog.now()
                               AND (ca.coach_id = uid OR ca.coach_id IN (SELECT rc.descendant_id FROM eureka.reporting_closure rc WHERE rc.ancestor_id = uid))
                            )::text[],
    -- "Selected teams" shares reaching the caller's teams (0240); same set the candidate_read policy uses.
    'shared', authz.shared_candidate_ids('candidate:read')::text[]
  ) INTO acc;

  mc := coalesce(p_check_password, false) AND coalesce(authz.password_must_change(), false);

  PERFORM pg_catalog.set_config('eureka.user_id', coalesce(prev, ''), true);
  RETURN QUERY SELECT uid, authed, acc, mc;
END $function$;

REVOKE ALL ON FUNCTION authz.request_context(bytea, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.request_context(bytea, integer, boolean) TO eureka_app;
RESET ROLE;
