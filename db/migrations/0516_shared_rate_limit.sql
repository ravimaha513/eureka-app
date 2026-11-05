-- Shared-store rate limiter for security-relevant limits (R-24; docs/backend-audit F-06, B-09).
--
-- The API's in-memory limiters (apps/api/src/platform/rate-limit.ts) count per
-- task and reset on every deploy, so with N tasks a limit is N x its value. The
-- limits that protect data (password sign-in and reset, portal sign-up/link/verify,
-- public feedback, document and Data Hub downloads/uploads, exports) now also count
-- here, in one fixed-window counter per key shared by every task:
--
--   authz.rate_take(key, limit, window_seconds) -> boolean   (db/functions/authz/rate_take.sql)
--     one UPSERT; true while the window's count is within the limit.
--   authz.rate_purge() -> integer                             (db/functions/authz/rate_purge.sql)
--     deletes expired windows; for the worker (eureka_worker).
--
-- Keys are stored only as SHA-256 digests (the API also hashes before sending),
-- never as raw IPs, emails or user ids (rule 5 spirit). The table lives in the
-- authz schema, owned by authz_definer with no grants to anyone else (the
-- 0506 reporting_closure_pending pattern): the app reaches it only through the
-- two functions.

SET ROLE authz_definer;
CREATE TABLE authz.rate_window (
  key_hash     bytea       NOT NULL CHECK (pg_catalog.octet_length(key_hash) = 32),
  window_start timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  n            integer     NOT NULL CHECK (n > 0),
  PRIMARY KEY (key_hash, window_start)
);
-- authz.rate_purge deletes by expiry.
CREATE INDEX rate_window_expires ON authz.rate_window (expires_at);
REVOKE ALL ON authz.rate_window FROM PUBLIC;
RESET ROLE;
