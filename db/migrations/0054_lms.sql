-- LMS / training module (contract: docs/lms-api.md).
--
--   1. Tables (all prefixed lms_; unrelated to eureka.batch, the candidate sales cohorts):
--        lms_course          course catalogue (version for If-Match, archived_at)
--        lms_module          ordered lessons of a course (position unique per course, deferred so a
--                            reorder is one statement)
--        lms_batch           a training batch (status is derived at read time, never stored)
--        lms_batch_course    courses assigned to a batch
--        lms_enrollment      students of a batch
--        lms_module_progress percent per (batch, student, module); only for enrolled students and
--                            modules of courses assigned to the batch (checked by the writer)
--   2. Writes only through SECURITY DEFINER functions that re-check the permission in the database:
--        lms:manage (org scope: HR, Associate HR, Interview Coach) for catalogue, batches, students
--        and staff progress overrides; lms:learn (own scope: every role but org_admin) for the
--        caller's own progress. The app role has SELECT only; BEFORE guards refuse every other
--        writer, stamp server-managed columns (timestamps, version, archived_at, completed_at) and
--        TRUNCATE is refused for everyone.
--   3. Reads under RLS (rule 3, InitPlan permission calls, EXISTS by primary key): lms:manage sees
--      everything; a learner sees only the batches they are enrolled in, those batches' courses and
--      modules, and only their own progress rows.
-- Audit events are written by the API in the same transaction (ids and counts only, rule 5).
-- Every IF is NULL-safe (rule 1). Every function: REVOKE ALL FROM PUBLIC, pinned search_path,
-- EXECUTE only to eureka_app where the API calls it (rule 2).
SET search_path = eureka, public;

-- ---------- tables ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.lms_course (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  created_by  uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE INDEX lms_course_list ON eureka.lms_course (created_at DESC, id DESC);

CREATE TABLE eureka.lms_module (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        uuid NOT NULL REFERENCES eureka.lms_course(id),
  position         integer NOT NULL CHECK (position BETWEEN 1 AND 1000),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 0 AND 6000),
  CONSTRAINT lms_module_position UNIQUE (course_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE eureka.lms_batch (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  year        integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  start_date  date NOT NULL CHECK (start_date BETWEEN date '2000-01-01' AND date '2100-12-31'),
  end_date    date NOT NULL CHECK (end_date BETWEEN date '2000-01-01' AND date '2100-12-31'),
  created_by  uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT lms_batch_dates CHECK (end_date >= start_date)
);
CREATE INDEX lms_batch_list ON eureka.lms_batch (start_date DESC, id DESC);

CREATE TABLE eureka.lms_batch_course (
  batch_id  uuid NOT NULL REFERENCES eureka.lms_batch(id),
  course_id uuid NOT NULL REFERENCES eureka.lms_course(id),
  position  integer NOT NULL CHECK (position BETWEEN 1 AND 1000),
  PRIMARY KEY (batch_id, course_id)
);
CREATE INDEX lms_batch_course_course ON eureka.lms_batch_course (course_id);

CREATE TABLE eureka.lms_enrollment (
  batch_id    uuid NOT NULL REFERENCES eureka.lms_batch(id),
  user_id     uuid NOT NULL REFERENCES eureka.app_user(id),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, user_id)
);
CREATE INDEX lms_enrollment_user ON eureka.lms_enrollment (user_id, batch_id);

CREATE TABLE eureka.lms_module_progress (
  batch_id     uuid NOT NULL,
  user_id      uuid NOT NULL,
  module_id    uuid NOT NULL REFERENCES eureka.lms_module(id),
  percent      integer NOT NULL CHECK (percent BETWEEN 0 AND 100),
  completed_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, user_id, module_id),
  FOREIGN KEY (batch_id, user_id) REFERENCES eureka.lms_enrollment(batch_id, user_id),
  CONSTRAINT lms_progress_completed CHECK ((percent = 100) = (completed_at IS NOT NULL))
);
CREATE INDEX lms_module_progress_module ON eureka.lms_module_progress (module_id);

