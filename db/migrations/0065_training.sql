-- Training: course catalog, courses per batch, module progress per student
-- (Phase 3c "training"). Contract: docs/training-api.md (rules TR-1..TR-12).
-- Extends the batches of 0026/0032 instead of duplicating them: a student is
-- a candidate whose candidate.batch_id points at the batch.
--
--   1. eureka.batch gains a display name, a trainer, start and end dates, a
--      cover (tint + icon) and a row version. Writes stay inside definer
--      functions: authz.create_batch / authz.set_batch_status (replaced: now
--      also training:manage at the batch location), authz.update_batch
--      (If-Match row version), authz.delete_batch (only without students).
--   2. eureka.course (org catalog with an owning location: managers of that
--      location edit it, every training:read holder reads it) and
--      eureka.course_module (ordered, duration in minutes, https resource
--      links). Direct app writes under RLS (training:manage at the owning
--      location, or org) with server-managed columns set by triggers.
--   3. eureka.batch_course: ordered courses of a batch. Direct app writes
--      under RLS (training:manage covering the batch).
--   4. eureka.module_progress: one row per (batch, student, module) that is
--      complete, with who marked it and when. Written only by
--      authz.set_module_progress (training.progress:update covering the
--      batch: location roles at their location, interview coaches for the
--      batches they train).
--   5. Students are added and removed by training managers through
--      authz.set_batch_student; the candidate column guard now lets that
--      definer function (and only definer code) change batch_id without the
--      Sales candidate:update right. Sales keep editing batch_id on profiles
--      they own, as before.
--   6. Visibility. Batch-level coverage for a permission
--      (authz.training_batch_ids): org = every batch, location = batches at
--      that location, coached = batches where the user is the trainer.
--      Progress rows are readable with batch-level training:read coverage or
--      when the candidate is owned under training:read (Sales own/team/
--      hierarchy, coached teams; never Open to all teams). Policies use
--      InitPlans and the hashed owned-candidate set (rule 3).
-- Audit and outbox: nothing here writes free text to either (rule 5); the API
-- audits ids, codes and changed field names only.
-- Every IF is NULL-safe (see 0012/0015).
SET search_path = eureka, public;

-- =====================================================================
-- tables
-- =====================================================================
SET ROLE eureka_owner;

ALTER TABLE eureka.batch
  ADD COLUMN name        text CHECK (name IS NULL OR (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]')),
  ADD COLUMN trainer_id  uuid REFERENCES eureka.app_user(id),
  ADD COLUMN start_date  date,
  ADD COLUMN end_date    date,
  ADD COLUMN cover_color text NOT NULL DEFAULT 'indigo'
             CHECK (cover_color IN ('indigo', 'teal', 'amber', 'rose', 'violet', 'sky')),
  ADD COLUMN cover_icon  text NOT NULL DEFAULT 'users'
             CHECK (cover_icon IN ('book', 'code', 'database', 'cloud', 'shield', 'chart', 'users', 'cap')),
  ADD COLUMN row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT batch_start_in_month CHECK (start_date IS NULL OR date_trunc('month', start_date)::date = start_month),
  ADD CONSTRAINT batch_dates CHECK (end_date IS NULL OR end_date >= coalesce(start_date, start_month)),
  ADD CONSTRAINT batch_end_range CHECK (end_date IS NULL OR end_date <= date '2100-12-31');
CREATE INDEX batch_trainer ON eureka.batch (trainer_id) WHERE trainer_id IS NOT NULL;

CREATE TABLE eureka.course (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owning location: training managers of this location (or org) edit the course.
  location_id  uuid NOT NULL REFERENCES eureka.location(id),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title !~ '[[:cntrl:]]'),
  description  text CHECK (description IS NULL OR (char_length(description) <= 2000
                           AND description !~ '[\x01-\x09\x0b-\x1f\x7f]')),
  cover_color  text NOT NULL DEFAULT 'indigo' CHECK (cover_color IN ('indigo', 'teal', 'amber', 'rose', 'violet', 'sky')),
  cover_icon   text NOT NULL DEFAULT 'book'
               CHECK (cover_icon IN ('book', 'code', 'database', 'cloud', 'shield', 'chart', 'users', 'cap')),
  archived     boolean NOT NULL DEFAULT false,
  created_by   uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1
);
CREATE INDEX course_location ON eureka.course (location_id);

