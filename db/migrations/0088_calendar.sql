-- Support calendar (interview-alerts package; contract docs/alerts-calendar-birthdays.md CA-1..CA-6).
--   1. eureka.calendar_connection: the one shared connection to the support
--      team's Google Calendar (key 'support'): provider, calendar id, the
--      Google account that authorised it and the refresh token as AES-256-GCM
--      ciphertext under the API's CALENDAR_TOKEN_KEY (the key is not in the
--      database; the worker never reads this table). Read and written by
--      holders of calendar:block (Sales leads and up, interview coordinators).
--   2. eureka.calendar_block: one active block per interview on that calendar
--      (the provider's event id, the slot, who blocked it, release). Readable
--      wherever the interview is readable; written by calendar:block holders
--      who can read the interview. No candidate data: the interview id only.
-- Every IF is NULL-safe (rule 1); functions pin search_path (rule 2).
SET search_path = eureka, public;

SET ROLE eureka_owner;
CREATE TABLE eureka.calendar_connection (
  key           text PRIMARY KEY CHECK (key = 'support'),
  provider      text NOT NULL CHECK (provider IN ('google', 'dev')),
  calendar_id   text NOT NULL CHECK (char_length(calendar_id) BETWEEN 1 AND 200 AND calendar_id !~ '[[:cntrl:][:space:]]'),
  account_email citext NOT NULL CHECK (char_length(account_email::text) BETWEEN 3 AND 254),
  token_enc     text NOT NULL CHECK (char_length(token_enc) BETWEEN 1 AND 4000 AND token_enc ~ '^[A-Za-z0-9+/=]+$'),
  connected_by  uuid NOT NULL REFERENCES eureka.app_user(id),
  connected_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION eureka.calendar_connection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'calendar connections are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.connected_by := authz.current_user_id();
  NEW.connected_at := pg_catalog.now();
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_connection_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.calendar_connection
  FOR EACH ROW EXECUTE FUNCTION eureka.calendar_connection_guard();
CREATE TRIGGER calendar_connection_no_truncate BEFORE TRUNCATE ON eureka.calendar_connection
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.calendar_connection_guard();
ALTER TABLE eureka.calendar_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.calendar_connection FORCE ROW LEVEL SECURITY;

CREATE TABLE eureka.calendar_block (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES eureka.interview(id),
  calendar_id  text NOT NULL CHECK (char_length(calendar_id) BETWEEN 1 AND 200),
  external_id  text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200 AND external_id !~ '[[:cntrl:]]'),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL CHECK (ends_at > starts_at),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_by   uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_by  uuid REFERENCES eureka.app_user(id),
  released_at  timestamptz,
  CONSTRAINT calendar_block_release CHECK ((status = 'released') = (released_at IS NOT NULL))
);
CREATE UNIQUE INDEX calendar_block_active ON eureka.calendar_block (interview_id) WHERE status = 'active';
CREATE INDEX calendar_block_interview ON eureka.calendar_block (interview_id, created_at);

-- Insert: created_by / created_at server-set, always active. Update: only
-- active -> released, with released_by / released_at server-set. No delete.
CREATE FUNCTION eureka.calendar_block_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF authz.current_user_id() IS NULL THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.status := 'active';
    NEW.created_by := authz.current_user_id();
    NEW.created_at := pg_catalog.now();
    NEW.released_by := NULL;
    NEW.released_at := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM 'active' OR NEW.status IS DISTINCT FROM 'released'
       OR (pg_catalog.to_jsonb(NEW) - 'status' - 'released_by' - 'released_at')
          IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'status' - 'released_by' - 'released_at') THEN
      RAISE EXCEPTION 'a calendar block can only be released' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.released_by := authz.current_user_id();
    NEW.released_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'calendar blocks are never deleted' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER calendar_block_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.calendar_block
  FOR EACH ROW EXECUTE FUNCTION eureka.calendar_block_guard();
CREATE TRIGGER calendar_block_no_truncate BEFORE TRUNCATE ON eureka.calendar_block
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.calendar_block_guard();
ALTER TABLE eureka.calendar_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.calendar_block FORCE ROW LEVEL SECURITY;
RESET ROLE;

REVOKE ALL ON FUNCTION eureka.calendar_connection_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.calendar_block_guard() FROM PUBLIC;
REVOKE ALL ON eureka.calendar_connection, eureka.calendar_block FROM PUBLIC;

-- Connection: calendar:block holders only (any scope: the connection is shared).
GRANT SELECT, INSERT (key, provider, calendar_id, account_email, token_enc), UPDATE (provider, calendar_id, account_email, token_enc), DELETE
  ON eureka.calendar_connection TO eureka_app;
CREATE POLICY calendar_connection_read ON eureka.calendar_connection FOR SELECT TO eureka_app
  USING ((SELECT authz.has_perm('calendar:block')));
CREATE POLICY calendar_connection_write ON eureka.calendar_connection FOR INSERT TO eureka_app
  WITH CHECK ((SELECT authz.has_perm('calendar:block')));
CREATE POLICY calendar_connection_update ON eureka.calendar_connection FOR UPDATE TO eureka_app
  USING ((SELECT authz.has_perm('calendar:block'))) WITH CHECK ((SELECT authz.has_perm('calendar:block')));
CREATE POLICY calendar_connection_delete ON eureka.calendar_connection FOR DELETE TO eureka_app
  USING ((SELECT authz.has_perm('calendar:block')));

-- Blocks: readable with the interview; written by calendar:block holders who can read the interview.
GRANT SELECT, INSERT (interview_id, calendar_id, external_id, starts_at, ends_at), UPDATE (status) ON eureka.calendar_block TO eureka_app;
CREATE POLICY calendar_block_read ON eureka.calendar_block FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.interview i WHERE i.id = calendar_block.interview_id));
CREATE POLICY calendar_block_insert ON eureka.calendar_block FOR INSERT TO eureka_app
  WITH CHECK ((SELECT authz.has_perm('calendar:block'))
              AND EXISTS (SELECT 1 FROM eureka.interview i WHERE i.id = calendar_block.interview_id));
CREATE POLICY calendar_block_update ON eureka.calendar_block FOR UPDATE TO eureka_app
  USING ((SELECT authz.has_perm('calendar:block'))
         AND EXISTS (SELECT 1 FROM eureka.interview i WHERE i.id = calendar_block.interview_id))
  WITH CHECK ((SELECT authz.has_perm('calendar:block')));
