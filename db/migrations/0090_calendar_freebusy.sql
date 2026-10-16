-- Support calendar free/busy (interview-alerts package; docs/alerts-calendar-birthdays.md CA-7).
--   1. calendar_connection.scopes: the OAuth scopes Google granted when the
--      connection was made (space-separated, as the token response lists them).
--      Connections made before this migration have '' and need a reconnect
--      before the free/busy check works (the card offers it).
--   2. authz.calendar_freebusy_connection(): the connection row for the
--      free/busy read, for holders of calendar:block OR interview:create. The
--      table's own policies stay calendar:block only (the recruiter who schedules
--      an interview never reads the table); the definer function returns the
--      ciphertext the API needs for one read and nothing it can change.
-- Every IF is NULL-safe (rule 1); functions pin search_path (rule 2).
SET search_path = eureka, public;

SET ROLE eureka_owner;
ALTER TABLE eureka.calendar_connection
  ADD COLUMN scopes text NOT NULL DEFAULT '' CHECK (char_length(scopes) <= 2000 AND scopes !~ '[[:cntrl:]]');
RESET ROLE;

GRANT INSERT (scopes), UPDATE (scopes) ON eureka.calendar_connection TO eureka_app;
GRANT SELECT ON eureka.calendar_connection TO authz_definer;
CREATE POLICY definer_read ON eureka.calendar_connection FOR SELECT TO authz_definer USING (true);

SET ROLE authz_definer;
CREATE FUNCTION authz.calendar_freebusy_connection()
RETURNS TABLE (provider text, calendar_id text, token_enc text, scopes text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.provider, k.calendar_id, k.token_enc, k.scopes
    FROM eureka.calendar_connection k
   WHERE k.key = 'support'
     AND authz.current_user_id() IS NOT NULL
     AND (authz.has_perm('calendar:block') OR authz.has_perm('interview:create'))
$$;
RESET ROLE;
REVOKE ALL ON FUNCTION authz.calendar_freebusy_connection() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.calendar_freebusy_connection() TO eureka_app;
