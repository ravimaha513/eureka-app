-- Portal sign-in caps that a few addresses cannot use to lock everyone out
-- (security review E-01, roadmap R-05; docs/jobs-portal-api.md JP-10/JP-11).
--
--   * The database-wide hourly link cap (portal_throttle kind 'link') now
--     counts and limits only links to UNVERIFIED addresses (sign-up
--     confirmations). Links to verified applicants are exempt from it: they
--     stay bound by the per-applicant limits (one per p_cooldown seconds,
--     p_max an hour), so a burst of sign-ups for made-up addresses can no
--     longer stop existing applicants from signing in. The sign-up cap (kind
--     'signup') is unchanged. portal_throttle's CHECK on kind is unchanged.
--   * The functions now say which cap stopped a request (cap_reached:
--     'signup' | 'link' | NULL) so the API can log `portal_cap_reached`
--     {kind} for alerting. The value is a kind only: no address, no id of the
--     caller. The HTTP answer does not change (the work runs after the reply).
--
-- Return types change, so the three functions are dropped and created again
-- here (none of them has a db/functions file; portal_take is unchanged).
-- Hardening as in 0061: SECURITY DEFINER owned by authz_definer, pinned
-- search_path, no PUBLIC execute, portal_sign_up / portal_issue_link to
-- eureka_app only, portal_link_insert internal (owner only). NULL-safe IFs.

SET ROLE authz_definer;

DROP FUNCTION authz.portal_sign_up(text, text, text, text, uuid, bytea, integer, integer, integer, integer, integer);
DROP FUNCTION authz.portal_issue_link(text, uuid, bytea, integer, integer, integer, integer);
DROP FUNCTION authz.portal_link_insert(uuid, uuid, bytea, integer, integer, integer, integer, text, text, text);