CREATE TABLE eureka.course_module (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        uuid NOT NULL REFERENCES eureka.course(id) ON DELETE CASCADE,
  position         integer NOT NULL CHECK (position BETWEEN 1 AND 1000),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160 AND title !~ '[[:cntrl:]]'),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 10000),
  -- Up to 10 https links, no whitespace or control characters, no NULL elements.
  -- Joined with \x01, which no valid element contains, so the split is unambiguous.
  resource_urls    text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(resource_urls) <= 10
    AND array_position(resource_urls, NULL) IS NULL
    AND (cardinality(resource_urls) = 0
         -- Authority without '@' (no user info), then an optional path, query or fragment.
         OR array_to_string(resource_urls, E'\x01') ~
            '^https://[^[:space:][:cntrl:]@/?#]+([/?#][^[:space:][:cntrl:]]*)?(\x01https://[^[:space:][:cntrl:]@/?#]+([/?#][^[:space:][:cntrl:]]*)?)*$')
    AND char_length(array_to_string(resource_urls, '')) <= 20000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  row_version      integer NOT NULL DEFAULT 1,
  -- Deferrable so one UPDATE can reorder (checked at the end of the statement).
  CONSTRAINT course_module_position UNIQUE (course_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE eureka.batch_course (
  batch_id  uuid NOT NULL REFERENCES eureka.batch(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES eureka.course(id),
  position  integer NOT NULL CHECK (position BETWEEN 1 AND 1000),
  added_by  uuid NOT NULL REFERENCES eureka.app_user(id),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, course_id),
  CONSTRAINT batch_course_position UNIQUE (batch_id, position) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX batch_course_course ON eureka.batch_course (course_id);

CREATE TABLE eureka.module_progress (
  batch_id     uuid NOT NULL REFERENCES eureka.batch(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES eureka.candidate(id),
  -- RESTRICT: a module with recorded completions cannot be deleted (409 module_in_use).
  module_id    uuid NOT NULL REFERENCES eureka.course_module(id),
  completed_at timestamptz NOT NULL DEFAULT now(),
  completed_by uuid NOT NULL REFERENCES eureka.app_user(id),
  PRIMARY KEY (batch_id, candidate_id, module_id)
);
CREATE INDEX module_progress_candidate ON eureka.module_progress (candidate_id);
CREATE INDEX module_progress_module ON eureka.module_progress (module_id);

-- ---------- guards (server-managed columns, immutables) ----------

-- course: the server stamps who and when; location and creator never change.
CREATE FUNCTION eureka.course_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'eureka_app' THEN
      IF authz.current_user_id() IS NULL THEN
        RAISE EXCEPTION 'no user context' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.created_by := authz.current_user_id();
      NEW.archived := false;
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := pg_catalog.now();
    NEW.row_version := 1;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- TR-4: archiving blocks other locations' batches from adding the course; refused while any
  -- batch outside the editor's training locations uses it.
  IF NEW.archived AND NOT OLD.archived AND current_user = 'eureka_app'
     AND coalesce(authz.course_used_outside(OLD.id), true) THEN
    RAISE EXCEPTION 'course_shared' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := pg_catalog.now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER course_guard BEFORE INSERT OR UPDATE ON eureka.course
  FOR EACH ROW EXECUTE FUNCTION eureka.course_guard();

-- course_module: a module stays in its course; a reorder alone keeps the row version.
CREATE FUNCTION eureka.course_module_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- TR-4: durations feed every student's progress live, so adding, re-timing, reordering or
  -- deleting modules of a course used by a batch outside the editor's training locations is
  -- refused (title and link edits stay allowed). Checked for the app role only.
  IF current_user = 'eureka_app' AND (
       TG_OP IN ('INSERT', 'DELETE')
       OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
       OR NEW.position IS DISTINCT FROM OLD.position) THEN
    IF coalesce(authz.course_used_outside(CASE WHEN TG_OP = 'DELETE' THEN OLD.course_id ELSE NEW.course_id END), true) THEN
      RAISE EXCEPTION 'course_shared' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := pg_catalog.now();
    NEW.row_version := 1;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.course_id IS DISTINCT FROM OLD.course_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.title, NEW.duration_minutes, NEW.resource_urls) IS DISTINCT FROM (OLD.title, OLD.duration_minutes, OLD.resource_urls) THEN
    NEW.updated_at := pg_catalog.now();
    NEW.row_version := OLD.row_version + 1;
  ELSE
    NEW.updated_at := OLD.updated_at;
    NEW.row_version := OLD.row_version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER course_module_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.course_module
  FOR EACH ROW EXECUTE FUNCTION eureka.course_module_guard();

-- batch_course: who added it and when are the server's; only the position
-- changes later. New assignments need an open batch and an active course.
CREATE FUNCTION eureka.batch_course_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'eureka_app' THEN
      IF authz.current_user_id() IS NULL THEN
        RAISE EXCEPTION 'no user context' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.added_by := authz.current_user_id();
    END IF;
    NEW.added_at := pg_catalog.now();
    IF NOT EXISTS (SELECT 1 FROM eureka.batch b WHERE b.id = NEW.batch_id AND b.status IN ('planned', 'in_training')) THEN
      RAISE EXCEPTION 'batch_closed' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM eureka.course c WHERE c.id = NEW.course_id AND c.archived) THEN
      RAISE EXCEPTION 'course_archived' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.batch_id, NEW.course_id, NEW.added_by, NEW.added_at) IS DISTINCT FROM (OLD.batch_id, OLD.course_id, OLD.added_by, OLD.added_at) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER batch_course_guard BEFORE INSERT OR UPDATE ON eureka.batch_course
  FOR EACH ROW EXECUTE FUNCTION eureka.batch_course_guard();

