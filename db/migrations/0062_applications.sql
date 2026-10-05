-- Applications, application interviews and scorecards (jobs-portal package;
-- docs/jobs-portal-api.md JP-17..JP-30).
--
--   1. eureka.job_application: an applicant's application to an internal
--      opening (one per applicant and job). Status machine (shared
--      applicationTransitionAllowed): applied -> shortlisted ->
--      interview_scheduled -> offered -> hired, forward skips allowed, rejected
--      from any open state, withdrawn by the applicant (applied..offered).
--      candidate_id links the Eureka candidate created from a hired applicant.
--   2. eureka.application_event: append-only history (status changes with the
--      staff comment, interviews scheduled). Comments are internal: the portal
--      role has no access, emails never carry them, audit/outbox never do.
--   3. eureka.application_interview (+ _panel) and application_scorecard
--      (technical, communication, problem solving, attitude 1-5, notes; one per
--      reviewer and interview). The applicant sees an interview's type, round,
--      slot, duration, meeting link and status only.
--   4. Access (application:read / application:manage, JP-18):
--        staff read: application:read at org scope (HR); the job's hiring
--          manager; the lead or a panel member of one of its interviews
--          (to review). Sets come from definer functions called once per
--          statement (InitPlan feeding a hashed SubPlan, rule 3).
--        manage (status, interviews): application:manage at org scope, or the
--          job's hiring manager. Scorecards: the interview's lead or panel,
--          or a manager of the application.
--        portal role: own applications; their jobs; their interviews' public
--          columns. The portal's job list: published open internal openings.
--   5. Writes only through SECURITY DEFINER functions that re-check all of it
--      (apply/withdraw for the portal role; transition, schedule, interview
--      status, scorecard, candidate link for the app); a guard refuses every
--      other writer.
--   6. `application.received` outbox event (ids only) when an applicant
--      applies: in-app notice to the job's hiring manager and HR
--      (docs/notifications.md). The notification inbox gains entity type
--      'application'; notification_entity / notification_recipients are
--      replaced carrying every earlier branch over unchanged (0051, 0052).
-- Every IF is NULL-safe (rule 1). Functions pin search_path, are not
-- executable by PUBLIC and are granted to exactly the role that needs them (rule 2).
SET search_path = eureka, public;

SET ROLE eureka_owner;

CREATE TABLE eureka.job_application (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES eureka.job(id),
  applicant_id      uuid NOT NULL REFERENCES eureka.applicant(id),
  status            text NOT NULL DEFAULT 'applied' CHECK (status IN
                      ('applied', 'shortlisted', 'interview_scheduled', 'offered', 'hired', 'rejected', 'withdrawn')),
  applied_at        timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  candidate_id      uuid REFERENCES eureka.candidate(id),
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (job_id, applicant_id),
  CONSTRAINT job_application_candidate CHECK (candidate_id IS NULL OR status = 'hired')
);
CREATE INDEX job_application_list ON eureka.job_application (applied_at DESC, id DESC);
CREATE INDEX job_application_applicant ON eureka.job_application (applicant_id);

CREATE TABLE eureka.application_event (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES eureka.job_application(id),
  at             timestamptz NOT NULL DEFAULT now(),
  kind           text NOT NULL CHECK (kind IN ('applied', 'status', 'withdrawn', 'interview_scheduled', 'interview_status', 'candidate_created')),
  actor_id       uuid,              -- staff user; NULL when the applicant acted
  from_status    text,
  to_status      text,
  comment        text CHECK (char_length(comment) BETWEEN 1 AND 1000)
);
CREATE INDEX application_event_app ON eureka.application_event (application_id, id);

