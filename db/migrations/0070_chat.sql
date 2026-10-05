-- Internal staff chat (docs/chat-api.md; reference screens "Chat"): direct
-- and group conversations between app users (applicants never: only
-- eureka.app_user rows with a valid role holding chat:use can take part).
--
--   * eureka.chat_conversation: direct (one per user pair, `direct_key` =
--     the two user ids sorted) or group (`name`, owners and members).
--     `last_seq` / `last_rev` are the newest message sequence and change
--     revision, kept under the conversation's row lock (see "Ordering").
--     A group deleted by an owner is soft-deleted (`deleted_at`) for everyone.
--   * eureka.chat_member: who is in a conversation (role owner/member,
--     joined_at, left_at). Readable by the conversation's current members.
--   * eureka.chat_member_state: one member's own view: read position
--     (`last_read_message_id` / `last_read_seq`), archived, favorite, muted,
--     hidden ("delete chat" of a direct chat), `visible_after_seq` (messages
--     at or before it are not visible to that member: sent before they joined
--     or before they deleted the direct chat), `last_viewed_at` and
--     `notified_at` (the 10-minute direct-message notification). Readable by
--     that member only.
--   * eureka.chat_message: body up to 4000 characters (plain text, newlines
--     and tabs only), `seq` (order of creation) and `rev` (order of last
--     change) from one sequence, `client_id` (idempotent sends), soft delete
--     (`deleted_at`, the body is cleared).
--   * eureka.chat_attachment: a file of the documents pipeline (0043
--     `eureka.file_object`, classification internal): presigned upload into
--     quarantine/documents/<file id>, the worker's `document-scan` job, a
--     download only once clean. The file name is shown to the conversation's
--     members only; it never reaches audit or outbox rows.
--
-- Access (CH-2): a user sees only conversations they are a current member of
-- (left members and members of a deleted group have no access, history
-- included), and only messages after their `visible_after_seq`. Nobody else
-- reads chats: org admins and auditors get no policy (CH-9). Reads go through
-- RLS with the conversation set as an InitPlan feeding a hashed SubPlan
-- (rule 3) and the member's own state row by primary key.
-- Writes only through the SECURITY DEFINER functions below, which re-check
-- chat:use and membership (rule 6); the guard trigger refuses every other
-- writer and every DELETE/TRUNCATE (rule 4).
--
-- Ordering: every function that assigns `seq`/`rev` first locks the
-- conversation row, so within one conversation revisions become visible in
-- commit order and a poll with `rev > cursor` never skips one.
--
-- Audit (CH-10, rule 5): ids, kinds, roles and counts only. Never message
-- text, conversation names, file names or display names.
-- Notification (CH-8): `chat.direct_message` (ids only) for the other member
-- of a direct chat when they have not viewed it for 10 minutes, once per
-- unseen stretch, never when muted; the registry resolves the recipient.
-- Every IF is NULL-safe (rule 1).
SET search_path = eureka, public;

-- ---------- tables ----------
SET ROLE eureka_owner;

CREATE SEQUENCE eureka.chat_rev_seq AS bigint;

CREATE TABLE eureka.chat_conversation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('direct', 'group')),
  name            text CHECK (name IS NULL OR (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]' AND name = btrim(name))),
  -- Direct chats: '<smaller user id>:<larger user id>' (one conversation per pair).
  direct_key      text UNIQUE CHECK (direct_key IS NULL OR direct_key ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$'),
  created_by      uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  last_seq        bigint NOT NULL DEFAULT 0,
  last_rev        bigint NOT NULL DEFAULT 0,
  deleted_at      timestamptz,
  row_version     integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT chat_conversation_kind CHECK (
    (kind = 'direct' AND direct_key IS NOT NULL AND name IS NULL AND deleted_at IS NULL)
    OR (kind = 'group' AND direct_key IS NULL AND name IS NOT NULL))
);

CREATE TABLE eureka.chat_member (
  conversation_id uuid NOT NULL REFERENCES eureka.chat_conversation(id),
  user_id         uuid NOT NULL REFERENCES eureka.app_user(id),
  role            text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX chat_member_current ON eureka.chat_member (user_id, conversation_id) WHERE left_at IS NULL;

-- One row per member added by someone else (also rejoins): the limit on members added per hour counts these.
CREATE TABLE eureka.chat_add_event (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES eureka.app_user(id),
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_add_event_actor ON eureka.chat_add_event (actor_id, at DESC);

CREATE TABLE eureka.chat_member_state (
  conversation_id      uuid NOT NULL,
  user_id              uuid NOT NULL,
  visible_after_seq    bigint NOT NULL DEFAULT 0 CHECK (visible_after_seq >= 0),
  last_read_message_id uuid,
  last_read_seq        bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  last_viewed_at       timestamptz,
  notified_at          timestamptz,
  archived             boolean NOT NULL DEFAULT false,
  favorite             boolean NOT NULL DEFAULT false,
  muted                boolean NOT NULL DEFAULT false,
  hidden               boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, user_id) REFERENCES eureka.chat_member(conversation_id, user_id)
);

CREATE TABLE eureka.chat_message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES eureka.chat_conversation(id),
  seq             bigint NOT NULL UNIQUE,
  rev             bigint NOT NULL UNIQUE,
  sender_id       uuid NOT NULL REFERENCES eureka.app_user(id),
  client_id       uuid NOT NULL,
  -- Plain text: newlines and tabs allowed, other control characters refused.
  body            text NOT NULL CHECK (char_length(body) <= 4000
                    AND body !~ E'[\\x01-\\x08\\x0b-\\x1f\\x7f]'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  UNIQUE (sender_id, client_id),
  CONSTRAINT chat_message_rev CHECK (rev >= seq),
  CONSTRAINT chat_message_deleted_cleared CHECK (deleted_at IS NULL OR body = '')
);
CREATE INDEX chat_message_conversation_seq ON eureka.chat_message (conversation_id, seq);
CREATE INDEX chat_message_conversation_rev ON eureka.chat_message (conversation_id, rev);

ALTER TABLE eureka.chat_member_state
  ADD CONSTRAINT chat_member_state_last_read FOREIGN KEY (last_read_message_id) REFERENCES eureka.chat_message(id);

CREATE TABLE eureka.chat_attachment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES eureka.chat_message(id),
  conversation_id uuid NOT NULL REFERENCES eureka.chat_conversation(id),
  file_id         uuid NOT NULL UNIQUE REFERENCES eureka.file_object(id),
  position        smallint NOT NULL CHECK (position BETWEEN 1 AND 5),
  -- Shown to members only; a base name (no path separators, no control characters).
  file_name       text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200
                    AND file_name !~ '[[:cntrl:]/\\]' AND file_name NOT IN ('.', '..')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, position)
);

-- Presence ("Online": a live session seen in the last 2 minutes).
CREATE INDEX session_user_seen ON eureka.session (user_id, last_seen_at DESC);

