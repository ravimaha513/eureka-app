-- One-statement staff request authentication (R-25; docs/backend-audit F-03).
--
-- authz.request_context(id_hash, idle_minutes, check_password)
-- (db/functions/authz/request_context.sql) validates and touches the session and
-- returns the user id, auth_time, the access facts and the temporary-password flag
-- in one round trip; platform/auth.guard.ts calls it once per request on one
-- connection. Access is still read from current rows on every request (no cache).
--
-- The function runs as authz_definer, which already reads id_hash, user_id,
-- expires_at, revoked_at and last_seen_at (0043, 0070); it also needs auth_time
-- and the once-a-minute last_seen_at touch the API used to do itself.

GRANT SELECT (auth_time) ON eureka.session TO authz_definer;
GRANT UPDATE (last_seen_at) ON eureka.session TO authz_definer;