CREATE TABLE eureka.application_interview (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES eureka.job_application(id),
  interview_type   text NOT NULL CHECK (interview_type IN ('phone', 'video', 'in_person')),
  round            text NOT NULL CHECK (round IN ('screening', 'technical', 'hr', 'managerial', 'final')),
  lead_user_id     uuid NOT NULL REFERENCES eureka.app_user(id),
  starts_at        timestamptz NOT NULL CHECK (starts_at >= timestamptz '2000-01-01'),
  duration_minutes smallint NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  meeting_link     text CHECK (char_length(meeting_link) <= 2000 AND meeting_link ~ '^https://[^\s/@]+(/[^\s]*)?$'),
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  created_by       uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_interview_app ON eureka.application_interview (application_id, starts_at);
CREATE INDEX application_interview_lead ON eureka.application_interview (lead_user_id);

CREATE TABLE eureka.application_interview_panel (
  interview_id uuid NOT NULL REFERENCES eureka.application_interview(id),
  user_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  PRIMARY KEY (interview_id, user_id)
);
CREATE INDEX application_interview_panel_user ON eureka.application_interview_panel (user_id);

CREATE TABLE eureka.application_scorecard (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id    uuid NOT NULL REFERENCES eureka.application_interview(id),
  reviewer_id     uuid NOT NULL REFERENCES eureka.app_user(id),
  technical       smallint NOT NULL CHECK (technical BETWEEN 1 AND 5),
  communication   smallint NOT NULL CHECK (communication BETWEEN 1 AND 5),
  problem_solving smallint NOT NULL CHECK (problem_solving BETWEEN 1 AND 5),
  attitude        smallint NOT NULL CHECK (attitude BETWEEN 1 AND 5),
  notes           text CHECK (char_length(notes) BETWEEN 1 AND 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interview_id, reviewer_id)
);

-- Only the definer functions write (rule 6); history is append-only; nothing is deleted.
CREATE FUNCTION eureka.application_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'application data changes only through application functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'application_interview_panel' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'application data is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'application_event' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'application_event is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_application_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.job_application
  FOR EACH ROW EXECUTE FUNCTION eureka.application_write_guard();
CREATE TRIGGER application_event_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.application_event
  FOR EACH ROW EXECUTE FUNCTION eureka.application_write_guard();
CREATE TRIGGER application_interview_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.application_interview
  FOR EACH ROW EXECUTE FUNCTION eureka.application_write_guard();
CREATE TRIGGER application_interview_panel_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.application_interview_panel
  FOR EACH ROW EXECUTE FUNCTION eureka.application_write_guard();
CREATE TRIGGER application_scorecard_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.application_scorecard
  FOR EACH ROW EXECUTE FUNCTION eureka.application_write_guard();

CREATE FUNCTION eureka.application_truncate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'application data is never truncated' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER job_application_truncate_guard BEFORE TRUNCATE ON eureka.job_application
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.application_truncate_guard();
CREATE TRIGGER application_event_truncate_guard BEFORE TRUNCATE ON eureka.application_event
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.application_truncate_guard();
CREATE TRIGGER application_interview_truncate_guard BEFORE TRUNCATE ON eureka.application_interview
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.application_truncate_guard();
CREATE TRIGGER application_interview_panel_truncate_guard BEFORE TRUNCATE ON eureka.application_interview_panel
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.application_truncate_guard();
CREATE TRIGGER application_scorecard_truncate_guard BEFORE TRUNCATE ON eureka.application_scorecard
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.application_truncate_guard();

ALTER TABLE eureka.job_application              ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.job_application              FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.application_event            ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.application_event            FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.application_interview        ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.application_interview        FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.application_interview_panel  ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.application_interview_panel  FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.application_scorecard        ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.application_scorecard        FORCE ROW LEVEL SECURITY;

-- Inbox entries can open an application.
ALTER TABLE eureka.notification DROP CONSTRAINT notification_entity_type_check;
ALTER TABLE eureka.notification ADD CONSTRAINT notification_entity_type_check
  CHECK (entity_type IN ('placement', 'candidate', 'application'));

RESET ROLE;

GRANT SELECT, INSERT, UPDATE ON eureka.job_application, eureka.application_interview, eureka.application_scorecard TO authz_definer;
GRANT SELECT, INSERT ON eureka.application_event TO authz_definer;
GRANT SELECT, INSERT, DELETE ON eureka.application_interview_panel TO authz_definer;

-- ---------- access sets and checks ----------
SET ROLE authz_definer;

-- Jobs whose hiring manager is the current user.
CREATE FUNCTION authz.my_hiring_job_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(j.id), '{}') FROM eureka.job j
   WHERE authz.current_user_id() IS NOT NULL AND j.hiring_manager_id = authz.current_user_id()
$$;