-- Only the definer functions (as authz_definer) write these tables; the server stamps
-- timestamps, version, archived_at and completed_at (rule 4). Courses are never deleted.
CREATE FUNCTION eureka.lms_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'lms data changes only through lms functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'lms_course' THEN
      RAISE EXCEPTION 'lms courses are archived, never deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'lms_course' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := pg_catalog.now(); NEW.updated_at := NEW.created_at;
      NEW.version := 1; NEW.archived_at := NULL;
    ELSE
      NEW.updated_at := pg_catalog.now(); NEW.version := OLD.version + 1;
      NEW.archived_at := CASE WHEN NEW.archived_at IS NULL THEN NULL
                              ELSE coalesce(OLD.archived_at, pg_catalog.now()) END;
    END IF;
  ELSIF TG_TABLE_NAME = 'lms_batch' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := pg_catalog.now(); NEW.archived_at := NULL;
    ELSE
      NEW.archived_at := CASE WHEN NEW.archived_at IS NULL THEN NULL
                              ELSE coalesce(OLD.archived_at, pg_catalog.now()) END;
    END IF;
  ELSIF TG_TABLE_NAME = 'lms_enrollment' THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'enrollments are not updated' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.enrolled_at := pg_catalog.now();
  ELSIF TG_TABLE_NAME = 'lms_module_progress' THEN
    NEW.updated_at := pg_catalog.now();
    NEW.completed_at := CASE WHEN NEW.percent = 100
      THEN coalesce(CASE WHEN TG_OP = 'UPDATE' THEN OLD.completed_at END, pg_catalog.now()) ELSE NULL END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lms_course_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.lms_course
  FOR EACH ROW EXECUTE FUNCTION eureka.lms_write_guard();
CREATE TRIGGER lms_module_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.lms_module
  FOR EACH ROW EXECUTE FUNCTION eureka.lms_write_guard();
CREATE TRIGGER lms_batch_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.lms_batch
  FOR EACH ROW EXECUTE FUNCTION eureka.lms_write_guard();
CREATE TRIGGER lms_batch_course_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.lms_batch_course
  FOR EACH ROW EXECUTE FUNCTION eureka.lms_write_guard();
CREATE TRIGGER lms_enrollment_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.lms_enrollment
  FOR EACH ROW EXECUTE FUNCTION eureka.lms_write_guard();
CREATE TRIGGER lms_module_progress_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.lms_module_progress
  FOR EACH ROW EXECUTE FUNCTION eureka.lms_write_guard();

-- TRUNCATE skips row triggers: refuse it for everyone (owner included).
CREATE FUNCTION eureka.lms_truncate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'lms data is never truncated' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER lms_course_truncate BEFORE TRUNCATE ON eureka.lms_course
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.lms_truncate_guard();
CREATE TRIGGER lms_module_truncate BEFORE TRUNCATE ON eureka.lms_module
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.lms_truncate_guard();
CREATE TRIGGER lms_batch_truncate BEFORE TRUNCATE ON eureka.lms_batch
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.lms_truncate_guard();
CREATE TRIGGER lms_batch_course_truncate BEFORE TRUNCATE ON eureka.lms_batch_course
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.lms_truncate_guard();
CREATE TRIGGER lms_enrollment_truncate BEFORE TRUNCATE ON eureka.lms_enrollment
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.lms_truncate_guard();
CREATE TRIGGER lms_module_progress_truncate BEFORE TRUNCATE ON eureka.lms_module_progress
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.lms_truncate_guard();

ALTER TABLE eureka.lms_course          ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.lms_course          FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.lms_module          ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.lms_module          FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.lms_batch           ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.lms_batch           FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.lms_batch_course    ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.lms_batch_course    FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.lms_enrollment      ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.lms_enrollment      FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.lms_module_progress ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.lms_module_progress FORCE ROW LEVEL SECURITY;

