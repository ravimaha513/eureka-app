-- Coaches' own Google Calendars on the coach calendar (docs/coach-calendar-api.md CC-6..CC-8).
--   1. eureka.coach_google_connection: one row per coach who connected, holding the refresh token
--      as AES-256-GCM ciphertext under the API's CALENDAR_TOKEN_KEY (the key is not in the
--      database). Events are read live from Google and are never stored here or anywhere else.
--      No direct access for eureka_app: the row is only reachable through the functions below.
--   2. authz.coach_google_connect(): a coach connects themself, and only the Google account they
--      sign in to Eureka with, so nobody can attach somebody else's calendar.
--   3. authz.coach_google_connections(): tokens only for coaches the caller may already see
--      (authz.coach_calendar_visible, 0540), with the detail that grant allows.
-- Who sees what stays the CEO's decision: this adds no new way to reach a coach's column.
-- No account email, token or event title in audit (rule 5).
-- Every IF is NULL-safe (rule 1); functions pin search_path (rule 2).

SET ROLE eureka_owner;
CREATE TABLE eureka.coach_google_connection (
  user_id       uuid PRIMARY KEY REFERENCES eureka.app_user(id),
  provider      text NOT NULL CHECK (provider IN ('google', 'dev')),
  account_email text NOT NULL CHECK (char_length(account_email) BETWEEN 3 AND 254),
  token_enc     text NOT NULL CHECK (char_length(token_enc) BETWEEN 1 AND 4000 AND token_enc ~ '^[A-Za-z0-9+/=]+$'),
  scopes        text NOT NULL CHECK (char_length(scopes) <= 2000),
  connected_at  timestamptz NOT NULL DEFAULT now()
);

-- connected_at is server-managed (rule 4).
CREATE FUNCTION eureka.coach_google_connection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.connected_at := pg_catalog.now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eureka.coach_google_connection_guard() FROM PUBLIC;
CREATE TRIGGER coach_google_connection_guard BEFORE INSERT OR UPDATE ON eureka.coach_google_connection
  FOR EACH ROW EXECUTE FUNCTION eureka.coach_google_connection_guard();

ALTER TABLE eureka.coach_google_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.coach_google_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_read ON eureka.coach_google_connection FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.coach_google_connection FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.coach_google_connection FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.coach_google_connection FOR DELETE TO authz_definer USING (true);
RESET ROLE;

REVOKE ALL ON eureka.coach_google_connection FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON eureka.coach_google_connection TO authz_definer;

SET ROLE authz_definer;
-- The caller's own state, for the connect bar and the sign-in hint.
CREATE FUNCTION authz.coach_google_me()
RETURNS TABLE (can_connect boolean, connected boolean, account_email text, login_email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM eureka.user_role ur
                  WHERE ur.user_id = u.id AND ur.role_key = 'interview_coach' AND ur.valid @> pg_catalog.now()),
         k.user_id IS NOT NULL, k.account_email, u.email::text
    FROM eureka.app_user u
    LEFT JOIN eureka.coach_google_connection k ON k.user_id = u.id
   WHERE u.id = authz.current_user_id() AND u.status = 'active'
$$;
REVOKE ALL ON FUNCTION authz.coach_google_me() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_google_me() TO eureka_app;

-- Connections of the coaches the caller may see. The API decrypts the token to ask Google, and
-- removes titles itself where the detail is 'busy'.
CREATE FUNCTION authz.coach_google_connections()
RETURNS TABLE (coach_id uuid, detail text, provider text, token_enc text, scopes text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.coach_id, v.detail, k.provider, k.token_enc, k.scopes
    FROM authz.coach_calendar_visible() v
    JOIN eureka.coach_google_connection k ON k.user_id = v.coach_id
$$;
REVOKE ALL ON FUNCTION authz.coach_google_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_google_connections() TO eureka_app;

CREATE FUNCTION authz.coach_google_connect(p_provider text, p_email text, p_token_enc text, p_scopes text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_me uuid := authz.current_user_id();
  v_login text;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The lock orders this against admin_set_user_status, whose DELETE could not see an uncommitted row.
  SELECT u.email::text INTO v_login FROM eureka.app_user u WHERE u.id = v_me AND u.status = 'active' FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
       SELECT 1 FROM eureka.user_role ur
        WHERE ur.user_id = v_me AND ur.role_key = 'interview_coach' AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_email IS NULL OR pg_catalog.lower(p_email) IS DISTINCT FROM pg_catalog.lower(v_login) THEN
    RAISE EXCEPTION 'wrong_account' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.coach_google_connection AS k (user_id, provider, account_email, token_enc, scopes)
  VALUES (v_me, p_provider, pg_catalog.lower(p_email), p_token_enc, p_scopes)
  ON CONFLICT (user_id) DO UPDATE SET provider = EXCLUDED.provider, account_email = EXCLUDED.account_email,
    token_enc = EXCLUDED.token_enc, scopes = EXCLUDED.scopes;
END $$;
REVOKE ALL ON FUNCTION authz.coach_google_connect(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_google_connect(text, text, text, text) TO eureka_app;

-- Removes the caller's own connection and returns the token so the API can revoke it at Google.
-- Google revokes per account and OAuth client, so `revocable` is false when this same account also
-- holds the shared support calendar: revoking would disconnect that for everyone.
CREATE FUNCTION authz.coach_google_disconnect()
RETURNS TABLE (provider text, token_enc text, revocable boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY DELETE FROM eureka.coach_google_connection k
    WHERE k.user_id = authz.current_user_id()
    RETURNING k.provider, k.token_enc, NOT EXISTS (
      SELECT 1 FROM eureka.calendar_connection s
       WHERE pg_catalog.lower(s.account_email::text) = pg_catalog.lower(k.account_email));
END $$;
REVOKE ALL ON FUNCTION authz.coach_google_disconnect() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_google_disconnect() TO eureka_app;
RESET ROLE;