-- Applications with an interview the current user leads or sits on.
CREATE FUNCTION authz.my_interview_application_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT i.application_id), '{}') FROM eureka.application_interview i
   WHERE authz.current_user_id() IS NOT NULL AND (i.lead_user_id = authz.current_user_id()
      OR EXISTS (SELECT 1 FROM eureka.application_interview_panel p WHERE p.interview_id = i.id AND p.user_id = authz.current_user_id()))
$$;

-- Jobs and applicants reachable through those two paths (job details and applicant tab for reviewers and hiring managers).
CREATE FUNCTION authz.my_interview_job_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT a.job_id), '{}') FROM eureka.job_application a
   WHERE a.id = ANY (authz.my_interview_application_ids())
$$;

CREATE FUNCTION authz.my_application_applicant_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT a.applicant_id), '{}') FROM eureka.job_application a
   WHERE a.job_id = ANY (authz.my_hiring_job_ids()) OR a.id = ANY (authz.my_interview_application_ids())
$$;

-- Readable by the current staff user (mirrors job_application_staff_read).
CREATE FUNCTION authz.application_readable(p_app uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM eureka.job_application a WHERE a.id = p_app AND authz.current_user_id() IS NOT NULL AND (
    authz.has_org('application:read') OR a.job_id = ANY (authz.my_hiring_job_ids()) OR a.id = ANY (authz.my_interview_application_ids())))
$$;

-- Manageable (status, interviews): application:manage at org scope or the job's hiring manager.
CREATE FUNCTION authz.application_manageable(p_app uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM eureka.job_application a JOIN eureka.job j ON j.id = a.job_id
    WHERE a.id = p_app AND authz.current_user_id() IS NOT NULL
      AND (authz.has_org('application:manage') OR j.hiring_manager_id = authz.current_user_id()))
$$;

-- Internal: lock the application after the read (404) and manage (403) checks.
CREATE FUNCTION authz.application_for_update(p_app uuid) RETURNS eureka.job_application
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a eureka.job_application;
BEGIN
  IF p_app IS NULL OR NOT coalesce(authz.application_readable(p_app), false) THEN
    RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.application_manageable(p_app), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.* INTO a FROM eureka.job_application x WHERE x.id = p_app FOR UPDATE;
  RETURN a;
END $$;

-- The shared state machine (packages/shared jobs.ts applicationTransitionAllowed).
CREATE FUNCTION authz.application_transition_ok(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    p_from IN ('applied', 'shortlisted', 'interview_scheduled', 'offered') AND p_to IS DISTINCT FROM p_from AND (
      p_to = 'rejected'
      OR pg_catalog.array_position(ARRAY['applied', 'shortlisted', 'interview_scheduled', 'offered', 'hired'], p_to)
         > pg_catalog.array_position(ARRAY['applied', 'shortlisted', 'interview_scheduled', 'offered', 'hired'], p_from)),
    false)
$$;

-- ---------- portal (eureka_portal) ----------

-- JP-24: apply to a published open internal opening (once).
CREATE FUNCTION authz.application_apply(p_job uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_applicant_id(); j record; new_id uuid;
BEGIN
  IF me IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.applicant a WHERE a.id = me AND a.status = 'active') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.kind, x.published_to_portal, x.status INTO j FROM eureka.job x WHERE x.id = p_job;
  IF j.id IS NULL OR j.kind IS DISTINCT FROM 'internal_opening' OR NOT coalesce(j.published_to_portal, false) OR j.status = 'draft' THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF j.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'job_not_open' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.job_application (job_id, applicant_id) VALUES (p_job, me)
  ON CONFLICT (job_id, applicant_id) DO NOTHING RETURNING id INTO new_id;
  IF new_id IS NULL THEN
    RAISE EXCEPTION 'already_applied' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.application_event (application_id, kind, to_status) VALUES (new_id, 'applied', 'applied');
  INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
  VALUES ('application.received', 'job_application', new_id,
          pg_catalog.jsonb_build_object('applicationId', new_id, 'jobId', p_job));
  RETURN new_id;
END $$;