-- App read policies. Staff (lms:manage at org scope) read everything. A learner (lms:learn) reads
-- their own enrollments and progress and, through an enrollment, the batch, its course links, the
-- courses and their modules. Permission calls are InitPlans (evaluated once per statement).
CREATE POLICY lms_enrollment_read ON eureka.lms_enrollment FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('lms:manage'))
         OR ((SELECT authz.has_perm('lms:learn')) AND user_id = (SELECT authz.current_user_id())));
CREATE POLICY lms_progress_read ON eureka.lms_module_progress FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('lms:manage'))
         OR ((SELECT authz.has_perm('lms:learn')) AND user_id = (SELECT authz.current_user_id())));
CREATE POLICY lms_batch_read ON eureka.lms_batch FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('lms:manage'))
         OR EXISTS (SELECT 1 FROM eureka.lms_enrollment e
                    WHERE e.batch_id = lms_batch.id AND e.user_id = (SELECT authz.current_user_id())
                      AND (SELECT authz.has_perm('lms:learn'))));
CREATE POLICY lms_batch_course_read ON eureka.lms_batch_course FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('lms:manage'))
         OR EXISTS (SELECT 1 FROM eureka.lms_enrollment e
                    WHERE e.batch_id = lms_batch_course.batch_id AND e.user_id = (SELECT authz.current_user_id())
                      AND (SELECT authz.has_perm('lms:learn'))));
CREATE POLICY lms_course_read ON eureka.lms_course FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('lms:manage'))
         OR EXISTS (SELECT 1 FROM eureka.lms_batch_course bc
                    JOIN eureka.lms_enrollment e ON e.batch_id = bc.batch_id
                    WHERE bc.course_id = lms_course.id AND e.user_id = (SELECT authz.current_user_id())
                      AND (SELECT authz.has_perm('lms:learn'))));
CREATE POLICY lms_module_read ON eureka.lms_module FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('lms:manage'))
         OR EXISTS (SELECT 1 FROM eureka.lms_batch_course bc
                    JOIN eureka.lms_enrollment e ON e.batch_id = bc.batch_id
                    WHERE bc.course_id = lms_module.course_id AND e.user_id = (SELECT authz.current_user_id())
                      AND (SELECT authz.has_perm('lms:learn'))));

-- Definer: exactly what the functions below do.
CREATE POLICY definer_read   ON eureka.lms_course FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.lms_course FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.lms_course FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.lms_module FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.lms_module FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.lms_module FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.lms_module FOR DELETE TO authz_definer USING (true);
CREATE POLICY definer_read   ON eureka.lms_batch FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.lms_batch FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.lms_batch FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.lms_batch FOR DELETE TO authz_definer USING (true);
CREATE POLICY definer_read   ON eureka.lms_batch_course FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.lms_batch_course FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.lms_batch_course FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.lms_batch_course FOR DELETE TO authz_definer USING (true);
CREATE POLICY definer_read   ON eureka.lms_enrollment FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.lms_enrollment FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.lms_enrollment FOR DELETE TO authz_definer USING (true);
CREATE POLICY definer_read   ON eureka.lms_module_progress FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.lms_module_progress FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.lms_module_progress FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.lms_module_progress FOR DELETE TO authz_definer USING (true);

RESET ROLE;

REVOKE ALL ON eureka.lms_course, eureka.lms_module, eureka.lms_batch, eureka.lms_batch_course,
  eureka.lms_enrollment, eureka.lms_module_progress FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.lms_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.lms_truncate_guard() FROM PUBLIC;

GRANT SELECT ON eureka.lms_course, eureka.lms_module, eureka.lms_batch, eureka.lms_batch_course,
  eureka.lms_enrollment, eureka.lms_module_progress TO eureka_app;

GRANT SELECT, INSERT ON eureka.lms_course, eureka.lms_module, eureka.lms_batch, eureka.lms_batch_course,
  eureka.lms_enrollment, eureka.lms_module_progress TO authz_definer;