-- module_progress: definer only; the server stamps who and when; never updated.
CREATE FUNCTION eureka.module_progress_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'module_progress rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'module_progress rows are never updated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'no user context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.completed_at := pg_catalog.now();
  NEW.completed_by := authz.current_user_id();
  RETURN NEW;
END $$;
CREATE TRIGGER module_progress_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.module_progress
  FOR EACH ROW EXECUTE FUNCTION eureka.module_progress_guard();

-- Batch write guard (0026/0032): the definer may now also change the details
-- (name, trainer, dates, size, cover; start_month follows start_date) and
-- delete a batch (authz.delete_batch checks there are no students). Location
-- and technology never change. Every update bumps the row version.
CREATE OR REPLACE FUNCTION eureka.candidate_extras_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION '% rows are written only by definer functions', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'batch' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'batch' THEN
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'name', 'trainer_id', 'start_date', 'end_date', 'start_month',
                                         'size_planned', 'cover_color', 'cover_icon', 'row_version', 'updated_at'])
       IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'name', 'trainer_id', 'start_date', 'end_date', 'start_month',
                                         'size_planned', 'cover_color', 'cover_icon', 'row_version', 'updated_at']) THEN
      RAISE EXCEPTION 'only the batch status and details change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.row_version := OLD.row_version + 1;
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'candidate_event' THEN
    NEW.at := pg_catalog.now();
    NEW.actor_id := authz.current_user_id();
  ELSE
    NEW.created_at := pg_catalog.now();
    NEW.created_by := authz.current_user_id();
    NEW.status := 'planned';
    NEW.row_version := 1;
    NEW.updated_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;

-- Candidate column guard (0026): batch_id may also change inside definer code
-- (authz.set_batch_student re-checks training:manage over the batch). For the
-- app role nothing changes: batch_id is a profile field under candidate:update.
CREATE OR REPLACE FUNCTION eureka.candidate_column_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  is_definer boolean := current_user = 'authz_definer';
  owns_old   boolean;