-- ---------- write guard (rules 4 and 6) ----------
CREATE FUNCTION eureka.chat_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'chat rows are written only by chat functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP IS DISTINCT FROM 'INSERT' AND TG_OP IS DISTINCT FROM 'UPDATE' THEN
    RAISE EXCEPTION 'chat rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'chat_conversation' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_by := authz.current_user_id();
      NEW.created_at := pg_catalog.now();
      NEW.deleted_at := NULL;
      NEW.row_version := 1;
    ELSIF (NEW.id, NEW.kind, NEW.direct_key, NEW.created_by, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.kind, OLD.direct_key, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    ELSIF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a deleted conversation is final' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME = 'chat_member' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.joined_at := pg_catalog.now();
      NEW.left_at := NULL;
    ELSIF (NEW.conversation_id, NEW.user_id) IS DISTINCT FROM (OLD.conversation_id, OLD.user_id) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME = 'chat_member_state' THEN
    IF TG_OP = 'UPDATE' AND (NEW.conversation_id, NEW.user_id) IS DISTINCT FROM (OLD.conversation_id, OLD.user_id) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME = 'chat_message' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.sender_id := authz.current_user_id();
      NEW.created_at := pg_catalog.now();
      NEW.edited_at := NULL;
      NEW.deleted_at := NULL;
    ELSIF (NEW.id, NEW.conversation_id, NEW.seq, NEW.sender_id, NEW.client_id, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.conversation_id, OLD.seq, OLD.sender_id, OLD.client_id, OLD.created_at) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    ELSIF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a deleted message is final' USING ERRCODE = 'insufficient_privilege';
    ELSIF NOT coalesce(NEW.rev > OLD.rev, false) THEN
      RAISE EXCEPTION 'a changed message needs a new revision' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'chat_attachment' THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'attachments are not changed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION eureka.chat_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is never truncated', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER chat_conversation_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.chat_conversation
  FOR EACH ROW EXECUTE FUNCTION eureka.chat_write_guard();
CREATE TRIGGER chat_member_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.chat_member
  FOR EACH ROW EXECUTE FUNCTION eureka.chat_write_guard();
CREATE TRIGGER chat_member_state_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.chat_member_state
  FOR EACH ROW EXECUTE FUNCTION eureka.chat_write_guard();
CREATE TRIGGER chat_message_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.chat_message
  FOR EACH ROW EXECUTE FUNCTION eureka.chat_write_guard();
CREATE TRIGGER chat_attachment_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.chat_attachment
  FOR EACH ROW EXECUTE FUNCTION eureka.chat_write_guard();
CREATE TRIGGER chat_conversation_no_truncate BEFORE TRUNCATE ON eureka.chat_conversation
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.chat_no_truncate();
CREATE TRIGGER chat_member_no_truncate BEFORE TRUNCATE ON eureka.chat_member
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.chat_no_truncate();
CREATE TRIGGER chat_member_state_no_truncate BEFORE TRUNCATE ON eureka.chat_member_state
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.chat_no_truncate();
CREATE TRIGGER chat_message_no_truncate BEFORE TRUNCATE ON eureka.chat_message
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.chat_no_truncate();
CREATE TRIGGER chat_attachment_no_truncate BEFORE TRUNCATE ON eureka.chat_attachment
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.chat_no_truncate();

ALTER TABLE eureka.chat_conversation ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.chat_conversation FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.chat_member ENABLE ROW LEVEL SECURITY;       ALTER TABLE eureka.chat_member FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.chat_member_state ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.chat_member_state FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.chat_message ENABLE ROW LEVEL SECURITY;      ALTER TABLE eureka.chat_message FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.chat_attachment ENABLE ROW LEVEL SECURITY;   ALTER TABLE eureka.chat_attachment FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.chat_add_event ENABLE ROW LEVEL SECURITY;    ALTER TABLE eureka.chat_add_event FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_read   ON eureka.chat_add_event FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.chat_add_event FOR INSERT TO authz_definer WITH CHECK (true);

-- The definer functions (and the notification resolver) read and write everything; nobody deletes.
CREATE POLICY definer_read   ON eureka.chat_conversation FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.chat_conversation FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.chat_conversation FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.chat_member FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.chat_member FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.chat_member FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.chat_member_state FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.chat_member_state FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.chat_member_state FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.chat_message FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.chat_message FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.chat_message FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.chat_attachment FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.chat_attachment FOR INSERT TO authz_definer WITH CHECK (true);

-- The chat functions write their own audit rows (actor = caller; ids, kinds, roles and counts only).
CREATE POLICY chat_definer_audit ON eureka.audit_event FOR INSERT TO authz_definer WITH CHECK (
  actor_id IS NOT NULL AND actor_id = authz.current_user_id() AND entity_type = 'chat_conversation'
  AND action IN ('chat.conversation_created', 'chat.conversation_renamed', 'chat.conversation_deleted',
                 'chat.member_added', 'chat.member_removed', 'chat.member_left', 'chat.member_role_changed',
                 'chat.message_deleted'));

-- Inbox rows of chat.direct_message open the conversation (0062 added 'application', carried over here).
ALTER TABLE eureka.notification DROP CONSTRAINT notification_entity_type_check;
ALTER TABLE eureka.notification ADD CONSTRAINT notification_entity_type_check
  CHECK (entity_type IN ('placement', 'candidate', 'application', 'conversation'));

RESET ROLE;

REVOKE ALL ON eureka.chat_add_event FROM PUBLIC;
GRANT SELECT, INSERT (actor_id) ON eureka.chat_add_event TO authz_definer;
REVOKE ALL ON eureka.chat_conversation, eureka.chat_member, eureka.chat_member_state, eureka.chat_message,
  eureka.chat_attachment FROM PUBLIC;
REVOKE ALL ON SEQUENCE eureka.chat_rev_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.chat_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.chat_no_truncate() FROM PUBLIC;
GRANT SELECT ON eureka.chat_conversation, eureka.chat_member, eureka.chat_member_state, eureka.chat_message,
  eureka.chat_attachment TO eureka_app;
GRANT SELECT, INSERT, UPDATE ON eureka.chat_conversation, eureka.chat_member, eureka.chat_member_state,
  eureka.chat_message TO authz_definer;
GRANT SELECT, INSERT ON eureka.chat_attachment TO authz_definer;
GRANT USAGE ON SEQUENCE eureka.chat_rev_seq TO authz_definer;
-- Presence (authz.chat_online) reads session liveness.
GRANT SELECT (id_hash, user_id, expires_at, revoked_at, last_seen_at) ON eureka.session TO authz_definer;
-- Repeated from 0033/0037/0043 so this migration stands alone.
GRANT INSERT (actor_id, action, entity_type, entity_id, changes) ON eureka.audit_event TO authz_definer;
GRANT USAGE ON SEQUENCE eureka.audit_event_seq_seq TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- Internal: the caller, when they may chat (an active user holding chat:use); else not_permitted.
CREATE FUNCTION authz.chat_me() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_user_id();
BEGIN
  IF me IS NULL OR NOT coalesce(authz.has_perm('chat:use'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN me;
END $$;

-- Internal: may this user take part in chats (active, a valid role holding chat:use)?
CREATE FUNCTION authz.chat_user_ok(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM eureka.app_user u
      JOIN eureka.user_role ur ON ur.user_id = u.id AND ur.valid @> pg_catalog.now()
      JOIN eureka.role_permission rp ON rp.role_key = ur.role_key AND rp.permission = 'chat:use'
     WHERE u.id = p_user AND u.status = 'active')
$$;

-- RLS: the conversations the caller is a current member of (not deleted),
-- when the caller may chat. Called once per statement (InitPlan).
CREATE FUNCTION authz.chat_conversation_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.array_agg(m.conversation_id), '{}')
    FROM eureka.chat_member m JOIN eureka.chat_conversation c ON c.id = m.conversation_id
   WHERE m.user_id = authz.current_user_id() AND m.left_at IS NULL AND c.deleted_at IS NULL
     AND coalesce(authz.has_perm('chat:use'), false)
$$;

-- Internal: the caller's role in a live conversation they are a current
-- member of, optionally locking the conversation row (every write that
-- assigns a revision locks first). not_found otherwise (no existence oracle).
CREATE FUNCTION authz.chat_enter(p_conv uuid, p_lock boolean)
RETURNS TABLE (kind text, my_role text, last_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE me uuid := authz.chat_me(); r text; k text; s bigint;
BEGIN
  SELECT m.role INTO r FROM eureka.chat_member m
   WHERE m.conversation_id = p_conv AND m.user_id = me AND m.left_at IS NULL;
  IF r IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF coalesce(p_lock, false) THEN
    SELECT c.kind, c.last_seq INTO k, s FROM eureka.chat_conversation c WHERE c.id = p_conv AND c.deleted_at IS NULL FOR UPDATE;
    -- Re-read after the lock: the caller may have been removed meanwhile.
    SELECT m.role INTO r FROM eureka.chat_member m
     WHERE m.conversation_id = p_conv AND m.user_id = me AND m.left_at IS NULL;
  ELSE
    SELECT c.kind, c.last_seq INTO k, s FROM eureka.chat_conversation c WHERE c.id = p_conv AND c.deleted_at IS NULL;
  END IF;
  IF k IS NULL OR r IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY SELECT k, r, s;
END $$;

-- API: which of p_users have a live session seen in the last 2 minutes, but
-- only users who share a current conversation with the caller (or the caller):
-- presence is no directory-wide oracle (CH-7).
CREATE FUNCTION authz.chat_online(p_users uuid[]) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me();
BEGIN
  RETURN coalesce((
    SELECT pg_catalog.array_agg(DISTINCT u.id)
      FROM pg_catalog.unnest(coalesce(p_users, '{}'::uuid[])) AS u(id)
     WHERE (u.id = me OR EXISTS (
              SELECT 1 FROM eureka.chat_member a
                JOIN eureka.chat_member b ON b.conversation_id = a.conversation_id AND b.left_at IS NULL AND b.user_id = u.id
                JOIN eureka.chat_conversation c ON c.id = a.conversation_id AND c.deleted_at IS NULL
               WHERE a.user_id = me AND a.left_at IS NULL))
       AND coalesce(authz.chat_user_ok(u.id), false)
       AND EXISTS (SELECT 1 FROM eureka.session s
                    WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > pg_catalog.now()
                      AND s.last_seen_at > pg_catalog.now() - interval '2 minutes')), '{}'::uuid[]);
END $$;

-- Internal: one audit row about a conversation.
CREATE FUNCTION authz.chat_audit(p_action text, p_conv uuid, p_changes jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), p_action, 'chat_conversation', p_conv, p_changes)
$$;

-- Internal: a member row (new or rejoining) with a fresh state that sees
-- only messages after p_from_seq.
CREATE FUNCTION authz.chat_join(p_conv uuid, p_user uuid, p_role text, p_from_seq bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO eureka.chat_member (conversation_id, user_id, role) VALUES (p_conv, p_user, p_role)
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = EXCLUDED.role, left_at = NULL, joined_at = pg_catalog.now();
  INSERT INTO eureka.chat_member_state (conversation_id, user_id, visible_after_seq, last_read_seq)
  VALUES (p_conv, p_user, coalesce(p_from_seq, 0), coalesce(p_from_seq, 0))
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET
    visible_after_seq = EXCLUDED.visible_after_seq, last_read_seq = EXCLUDED.last_read_seq, last_read_message_id = NULL,
    last_viewed_at = NULL, notified_at = NULL, archived = false, favorite = false, muted = false, hidden = false;
END $$;

-- API: the direct conversation with another chat user, created on first use
-- (one per pair). Re-opening a chat the caller deleted shows it again, with
-- only the messages after the deletion. Returns the id and whether it was created.
CREATE FUNCTION authz.chat_open_direct(p_other uuid)
RETURNS TABLE (conversation_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE me uuid := authz.chat_me(); k text; c_id uuid; made boolean := false;
BEGIN
  IF p_other IS NULL OR p_other = me OR NOT coalesce(authz.chat_user_ok(p_other), false) THEN
    RAISE EXCEPTION 'invalid_member' USING ERRCODE = 'check_violation';
  END IF;
  k := CASE WHEN me::text < p_other::text THEN me::text || ':' || p_other::text ELSE p_other::text || ':' || me::text END;
  -- Limit (CH-12): at most 50 new direct chats per user per hour.
  IF NOT EXISTS (SELECT 1 FROM eureka.chat_conversation x WHERE x.direct_key = k)
     AND (SELECT pg_catalog.count(*) FROM eureka.chat_conversation x
           WHERE x.created_by = me AND x.kind = 'direct' AND x.created_at > pg_catalog.now() - interval '1 hour') >= 50 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.chat_conversation AS c (kind, direct_key, created_by) VALUES ('direct', k, me)
  ON CONFLICT (direct_key) DO NOTHING
  RETURNING c.id INTO c_id;
  IF c_id IS NOT NULL THEN
    made := true;
    PERFORM authz.chat_join(c_id, me, 'member', 0);
    PERFORM authz.chat_join(c_id, p_other, 'member', 0);
    PERFORM authz.chat_audit('chat.conversation_created', c_id, pg_catalog.jsonb_build_object('kind', 'direct', 'memberCount', 2));
  ELSE
    SELECT c.id INTO c_id FROM eureka.chat_conversation c WHERE c.direct_key = k;
    UPDATE eureka.chat_member_state s SET hidden = false WHERE s.conversation_id = c_id AND s.user_id = me AND s.hidden;
  END IF;
  RETURN QUERY SELECT c_id, made;
END $$;

-- API: a group with the caller as owner and 1..99 other chat users as members.
CREATE FUNCTION authz.chat_create_group(p_name text, p_members uuid[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); c_id uuid; others uuid[]; u uuid;
BEGIN
  IF p_name IS NULL OR NOT coalesce(char_length(p_name) BETWEEN 1 AND 80, false)
     OR p_name ~ '[[:cntrl:]]' OR p_name IS DISTINCT FROM pg_catalog.btrim(p_name) THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'check_violation';
  END IF;
  -- Limit (CH-12): at most 20 groups per user per hour.
  IF (SELECT pg_catalog.count(*) FROM eureka.chat_conversation x
       WHERE x.created_by = me AND x.kind = 'group' AND x.created_at > pg_catalog.now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'check_violation';
  END IF;
  others := ARRAY(SELECT DISTINCT x FROM pg_catalog.unnest(coalesce(p_members, '{}'::uuid[])) x WHERE x IS DISTINCT FROM me);
  IF coalesce(pg_catalog.cardinality(others), 0) < 1 OR pg_catalog.cardinality(others) > 99 THEN
    RAISE EXCEPTION 'invalid_member' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH u IN ARRAY others LOOP
    IF NOT coalesce(authz.chat_user_ok(u), false) THEN
      RAISE EXCEPTION 'invalid_member' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  INSERT INTO eureka.chat_conversation AS c (kind, name, created_by) VALUES ('group', p_name, me) RETURNING c.id INTO c_id;
  PERFORM authz.chat_join(c_id, me, 'owner', 0);
  FOREACH u IN ARRAY others LOOP
    PERFORM authz.chat_join(c_id, u, 'member', 0);
  END LOOP;
  PERFORM authz.chat_audit('chat.conversation_created', c_id,
    pg_catalog.jsonb_build_object('kind', 'group', 'memberCount', pg_catalog.cardinality(others) + 1));
  RETURN c_id;
END $$;

-- API: sends a message (idempotent per sender and client id: a repeat returns
-- the first message, created = false). p_files: up to 5 attachments
-- [{name, contentType, size}] (the documents allowlist and 15 MB cap); each
-- becomes a pending file_object for the presigned upload and the scan. A
-- message needs a body or an attachment. Unhides the chat for members who
-- deleted it, marks it read for the sender and, for a direct chat, emits
-- chat.direct_message when the other member has not viewed it for 10
-- minutes (once per unseen stretch; never when muted).
CREATE FUNCTION authz.chat_send(p_conv uuid, p_client uuid, p_body text, p_files jsonb)
RETURNS TABLE (message_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me uuid := authz.chat_me();
  e record; prior record; f jsonb; pos bigint; n_files integer; f_id uuid; m_id uuid; r bigint;
  other record;
BEGIN
  IF p_client IS NULL THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x.id, x.conversation_id INTO prior FROM eureka.chat_message x WHERE x.sender_id = me AND x.client_id = p_client;
  IF prior.id IS NOT NULL THEN
    IF prior.conversation_id IS DISTINCT FROM p_conv THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'unique_violation';
    END IF;
    PERFORM 1 FROM authz.chat_enter(p_conv, false);
    RETURN QUERY SELECT prior.id, false;
    RETURN;
  END IF;
  n_files := CASE WHEN p_files IS NULL OR pg_catalog.jsonb_typeof(p_files) IS DISTINCT FROM 'array' THEN -1
                  ELSE pg_catalog.jsonb_array_length(p_files) END;
  IF p_body IS NULL OR n_files < 0 OR n_files > 5 OR char_length(p_body) > 4000
     OR (n_files = 0 AND pg_catalog.btrim(p_body, E' \t\n') = '') THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'check_violation';
  END IF;
  FOR f IN SELECT * FROM pg_catalog.jsonb_array_elements(p_files) LOOP
    IF pg_catalog.jsonb_typeof(f) IS DISTINCT FROM 'object'
       OR (f ->> 'contentType') IS NULL OR (f ->> 'contentType') NOT IN (
            'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg')
       OR pg_catalog.jsonb_typeof(f -> 'size') IS DISTINCT FROM 'number'
       OR NOT coalesce((f ->> 'size') ~ '^[0-9]{1,8}$' AND (f ->> 'size')::integer BETWEEN 1 AND 15728640, false)
       OR (f ->> 'name') IS NULL OR NOT coalesce(char_length(f ->> 'name') BETWEEN 1 AND 200, false)
       OR (f ->> 'name') ~ '[[:cntrl:]/\\]' OR (f ->> 'name') IN ('.', '..') THEN
      RAISE EXCEPTION 'invalid_attachment' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  SELECT * INTO e FROM authz.chat_enter(p_conv, true);
  -- A concurrent send with the same client id may have committed while this one waited for the lock (L4).
  SELECT x.id INTO prior FROM eureka.chat_message x WHERE x.sender_id = me AND x.client_id = p_client;
  IF prior.id IS NOT NULL THEN
    RETURN QUERY SELECT prior.id, false;
    RETURN;
  END IF;
  -- Limit (CH-12): at most 120 messages per user per minute, across all API tasks.
  IF (SELECT pg_catalog.count(*) FROM eureka.chat_message x
       WHERE x.sender_id = me AND x.created_at > pg_catalog.now() - interval '1 minute') >= 120 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'check_violation';
  END IF;
  IF n_files > 0 THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat_upload:' || me::text, 0));
    IF (SELECT pg_catalog.count(*) FROM eureka.chat_attachment a JOIN eureka.file_object o ON o.id = a.file_id
         WHERE o.uploaded_by = me AND o.status = 'pending') + n_files > 10 THEN
      RAISE EXCEPTION 'too_many_pending' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  r := pg_catalog.nextval('eureka.chat_rev_seq');
  INSERT INTO eureka.chat_message AS m (conversation_id, seq, rev, sender_id, client_id, body)
  VALUES (p_conv, r, r, me, p_client, p_body)
  RETURNING m.id INTO m_id;
  FOR f, pos IN SELECT x.value, x.ordinality FROM pg_catalog.jsonb_array_elements(p_files) WITH ORDINALITY x LOOP
    INSERT INTO eureka.file_object AS o (classification, content_type, size_bytes, uploaded_by, upload_expires_at)
    VALUES ('internal', f ->> 'contentType', (f ->> 'size')::integer, me, pg_catalog.now())
    RETURNING o.id INTO f_id;
    INSERT INTO eureka.chat_attachment (message_id, conversation_id, file_id, position, file_name)
    VALUES (m_id, p_conv, f_id, pos, f ->> 'name');
  END LOOP;
  UPDATE eureka.chat_conversation SET last_seq = r, last_rev = r, last_message_at = pg_catalog.now() WHERE id = p_conv;
  UPDATE eureka.chat_member_state s SET hidden = false
   WHERE s.conversation_id = p_conv AND s.hidden
     AND EXISTS (SELECT 1 FROM eureka.chat_member x WHERE x.conversation_id = s.conversation_id AND x.user_id = s.user_id AND x.left_at IS NULL);
  UPDATE eureka.chat_member_state s SET last_read_seq = r, last_read_message_id = m_id, last_viewed_at = pg_catalog.now()
   WHERE s.conversation_id = p_conv AND s.user_id = me;

  IF e.kind = 'direct' THEN
    SELECT s.user_id, s.last_viewed_at, s.notified_at, s.muted INTO other
      FROM eureka.chat_member_state s JOIN eureka.chat_member x ON x.conversation_id = s.conversation_id AND x.user_id = s.user_id
     WHERE s.conversation_id = p_conv AND s.user_id <> me AND x.left_at IS NULL
     FOR UPDATE OF s;
    IF other.user_id IS NOT NULL AND NOT coalesce(other.muted, false)
       AND (other.last_viewed_at IS NULL OR other.last_viewed_at < pg_catalog.now() - interval '10 minutes')
       AND (other.notified_at IS NULL OR (other.last_viewed_at IS NOT NULL AND other.notified_at < other.last_viewed_at))
       AND coalesce(authz.chat_user_ok(other.user_id), false) THEN
      INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
      VALUES ('chat.direct_message', 'chat_conversation', p_conv,
              pg_catalog.jsonb_build_object('conversationId', p_conv, 'recipientId', other.user_id));
      UPDATE eureka.chat_member_state SET notified_at = pg_catalog.now()
       WHERE conversation_id = p_conv AND user_id = other.user_id;
    END IF;
  END IF;
  RETURN QUERY SELECT m_id, true;
END $$;

-- API: the sender edits the body of their own message (not deleted). A
-- message with attachments may have an empty body.
CREATE FUNCTION authz.chat_edit_message(p_message uuid, p_body text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); m record; r bigint;
BEGIN
  SELECT x.id, x.conversation_id, x.sender_id, x.deleted_at INTO m FROM eureka.chat_message x WHERE x.id = p_message;
  IF m.id IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM authz.chat_enter(m.conversation_id, true);
  IF NOT EXISTS (SELECT 1 FROM eureka.chat_member_state s JOIN eureka.chat_message x ON x.id = p_message
                  WHERE s.conversation_id = m.conversation_id AND s.user_id = me AND x.seq > s.visible_after_seq) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF m.sender_id IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.deleted_at INTO m.deleted_at FROM eureka.chat_message x WHERE x.id = p_message;
  IF m.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'message_deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF p_body IS NULL OR char_length(p_body) > 4000
     OR (pg_catalog.btrim(p_body, E' \t\n') = '' AND NOT EXISTS (SELECT 1 FROM eureka.chat_attachment a WHERE a.message_id = p_message)) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'check_violation';
  END IF;
  -- Limit (CH-12): at most 30 edited messages per user per minute.
  IF (SELECT pg_catalog.count(*) FROM eureka.chat_message x
       WHERE x.sender_id = me AND x.edited_at > pg_catalog.now() - interval '1 minute') >= 30 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'check_violation';
  END IF;
  r := pg_catalog.nextval('eureka.chat_rev_seq');
  UPDATE eureka.chat_message SET body = p_body, edited_at = pg_catalog.now(), rev = r WHERE id = p_message;
  UPDATE eureka.chat_conversation SET last_rev = r WHERE id = m.conversation_id;
  RETURN r;
END $$;

-- API: the sender deletes their own message (soft: the body is cleared, the
-- attachments are no longer listed or downloadable). Idempotent. Audited
-- (ids and the attachment count).
CREATE FUNCTION authz.chat_delete_message(p_message uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); m record; r bigint;
BEGIN
  SELECT x.id, x.conversation_id, x.sender_id INTO m FROM eureka.chat_message x WHERE x.id = p_message;
  IF m.id IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM authz.chat_enter(m.conversation_id, true);
  IF NOT EXISTS (SELECT 1 FROM eureka.chat_member_state s JOIN eureka.chat_message x ON x.id = p_message
                  WHERE s.conversation_id = m.conversation_id AND s.user_id = me AND x.seq > s.visible_after_seq) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF m.sender_id IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.chat_message x WHERE x.id = p_message AND x.deleted_at IS NOT NULL) THEN
    RETURN;
  END IF;
  -- Limit (CH-12): at most 60 deleted messages per user per minute.
  IF (SELECT pg_catalog.count(*) FROM eureka.chat_message x
       WHERE x.sender_id = me AND x.deleted_at > pg_catalog.now() - interval '1 minute') >= 60 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'check_violation';
  END IF;
  r := pg_catalog.nextval('eureka.chat_rev_seq');
  UPDATE eureka.chat_message SET body = '', deleted_at = pg_catalog.now(), rev = r WHERE id = p_message;
  UPDATE eureka.chat_conversation SET last_rev = r WHERE id = m.conversation_id;
  PERFORM authz.chat_audit('chat.message_deleted', m.conversation_id, pg_catalog.jsonb_build_object(
    'messageId', p_message,
    'attachmentCount', (SELECT pg_catalog.count(*) FROM eureka.chat_attachment a WHERE a.message_id = p_message)));
END $$;

-- API: marks the conversation read up to a message (never backwards; NULL =
-- the newest) and records that the caller viewed it now.
CREATE FUNCTION authz.chat_mark_read(p_conv uuid, p_message uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); e record; s bigint; m_id uuid;
BEGIN
  SELECT * INTO e FROM authz.chat_enter(p_conv, false);
  IF p_message IS NULL THEN
    SELECT x.seq, x.id INTO s, m_id FROM eureka.chat_message x WHERE x.conversation_id = p_conv ORDER BY x.seq DESC LIMIT 1;
  ELSE
    SELECT x.seq, x.id INTO s, m_id FROM eureka.chat_message x WHERE x.id = p_message AND x.conversation_id = p_conv;
    IF m_id IS NULL THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;
  UPDATE eureka.chat_member_state st
     SET last_viewed_at = pg_catalog.now(),
         last_read_seq = GREATEST(st.last_read_seq, coalesce(s, 0)),
         last_read_message_id = CASE WHEN coalesce(s, 0) > st.last_read_seq THEN m_id ELSE st.last_read_message_id END
   WHERE st.conversation_id = p_conv AND st.user_id = me;
END $$;

-- API: the caller's own flags (NULL = unchanged).
CREATE FUNCTION authz.chat_set_prefs(p_conv uuid, p_archived boolean, p_favorite boolean, p_muted boolean)
RETURNS TABLE (archived boolean, favorite boolean, muted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE me uuid := authz.chat_me();
BEGIN
  PERFORM 1 FROM authz.chat_enter(p_conv, false);
  RETURN QUERY
  UPDATE eureka.chat_member_state s
     SET archived = coalesce(p_archived, s.archived), favorite = coalesce(p_favorite, s.favorite), muted = coalesce(p_muted, s.muted)
   WHERE s.conversation_id = p_conv AND s.user_id = me
  RETURNING s.archived, s.favorite, s.muted;
END $$;

-- API: "Delete chat" of a direct chat: hidden for the caller, with its
-- history up to now; it comes back (newer messages only) when either side
-- writes or the caller opens it again. Not audited (a personal view action).
CREATE FUNCTION authz.chat_hide(p_conv uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); e record;
BEGIN
  SELECT * INTO e FROM authz.chat_enter(p_conv, true);
  IF e.kind IS DISTINCT FROM 'direct' THEN
    RAISE EXCEPTION 'not_direct' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.chat_member_state s
     SET hidden = true, archived = false, favorite = false,
         visible_after_seq = GREATEST(s.visible_after_seq, e.last_seq),
         last_read_seq = GREATEST(s.last_read_seq, e.last_seq)
   WHERE s.conversation_id = p_conv AND s.user_id = me;
END $$;

-- Internal: the group's current owners (locked conversation assumed).
CREATE FUNCTION authz.chat_owner_count(p_conv uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.count(*)::integer FROM eureka.chat_member m
   WHERE m.conversation_id = p_conv AND m.left_at IS NULL AND m.role = 'owner' AND authz.chat_user_ok(m.user_id)
$$;

-- API (group owner): adds chat users; a former member rejoins and sees only
-- messages from now on. At most 100 current members. Audited per member (ids).
CREATE FUNCTION authz.chat_add_members(p_conv uuid, p_users uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); e record; u uuid; n integer := 0; adds uuid[];
BEGIN
  SELECT * INTO e FROM authz.chat_enter(p_conv, true);
  IF e.kind IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'not_group' USING ERRCODE = 'check_violation';
  END IF;
  IF e.my_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  adds := ARRAY(SELECT DISTINCT x FROM pg_catalog.unnest(coalesce(p_users, '{}'::uuid[])) x
                 WHERE x IS NOT NULL AND NOT EXISTS (SELECT 1 FROM eureka.chat_member m
                   WHERE m.conversation_id = p_conv AND m.user_id = x AND m.left_at IS NULL));
  IF coalesce(pg_catalog.cardinality(p_users), 0) < 1 OR pg_catalog.cardinality(p_users) > 99 THEN
    RAISE EXCEPTION 'invalid_member' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH u IN ARRAY adds LOOP
    IF NOT coalesce(authz.chat_user_ok(u), false) THEN
      RAISE EXCEPTION 'invalid_member' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM eureka.chat_member m WHERE m.conversation_id = p_conv AND m.left_at IS NULL)
     + coalesce(pg_catalog.cardinality(adds), 0) > 100 THEN
    RAISE EXCEPTION 'too_many_members' USING ERRCODE = 'check_violation';
  END IF;
  -- Limit (CH-12): at most 200 members added per user per hour (all conversations).
  IF (SELECT pg_catalog.count(*) FROM eureka.chat_add_event a
       WHERE a.actor_id = me AND a.at > pg_catalog.now() - interval '1 hour')
     + coalesce(pg_catalog.cardinality(adds), 0) > 200 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH u IN ARRAY adds LOOP
    PERFORM authz.chat_join(p_conv, u, 'member', e.last_seq);
    INSERT INTO eureka.chat_add_event (actor_id) VALUES (me);
    PERFORM authz.chat_audit('chat.member_added', p_conv, pg_catalog.jsonb_build_object('userId', u));
    n := n + 1;
  END LOOP;
  UPDATE eureka.chat_conversation SET row_version = row_version + 1 WHERE id = p_conv AND n > 0;
  RETURN n;
END $$;

-- API (group owner): removes another current member. Audited (ids).
CREATE FUNCTION authz.chat_remove_member(p_conv uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); e record;
BEGIN
  SELECT * INTO e FROM authz.chat_enter(p_conv, true);
  IF e.kind IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'not_group' USING ERRCODE = 'check_violation';
  END IF;
  IF e.my_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user IS NULL OR p_user = me THEN
    RAISE EXCEPTION 'use_leave' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.chat_member SET left_at = pg_catalog.now()
   WHERE conversation_id = p_conv AND user_id = p_user AND left_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE eureka.chat_conversation SET row_version = row_version + 1 WHERE id = p_conv;
  PERFORM authz.chat_audit('chat.member_removed', p_conv, pg_catalog.jsonb_build_object('userId', p_user));
END $$;

-- API (group owner): makes a current member owner or member; the group
-- always keeps at least one owner. Audited (ids, role).
CREATE FUNCTION authz.chat_set_member_role(p_conv uuid, p_user uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); e record; old_role text;
BEGIN
  SELECT * INTO e FROM authz.chat_enter(p_conv, true);
  IF e.kind IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'not_group' USING ERRCODE = 'check_violation';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'member') THEN
    RAISE EXCEPTION 'invalid_role' USING ERRCODE = 'check_violation';
  END IF;
  -- Owners manage roles. A member may take ownership of a group whose owners are all deactivated (L6).
  IF e.my_role IS DISTINCT FROM 'owner'
     AND NOT (p_user IS NOT DISTINCT FROM me AND p_role = 'owner' AND authz.chat_owner_count(p_conv) = 0) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'member') THEN
    RAISE EXCEPTION 'invalid_role' USING ERRCODE = 'check_violation';
  END IF;
  SELECT m.role INTO old_role FROM eureka.chat_member m
   WHERE m.conversation_id = p_conv AND m.user_id = p_user AND m.left_at IS NULL;
  IF old_role IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF old_role = p_role THEN
    RETURN;
  END IF;
  IF p_role = 'member' AND authz.chat_owner_count(p_conv) <= 1 THEN
    RAISE EXCEPTION 'last_owner' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.chat_member SET role = p_role WHERE conversation_id = p_conv AND user_id = p_user;
  UPDATE eureka.chat_conversation SET row_version = row_version + 1 WHERE id = p_conv;
  PERFORM authz.chat_audit('chat.member_role_changed', p_conv, pg_catalog.jsonb_build_object('userId', p_user, 'role', p_role));
END $$;

-- API: leaves a group (no access to it afterwards, history included). When
-- the last owner leaves, the longest-standing member becomes owner; when the
-- last member leaves, the group is deleted. Audited (counts).
CREATE FUNCTION authz.chat_leave(p_conv uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); e record; heir uuid; left_n integer;
BEGIN
  SELECT * INTO e FROM authz.chat_enter(p_conv, true);
  IF e.kind IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'not_group' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.chat_member SET left_at = pg_catalog.now() WHERE conversation_id = p_conv AND user_id = me;
  SELECT pg_catalog.count(*)::integer INTO left_n FROM eureka.chat_member m WHERE m.conversation_id = p_conv AND m.left_at IS NULL;
  IF left_n = 0 THEN
    UPDATE eureka.chat_conversation SET deleted_at = pg_catalog.now(), row_version = row_version + 1 WHERE id = p_conv;
  ELSE
    IF authz.chat_owner_count(p_conv) = 0 THEN
      SELECT m.user_id INTO heir FROM eureka.chat_member m
       WHERE m.conversation_id = p_conv AND m.left_at IS NULL AND authz.chat_user_ok(m.user_id)
       ORDER BY m.joined_at, m.user_id LIMIT 1;
      UPDATE eureka.chat_member SET role = 'owner' WHERE conversation_id = p_conv AND user_id = heir AND heir IS NOT NULL;
    END IF;
    UPDATE eureka.chat_conversation SET row_version = row_version + 1 WHERE id = p_conv;
  END IF;
  PERFORM authz.chat_audit('chat.member_left', p_conv, pg_catalog.jsonb_build_object(
    'remainingMembers', left_n, 'ownerPromoted', heir IS NOT NULL));
END $$;

-- API (group owner): renames the group; p_version is the row version the
-- client saw (stale otherwise). Returns the new row version. Audited without the name.
CREATE FUNCTION authz.chat_rename(p_conv uuid, p_name text, p_version integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); e record; v integer;
BEGIN
  SELECT * INTO e FROM authz.chat_enter(p_conv, true);
  IF e.kind IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'not_group' USING ERRCODE = 'check_violation';
  END IF;
  IF e.my_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_name IS NULL OR NOT coalesce(char_length(p_name) BETWEEN 1 AND 80, false)
     OR p_name ~ '[[:cntrl:]]' OR p_name IS DISTINCT FROM pg_catalog.btrim(p_name) THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.row_version INTO v FROM eureka.chat_conversation c WHERE c.id = p_conv;
  IF p_version IS NULL OR p_version IS DISTINCT FROM v THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.chat_conversation SET name = p_name, row_version = row_version + 1 WHERE id = p_conv
  RETURNING row_version INTO v;
  PERFORM authz.chat_audit('chat.conversation_renamed', p_conv, pg_catalog.jsonb_build_object('rowVersion', v));
  RETURN v;
END $$;

-- API (group owner): "Delete chat" of a group: soft-deleted for everyone.
CREATE FUNCTION authz.chat_delete_group(p_conv uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.chat_me(); e record;
BEGIN
  SELECT * INTO e FROM authz.chat_enter(p_conv, true);
  IF e.kind IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'not_group' USING ERRCODE = 'check_violation';
  END IF;
  IF e.my_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE eureka.chat_conversation SET deleted_at = pg_catalog.now(), row_version = row_version + 1 WHERE id = p_conv;
  PERFORM authz.chat_audit('chat.conversation_deleted', p_conv, pg_catalog.jsonb_build_object(
    'memberCount', (SELECT pg_catalog.count(*) FROM eureka.chat_member m WHERE m.conversation_id = p_conv AND m.left_at IS NULL)));
END $$;

-- API: authorizes one download of an attachment: a current member who can
-- see the message (not deleted, after their visible_after_seq); the file
-- must be clean ('not_available' otherwise). Returns what the API needs to
-- sign the link (never a key chosen by the client).
CREATE FUNCTION authz.chat_attachment_download(p_attachment uuid)
RETURNS TABLE (outcome text, file_id uuid, content_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE me uuid := authz.chat_me(); a record;
BEGIN
  SELECT x.conversation_id, x.file_id, o.status, o.content_type, m.seq, m.deleted_at INTO a
    FROM eureka.chat_attachment x JOIN eureka.chat_message m ON m.id = x.message_id JOIN eureka.file_object o ON o.id = x.file_id
   WHERE x.id = p_attachment;
  IF a.file_id IS NULL OR a.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM authz.chat_enter(a.conversation_id, false);
  IF NOT EXISTS (SELECT 1 FROM eureka.chat_member_state s
                  WHERE s.conversation_id = a.conversation_id AND s.user_id = me AND a.seq > s.visible_after_seq) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF a.status IS DISTINCT FROM 'clean' THEN
    RETURN QUERY SELECT 'not_available'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, a.file_id, a.content_type;
END $$;

-- ---------- notification registry: chat.direct_message ----------
-- The resolver as last replaced by 0052 (0051 + the checklist assignee check),
-- with one more type: the recipient named by the producer
-- (authz.chat_send), while a current member of that direct conversation.
CREATE OR REPLACE FUNCTION authz.notification_recipients(p_event uuid, p_user uuid DEFAULT NULL)
RETURNS TABLE (recipient_id uuid, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_type    text;
  v_payload jsonb;
  v_roles   text[] := '{}';
  v_rec     uuid;
  v_team    uuid;
  v_lead    uuid;
  v_mgr     uuid;
  v_assign  uuid;
  v_chat    uuid;
  v_hiring  uuid;
BEGIN
  SELECT e.type, e.payload INTO v_type, v_payload
    FROM eureka.outbox_event e WHERE e.id = p_event AND e.published_at IS NULL;
  IF v_type IS NULL THEN
    RETURN;
  END IF;

  IF v_type IN ('placement.created', 'placement.state_changed') THEN
    v_roles := ARRAY(
      SELECT DISTINCT g FROM pg_catalog.jsonb_array_elements_text(
        CASE WHEN pg_catalog.jsonb_typeof(v_payload -> 'notify') = 'array' THEN v_payload -> 'notify' ELSE '[]'::jsonb END) g
       WHERE g IN ('hr', 'accounts', 'immigration'));
  ELSIF v_type = 'work_authorization.expiring' THEN
    v_roles := ARRAY['hr', 'immigration'];
  ELSIF v_type IN ('employee.benched', 'employee.exited') THEN
    v_roles := ARRAY['hr', 'accounts', 'immigration', 'bu_head', 'ceo'];
  ELSIF v_type = 'assignment.ending_soon' THEN
    v_roles := ARRAY['hr', 'accounts'];
  ELSIF v_type = 'employee.bench_time' THEN
    v_roles := ARRAY['ceo'];
    SELECT c.recruiter_id, c.team_id INTO v_rec, v_team
      FROM eureka.candidate c WHERE c.id = (v_payload ->> 'candidateId')::uuid;
  ELSIF v_type = 'candidate.assigned' THEN
    SELECT c.team_id INTO v_team FROM eureka.candidate c
     WHERE c.id = (v_payload ->> 'candidateId')::uuid
       AND c.team_id = (v_payload ->> 'teamId')::uuid;
  ELSIF v_type = 'checklist.item_overdue' THEN
    SELECT p.recruiter_id, p.team_id INTO v_rec, v_team
      FROM eureka.placement p WHERE p.id = (v_payload ->> 'placementId')::uuid;
    -- 0052: the assignee only when the payload names the item's current assignee.
    SELECT ci.assignee_id INTO v_assign FROM eureka.checklist_item ci
     WHERE ci.id = (v_payload ->> 'checklistItemId')::uuid
       AND ci.placement_id = (v_payload ->> 'placementId')::uuid
       AND ci.assignee_id = (v_payload ->> 'assigneeId')::uuid;
  ELSIF v_type = 'application.received' THEN
    -- jobs-portal (0062): HR and the job's current hiring manager.
    v_roles := ARRAY['hr'];
    SELECT j.hiring_manager_id INTO v_hiring FROM eureka.job_application a JOIN eureka.job j ON j.id = a.job_id
     WHERE a.id = (v_payload ->> 'applicationId')::uuid AND a.job_id = (v_payload ->> 'jobId')::uuid;
  ELSIF v_type = 'chat.direct_message' THEN
    SELECT m.user_id INTO v_chat
      FROM eureka.chat_conversation c
      JOIN eureka.chat_member m ON m.conversation_id = c.id AND m.left_at IS NULL
     WHERE c.id = (v_payload ->> 'conversationId')::uuid AND c.kind = 'direct' AND c.deleted_at IS NULL
       AND m.user_id = (v_payload ->> 'recipientId')::uuid;
  ELSE
    RETURN;
  END IF;

  IF v_team IS NOT NULL THEN
    SELECT t.lead_id INTO v_lead FROM eureka.team t WHERE t.id = v_team;
  END IF;
  IF v_lead IS NOT NULL THEN
    SELECT rl.manager_id INTO v_mgr FROM eureka.reporting_line rl
     WHERE rl.user_id = v_lead AND rl.valid @> pg_catalog.now();
  END IF;

  RETURN QUERY
  WITH r(uid, why) AS (
    SELECT ur.user_id, ur.role_key FROM eureka.user_role ur
     WHERE ur.role_key = ANY (v_roles) AND ur.valid @> pg_catalog.now()
    UNION ALL SELECT v_rec, 'recruiter' WHERE v_rec IS NOT NULL
    UNION ALL SELECT v_lead, 'lead' WHERE v_lead IS NOT NULL
    UNION ALL SELECT v_mgr, 'manager' WHERE v_mgr IS NOT NULL
    UNION ALL SELECT ur.user_id, 'documents_team' FROM eureka.user_role ur
     WHERE v_assign IS NOT NULL AND ur.user_id = v_assign AND ur.role_key = 'documents_team'
       AND ur.valid @> pg_catalog.now()
    UNION ALL SELECT v_hiring, 'hiring_manager' WHERE v_hiring IS NOT NULL
    UNION ALL SELECT v_chat, 'chat' WHERE v_chat IS NOT NULL
  )
  SELECT DISTINCT r.uid, r.why FROM r JOIN eureka.app_user u ON u.id = r.uid
   WHERE u.status = 'active' AND (p_user IS NULL OR r.uid = p_user);
END $$;

-- 0051's entity mapping with the conversation of a chat event and the application of 0062 (a later migration replacing this function must carry every branch over).
CREATE OR REPLACE FUNCTION authz.notification_entity(p_event uuid)
RETURNS TABLE (entity_type text, entity_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_type text; v_payload jsonb;
BEGIN
  SELECT e.type, e.payload INTO v_type, v_payload
    FROM eureka.outbox_event e WHERE e.id = p_event AND e.published_at IS NULL;
  IF v_type IS NULL THEN
    RETURN;
  END IF;
  IF v_type = 'work_authorization.expiring' THEN
    RETURN QUERY SELECT 'candidate'::text, (v_payload ->> 'candidate_id')::uuid;
  ELSIF v_type IN ('employee.benched', 'assignment.ending_soon', 'checklist.item_overdue') THEN
    RETURN QUERY SELECT 'placement'::text, (v_payload ->> 'placementId')::uuid;
  ELSIF v_type IN ('employee.exited', 'employee.bench_time', 'candidate.assigned') THEN
    RETURN QUERY SELECT 'candidate'::text, (v_payload ->> 'candidateId')::uuid;
  ELSIF v_type = 'application.received' THEN
    RETURN QUERY SELECT 'application'::text, (v_payload ->> 'applicationId')::uuid;
  ELSIF v_type = 'chat.direct_message' THEN
    RETURN QUERY SELECT 'conversation'::text, (v_payload ->> 'conversationId')::uuid;
  END IF;
END $$;

RESET ROLE;

-- L6: reactivating a user must not show them what was sent to their chats
-- while they were deactivated: their visible_after_seq moves to each
-- conversation's newest message (CH-2).
SET ROLE authz_definer;
CREATE FUNCTION authz.chat_on_user_reactivated() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active' THEN
    UPDATE eureka.chat_member_state s
       SET visible_after_seq = GREATEST(s.visible_after_seq, c.last_seq), last_read_seq = GREATEST(s.last_read_seq, c.last_seq)
      FROM eureka.chat_conversation c
     WHERE s.user_id = NEW.id AND c.id = s.conversation_id;
  END IF;
  RETURN NEW;
END $$;
RESET ROLE;
REVOKE ALL ON FUNCTION authz.chat_on_user_reactivated() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.chat_on_user_reactivated() TO eureka_owner;
SET ROLE eureka_owner;
CREATE TRIGGER chat_user_reactivated AFTER UPDATE OF status ON eureka.app_user
  FOR EACH ROW EXECUTE FUNCTION authz.chat_on_user_reactivated();
RESET ROLE;

-- ---------- read policies (need authz.chat_conversation_ids) ----------
SET ROLE eureka_owner;

-- Rule 3: the caller's conversations as an InitPlan feeding a hashed SubPlan;
-- the caller's own state row by primary key.
CREATE POLICY chat_conversation_read ON eureka.chat_conversation FOR SELECT TO eureka_app
  USING (id IN (SELECT pg_catalog.unnest((SELECT authz.chat_conversation_ids()))));
CREATE POLICY chat_member_read ON eureka.chat_member FOR SELECT TO eureka_app
  USING (conversation_id IN (SELECT pg_catalog.unnest((SELECT authz.chat_conversation_ids()))));
CREATE POLICY chat_member_state_read ON eureka.chat_member_state FOR SELECT TO eureka_app
  USING (user_id = (SELECT authz.current_user_id())
         AND conversation_id IN (SELECT pg_catalog.unnest((SELECT authz.chat_conversation_ids()))));
CREATE POLICY chat_message_read ON eureka.chat_message FOR SELECT TO eureka_app USING (
  conversation_id IN (SELECT pg_catalog.unnest((SELECT authz.chat_conversation_ids())))
  AND EXISTS (SELECT 1 FROM eureka.chat_member_state s
               WHERE s.conversation_id = chat_message.conversation_id AND s.user_id = (SELECT authz.current_user_id())
                 AND chat_message.seq > s.visible_after_seq));
-- Attachments of a visible, not deleted message (the message by primary key, under its policy).
CREATE POLICY chat_attachment_read ON eureka.chat_attachment FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.chat_message m WHERE m.id = chat_attachment.message_id AND m.deleted_at IS NULL));
-- A chat file is readable with its attachment (unique file_id: a key probe).
CREATE POLICY file_object_chat_read ON eureka.file_object FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.chat_attachment a WHERE a.file_id = file_object.id));

RESET ROLE;

-- Rule 2: no PUBLIC execute; the API's functions to eureka_app only; the
-- internal helpers to nobody (the definer functions run as their owner).
REVOKE ALL ON FUNCTION authz.chat_me() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_user_ok(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_conversation_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_enter(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_audit(text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_online(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_join(uuid, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_owner_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_open_direct(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_create_group(text, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_send(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_edit_message(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_delete_message(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_mark_read(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_set_prefs(uuid, boolean, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_hide(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_add_members(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_remove_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_set_member_role(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_leave(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_rename(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_delete_group(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.chat_attachment_download(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_recipients(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_entity(uuid) FROM PUBLIC;
-- RLS calls it as the querying role.
GRANT EXECUTE ON FUNCTION authz.chat_conversation_ids() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.chat_online(uuid[]) TO eureka_app;
GRANT EXECUTE ON FUNCTION
  authz.chat_open_direct(uuid), authz.chat_create_group(text, uuid[]), authz.chat_send(uuid, uuid, text, jsonb),
  authz.chat_edit_message(uuid, text), authz.chat_delete_message(uuid), authz.chat_mark_read(uuid, uuid),
  authz.chat_set_prefs(uuid, boolean, boolean, boolean), authz.chat_hide(uuid), authz.chat_add_members(uuid, uuid[]),
  authz.chat_remove_member(uuid, uuid), authz.chat_set_member_role(uuid, uuid, text), authz.chat_leave(uuid),
  authz.chat_rename(uuid, text, integer), authz.chat_delete_group(uuid), authz.chat_attachment_download(uuid)
  TO eureka_app;