-- JP-26: the applicant withdraws their own open application.
CREATE FUNCTION authz.application_withdraw(p_app uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_applicant_id(); a record;
BEGIN
  SELECT x.* INTO a FROM eureka.job_application x WHERE x.id = p_app AND me IS NOT NULL AND x.applicant_id = me FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(a.status IN ('applied', 'shortlisted', 'interview_scheduled', 'offered'), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.job_application SET status = 'withdrawn', status_changed_at = pg_catalog.now(), row_version = row_version + 1 WHERE id = a.id;
  UPDATE eureka.application_interview SET status = 'cancelled', updated_at = pg_catalog.now()
   WHERE application_id = a.id AND status = 'scheduled';
  INSERT INTO eureka.application_event (application_id, kind, from_status, to_status) VALUES (a.id, 'withdrawn', a.status, 'withdrawn');
  RETURN a.status;
END $$;

-- ---------- staff (eureka_app) ----------

-- JP-20: status change with an optional internal comment. p_version: the row version the client saw.
CREATE FUNCTION authz.application_transition(p_app uuid, p_to text, p_comment text, p_version integer)
RETURNS TABLE (from_status text, to_status text, row_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE a eureka.job_application;
BEGIN
  a := authz.application_for_update(p_app);
  IF p_version IS NULL OR a.row_version IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'serialization_failure';
  END IF;
  IF NOT authz.application_transition_ok(a.status, p_to) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.job_application x SET status = p_to, status_changed_at = pg_catalog.now(), row_version = x.row_version + 1 WHERE x.id = a.id;
  IF p_to IN ('hired', 'rejected') THEN
    UPDATE eureka.application_interview i SET status = 'cancelled', updated_at = pg_catalog.now()
     WHERE i.application_id = a.id AND i.status = 'scheduled' AND i.starts_at > pg_catalog.now();
  END IF;
  INSERT INTO eureka.application_event (application_id, kind, actor_id, from_status, to_status, comment)
  VALUES (a.id, 'status', authz.current_user_id(), a.status, p_to, nullif(pg_catalog.btrim(p_comment), ''));
  RETURN QUERY SELECT a.status, p_to, a.row_version + 1;
END $$;

-- JP-27: schedule an interview. Lead and panel: active users (panel up to 10).
-- An application still applied/shortlisted moves to interview_scheduled.
CREATE FUNCTION authz.application_schedule_interview(p_app uuid, p_type text, p_round text, p_lead uuid, p_panel uuid[],
                                                     p_starts timestamptz, p_minutes integer, p_link text)
RETURNS TABLE (interview_id uuid, from_status text, to_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE a eureka.job_application; iid uuid; panel uuid[] := ARRAY(SELECT DISTINCT x FROM pg_catalog.unnest(coalesce(p_panel, '{}')) x WHERE x IS NOT NULL);
BEGIN
  a := authz.application_for_update(p_app);
  IF NOT coalesce(a.status IN ('applied', 'shortlisted', 'interview_scheduled', 'offered'), false) THEN
    RAISE EXCEPTION 'application_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF pg_catalog.cardinality(panel) > 10 THEN
    RAISE EXCEPTION 'invalid_panel' USING ERRCODE = 'check_violation';
  END IF;
  IF p_lead IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_lead AND u.status = 'active')
     OR (SELECT count(*) FROM eureka.app_user u WHERE u.id = ANY (panel) AND u.status = 'active') <> pg_catalog.cardinality(panel) THEN
    RAISE EXCEPTION 'invalid_interviewer' USING ERRCODE = 'check_violation';
  END IF;
  IF p_starts IS NULL OR p_starts < pg_catalog.now() - interval '1 day' THEN
    RAISE EXCEPTION 'invalid_slot' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.application_interview (application_id, interview_type, round, lead_user_id, starts_at, duration_minutes, meeting_link, created_by)
  VALUES (a.id, p_type, p_round, p_lead, p_starts, p_minutes, nullif(p_link, ''), authz.current_user_id())
  RETURNING id INTO iid;
  INSERT INTO eureka.application_interview_panel (interview_id, user_id) SELECT iid, x FROM pg_catalog.unnest(panel) x;
  INSERT INTO eureka.application_event (application_id, kind, actor_id) VALUES (a.id, 'interview_scheduled', authz.current_user_id());
  IF a.status IN ('applied', 'shortlisted') THEN
    UPDATE eureka.job_application x SET status = 'interview_scheduled', status_changed_at = pg_catalog.now(), row_version = x.row_version + 1 WHERE x.id = a.id;
    INSERT INTO eureka.application_event (application_id, kind, actor_id, from_status, to_status)
    VALUES (a.id, 'status', authz.current_user_id(), a.status, 'interview_scheduled');
    RETURN QUERY SELECT iid, a.status, 'interview_scheduled'::text;
  ELSE
    RETURN QUERY SELECT iid, a.status, a.status;
  END IF;
END $$;

-- JP-28: interview outcome (scheduled -> completed / cancelled / no_show).
CREATE FUNCTION authz.application_interview_set_status(p_interview uuid, p_status text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i record;
BEGIN
  SELECT x.id, x.application_id, x.status INTO i FROM eureka.application_interview x WHERE x.id = p_interview;
  IF i.id IS NULL OR NOT coalesce(authz.application_readable(i.application_id), false) THEN
    RAISE EXCEPTION 'interview_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM authz.application_for_update(i.application_id);
  SELECT x.status INTO i.status FROM eureka.application_interview x WHERE x.id = p_interview FOR UPDATE;
  IF i.status IS DISTINCT FROM 'scheduled' OR NOT coalesce(p_status IN ('completed', 'cancelled', 'no_show'), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.application_interview SET status = p_status, updated_at = pg_catalog.now() WHERE id = p_interview;
  INSERT INTO eureka.application_event (application_id, kind, actor_id, from_status, to_status)
  VALUES (i.application_id, 'interview_status', authz.current_user_id(), 'scheduled', p_status);
  RETURN i.status;
END $$;

-- JP-29: the current user's scorecard for an interview (insert or replace).
-- Reviewers: the interview's lead or panel, or a manager of the application.
CREATE FUNCTION authz.application_scorecard_submit(p_interview uuid, p_technical integer, p_communication integer,
                                                   p_problem integer, p_attitude integer, p_notes text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i record; me uuid := authz.current_user_id(); sid uuid;
BEGIN
  SELECT x.id, x.application_id, x.lead_user_id, x.status INTO i FROM eureka.application_interview x WHERE x.id = p_interview;
  IF me IS NULL OR i.id IS NULL OR NOT coalesce(authz.application_readable(i.application_id), false) THEN
    RAISE EXCEPTION 'interview_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (i.lead_user_id = me
          OR EXISTS (SELECT 1 FROM eureka.application_interview_panel p WHERE p.interview_id = i.id AND p.user_id = me)
          OR coalesce(authz.application_manageable(i.application_id), false)) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF i.status IS DISTINCT FROM 'completed' AND i.status IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'interview_closed' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.application_scorecard (interview_id, reviewer_id, technical, communication, problem_solving, attitude, notes)
  VALUES (i.id, me, p_technical, p_communication, p_problem, p_attitude, nullif(pg_catalog.btrim(p_notes), ''))
  ON CONFLICT (interview_id, reviewer_id) DO UPDATE SET technical = EXCLUDED.technical, communication = EXCLUDED.communication,
    problem_solving = EXCLUDED.problem_solving, attitude = EXCLUDED.attitude, notes = EXCLUDED.notes, updated_at = pg_catalog.now()
  RETURNING id INTO sid;
  RETURN sid;
END $$;

-- JP-30: link the Eureka candidate created from a hired application (once).
CREATE FUNCTION authz.application_link_candidate(p_app uuid, p_candidate uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a eureka.job_application;
BEGIN
  a := authz.application_for_update(p_app);
  IF a.status IS DISTINCT FROM 'hired' THEN
    RAISE EXCEPTION 'application_not_hired' USING ERRCODE = 'check_violation';
  END IF;
  IF a.candidate_id IS NOT NULL THEN
    RAISE EXCEPTION 'candidate_exists' USING ERRCODE = 'check_violation';
  END IF;
  IF p_candidate IS NULL OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false) THEN
    RAISE EXCEPTION 'candidate_not_found' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.job_application SET candidate_id = p_candidate, row_version = row_version + 1 WHERE id = a.id;
  INSERT INTO eureka.application_event (application_id, kind, actor_id) VALUES (a.id, 'candidate_created', authz.current_user_id());
END $$;

-- ---------- notifications: application.received ----------
-- 0051's entity mapping plus 'application.received' -> the application.
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
  END IF;
END $$;

-- The 0052 resolver unchanged, plus 'application.received': the job's hiring
-- manager (reason hiring_manager, only while the payload's job is the
-- application's job) and HR. A later migration replacing this function must
-- carry every branch over.
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
    SELECT ci.assignee_id INTO v_assign FROM eureka.checklist_item ci
     WHERE ci.id = (v_payload ->> 'checklistItemId')::uuid
       AND ci.placement_id = (v_payload ->> 'placementId')::uuid
       AND ci.assignee_id = (v_payload ->> 'assigneeId')::uuid;
  ELSIF v_type = 'application.received' THEN
    -- jobs-portal (0062): HR and the job's current hiring manager.
    v_roles := ARRAY['hr'];
    SELECT j.hiring_manager_id INTO v_hiring FROM eureka.job_application a JOIN eureka.job j ON j.id = a.job_id
     WHERE a.id = (v_payload ->> 'applicationId')::uuid AND a.job_id = (v_payload ->> 'jobId')::uuid;
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
  )
  SELECT DISTINCT r.uid, r.why FROM r JOIN eureka.app_user u ON u.id = r.uid
   WHERE u.status = 'active' AND (p_user IS NULL OR r.uid = p_user);
END $$;

-- ---------- company display names (least privilege) ----------
-- eureka.company is readable only by company:read holders (location scope), and
-- stays so. Job readers, application reviewers and the portal need the NAME of
-- the company of a job they can already read, nothing else of the company
-- (address, incharges, utilities, bills, status). These batch functions return
-- (job id, name) for the requested jobs the caller may read, re-checked here
-- against the same rules as the job read policies (job_read, job_read_reviewer,
-- job_portal_read); a job the caller cannot read is simply absent. Only internal
-- openings have a company (job_kind_ref). Called from SELECT lists once per
-- page, never from RLS policies. At most 500 ids per call.
CREATE FUNCTION authz.job_company_names(p_jobs uuid[]) RETURNS TABLE (job_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT j.id, c.name
    FROM eureka.job j JOIN eureka.company c ON c.id = j.company_id
   WHERE authz.current_user_id() IS NOT NULL
     AND coalesce(cardinality(p_jobs), 0) BETWEEN 1 AND 500
     AND j.id = ANY (p_jobs) AND j.kind = 'internal_opening'
     AND (j.hiring_manager_id = authz.current_user_id()
          OR (SELECT authz.has_org_kind('job:read', false))
          OR j.id = ANY (authz.my_interview_job_ids()))
$$;

-- Portal role: published open internal openings and the jobs of the applicant's own applications.
CREATE FUNCTION authz.portal_job_company_names(p_jobs uuid[]) RETURNS TABLE (job_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT j.id, c.name
    FROM eureka.job j JOIN eureka.company c ON c.id = j.company_id
   WHERE authz.current_applicant_id() IS NOT NULL
     AND coalesce(cardinality(p_jobs), 0) BETWEEN 1 AND 500
     AND j.id = ANY (p_jobs) AND j.kind = 'internal_opening'
     AND ((j.published_to_portal AND j.status = 'open')
          OR EXISTS (SELECT 1 FROM eureka.job_application a
                      WHERE a.job_id = j.id AND a.applicant_id = authz.current_applicant_id()))
$$;

RESET ROLE;

-- ---------- policies ----------
SET ROLE eureka_owner;

-- Staff (rule 3: each set computed once per statement).
CREATE POLICY job_application_staff_read ON eureka.job_application FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('application:read'))
  OR job_id IN (SELECT pg_catalog.unnest((SELECT authz.my_hiring_job_ids())))
  OR id IN (SELECT pg_catalog.unnest((SELECT authz.my_interview_application_ids())))
);
CREATE POLICY application_event_staff_read ON eureka.application_event FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.job_application a WHERE a.id = application_event.application_id));
CREATE POLICY application_interview_staff_read ON eureka.application_interview FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.job_application a WHERE a.id = application_interview.application_id));
CREATE POLICY application_interview_panel_staff_read ON eureka.application_interview_panel FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.application_interview i WHERE i.id = application_interview_panel.interview_id));
CREATE POLICY application_scorecard_staff_read ON eureka.application_scorecard FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.application_interview i WHERE i.id = application_scorecard.interview_id));
-- Hiring managers and reviewers see the applicants of the applications they can read.
CREATE POLICY applicant_via_application ON eureka.applicant FOR SELECT TO eureka_app
  USING (id IN (SELECT pg_catalog.unnest((SELECT authz.my_application_applicant_ids()))));