BEGIN
  -- Never changeable through the API.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Status columns change only through authz.transition_candidate (N2).
  IF (NEW.marketing_status IS DISTINCT FROM OLD.marketing_status
      OR NEW.bench_since IS DISTINCT FROM OLD.bench_since) AND NOT is_definer THEN
    RAISE EXCEPTION 'status changes must use a transition' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF ((NEW.technology_id, NEW.gh_location_id, NEW.priority, NEW.marketing_email, NEW.vitel_number,
       NEW.marketing_start_date, NEW.in_person_ok)
      IS DISTINCT FROM
      (OLD.technology_id, OLD.gh_location_id, OLD.priority, OLD.marketing_email, OLD.vitel_number,
       OLD.marketing_start_date, OLD.in_person_ok)
      OR (NEW.batch_id IS DISTINCT FROM OLD.batch_id AND NOT is_definer))
     AND NOT authz.owns('candidate:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update profile fields' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.technical_rating IS DISTINCT FROM OLD.technical_rating
     AND NOT authz.owns('candidate.rating:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update technical rating' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.visibility IS DISTINCT FROM OLD.visibility
     AND NOT authz.owns('candidate.visibility:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to change visibility' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     OR (NEW.recruiter_id IS DISTINCT FROM OLD.recruiter_id AND NOT is_definer) THEN
    owns_old := authz.owns('candidate:assign', OLD.recruiter_id, OLD.team_id, OLD.location_id);
    IF NOT owns_old
       OR NOT coalesce(authz.has_org('candidate:assign') OR NEW.team_id = ANY (authz.team_ids('candidate:assign')), false) THEN
      RAISE EXCEPTION 'not permitted to reassign candidate' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;

RESET ROLE;

-- =====================================================================
-- scope helpers and definer functions
-- =====================================================================
SET ROLE authz_definer;

-- Batch-level coverage for a training permission (TR-2): org = every batch,
-- location = batches at the grant's location, coached = batches the caller
-- trains. Own/team/hierarchy grants cover no batch.
CREATE FUNCTION authz.training_batch_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN perm NOT IN ('training:read', 'training:manage', 'training.progress:update') THEN '{}'::uuid[]
    WHEN authz.has_org(perm) THEN (SELECT coalesce(pg_catalog.array_agg(b.id), '{}') FROM eureka.batch b)
    ELSE (SELECT coalesce(pg_catalog.array_agg(b.id), '{}') FROM eureka.batch b
          WHERE b.location_id = ANY (authz.location_ids(perm))
             OR (b.trainer_id = authz.current_user_id()
                 AND EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope = 'coached')))
  END
$$;

-- Locations where the caller may create, edit, change the status of and
-- delete batches: Sales leadership's planning locations (0032) and the
-- locations of a training:manage grant (every location for an org grant).
CREATE FUNCTION authz.batch_manage_location_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN authz.has_org('training:manage') THEN (SELECT coalesce(pg_catalog.array_agg(l.id), '{}') FROM eureka.location l)
    ELSE (SELECT coalesce(pg_catalog.array_agg(DISTINCT x), '{}') FROM (
      SELECT pg_catalog.unnest(authz.location_ids('training:manage')) AS x
      UNION
      SELECT pg_catalog.unnest(CASE WHEN coalesce(authz.batch_manager(), false) THEN authz.batch_location_ids()
                                    ELSE '{}'::uuid[] END)) s)
  END
$$;

-- Locations of a training:manage grant only (every location for an org grant): the
-- authority for editing and deleting batches (TR-1). Sales planning rights reach only
-- create_batch and set_batch_status, as before 0065.
CREATE FUNCTION authz.training_manage_location_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN authz.has_org('training:manage') THEN (SELECT coalesce(pg_catalog.array_agg(l.id), '{}') FROM eureka.location l)
    ELSE authz.location_ids('training:manage')
  END
$$;

-- True when a batch outside the caller's training:manage locations uses the course
-- (TR-4). The caller's own locations are the only ones they may re-time.
CREATE FUNCTION authz.course_used_outside(p_course uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM eureka.batch_course bc JOIN eureka.batch b ON b.id = bc.batch_id
    WHERE bc.course_id = p_course
      AND NOT (b.location_id = ANY (authz.training_manage_location_ids())))
$$;

-- Batches the caller sees on the Training Batches screen, with the number of
-- students they may see there: every student when the batch is covered at
-- batch level, else the students they own under training:read.
CREATE FUNCTION authz.training_batches()
RETURNS TABLE (batch_id uuid, covered boolean, students integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH s AS MATERIALIZED (
    SELECT authz.training_batch_ids('training:read') AS b, authz.owned_candidate_ids('training:read') AS c
    WHERE authz.has_perm('training:read')),
  owned AS MATERIALIZED (
    SELECT c.id, c.batch_id FROM s, pg_catalog.unnest(s.c) AS x(id) JOIN eureka.candidate c ON c.id = x.id
    WHERE c.batch_id IS NOT NULL),
  vis AS (
    SELECT pg_catalog.unnest(s.b) AS id FROM s
    UNION
    SELECT o.batch_id FROM owned o)
  SELECT v.id, coalesce(v.id = ANY (s.b), false),
         CASE WHEN coalesce(v.id = ANY (s.b), false)
              THEN (SELECT count(*)::integer FROM eureka.candidate c WHERE c.batch_id = v.id)
              ELSE (SELECT count(*)::integer FROM owned o WHERE o.batch_id = v.id) END
  FROM vis v, s
$$;

-- Students of a batch the caller may list (names, technology and status only):
-- all of them with batch-level training:read coverage, else the owned ones.
CREATE FUNCTION authz.training_batch_students(p_batch uuid)
RETURNS TABLE (candidate_id uuid, first_name text, last_name text, technology text, marketing_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH s AS MATERIALIZED (
    SELECT coalesce(p_batch = ANY (authz.training_batch_ids('training:read')), false) AS covered
    WHERE authz.has_perm('training:read')),
  o AS MATERIALIZED (
    SELECT CASE WHEN s.covered THEN '{}'::uuid[] ELSE authz.owned_candidate_ids('training:read') END AS ids FROM s)
  SELECT c.id, p.first_name, p.last_name, t.name, c.marketing_status
  FROM s, o, eureka.candidate c
  JOIN eureka.person p ON p.id = c.person_id
  JOIN eureka.technology t ON t.id = c.technology_id
  WHERE c.batch_id = p_batch AND (s.covered OR c.id = ANY (o.ids))
$$;

-- 0032's create_batch, now also for training managers at their locations.
CREATE OR REPLACE FUNCTION authz.create_batch(p_location uuid, p_technology uuid, p_start_month date, p_size integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE new_id uuid;
BEGIN
  IF authz.current_user_id() IS NULL
     OR NOT coalesce(authz.batch_manager() OR authz.has_perm('training:manage'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_location IS NULL OR p_technology IS NULL OR p_start_month IS NULL
     OR NOT EXISTS (SELECT 1 FROM eureka.location l WHERE l.id = p_location)
     OR NOT EXISTS (SELECT 1 FROM eureka.technology t WHERE t.id = p_technology AND t.active)
     OR (p_size IS NOT NULL AND NOT coalesce(p_size BETWEEN 1 AND 500, false)) THEN
    RAISE EXCEPTION 'invalid_batch' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(p_location = ANY (authz.batch_manage_location_ids()), false) THEN
    RAISE EXCEPTION 'location_not_in_scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  BEGIN
    INSERT INTO eureka.batch (location_id, technology_id, start_month, size_planned)
    VALUES (p_location, p_technology, pg_catalog.date_trunc('month', p_start_month)::date, p_size)
    RETURNING id INTO new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'batch_exists' USING ERRCODE = 'unique_violation';
  END;
  RETURN new_id;
END $$;

-- 0032's set_batch_status, now also for training managers at the batch location.
CREATE OR REPLACE FUNCTION authz.set_batch_status(p_batch uuid, p_to text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(authz.has_perm('candidate:read') OR authz.has_perm('training:read'), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(b.location_id = ANY (authz.batch_manage_location_ids()), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to IS NULL OR NOT coalesce((b.status, p_to) IN (
      ('planned', 'in_training'), ('in_training', 'completed'),
      ('planned', 'cancelled'), ('in_training', 'cancelled')), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.batch SET status = p_to WHERE id = p_batch;
  RETURN p_to;
END $$;

-- Batch details (TR-6). All values are the new ones (the API merges the
-- request with what it read); p_version is the row version from If-Match.
-- Returns the new row version.
CREATE FUNCTION authz.update_batch(
  p_batch uuid, p_version integer, p_name text, p_trainer uuid, p_start date, p_end date,
  p_size integer, p_color text, p_icon text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record; nm text := nullif(pg_catalog.btrim(p_name), ''); v integer; month date;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(authz.has_perm('candidate:read') OR authz.has_perm('training:read'), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(b.location_id = ANY (authz.training_manage_location_ids()), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_version IS NULL OR p_version IS DISTINCT FROM b.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'raise_exception';
  END IF;
  IF (nm IS NOT NULL AND NOT coalesce(pg_catalog.char_length(nm) <= 80 AND nm !~ '[[:cntrl:]]', false))
     OR (p_size IS NOT NULL AND NOT coalesce(p_size BETWEEN 1 AND 500, false))
     OR p_color IS NULL OR p_color NOT IN ('indigo', 'teal', 'amber', 'rose', 'violet', 'sky')
     OR p_icon IS NULL OR p_icon NOT IN ('book', 'code', 'database', 'cloud', 'shield', 'chart', 'users', 'cap')
     OR (p_start IS NOT NULL AND NOT coalesce(p_start BETWEEN date '2000-01-01' AND date '2100-12-31', false)) THEN
    RAISE EXCEPTION 'invalid_batch' USING ERRCODE = 'check_violation';
  END IF;
  month := coalesce(pg_catalog.date_trunc('month', p_start)::date, b.start_month);
  IF p_end IS NOT NULL AND NOT coalesce(p_end >= coalesce(p_start, month) AND p_end <= date '2100-12-31', false) THEN
    RAISE EXCEPTION 'invalid_dates' USING ERRCODE = 'check_violation';
  END IF;
  -- The trainer is an active user who may record progress (any scope).
  IF p_trainer IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM eureka.user_role ur
      JOIN eureka.app_user u ON u.id = ur.user_id AND u.status = 'active'
      JOIN eureka.role_permission rp ON rp.role_key = ur.role_key AND rp.permission = 'training.progress:update'
      WHERE ur.user_id = p_trainer AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'invalid_trainer' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    UPDATE eureka.batch SET name = nm, trainer_id = p_trainer, start_date = p_start, end_date = p_end,
      start_month = month, size_planned = p_size, cover_color = p_color, cover_icon = p_icon
    WHERE id = p_batch RETURNING row_version INTO v;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'batch_exists' USING ERRCODE = 'unique_violation';
  END;
  RETURN v;
END $$;

-- Delete a batch (TR-7): only while it has no students (otherwise cancel it).
-- Its course list and any progress of former students go with it.
CREATE FUNCTION authz.delete_batch(p_batch uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(authz.has_perm('candidate:read') OR authz.has_perm('training:read'), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(b.location_id = ANY (authz.training_manage_location_ids()), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- set_batch_student holds FOR SHARE on the batch row, so it waits for this lock; a
  -- concurrent profile edit that still sets batch_id makes the DELETE fail on the foreign key.
  IF EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.batch_id = p_batch) THEN
    RAISE EXCEPTION 'batch_has_students' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.module_progress WHERE batch_id = p_batch;
  DELETE FROM eureka.batch WHERE id = p_batch;
END $$;

-- Add (p_member true) or remove a student (TR-8): training:manage covering
-- the batch. The candidate must be at the batch's location; the batch must be
-- planned or in training to add. Moving from another batch is allowed.
CREATE FUNCTION authz.set_batch_student(p_batch uuid, p_candidate uuid, p_member boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record; c record;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR SHARE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(p_batch = ANY (authz.training_batch_ids('training:read')), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(p_batch = ANY (authz.training_batch_ids('training:manage')), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_member IS NULL THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x.id, x.batch_id, x.location_id INTO c FROM eureka.candidate x WHERE x.id = p_candidate FOR UPDATE;
  -- One answer for "no such candidate", "not readable by the caller" and "not at this location".
  IF NOT FOUND OR c.location_id IS DISTINCT FROM b.location_id
     OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false) THEN
    RAISE EXCEPTION 'candidate_not_eligible' USING ERRCODE = 'check_violation';
  END IF;
  IF p_member THEN
    IF c.batch_id IS NOT DISTINCT FROM p_batch THEN RETURN; END IF;
    IF b.status NOT IN ('planned', 'in_training') THEN
      RAISE EXCEPTION 'batch_closed' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.candidate SET batch_id = p_batch WHERE id = p_candidate;
  ELSE
    IF c.batch_id IS DISTINCT FROM p_batch THEN
      RAISE EXCEPTION 'not_in_batch' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.candidate SET batch_id = NULL WHERE id = p_candidate;
  END IF;
END $$;

-- Mark a module complete (p_done true) or not (TR-10): training.progress:update
-- covering the batch; the candidate is a current student, the module belongs
-- to a course assigned to the batch, the batch is planned or in training.
-- Returns the completion time, or NULL when cleared.
CREATE FUNCTION authz.set_module_progress(p_batch uuid, p_candidate uuid, p_module uuid, p_done boolean)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record; t timestamptz;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR SHARE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(p_batch = ANY (authz.training_batch_ids('training:read')), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(p_batch = ANY (authz.training_batch_ids('training.progress:update')), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_done IS NULL THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  IF b.status NOT IN ('planned', 'in_training') THEN
    RAISE EXCEPTION 'batch_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.id = p_candidate AND c.batch_id = p_batch) THEN
    RAISE EXCEPTION 'not_in_batch' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.course_module m
                 JOIN eureka.batch_course bc ON bc.course_id = m.course_id AND bc.batch_id = p_batch
                 WHERE m.id = p_module) THEN
    RAISE EXCEPTION 'module_not_in_batch' USING ERRCODE = 'check_violation';
  END IF;
  IF p_done THEN
    INSERT INTO eureka.module_progress (batch_id, candidate_id, module_id, completed_by)
    VALUES (p_batch, p_candidate, p_module, authz.current_user_id())
    ON CONFLICT (batch_id, candidate_id, module_id) DO NOTHING;
    SELECT mp.completed_at INTO t FROM eureka.module_progress mp
    WHERE mp.batch_id = p_batch AND mp.candidate_id = p_candidate AND mp.module_id = p_module;
    RETURN t;
  END IF;
  DELETE FROM eureka.module_progress mp
  WHERE mp.batch_id = p_batch AND mp.candidate_id = p_candidate AND mp.module_id = p_module;
  RETURN NULL;
END $$;

RESET ROLE;

-- =====================================================================
-- RLS
-- =====================================================================
SET ROLE eureka_owner;

ALTER TABLE eureka.course          ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.course          FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.course_module   ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.course_module   FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.batch_course    ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.batch_course    FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.module_progress ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.module_progress FORCE ROW LEVEL SECURITY;

-- Batches: also readable by training:read holders (0026 lets candidate:read holders list them).
CREATE POLICY batch_training_read ON eureka.batch FOR SELECT TO eureka_app
  USING ((SELECT authz.has_perm('training:read')));
CREATE POLICY definer_delete ON eureka.batch FOR DELETE TO authz_definer USING (true);

-- Course catalog: read by every training:read holder; written by training
-- managers of the owning location (or org).
CREATE POLICY course_read ON eureka.course FOR SELECT TO eureka_app
  USING ((SELECT authz.has_perm('training:read')));
CREATE POLICY course_insert ON eureka.course FOR INSERT TO eureka_app WITH CHECK (
  (SELECT authz.has_org('training:manage'))
  OR location_id = ANY ((SELECT authz.location_ids('training:manage'))::uuid[]));
CREATE POLICY course_update ON eureka.course FOR UPDATE TO eureka_app
  USING ((SELECT authz.has_org('training:manage'))
         OR location_id = ANY ((SELECT authz.location_ids('training:manage'))::uuid[]))
  WITH CHECK ((SELECT authz.has_org('training:manage'))
              OR location_id = ANY ((SELECT authz.location_ids('training:manage'))::uuid[]));
CREATE POLICY course_delete ON eureka.course FOR DELETE TO eureka_app
  USING ((SELECT authz.has_org('training:manage'))
         OR location_id = ANY ((SELECT authz.location_ids('training:manage'))::uuid[]));
CREATE POLICY definer_read ON eureka.course FOR SELECT TO authz_definer USING (true);

-- Modules follow their course (EXISTS by primary key; the scope arrays are InitPlans).
CREATE POLICY course_module_read ON eureka.course_module FOR SELECT TO eureka_app
  USING ((SELECT authz.has_perm('training:read')));
CREATE POLICY course_module_insert ON eureka.course_module FOR INSERT TO eureka_app WITH CHECK (
  EXISTS (SELECT 1 FROM eureka.course c WHERE c.id = course_module.course_id
          AND ((SELECT authz.has_org('training:manage'))
               OR c.location_id = ANY ((SELECT authz.location_ids('training:manage'))::uuid[]))));
CREATE POLICY course_module_update ON eureka.course_module FOR UPDATE TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.course c WHERE c.id = course_module.course_id
                 AND ((SELECT authz.has_org('training:manage'))
                      OR c.location_id = ANY ((SELECT authz.location_ids('training:manage'))::uuid[]))))
  WITH CHECK (EXISTS (SELECT 1 FROM eureka.course c WHERE c.id = course_module.course_id
                      AND ((SELECT authz.has_org('training:manage'))
                           OR c.location_id = ANY ((SELECT authz.location_ids('training:manage'))::uuid[]))));
CREATE POLICY course_module_delete ON eureka.course_module FOR DELETE TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.course c WHERE c.id = course_module.course_id
                 AND ((SELECT authz.has_org('training:manage'))
                      OR c.location_id = ANY ((SELECT authz.location_ids('training:manage'))::uuid[]))));
CREATE POLICY definer_read ON eureka.course_module FOR SELECT TO authz_definer USING (true);

-- Courses of a batch: read by training:read holders; written by training
-- managers covering the batch.
CREATE POLICY batch_course_read ON eureka.batch_course FOR SELECT TO eureka_app
  USING ((SELECT authz.has_perm('training:read')));
CREATE POLICY batch_course_insert ON eureka.batch_course FOR INSERT TO eureka_app
  WITH CHECK (batch_id = ANY ((SELECT authz.training_batch_ids('training:manage'))::uuid[]));
CREATE POLICY batch_course_update ON eureka.batch_course FOR UPDATE TO eureka_app
  USING (batch_id = ANY ((SELECT authz.training_batch_ids('training:manage'))::uuid[]))
  WITH CHECK (batch_id = ANY ((SELECT authz.training_batch_ids('training:manage'))::uuid[]));
CREATE POLICY batch_course_delete ON eureka.batch_course FOR DELETE TO eureka_app
  USING (batch_id = ANY ((SELECT authz.training_batch_ids('training:manage'))::uuid[]));
CREATE POLICY definer_read ON eureka.batch_course FOR SELECT TO authz_definer USING (true);

-- Progress: batch-level training:read coverage, or a candidate owned under
-- training:read (hashed owned-candidate set, rule 3). Written only by the definer.
CREATE POLICY module_progress_read ON eureka.module_progress FOR SELECT TO eureka_app USING (
  batch_id = ANY ((SELECT authz.training_batch_ids('training:read'))::uuid[])
  OR candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('training:read')))));
CREATE POLICY definer_read   ON eureka.module_progress FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.module_progress FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.module_progress FOR DELETE TO authz_definer USING (true);

RESET ROLE;

-- =====================================================================
-- grants
-- =====================================================================
REVOKE ALL ON eureka.course, eureka.course_module, eureka.batch_course, eureka.module_progress FROM PUBLIC;

GRANT SELECT, DELETE ON eureka.course TO eureka_app;
GRANT INSERT (location_id, title, description, cover_color, cover_icon) ON eureka.course TO eureka_app;
GRANT UPDATE (title, description, cover_color, cover_icon, archived) ON eureka.course TO eureka_app;
GRANT SELECT, DELETE ON eureka.course_module TO eureka_app;
GRANT INSERT (course_id, position, title, duration_minutes, resource_urls) ON eureka.course_module TO eureka_app;
GRANT UPDATE (position, title, duration_minutes, resource_urls) ON eureka.course_module TO eureka_app;
GRANT SELECT, DELETE ON eureka.batch_course TO eureka_app;
GRANT INSERT (batch_id, course_id, position) ON eureka.batch_course TO eureka_app;
GRANT UPDATE (position) ON eureka.batch_course TO eureka_app;
GRANT SELECT ON eureka.module_progress TO eureka_app;

GRANT SELECT ON eureka.course, eureka.course_module, eureka.batch_course TO authz_definer;
GRANT SELECT, INSERT, DELETE ON eureka.module_progress TO authz_definer;
GRANT UPDATE (name, trainer_id, start_date, end_date, start_month, size_planned, cover_color, cover_icon,
              row_version, updated_at) ON eureka.batch TO authz_definer;
GRANT DELETE ON eureka.batch TO authz_definer;
GRANT UPDATE (batch_id) ON eureka.candidate TO authz_definer;

REVOKE ALL ON FUNCTION eureka.course_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.course_module_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.batch_course_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.module_progress_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION authz.training_batch_ids(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.batch_manage_location_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.training_manage_location_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.course_used_outside(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.training_batches() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.training_batch_students(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.update_batch(uuid, integer, text, uuid, date, date, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.delete_batch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.set_batch_student(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.set_module_progress(uuid, uuid, uuid, boolean) FROM PUBLIC;
-- The app evaluates training_batch_ids in its policies (InitPlan) and calls the rest.
-- batch_manage_location_ids is internal to the definer functions.
GRANT EXECUTE ON FUNCTION authz.training_batch_ids(text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.training_batches() TO eureka_app;
-- Called by the course and module guard triggers, which run as the app role.
GRANT EXECUTE ON FUNCTION authz.course_used_outside(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.training_batch_students(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.update_batch(uuid, integer, text, uuid, date, date, integer, text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.delete_batch(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.set_batch_student(uuid, uuid, boolean) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.set_module_progress(uuid, uuid, uuid, boolean) TO eureka_app;
-- Replaced functions keep their grants (create_batch, set_batch_status: eureka_app;
-- the two guards: trigger functions, no EXECUTE).