GRANT UPDATE (title, description, archived_at, updated_at, version) ON eureka.lms_course TO authz_definer;
GRANT UPDATE (position, title, duration_minutes) ON eureka.lms_module TO authz_definer;
GRANT UPDATE (name, year, start_date, end_date, archived_at) ON eureka.lms_batch TO authz_definer;
GRANT UPDATE (position) ON eureka.lms_batch_course TO authz_definer;
GRANT UPDATE (percent, completed_at, updated_at) ON eureka.lms_module_progress TO authz_definer;
GRANT DELETE ON eureka.lms_module, eureka.lms_batch, eureka.lms_batch_course, eureka.lms_enrollment,
  eureka.lms_module_progress TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- Internal: the caller holds lms:manage at org scope (active user, current grant) else 403.
CREATE FUNCTION authz.lms_require_manage() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_org('lms:manage'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE FUNCTION authz.lms_create_course(p_title text, p_description text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid; v_title text := btrim(p_title); v_desc text := coalesce(p_description, '');
BEGIN
  PERFORM authz.lms_require_manage();
  IF v_title IS NULL OR NOT coalesce(char_length(v_title) BETWEEN 1 AND 160, false)
     OR NOT coalesce(char_length(v_desc) <= 2000, false) THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.lms_course (title, description, created_by)
  VALUES (v_title, v_desc, authz.current_user_id()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- p_patch keys: title, description, archived (boolean). p_expected: the version the client saw
-- (NULL skips the check; the API requires it). Returns the new version.
CREATE FUNCTION authz.lms_update_course(p_id uuid, p_expected integer, p_patch jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; v integer; v_title text; v_desc text; v_arch boolean;
BEGIN
  PERFORM authz.lms_require_manage();
  SELECT x.version INTO c FROM eureka.lms_course x WHERE x.id = p_id FOR UPDATE;
  IF c.version IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_expected IS NOT NULL AND c.version IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  IF p_patch ? 'title' THEN
    v_title := btrim(p_patch ->> 'title');
    IF v_title IS NULL OR NOT coalesce(char_length(v_title) BETWEEN 1 AND 160, false) THEN
      RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p_patch ? 'description' THEN
    v_desc := coalesce(p_patch ->> 'description', '');
    IF NOT coalesce(char_length(v_desc) <= 2000, false) THEN
      RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p_patch ? 'archived' THEN
    v_arch := (p_patch ->> 'archived')::boolean;
    IF v_arch IS NULL THEN
      RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE eureka.lms_course x
     SET title = coalesce(v_title, x.title),
         description = coalesce(v_desc, x.description),
         archived_at = CASE WHEN v_arch IS NULL THEN x.archived_at
                            WHEN v_arch THEN coalesce(x.archived_at, pg_catalog.now()) ELSE NULL END
   WHERE x.id = p_id RETURNING x.version INTO v;
  RETURN v;
END $$;

-- Full ordered module list: [{id?, title, durationMinutes}]. Ids present are kept (and must belong
-- to this course), others are created, modules left out are removed together with their progress.
-- Returns the new course version.
CREATE FUNCTION authz.lms_set_modules(p_course uuid, p_modules jsonb, p_expected integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; r record; kept uuid[]; v integer; n integer; ids integer;
BEGIN
  PERFORM authz.lms_require_manage();
  SELECT x.version, x.archived_at INTO c FROM eureka.lms_course x WHERE x.id = p_course FOR UPDATE;
  IF c.version IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_expected IS NOT NULL AND c.version IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  IF c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'course_archived' USING ERRCODE = 'check_violation';
  END IF;
  IF p_modules IS NULL OR pg_catalog.jsonb_typeof(p_modules) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_modules) > 200 THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN SELECT t.e, t.ord FROM pg_catalog.jsonb_array_elements(p_modules) WITH ORDINALITY t(e, ord) LOOP
    IF pg_catalog.jsonb_typeof(r.e) IS DISTINCT FROM 'object'
       OR NOT coalesce(char_length(btrim(r.e ->> 'title')) BETWEEN 1 AND 160, false)
       OR NOT coalesce((r.e ->> 'durationMinutes')::integer BETWEEN 0 AND 6000, false) THEN
      RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  SELECT coalesce(pg_catalog.array_agg((t.e ->> 'id')::uuid) FILTER (WHERE (t.e ->> 'id') IS NOT NULL), '{}'),
         count((t.e ->> 'id')), count(DISTINCT (t.e ->> 'id'))
    INTO kept, n, ids
    FROM pg_catalog.jsonb_array_elements(p_modules) t(e);
  IF n IS DISTINCT FROM ids
     OR (SELECT count(*) FROM eureka.lms_module m WHERE m.course_id = p_course AND m.id = ANY (kept))
        IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'invalid_module' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.lms_module_progress p
   WHERE p.module_id IN (SELECT m.id FROM eureka.lms_module m
                          WHERE m.course_id = p_course AND NOT (m.id = ANY (kept)));
  DELETE FROM eureka.lms_module m WHERE m.course_id = p_course AND NOT (m.id = ANY (kept));
  FOR r IN SELECT t.e, t.ord FROM pg_catalog.jsonb_array_elements(p_modules) WITH ORDINALITY t(e, ord) ORDER BY t.ord LOOP
    IF (r.e ->> 'id') IS NULL THEN
      INSERT INTO eureka.lms_module (course_id, position, title, duration_minutes)
      VALUES (p_course, r.ord, btrim(r.e ->> 'title'), (r.e ->> 'durationMinutes')::integer);
    ELSE
      UPDATE eureka.lms_module m
         SET position = r.ord, title = btrim(r.e ->> 'title'),
             duration_minutes = (r.e ->> 'durationMinutes')::integer
       WHERE m.id = (r.e ->> 'id')::uuid AND m.course_id = p_course;
    END IF;
  END LOOP;
  UPDATE eureka.lms_course x SET updated_at = pg_catalog.now() WHERE x.id = p_course RETURNING x.version INTO v;
  RETURN v;
END $$;

CREATE FUNCTION authz.lms_create_batch(p_name text, p_start date, p_end date, p_year integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid; v_name text := btrim(p_name); v_year integer;
BEGIN
  PERFORM authz.lms_require_manage();
  IF v_name IS NULL OR NOT coalesce(char_length(v_name) BETWEEN 1 AND 120, false)
     OR p_start IS NULL OR p_end IS NULL OR NOT coalesce(p_end >= p_start, false) THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  v_year := coalesce(p_year, pg_catalog.date_part('year', p_start)::integer);
  INSERT INTO eureka.lms_batch (name, year, start_date, end_date, created_by)
  VALUES (v_name, v_year, p_start, p_end, authz.current_user_id()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- p_patch keys: name, startDate, endDate, year, archived (boolean).
CREATE FUNCTION authz.lms_update_batch(p_id uuid, p_patch jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record; v_name text; v_start date; v_end date; v_year integer; v_arch boolean;
BEGIN
  PERFORM authz.lms_require_manage();
  SELECT x.start_date, x.end_date INTO b FROM eureka.lms_batch x WHERE x.id = p_id FOR UPDATE;
  IF b.start_date IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  IF p_patch ? 'name' THEN
    v_name := btrim(p_patch ->> 'name');
    IF v_name IS NULL OR NOT coalesce(char_length(v_name) BETWEEN 1 AND 120, false) THEN
      RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p_patch ? 'startDate' THEN v_start := (p_patch ->> 'startDate')::date; END IF;
  IF p_patch ? 'endDate' THEN v_end := (p_patch ->> 'endDate')::date; END IF;
  IF p_patch ? 'year' THEN v_year := (p_patch ->> 'year')::integer; END IF;
  IF p_patch ? 'archived' THEN v_arch := (p_patch ->> 'archived')::boolean; END IF;
  IF (p_patch ? 'startDate' AND v_start IS NULL) OR (p_patch ? 'endDate' AND v_end IS NULL)
     OR (p_patch ? 'year' AND v_year IS NULL) OR (p_patch ? 'archived' AND v_arch IS NULL)
     OR NOT coalesce(coalesce(v_end, b.end_date) >= coalesce(v_start, b.start_date), false) THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.lms_batch x
     SET name = coalesce(v_name, x.name), start_date = coalesce(v_start, x.start_date),
         end_date = coalesce(v_end, x.end_date), year = coalesce(v_year, x.year),
         archived_at = CASE WHEN v_arch IS NULL THEN x.archived_at
                            WHEN v_arch THEN coalesce(x.archived_at, pg_catalog.now()) ELSE NULL END
   WHERE x.id = p_id;
END $$;

-- Only a batch without progress rows can be deleted (archive it instead).
CREATE FUNCTION authz.lms_delete_batch(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b uuid;
BEGIN
  PERFORM authz.lms_require_manage();
  SELECT x.id INTO b FROM eureka.lms_batch x WHERE x.id = p_id FOR UPDATE;
  IF b IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.lms_module_progress p WHERE p.batch_id = p_id) THEN
    RAISE EXCEPTION 'batch_has_progress' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.lms_enrollment WHERE batch_id = p_id;
  DELETE FROM eureka.lms_batch_course WHERE batch_id = p_id;
  DELETE FROM eureka.lms_batch WHERE id = p_id;
END $$;

-- Full ordered set of courses for a batch (at most 100). A newly added course must not be archived;
-- a removed course must have no progress in this batch.
CREATE FUNCTION authz.lms_set_batch_courses(p_batch uuid, p_course_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b uuid; n integer; r record;
BEGIN
  PERFORM authz.lms_require_manage();
  SELECT x.id INTO b FROM eureka.lms_batch x WHERE x.id = p_batch FOR UPDATE;
  IF b IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_course_ids IS NULL OR pg_catalog.cardinality(p_course_ids) > 100
     OR pg_catalog.array_position(p_course_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT x) FROM pg_catalog.unnest(p_course_ids) x) IS DISTINCT FROM pg_catalog.cardinality(p_course_ids) THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  n := pg_catalog.cardinality(p_course_ids);
  IF (SELECT count(*) FROM eureka.lms_course c WHERE c.id = ANY (p_course_ids)) IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'course_not_found' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.lms_course c
              WHERE c.id = ANY (p_course_ids) AND c.archived_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM eureka.lms_batch_course bc
                                 WHERE bc.batch_id = p_batch AND bc.course_id = c.id)) THEN
    RAISE EXCEPTION 'course_archived' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.lms_batch_course bc
              WHERE bc.batch_id = p_batch AND NOT (bc.course_id = ANY (p_course_ids))
                AND EXISTS (SELECT 1 FROM eureka.lms_module m
                              JOIN eureka.lms_module_progress p ON p.module_id = m.id AND p.batch_id = p_batch
                             WHERE m.course_id = bc.course_id)) THEN
    RAISE EXCEPTION 'course_has_progress' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.lms_batch_course bc WHERE bc.batch_id = p_batch AND NOT (bc.course_id = ANY (p_course_ids));
  FOR r IN SELECT t.cid, t.ord FROM pg_catalog.unnest(p_course_ids) WITH ORDINALITY t(cid, ord) LOOP
    INSERT INTO eureka.lms_batch_course (batch_id, course_id, position) VALUES (p_batch, r.cid, r.ord)
    ON CONFLICT (batch_id, course_id) DO UPDATE SET position = EXCLUDED.position;
  END LOOP;
END $$;

-- Enrolls active users (duplicates in the list and existing students are ignored). Returns the number added.
CREATE FUNCTION authz.lms_add_students(p_batch uuid, p_user_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b uuid; n integer; added integer;
BEGIN
  PERFORM authz.lms_require_manage();
  SELECT x.id INTO b FROM eureka.lms_batch x WHERE x.id = p_batch FOR UPDATE;
  IF b IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_user_ids IS NULL OR pg_catalog.cardinality(p_user_ids) > 100
     OR pg_catalog.array_position(p_user_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(DISTINCT x) INTO n FROM pg_catalog.unnest(p_user_ids) x;
  IF (SELECT count(*) FROM eureka.app_user u WHERE u.id = ANY (p_user_ids) AND u.status = 'active')
     IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'student_not_found' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.lms_enrollment (batch_id, user_id)
  SELECT p_batch, u FROM (SELECT DISTINCT x AS u FROM pg_catalog.unnest(p_user_ids) x) s
  ON CONFLICT (batch_id, user_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END $$;

-- Removes a student and their progress in this batch.
CREATE FUNCTION authz.lms_remove_student(p_batch uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b uuid;
BEGIN
  PERFORM authz.lms_require_manage();
  SELECT x.id INTO b FROM eureka.lms_batch x WHERE x.id = p_batch FOR UPDATE;
  IF b IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.lms_enrollment e WHERE e.batch_id = p_batch AND e.user_id = p_user) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  DELETE FROM eureka.lms_module_progress WHERE batch_id = p_batch AND user_id = p_user;
  DELETE FROM eureka.lms_enrollment WHERE batch_id = p_batch AND user_id = p_user;
END $$;

-- Internal: shared progress write. The student must be enrolled (404), the module must belong to a
-- course assigned to the batch (course_not_in_batch). Percent 100 stamps completed_at, lowering
-- clears it (the BEFORE guard does that).
CREATE FUNCTION authz.lms_write_progress(p_batch uuid, p_user uuid, p_module uuid, p_percent integer,
                                         OUT o_percent integer, OUT o_completed_at timestamptz, OUT o_updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_percent IS NULL OR NOT coalesce(p_percent BETWEEN 0 AND 100, false) THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  IF p_batch IS NULL OR p_user IS NULL OR p_module IS NULL
     OR NOT EXISTS (SELECT 1 FROM eureka.lms_enrollment e WHERE e.batch_id = p_batch AND e.user_id = p_user) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.lms_module m
                   JOIN eureka.lms_batch_course bc ON bc.course_id = m.course_id AND bc.batch_id = p_batch
                  WHERE m.id = p_module) THEN
    RAISE EXCEPTION 'course_not_in_batch' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.lms_module_progress (batch_id, user_id, module_id, percent)
  VALUES (p_batch, p_user, p_module, p_percent)
  ON CONFLICT (batch_id, user_id, module_id) DO UPDATE SET percent = EXCLUDED.percent
  RETURNING percent, completed_at, updated_at INTO o_percent, o_completed_at, o_updated_at;
END $$;

-- Staff override (lms:manage).
CREATE FUNCTION authz.lms_set_progress(p_batch uuid, p_user uuid, p_module uuid, p_percent integer)
RETURNS TABLE (percent integer, completed_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM authz.lms_require_manage();
  RETURN QUERY SELECT w.o_percent, w.o_completed_at, w.o_updated_at
                 FROM authz.lms_write_progress(p_batch, p_user, p_module, p_percent) w;
END $$;

-- Own progress (lms:learn); the student is always the caller, in a batch not archived.
CREATE FUNCTION authz.lms_set_my_progress(p_batch uuid, p_module uuid, p_percent integer)
RETURNS TABLE (percent integer, completed_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_perm('lms:learn'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_batch IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.lms_batch b WHERE b.id = p_batch AND b.archived_at IS NULL) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY SELECT w.o_percent, w.o_completed_at, w.o_updated_at
                 FROM authz.lms_write_progress(p_batch, authz.current_user_id(), p_module, p_percent) w;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.lms_require_manage() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_create_course(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_update_course(uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_set_modules(uuid, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_create_batch(text, date, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_update_batch(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_delete_batch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_set_batch_courses(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_add_students(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_remove_student(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_write_progress(uuid, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_set_progress(uuid, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.lms_set_my_progress(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.lms_create_course(text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_update_course(uuid, integer, jsonb) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_set_modules(uuid, jsonb, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_create_batch(text, date, date, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_update_batch(uuid, jsonb) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_delete_batch(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_set_batch_courses(uuid, uuid[]) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_add_students(uuid, uuid[]) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_remove_student(uuid, uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_set_progress(uuid, uuid, uuid, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.lms_set_my_progress(uuid, uuid, integer) TO eureka_app;
