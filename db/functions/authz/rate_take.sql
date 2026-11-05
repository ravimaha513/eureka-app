-- authz.rate_take: current definition (repeatable; db/functions/README.md).
-- Created for migration 0486 (R-24). Change this file, not a new migration.
--
-- Shared fixed-window rate limiter: takes one unit for p_key in the current
-- window of p_window_seconds (windows are aligned to the epoch, so every API task
-- agrees on them) and returns true while the window's count is within p_limit.
-- One UPSERT; the key is stored only as SHA-256(key, window), never raw. The API
-- (platform/rate-limit.ts SharedRateLimiter) already sends a digest, not an IP,
-- email or user id. Called inside the request's transaction, a unit taken by a
-- request that then rolls back is given back; called on its own (autocommit) it
-- always counts.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.rate_take(p_key text, p_limit integer, p_window_seconds integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  ws timestamptz;
  cnt integer;
BEGIN
  IF p_key IS NULL OR pg_catalog.length(p_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_rate_key' USING ERRCODE = 'check_violation';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'invalid_rate_limit' USING ERRCODE = 'check_violation';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 604800 THEN
    RAISE EXCEPTION 'invalid_rate_window' USING ERRCODE = 'check_violation';
  END IF;
  ws := pg_catalog.to_timestamp(pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.now()) / p_window_seconds) * p_window_seconds);
  INSERT INTO authz.rate_window AS w (key_hash, window_start, expires_at, n)
  VALUES (pg_catalog.sha256(pg_catalog.convert_to(p_key || '|' || p_window_seconds::text, 'UTF8')), ws,
          ws + pg_catalog.make_interval(secs => p_window_seconds), 1)
  ON CONFLICT (key_hash, window_start) DO UPDATE SET n = w.n + 1
  RETURNING w.n INTO cnt;
  RETURN cnt <= p_limit;
END $function$;

REVOKE ALL ON FUNCTION authz.rate_take(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.rate_take(text, integer, integer) TO eureka_app;
RESET ROLE;