-- Issues a link for an active applicant unless: one was issued in the last p_cooldown seconds, p_max were issued
-- this hour, or (unverified address only) the global hourly cap p_global of links to unverified addresses is
-- reached. Only ISSUED links count (a suppressed request changes nothing, so an attacker cannot lock a victim out
-- by asking). p_first/p_last/p_phone: what the sign-up request submitted (NULL for a plain sign-in). Internal.
-- Returns 'issued', 'limited' (per-applicant limits) or 'capped' (the global cap).
CREATE FUNCTION authz.portal_link_insert(p_applicant uuid, p_link uuid, p_hash bytea, p_ttl_minutes integer, p_max integer,
                                         p_cooldown integer, p_global integer, p_first text, p_last text, p_phone text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer; verified boolean;
BEGIN
  IF p_link IS NULL OR p_hash IS NULL OR octet_length(p_hash) IS DISTINCT FROM 32
     OR p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 30 OR p_max IS NULL OR p_max < 1 OR p_max > 60
     OR p_cooldown IS NULL OR p_cooldown < 0 OR p_cooldown > 3600 OR p_global IS NULL OR p_global < 1 THEN
    RAISE EXCEPTION 'invalid_link_request' USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.email_verified_at IS NOT NULL INTO verified FROM eureka.applicant a WHERE a.id = p_applicant FOR UPDATE;
  DELETE FROM eureka.applicant_login_link l WHERE l.applicant_id = p_applicant AND l.created_at < pg_catalog.now() - interval '1 day';
  IF EXISTS (SELECT 1 FROM eureka.applicant_login_link l WHERE l.applicant_id = p_applicant
              AND l.created_at > pg_catalog.now() - pg_catalog.make_interval(secs => p_cooldown)) THEN
    RETURN 'limited';
  END IF;
  SELECT count(*) INTO n FROM eureka.applicant_login_link l
   WHERE l.applicant_id = p_applicant AND l.created_at > pg_catalog.now() - interval '1 hour';
  IF coalesce(n, 0) >= p_max THEN
    RETURN 'limited';
  END IF;
  -- Verified applicants: per-applicant limits only. Everyone else shares the global budget.
  IF NOT coalesce(verified, false) AND NOT coalesce(authz.portal_take('link', p_global), false) THEN
    RETURN 'capped';
  END IF;
  INSERT INTO eureka.applicant_login_link (id, applicant_id, secret_hash, created_at, expires_at, pending_first_name, pending_last_name, pending_phone)
  VALUES (p_link, p_applicant, p_hash, pg_catalog.now(), pg_catalog.now() + pg_catalog.make_interval(mins => p_ttl_minutes), p_first, p_last, p_phone);
  RETURN 'issued';
END $$;

-- JP-10 sign-up. An unknown email creates an unverified applicant (subject to the global hourly cap of new accounts);
-- an existing row (verified or not) is NEVER changed here: what this request submitted travels on the link and is
-- applied at redemption, to an unverified row only. Either way a link is issued when the limits allow. Returns no
-- row when nothing was created or found, and a row with applicant_id NULL and cap_reached 'signup' when the
-- new-account cap refused it; the API answers the caller the same way in every case.
CREATE FUNCTION authz.portal_sign_up(p_first text, p_last text, p_email text, p_phone text,
                                     p_link uuid, p_hash bytea, p_ttl_minutes integer, p_max integer,
                                     p_cooldown integer, p_global_links integer, p_global_signups integer)
RETURNS TABLE (applicant_id uuid, existing boolean, issued boolean, cap_reached text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE a record; e text := pg_catalog.lower(p_email); r text;
BEGIN
  IF p_email IS NULL OR p_first IS NULL OR p_last IS NULL THEN
    RAISE EXCEPTION 'invalid_sign_up' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x.id, x.status, x.email_verified_at INTO a FROM eureka.applicant x WHERE x.email = e;
  IF a.id IS NULL THEN
    IF NOT coalesce(authz.portal_take('signup', p_global_signups), false) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::boolean, false, 'signup'::text;
      RETURN;
    END IF;
    INSERT INTO eureka.applicant (first_name, last_name, email, phone_e164) VALUES (p_first, p_last, e, p_phone)
    ON CONFLICT (email) DO NOTHING;
    SELECT x.id, x.status, x.email_verified_at INTO a FROM eureka.applicant x WHERE x.email = e;
    IF a.id IS NULL THEN
      RETURN;
    END IF;
  END IF;
  IF a.status IS DISTINCT FROM 'active' THEN
    RETURN;
  END IF;
  r := authz.portal_link_insert(a.id, p_link, p_hash, p_ttl_minutes, p_max, p_cooldown, p_global_links, p_first, p_last, p_phone);
  RETURN QUERY SELECT a.id, a.email_verified_at IS NOT NULL, r = 'issued', CASE WHEN r = 'capped' THEN 'link' END;
END $$;

-- JP-11 sign-in link for an existing active applicant (no row when the email is unknown).
CREATE FUNCTION authz.portal_issue_link(p_email text, p_link uuid, p_hash bytea, p_ttl_minutes integer, p_max integer,
                                        p_cooldown integer, p_global_links integer)
RETURNS TABLE (applicant_id uuid, issued boolean, cap_reached text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE a record; r text;
BEGIN
  SELECT x.id INTO a FROM eureka.applicant x WHERE x.email = pg_catalog.lower(p_email) AND x.status = 'active';
  IF a.id IS NULL THEN
    RETURN;
  END IF;
  r := authz.portal_link_insert(a.id, p_link, p_hash, p_ttl_minutes, p_max, p_cooldown, p_global_links, NULL, NULL, NULL);
  RETURN QUERY SELECT a.id, r = 'issued', CASE WHEN r = 'capped' THEN 'link' END;
END $$;

REVOKE ALL ON FUNCTION authz.portal_link_insert(uuid, uuid, bytea, integer, integer, integer, integer, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_sign_up(text, text, text, text, uuid, bytea, integer, integer, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_issue_link(text, uuid, bytea, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.portal_sign_up(text, text, text, text, uuid, bytea, integer, integer, integer, integer, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.portal_issue_link(text, uuid, bytea, integer, integer, integer, integer) TO eureka_app;

RESET ROLE;