-- Reviewers see the job of an application they interview for.
CREATE POLICY job_read_reviewer ON eureka.job FOR SELECT TO eureka_app
  USING (id IN (SELECT pg_catalog.unnest((SELECT authz.my_interview_job_ids()))));

-- Portal role: own applications, their jobs and interviews; the published open jobs.
CREATE POLICY job_application_own ON eureka.job_application FOR SELECT TO eureka_portal
  USING (applicant_id = (SELECT authz.current_applicant_id()));
CREATE POLICY application_interview_own ON eureka.application_interview FOR SELECT TO eureka_portal
  USING (application_id IN (SELECT a.id FROM eureka.job_application a));
CREATE POLICY job_portal_read ON eureka.job FOR SELECT TO eureka_portal
  USING ((kind = 'internal_opening' AND published_to_portal AND status = 'open')
         OR id IN (SELECT a.job_id FROM eureka.job_application a));

CREATE POLICY definer_all ON eureka.job_application FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON eureka.application_event FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON eureka.application_interview FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON eureka.application_interview_panel FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON eureka.application_scorecard FOR ALL TO authz_definer USING (true) WITH CHECK (true);
RESET ROLE;

REVOKE ALL ON eureka.job_application, eureka.application_event, eureka.application_interview,
  eureka.application_interview_panel, eureka.application_scorecard FROM PUBLIC;
