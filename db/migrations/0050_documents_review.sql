-- Review follow-up for 0043 (step-up): a step-up flow that ends without a
-- usable ID token (the user cancelled at Google, Google returned an error, or
-- the token failed verification) still consumes its challenge, with its own
-- reason code instead of a misleading one. Every IF is NULL-safe (rule 1).
SET search_path = eureka, public;

SET ROLE authz_definer;

-- API: consumes the caller's challenge without granting step-up and audits
-- why (`cancelled`: no code / error from Google; `token_refused`: the ID token
-- failed verification). Same binding as authz.step_up_complete: the
-- challenge must belong to this session and user; an unknown or already
-- used challenge is reported, not consumed again.
CREATE FUNCTION authz.step_up_fail(p_session bytea, p_state_hash bytea, p_reason text)
RETURNS TABLE (outcome text, return_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c eureka.step_up_challenge%ROWTYPE; why text;
BEGIN
  IF NOT coalesce(authz.session_is_mine(p_session), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('cancelled', 'token_refused') THEN
    RAISE EXCEPTION 'invalid_step_up' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO c FROM eureka.step_up_challenge x
   WHERE x.state_hash = p_state_hash AND x.session_hash = p_session AND x.user_id = authz.current_user_id()
   FOR UPDATE;
  IF NOT FOUND THEN
    why := 'unknown_state';
  ELSIF c.used_at IS NOT NULL THEN
    why := 'replayed';
  ELSE
    why := p_reason;
    UPDATE eureka.step_up_challenge SET used_at = pg_catalog.now(), outcome = why WHERE state_hash = c.state_hash;
  END IF;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'auth.step_up_failed', 'app_user', authz.current_user_id(),
          pg_catalog.jsonb_build_object('method', 'google', 'reason', why));
  RETURN QUERY SELECT why, c.return_to;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.step_up_fail(bytea, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.step_up_fail(bytea, bytea, text) TO eureka_app;
