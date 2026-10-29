-- Emailed set-password links (docs/admin-api.md, "Password invite").
--
--   * An org admin sends a user a one-time link instead of choosing a
--     temporary password; the admin never sees the password. The user opens
--     the link, picks a password and is signed in (must_change = false).
--   * Same gates as 0083: password_login = 'on' (staging and local only),
--     access:manage, never one's own account, never a user holding a
--     restricted role (AD-3).
--   * Only the SHA-256 of the token is stored. The API makes the token and
--     emails it; nothing here sees or logs it. A link works once, expires
--     (1 to 168 hours, default 72) and a newer link for the same user
--     replaces any open one.
--   * Functions: authz.admin_issue_password_setup and
--     authz.password_setup_redeem (db/functions/authz/).

SET ROLE authz_definer;
CREATE TABLE authz.password_setup_token (
  token_hash  bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id     uuid NOT NULL,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX password_setup_token_user ON authz.password_setup_token (user_id) WHERE used_at IS NULL;
REVOKE ALL ON authz.password_setup_token FROM PUBLIC;
RESET ROLE;

SET ROLE eureka_owner;
-- The two functions write their own audit rows (no token, no email): the admin
-- who sent the link, and the user who used it (no session yet).
CREATE POLICY password_setup_definer_audit ON eureka.audit_event FOR INSERT TO authz_definer WITH CHECK (
  (SELECT authz.password_login_enabled())
  AND entity_type = 'app_user'
  AND ((action = 'admin.user.password_invite' AND actor_id IS NOT NULL AND actor_id = (SELECT authz.current_user_id()))
       OR (action = 'auth.password_setup' AND actor_id IS NOT NULL AND actor_id = entity_id)));
RESET ROLE;