GRANT SELECT ON eureka.job_application, eureka.application_event, eureka.application_interview,
  eureka.application_interview_panel, eureka.application_scorecard TO eureka_app;
GRANT SELECT (id, job_id, applicant_id, status, applied_at, status_changed_at) ON eureka.job_application TO eureka_portal;
GRANT SELECT (id, application_id, interview_type, round, starts_at, duration_minutes, meeting_link, status)
  ON eureka.application_interview TO eureka_portal;
GRANT SELECT (id, kind, title, category, experience_level, employment_type, work_mode, status, deadline, work_hours,
  pay_amount, pay_frequency, pay_currency, company_id, location, skills, requirements, description, published_to_portal, posted_at)
  ON eureka.job TO eureka_portal;

REVOKE ALL ON FUNCTION eureka.application_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.application_truncate_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.my_hiring_job_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.my_interview_application_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.my_interview_job_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.my_application_applicant_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_readable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_manageable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_for_update(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_transition_ok(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_apply(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_withdraw(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_transition(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_schedule_interview(uuid, text, text, uuid, uuid[], timestamptz, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_interview_set_status(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_scorecard_submit(uuid, integer, integer, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.application_link_candidate(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.job_company_names(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_job_company_names(uuid[]) FROM PUBLIC;
-- Policies evaluate as the querying role.
GRANT EXECUTE ON FUNCTION authz.my_hiring_job_ids() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.my_interview_application_ids() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.my_interview_job_ids() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.my_application_applicant_ids() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.job_company_names(uuid[]) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.portal_job_company_names(uuid[]) TO eureka_portal;
GRANT EXECUTE ON FUNCTION authz.application_apply(uuid) TO eureka_portal;
GRANT EXECUTE ON FUNCTION authz.application_withdraw(uuid) TO eureka_portal;
GRANT EXECUTE ON FUNCTION authz.application_transition(uuid, text, text, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.application_schedule_interview(uuid, text, text, uuid, uuid[], timestamptz, integer, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.application_interview_set_status(uuid, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.application_scorecard_submit(uuid, integer, integer, integer, integer, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.application_link_candidate(uuid, uuid) TO eureka_app;

-- The portal role writes its own audit rows (ids only, as the applicant), append-only like the app's.
SET ROLE eureka_owner;
CREATE POLICY audit_insert_portal ON eureka.audit_event FOR INSERT TO eureka_portal
  WITH CHECK (actor_id = (SELECT authz.current_applicant_id()) AND entity_type IN ('applicant', 'job_application'));
RESET ROLE;
GRANT INSERT ON eureka.audit_event TO eureka_portal;
GRANT USAGE ON SEQUENCE eureka.audit_event_seq_seq TO eureka_portal;
