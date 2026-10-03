-- Phase 3: paperwork checklist progress and background checks (implementation
-- plan Phase 3; design B2.4 `checklist_template`, `checklist_item`, `bgc`;
-- B2.6 placement state machine; B4.4 "Documents, BGC, work authorization";
-- FR-BGC-01..03, FR-PLC-06). Contract: docs/paperwork-api.md.
--
--   1. Templates are versioned. authz.checklist_template keeps one immutable
--      row per (kind, placement type, version); publishing appends a version
--      (authz.publish_checklist_template, HR-side roles holding document:verify
--      at org scope). A placement copies the latest paperwork version when it
--      is created (0035 trigger, now recording template_version); later
--      versions never rewrite existing placements. No template content ships:
--      it is an open product question (docs/phase2-status.md).
--   2. Checklist items gain progress: status pending -> received -> verified,
--      waived (with a reason), returned/reopened to pending (with a reason);
--      owner role, assignee, due date, notes and a document link
--      (`document_id`, no foreign key yet: the documents module lands in
--      parallel and the integrator adds the FK). Writes only through
--      authz.update_checklist_item (definer, re-checks permission and scope);
--      every change is recorded in eureka.checklist_item_event by trigger.
--   3. eureka.bgc: one background-check record per placement (design B2.4
--      columns), status not_started -> initiated -> in_progress -> cleared |
--      failed, and cleared -> failed after the fact (FR-PLC-06). Writes only
--      through authz.update_bgc (bgc:update). Recording `failed` can also move
--      the placement to bgc_failed in the same transaction, but only by calling
--      authz.transition_placement, so the placement rules (placement:update +
--      placement.bgc_status:update, states, side effects, outbox) live in one
--      place. History in eureka.bgc_event.
--   4. Visibility (B4.4): BGC rows and item/BGC history follow document:read
--      over the placement's actor snapshot or its owned candidate (snapshot
--      columns copied from the placement, immutable). Items stay readable
--      wherever the placement is (0035) and additionally under document:read.
--      Read policies use InitPlan scope arrays and the hashed owned-candidate
--      set (rule 3); no per-row definer calls.
-- No PII, free text or reasons reach audit_event or outbox_event (rule 5):
-- notes and reasons live only in these RLS-protected tables.
-- Every IF is NULL-safe (see 0012/0015).
SET search_path = eureka, public;

-- =====================================================================
-- 1. versioned templates
-- =====================================================================
SET ROLE authz_definer;

ALTER TABLE authz.checklist_template RENAME COLUMN updated_at TO published_at;
ALTER TABLE authz.checklist_template ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE authz.checklist_template ADD COLUMN published_by uuid;
ALTER TABLE authz.checklist_template DROP CONSTRAINT checklist_template_pkey;
ALTER TABLE authz.checklist_template ADD PRIMARY KEY (kind, placement_type, version);

-- Validation as in 0035, plus: the server assigns version, published_at and
-- published_by; a published version never changes and is never deleted.
CREATE OR REPLACE FUNCTION authz.checklist_template_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE it jsonb; seen text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP IS DISTINCT FROM 'INSERT' THEN
    RAISE EXCEPTION 'checklist template versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_checklist_template' USING ERRCODE = 'check_violation';
  END IF;
  FOR it IN SELECT e FROM pg_catalog.jsonb_array_elements(NEW.items) AS e LOOP
    IF pg_catalog.jsonb_typeof(it) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(it -> 'doc_type') IS DISTINCT FROM 'string'
       OR NOT coalesce((it ->> 'doc_type') ~ '^[a-z][a-z0-9_]{0,59}$', false)
       OR pg_catalog.jsonb_typeof(it -> 'owner_role') IS DISTINCT FROM 'string'
       OR NOT EXISTS (SELECT 1 FROM eureka.role r WHERE r.key = it ->> 'owner_role')
       OR coalesce(pg_catalog.jsonb_typeof(it -> 'required'), 'boolean') IS DISTINCT FROM 'boolean'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(it) k WHERE k NOT IN ('doc_type', 'owner_role', 'required'))
       OR coalesce((it ->> 'doc_type') = ANY (seen), false) THEN
      RAISE EXCEPTION 'invalid_checklist_template' USING ERRCODE = 'check_violation';
    END IF;
    seen := seen || (it ->> 'doc_type');
  END LOOP;
  -- One writer per (kind, type) at a time, so versions are gapless and unique.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
    'authz.checklist_template:' || coalesce(NEW.kind, '') || ':' || coalesce(NEW.placement_type, '')));
  NEW.version := coalesce((SELECT max(t.version) FROM authz.checklist_template t
                           WHERE t.kind = NEW.kind AND t.placement_type = NEW.placement_type), 0) + 1;
  NEW.published_at := pg_catalog.now();
  NEW.published_by := authz.current_user_id();
  RETURN NEW;
END $$;
DROP TRIGGER checklist_template_check ON authz.checklist_template;
CREATE TRIGGER checklist_template_check BEFORE INSERT OR UPDATE OR DELETE ON authz.checklist_template
  FOR EACH ROW EXECUTE FUNCTION authz.checklist_template_check();

CREATE FUNCTION authz.checklist_template_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'checklist templates are not truncated' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER checklist_template_no_truncate BEFORE TRUNCATE ON authz.checklist_template
  FOR EACH STATEMENT EXECUTE FUNCTION authz.checklist_template_no_truncate();

RESET ROLE;

-- =====================================================================
-- 2. checklist items: progress columns, snapshots, history
-- =====================================================================
SET ROLE eureka_owner;

-- The 0035 guard refuses every update; it is replaced below after the
-- snapshot columns are back-filled from the placements.
DROP TRIGGER checklist_item_write_guard ON eureka.checklist_item;

ALTER TABLE eureka.checklist_item DROP CONSTRAINT checklist_item_status_check;
ALTER TABLE eureka.checklist_item
  ADD CONSTRAINT checklist_item_status CHECK (status IN ('pending', 'received', 'verified', 'waived')),
  -- Snapshots of the placement (immutable, set by the guard): document:read
  -- scope over the actor snapshot or the owned candidate (B4.4) without a
  -- per-row definer call or a placement:read requirement.
  ADD COLUMN candidate_id      uuid REFERENCES eureka.candidate(id),
  ADD COLUMN recruiter_id      uuid REFERENCES eureka.app_user(id),
  ADD COLUMN team_id           uuid REFERENCES eureka.team(id),
  ADD COLUMN location_id       uuid REFERENCES eureka.location(id),
  ADD COLUMN template_version  integer CHECK (template_version >= 1),
  ADD COLUMN assignee_id       uuid REFERENCES eureka.app_user(id),
  ADD COLUMN due_on            date CHECK (due_on BETWEEN date '2000-01-01' AND date '2100-12-31'),
  ADD COLUMN notes             text CHECK (char_length(btrim(notes)) BETWEEN 1 AND 1000),
  -- Document link: the documents module (built in parallel) adds the foreign
  -- key to eureka.document when it merges (docs/HANDOFF.md).
  ADD COLUMN document_id       uuid,
  ADD COLUMN status_reason     text CHECK (char_length(btrim(status_reason)) BETWEEN 1 AND 500),
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_changed_by uuid REFERENCES eureka.app_user(id),
  ADD COLUMN updated_at        timestamptz,
  ADD COLUMN updated_by        uuid REFERENCES eureka.app_user(id),
  ADD COLUMN version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD CONSTRAINT checklist_item_waived_reason CHECK (status <> 'waived' OR status_reason IS NOT NULL);

-- Back-fill the snapshots of items created before this migration. The owner
-- reads both tables directly for this one statement (FORCE is restored below,
-- inside the same transaction).
ALTER TABLE eureka.checklist_item NO FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.placement NO FORCE ROW LEVEL SECURITY;
UPDATE eureka.checklist_item i
   SET candidate_id = p.candidate_id, recruiter_id = p.recruiter_id, team_id = p.team_id,
       location_id = p.location_id, template_version = 1
  FROM eureka.placement p WHERE p.id = i.placement_id;
ALTER TABLE eureka.placement FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.checklist_item FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.checklist_item ALTER COLUMN candidate_id SET NOT NULL, ALTER COLUMN recruiter_id SET NOT NULL;

CREATE INDEX checklist_item_placement ON eureka.checklist_item (placement_id, kind, position);
CREATE INDEX checklist_item_open_due ON eureka.checklist_item (due_on) WHERE status IN ('pending', 'received');
CREATE INDEX checklist_item_candidate ON eureka.checklist_item (candidate_id);

-- Rule 4/6: only authz_definer writes items. Inserts start pending with the
-- placement's snapshots; updates may change only the progress columns; the
-- server stamps who/when and the version; items are never deleted.
CREATE OR REPLACE FUNCTION eureka.checklist_item_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE p record;
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'checklist items are written only by placement functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'checklist items are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT pl.candidate_id, pl.recruiter_id, pl.team_id, pl.location_id INTO p
      FROM eureka.placement pl WHERE pl.id = NEW.placement_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'placement_not_found' USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.candidate_id := p.candidate_id; NEW.recruiter_id := p.recruiter_id;
    NEW.team_id := p.team_id; NEW.location_id := p.location_id;
    NEW.status := 'pending';
    NEW.assignee_id := NULL; NEW.due_on := NULL; NEW.notes := NULL; NEW.document_id := NULL;
    NEW.status_reason := NULL; NEW.status_changed_at := NULL; NEW.status_changed_by := NULL;
    NEW.updated_at := NULL; NEW.updated_by := NULL; NEW.version := 1;
    NEW.created_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'status_reason', 'status_changed_at', 'status_changed_by',
        'owner_role', 'assignee_id', 'due_on', 'notes', 'document_id', 'updated_at', 'updated_by', 'version'])
     IS DISTINCT FROM
     (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'status_reason', 'status_changed_at', 'status_changed_by',
        'owner_role', 'assignee_id', 'due_on', 'notes', 'document_id', 'updated_at', 'updated_by', 'version']) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.now();
  NEW.updated_by := authz.current_user_id();
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := pg_catalog.now();
    NEW.status_changed_by := authz.current_user_id();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
    NEW.status_changed_by := OLD.status_changed_by;
    NEW.status_reason := OLD.status_reason;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER checklist_item_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.checklist_item
  FOR EACH ROW EXECUTE FUNCTION eureka.checklist_item_write_guard();

-- History: one row per change, written by the AFTER UPDATE trigger below.
-- Holds field names and non-personal values (status, ids, dates, role keys);
-- the reason text stays here (never in audit_event). Notes are recorded as
-- "notes changed" only.
CREATE TABLE eureka.checklist_item_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES eureka.checklist_item(id),
  placement_id uuid NOT NULL REFERENCES eureka.placement(id),
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES eureka.app_user(id),
  from_status  text,
  to_status    text,
  changed      text[] NOT NULL CHECK (cardinality(changed) >= 1 AND changed <@ ARRAY[
                 'status', 'owner_role', 'assignee', 'due_on', 'notes', 'document']::text[]),
  details      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  reason       text CHECK (char_length(reason) <= 500)
);
CREATE INDEX checklist_item_event_item ON eureka.checklist_item_event (item_id, at);

-- =====================================================================
-- 3. background checks
-- =====================================================================
CREATE TABLE eureka.bgc (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id      uuid NOT NULL UNIQUE REFERENCES eureka.placement(id),
  -- Snapshots of the placement (immutable), as on checklist_item.
  candidate_id      uuid NOT NULL REFERENCES eureka.candidate(id),
  recruiter_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  team_id           uuid REFERENCES eureka.team(id),
  location_id       uuid REFERENCES eureka.location(id),
  status            text NOT NULL DEFAULT 'not_started'
                    CHECK (status IN ('not_started', 'initiated', 'in_progress', 'cleared', 'failed')),
  bgc_company       text CHECK (char_length(btrim(bgc_company)) BETWEEN 1 AND 120 AND bgc_company !~ '[[:cntrl:]]'),
  initiated_on      date CHECK (initiated_on BETWEEN date '2000-01-01' AND date '2100-12-31'),
  completed_on      date CHECK (completed_on BETWEEN date '2000-01-01' AND date '2100-12-31'),
  helped_by         uuid REFERENCES eureka.app_user(id),
  education_level   text CHECK (char_length(btrim(education_level)) BETWEEN 1 AND 60 AND education_level !~ '[[:cntrl:]]'),
  employment_years  smallint CHECK (employment_years BETWEEN 0 AND 50),
  address_years     smallint CHECK (address_years BETWEEN 0 AND 50),
  notes             text CHECK (char_length(btrim(notes)) BETWEEN 1 AND 1000),
  status_reason     text CHECK (char_length(btrim(status_reason)) BETWEEN 1 AND 500),
  status_changed_at timestamptz,
  status_changed_by uuid REFERENCES eureka.app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES eureka.app_user(id),
  updated_at        timestamptz,
  updated_by        uuid REFERENCES eureka.app_user(id),
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT bgc_dates CHECK (completed_on IS NULL OR initiated_on IS NULL OR completed_on >= initiated_on),
  CONSTRAINT bgc_failed_reason CHECK (status <> 'failed' OR status_reason IS NOT NULL)
);
CREATE INDEX bgc_candidate ON eureka.bgc (candidate_id);

CREATE FUNCTION eureka.bgc_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE p record;
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'bgc records are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bgc records are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT pl.candidate_id, pl.recruiter_id, pl.team_id, pl.location_id INTO p
      FROM eureka.placement pl WHERE pl.id = NEW.placement_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'placement_not_found' USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.candidate_id := p.candidate_id; NEW.recruiter_id := p.recruiter_id;
    NEW.team_id := p.team_id; NEW.location_id := p.location_id;
    NEW.status := 'not_started';
    NEW.bgc_company := NULL; NEW.initiated_on := NULL; NEW.completed_on := NULL; NEW.helped_by := NULL;
    NEW.education_level := NULL; NEW.employment_years := NULL; NEW.address_years := NULL; NEW.notes := NULL;
    NEW.status_reason := NULL; NEW.status_changed_at := NULL; NEW.status_changed_by := NULL;
    NEW.created_at := pg_catalog.now(); NEW.created_by := authz.current_user_id();
    NEW.updated_at := NULL; NEW.updated_by := NULL; NEW.version := 1;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.placement_id, NEW.candidate_id, NEW.recruiter_id, NEW.team_id, NEW.location_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.placement_id, OLD.candidate_id, OLD.recruiter_id, OLD.team_id, OLD.location_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.now();
  NEW.updated_by := authz.current_user_id();
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := pg_catalog.now();
    NEW.status_changed_by := authz.current_user_id();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
    NEW.status_changed_by := OLD.status_changed_by;
    NEW.status_reason := OLD.status_reason;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bgc_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.bgc
  FOR EACH ROW EXECUTE FUNCTION eureka.bgc_write_guard();

CREATE TABLE eureka.bgc_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bgc_id       uuid NOT NULL REFERENCES eureka.bgc(id),
  placement_id uuid NOT NULL REFERENCES eureka.placement(id),
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES eureka.app_user(id),
  from_status  text,
  to_status    text,
  changed      text[] NOT NULL CHECK (cardinality(changed) >= 1 AND changed <@ ARRAY[
                 'status', 'bgc_company', 'initiated_on', 'completed_on', 'helped_by', 'education_level',
                 'employment_years', 'address_years', 'notes']::text[]),
  reason       text CHECK (char_length(reason) <= 500)
);
CREATE INDEX bgc_event_bgc ON eureka.bgc_event (bgc_id, at);

-- History rows are written only by the AFTER triggers (as authz_definer);
-- the server stamps at and actor; append-only.
CREATE FUNCTION eureka.paperwork_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' OR TG_OP IS DISTINCT FROM 'INSERT' THEN
    RAISE EXCEPTION 'paperwork history is append-only and written by the database'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.at := pg_catalog.now();
  NEW.actor_id := authz.current_user_id();
  RETURN NEW;
END $$;
CREATE TRIGGER checklist_item_event_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.checklist_item_event
  FOR EACH ROW EXECUTE FUNCTION eureka.paperwork_event_guard();
CREATE TRIGGER bgc_event_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.bgc_event
  FOR EACH ROW EXECUTE FUNCTION eureka.paperwork_event_guard();

CREATE FUNCTION eureka.paperwork_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'paperwork tables are not truncated' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER checklist_item_no_truncate BEFORE TRUNCATE ON eureka.checklist_item
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.paperwork_no_truncate();
CREATE TRIGGER checklist_item_event_no_truncate BEFORE TRUNCATE ON eureka.checklist_item_event
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.paperwork_no_truncate();
CREATE TRIGGER bgc_no_truncate BEFORE TRUNCATE ON eureka.bgc
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.paperwork_no_truncate();
CREATE TRIGGER bgc_event_no_truncate BEFORE TRUNCATE ON eureka.bgc_event
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.paperwork_no_truncate();

ALTER TABLE eureka.checklist_item_event ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.checklist_item_event FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.bgc                  ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.bgc                  FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.bgc_event            ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.bgc_event            FORCE ROW LEVEL SECURITY;

-- ---------- read policies (rule 3) ----------
-- Items: wherever the placement is (0035), or document:read over the
-- placement's actor snapshot or its owned candidate.
DROP POLICY checklist_item_read ON eureka.checklist_item;
CREATE POLICY checklist_item_read ON eureka.checklist_item FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.placement p WHERE p.id = checklist_item.placement_id)
  OR (SELECT authz.has_org('document:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('document:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('document:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('document:read'))::uuid[])
  OR candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('document:read'))))
);
-- BGC (B4.4): document:read over the actor snapshot or the owned candidate.
CREATE POLICY bgc_read ON eureka.bgc FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('document:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('document:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('document:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('document:read'))::uuid[])
  OR candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('document:read'))))
);
-- History (reasons): document:read over the item's placement, probed by key.
CREATE POLICY checklist_item_event_read ON eureka.checklist_item_event FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.checklist_item i WHERE i.id = checklist_item_event.item_id AND (
    (SELECT authz.has_org('document:read'))
    OR i.recruiter_id = ANY ((SELECT authz.recruiter_ids('document:read'))::uuid[])
    OR i.team_id      = ANY ((SELECT authz.team_ids('document:read'))::uuid[])
    OR i.location_id  = ANY ((SELECT authz.location_ids('document:read'))::uuid[])
    OR i.candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('document:read'))))))
);
-- The EXISTS runs under bgc_read.
CREATE POLICY bgc_event_read ON eureka.bgc_event FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.bgc b WHERE b.id = bgc_event.bgc_id)
);

CREATE POLICY definer_read   ON eureka.checklist_item FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_update ON eureka.checklist_item FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_insert ON eureka.checklist_item_event FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.bgc FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.bgc FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.bgc FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_insert ON eureka.bgc_event FOR INSERT TO authz_definer WITH CHECK (true);

RESET ROLE;

REVOKE ALL ON eureka.checklist_item_event, eureka.bgc, eureka.bgc_event FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.checklist_item_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.bgc_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.paperwork_event_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.paperwork_no_truncate() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.checklist_template_no_truncate() FROM PUBLIC;

-- App: read only (every write goes through the definer functions below).
GRANT SELECT ON eureka.checklist_item_event, eureka.bgc, eureka.bgc_event TO eureka_app;
-- Items are readable wherever the placement is (location roles, CEO, ...), but
-- their free text (notes, reasons) only under document:read (B4.4): the app
-- reads every other column directly and the text through
-- authz.checklist_item_texts, which checks document:read over the placement.
REVOKE SELECT ON eureka.checklist_item FROM eureka_app;
GRANT SELECT (id, placement_id, kind, position, doc_type, owner_role, required, status, created_at,
              candidate_id, recruiter_id, team_id, location_id, template_version, assignee_id, due_on,
              document_id, status_changed_at, status_changed_by, updated_at, updated_by, version)
  ON eureka.checklist_item TO eureka_app;
-- Definer: exactly what the functions and triggers write.
GRANT SELECT ON eureka.checklist_item TO authz_definer;
GRANT UPDATE (status, status_reason, status_changed_at, status_changed_by, owner_role, assignee_id, due_on,
              notes, document_id, updated_at, updated_by, version) ON eureka.checklist_item TO authz_definer;
GRANT INSERT ON eureka.checklist_item_event TO authz_definer;
GRANT SELECT, INSERT ON eureka.bgc TO authz_definer;
GRANT UPDATE (status, bgc_company, initiated_on, completed_on, helped_by, education_level, employment_years,
              address_years, notes, status_reason, status_changed_at, status_changed_by, updated_at, updated_by, version)
  ON eureka.bgc TO authz_definer;
GRANT INSERT ON eureka.bgc_event TO authz_definer;

-- =====================================================================
-- 4. functions
-- =====================================================================
SET ROLE authz_definer;

-- Copy the latest paperwork template version (0035, now versioned).
CREATE OR REPLACE FUNCTION authz.checklist_on_placement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO eureka.checklist_item (placement_id, kind, position, doc_type, owner_role, required, template_version)
  SELECT NEW.id, t.kind, e.ord::smallint, e.item ->> 'doc_type', e.item ->> 'owner_role',
         coalesce((e.item ->> 'required')::boolean, true), t.version
  FROM authz.checklist_template t
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(t.items) WITH ORDINALITY AS e(item, ord)
  WHERE t.kind = 'paperwork' AND t.placement_type = NEW.placement_type
    AND t.version = (SELECT max(t2.version) FROM authz.checklist_template t2
                     WHERE t2.kind = 'paperwork' AND t2.placement_type = NEW.placement_type)
  ORDER BY e.ord;
  RETURN NULL;
END $$;

-- History of item changes (runs inside authz.update_checklist_item).
CREATE FUNCTION authz.checklist_item_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ch text[] := ARRAY[]::text[]; d jsonb := '{}'::jsonb;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN ch := ch || 'status'::text; END IF;
  IF NEW.owner_role IS DISTINCT FROM OLD.owner_role THEN
    ch := ch || 'owner_role'::text;
    d := d || pg_catalog.jsonb_build_object('ownerRole', pg_catalog.jsonb_build_object('from', OLD.owner_role, 'to', NEW.owner_role));
  END IF;
  IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
    ch := ch || 'assignee'::text;
    d := d || pg_catalog.jsonb_build_object('assigneeId', pg_catalog.jsonb_build_object('from', OLD.assignee_id, 'to', NEW.assignee_id));
  END IF;
  IF NEW.due_on IS DISTINCT FROM OLD.due_on THEN
    ch := ch || 'due_on'::text;
    d := d || pg_catalog.jsonb_build_object('dueOn', pg_catalog.jsonb_build_object('from', OLD.due_on, 'to', NEW.due_on));
  END IF;
  IF NEW.notes IS DISTINCT FROM OLD.notes THEN ch := ch || 'notes'::text; END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    ch := ch || 'document'::text;
    d := d || pg_catalog.jsonb_build_object('documentId', pg_catalog.jsonb_build_object('from', OLD.document_id, 'to', NEW.document_id));
  END IF;
  IF pg_catalog.cardinality(ch) > 0 THEN
    INSERT INTO eureka.checklist_item_event (item_id, placement_id, from_status, to_status, changed, details, reason)
    VALUES (NEW.id, NEW.placement_id,
            CASE WHEN 'status' = ANY (ch) THEN OLD.status END, CASE WHEN 'status' = ANY (ch) THEN NEW.status END,
            ch, d, CASE WHEN 'status' = ANY (ch) THEN NEW.status_reason END);
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION authz.bgc_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ch text[] := ARRAY[]::text[];
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN ch := ch || 'status'::text; END IF;
  IF NEW.bgc_company IS DISTINCT FROM OLD.bgc_company THEN ch := ch || 'bgc_company'::text; END IF;
  IF NEW.initiated_on IS DISTINCT FROM OLD.initiated_on THEN ch := ch || 'initiated_on'::text; END IF;
  IF NEW.completed_on IS DISTINCT FROM OLD.completed_on THEN ch := ch || 'completed_on'::text; END IF;
  IF NEW.helped_by IS DISTINCT FROM OLD.helped_by THEN ch := ch || 'helped_by'::text; END IF;
  IF NEW.education_level IS DISTINCT FROM OLD.education_level THEN ch := ch || 'education_level'::text; END IF;
  IF NEW.employment_years IS DISTINCT FROM OLD.employment_years THEN ch := ch || 'employment_years'::text; END IF;
  IF NEW.address_years IS DISTINCT FROM OLD.address_years THEN ch := ch || 'address_years'::text; END IF;
  IF NEW.notes IS DISTINCT FROM OLD.notes THEN ch := ch || 'notes'::text; END IF;
  IF pg_catalog.cardinality(ch) > 0 THEN
    INSERT INTO eureka.bgc_event (bgc_id, placement_id, from_status, to_status, changed, reason)
    VALUES (NEW.id, NEW.placement_id,
            CASE WHEN 'status' = ANY (ch) THEN OLD.status END, CASE WHEN 'status' = ANY (ch) THEN NEW.status END,
            ch, CASE WHEN 'status' = ANY (ch) THEN NEW.status_reason END);
  END IF;
  RETURN NULL;
END $$;

-- The placement as the definer sees it, with the caller's read and write
-- coverage for one permission (actor snapshot or owned candidate; never the
-- all-teams rule). Internal helper: not executable by the app.
CREATE FUNCTION authz.placement_covered(p_placement uuid, perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT authz.owns(perm, p.recruiter_id, p.team_id, p.location_id)
                          OR authz.candidate_owned(p.candidate_id, perm)
                   FROM eureka.placement p WHERE p.id = p_placement), false)
$$;

-- Item progress (docs/paperwork-api.md PW-2..PW-5). p_changes holds only the
-- keys being changed: status (+ reason), ownerRole, assigneeId, dueOn, notes,
-- documentId. p_expected_version (optional) guards against lost updates.
-- 404 (item_not_found) unless the item is readable to the caller; 403
-- (not_permitted) per key; 422 for invalid values and transitions.
CREATE FUNCTION authz.update_checklist_item(p_item uuid, p_changes jsonb, p_expected_version integer)
RETURNS TABLE (from_status text, to_status text, new_version integer, changed text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := authz.current_user_id();
  i record; pl record;
  k text;
  can_upload boolean; can_verify boolean;
  to_st text; reason text; owner text; assignee uuid; due date; note text; doc uuid;
  ch text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO i FROM eureka.checklist_item ci WHERE ci.id = p_item FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO pl FROM eureka.placement p WHERE p.id = i.placement_id;
  END IF;
  IF i.id IS NULL OR actor IS NULL OR NOT coalesce(
       authz.placement_covered(i.placement_id, 'placement:read')
       OR authz.placement_covered(i.placement_id, 'document:read'), false) THEN
    RAISE EXCEPTION 'item_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF pg_catalog.jsonb_typeof(p_changes) IS DISTINCT FROM 'object'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_changes))
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_changes) k2
                WHERE k2 NOT IN ('status', 'reason', 'ownerRole', 'assigneeId', 'dueOn', 'notes', 'documentId'))
     OR coalesce(p_changes ? 'reason' AND NOT p_changes ? 'status', false) THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;

  can_upload := coalesce(authz.placement_covered(i.placement_id, 'document:upload'), false);
  can_verify := coalesce(authz.placement_covered(i.placement_id, 'document:verify'), false);

  -- Permission per key (PW-3): receiving, notes and the document link need
  -- document:upload or document:verify; every other status change, the owner
  -- role, the assignee and the due date need document:verify.
  FOR k IN SELECT pg_catalog.jsonb_object_keys(p_changes) LOOP
    IF k IN ('notes', 'documentId') AND NOT coalesce(can_upload OR can_verify, false) THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    ELSIF k IN ('ownerRole', 'assigneeId', 'dueOn') AND NOT coalesce(can_verify, false) THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF p_changes ? 'status' THEN
    IF pg_catalog.jsonb_typeof(p_changes -> 'status') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    to_st := p_changes ->> 'status';
    IF NOT coalesce(CASE WHEN to_st = 'received' THEN can_upload OR can_verify ELSE can_verify END, false) THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF coalesce(pl.status = 'backout', true) THEN
    RAISE EXCEPTION 'placement_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM i.version THEN
    RAISE EXCEPTION 'version_mismatch' USING ERRCODE = 'serialization_failure';
  END IF;

  -- PW-2 state machine; waiving, returning and reopening need a reason.
  IF p_changes ? 'status' THEN
    IF NOT coalesce((i.status, to_st) IN (
         ('pending', 'received'), ('pending', 'waived'),
         ('received', 'verified'), ('received', 'waived'), ('received', 'pending'),
         ('verified', 'pending'), ('waived', 'pending')), false) THEN
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(p_changes ? 'reason' AND pg_catalog.jsonb_typeof(p_changes -> 'reason') NOT IN ('string', 'null'), false) THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    reason := nullif(pg_catalog.btrim(p_changes ->> 'reason'), '');
    IF coalesce(pg_catalog.char_length(reason) > 500, false) THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    IF reason IS NULL AND coalesce(to_st IN ('waived', 'pending'), true) THEN
      RAISE EXCEPTION 'reason_required' USING ERRCODE = 'check_violation';
    END IF;
    ch := ch || 'status'::text;
  END IF;

  owner := i.owner_role;
  IF p_changes ? 'ownerRole' THEN
    IF pg_catalog.jsonb_typeof(p_changes -> 'ownerRole') IS DISTINCT FROM 'string'
       OR NOT EXISTS (SELECT 1 FROM eureka.role r WHERE r.key = p_changes ->> 'ownerRole') THEN
      RAISE EXCEPTION 'invalid_owner_role' USING ERRCODE = 'check_violation';
    END IF;
    owner := p_changes ->> 'ownerRole';
  END IF;

  assignee := i.assignee_id;
  IF p_changes ? 'assigneeId' THEN
    IF pg_catalog.jsonb_typeof(p_changes -> 'assigneeId') = 'null' THEN
      assignee := NULL;
    ELSIF pg_catalog.jsonb_typeof(p_changes -> 'assigneeId') IS DISTINCT FROM 'string'
          OR NOT coalesce((p_changes ->> 'assigneeId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false) THEN
      RAISE EXCEPTION 'invalid_assignee' USING ERRCODE = 'check_violation';
    ELSE
      assignee := (p_changes ->> 'assigneeId')::uuid;
    END IF;
  END IF;
  -- The assignee is an active user who currently holds the item's owner role
  -- (also re-checked when only the owner role changes).
  IF assignee IS NOT NULL AND coalesce(p_changes ? 'assigneeId' OR p_changes ? 'ownerRole', true) AND NOT EXISTS (
       SELECT 1 FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
        WHERE u.id = assignee AND u.status = 'active' AND ur.role_key = owner AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'invalid_assignee' USING ERRCODE = 'check_violation';
  END IF;

  due := i.due_on;
  IF p_changes ? 'dueOn' THEN
    IF pg_catalog.jsonb_typeof(p_changes -> 'dueOn') = 'null' THEN
      due := NULL;
    ELSIF pg_catalog.jsonb_typeof(p_changes -> 'dueOn') IS DISTINCT FROM 'string'
          OR NOT coalesce((p_changes ->> 'dueOn') ~ '^\d{4}-\d{2}-\d{2}$', false) THEN
      RAISE EXCEPTION 'invalid_due_date' USING ERRCODE = 'check_violation';
    ELSE
      BEGIN
        due := (p_changes ->> 'dueOn')::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_due_date' USING ERRCODE = 'check_violation';
      END;
      IF NOT coalesce(due BETWEEN date '2000-01-01' AND date '2100-12-31', false) THEN
        RAISE EXCEPTION 'invalid_due_date' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  note := i.notes;
  IF p_changes ? 'notes' THEN
    IF coalesce(pg_catalog.jsonb_typeof(p_changes -> 'notes') NOT IN ('string', 'null'), true) THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    note := nullif(pg_catalog.btrim(p_changes ->> 'notes'), '');
    IF coalesce(pg_catalog.char_length(note) > 1000, false) THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  doc := i.document_id;
  IF p_changes ? 'documentId' THEN
    IF pg_catalog.jsonb_typeof(p_changes -> 'documentId') = 'null' THEN
      doc := NULL;
    ELSIF pg_catalog.jsonb_typeof(p_changes -> 'documentId') IS DISTINCT FROM 'string'
          OR NOT coalesce((p_changes ->> 'documentId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false) THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    ELSE
      doc := (p_changes ->> 'documentId')::uuid;
    END IF;
  END IF;

  UPDATE eureka.checklist_item ci
     SET status = coalesce(to_st, ci.status),
         status_reason = CASE WHEN to_st IS NOT NULL THEN reason ELSE ci.status_reason END,
         owner_role = owner, assignee_id = assignee, due_on = due, notes = note, document_id = doc
   WHERE ci.id = i.id;

  IF owner IS DISTINCT FROM i.owner_role THEN ch := ch || 'owner_role'::text; END IF;
  IF assignee IS DISTINCT FROM i.assignee_id THEN ch := ch || 'assignee'::text; END IF;
  IF due IS DISTINCT FROM i.due_on THEN ch := ch || 'due_on'::text; END IF;
  IF note IS DISTINCT FROM i.notes THEN ch := ch || 'notes'::text; END IF;
  IF doc IS DISTINCT FROM i.document_id THEN ch := ch || 'document'::text; END IF;

  RETURN QUERY SELECT i.status::text, coalesce(to_st, i.status)::text,
    (SELECT ci.version FROM eureka.checklist_item ci WHERE ci.id = i.id), ch;
END $$;

-- BGC record (docs/paperwork-api.md PW-6..PW-9). Created on first write
-- (status not_started). p_changes keys: status (+ reason), bgcCompany,
-- initiatedOn, completedOn, helpedBy, educationLevel, employmentYears,
-- addressYears, notes, failPlacement. failPlacement (with the record ending
-- `failed`) moves the placement to bgc_failed through
-- authz.transition_placement, which applies its own permission and state
-- rules; the placement and candidate changes are returned for the audit.
CREATE FUNCTION authz.update_bgc(p_placement uuid, p_changes jsonb, p_expected_version integer)
RETURNS TABLE (from_status text, to_status text, new_version integer, changed text[],
               placement_from text, placement_to text, candidate_from text, candidate_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := authz.current_user_id();
  pl record; b record;
  pl_from text; pl_to text; c_from text; c_to text;
  to_st text; reason text;
  v_company text; v_init date; v_done date; v_helper uuid; v_edu text; v_emp smallint; v_addr smallint; v_notes text;
  ch text[] := ARRAY[]::text[];
  fail_pl boolean := false;
BEGIN
  SELECT * INTO pl FROM eureka.placement p WHERE p.id = p_placement;
  IF NOT FOUND OR actor IS NULL OR NOT coalesce(authz.placement_covered(p_placement, 'document:read'), false) THEN
    RAISE EXCEPTION 'placement_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.placement_covered(p_placement, 'bgc:update'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_catalog.jsonb_typeof(p_changes) IS DISTINCT FROM 'object'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_changes))
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_changes) k
                WHERE k NOT IN ('status', 'reason', 'bgcCompany', 'initiatedOn', 'completedOn', 'helpedBy',
                                'educationLevel', 'employmentYears', 'addressYears', 'notes', 'failPlacement'))
     OR coalesce(p_changes ? 'reason' AND NOT p_changes ? 'status', false) THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(pl.status = 'backout', true) THEN
    RAISE EXCEPTION 'placement_closed' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO eureka.bgc (placement_id) VALUES (p_placement) ON CONFLICT (placement_id) DO NOTHING;
  SELECT * INTO b FROM eureka.bgc x WHERE x.placement_id = p_placement FOR UPDATE;
  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM b.version THEN
    RAISE EXCEPTION 'version_mismatch' USING ERRCODE = 'serialization_failure';
  END IF;

  to_st := b.status;
  IF p_changes ? 'status' THEN
    IF pg_catalog.jsonb_typeof(p_changes -> 'status') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    to_st := p_changes ->> 'status';
    -- PW-7: forward steps; cleared -> failed after the fact (FR-PLC-06); failed is final.
    IF NOT coalesce((b.status, to_st) IN (
         ('not_started', 'initiated'),
         ('initiated', 'in_progress'), ('initiated', 'cleared'), ('initiated', 'failed'),
         ('in_progress', 'cleared'), ('in_progress', 'failed'),
         ('cleared', 'failed')), false) THEN
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(p_changes ? 'reason' AND pg_catalog.jsonb_typeof(p_changes -> 'reason') NOT IN ('string', 'null'), false) THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    reason := nullif(pg_catalog.btrim(p_changes ->> 'reason'), '');
    IF coalesce(pg_catalog.char_length(reason) > 500, false) THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    IF reason IS NULL AND coalesce(to_st = 'failed', true) THEN
      RAISE EXCEPTION 'reason_required' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- JSON types: strings for text/dates/ids, numbers for years, boolean flag.
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_changes) e
             WHERE (e.key IN ('bgcCompany', 'initiatedOn', 'completedOn', 'helpedBy', 'educationLevel', 'notes')
                    AND pg_catalog.jsonb_typeof(e.value) NOT IN ('string', 'null'))
                OR (e.key IN ('employmentYears', 'addressYears') AND pg_catalog.jsonb_typeof(e.value) NOT IN ('number', 'null'))
                OR (e.key = 'failPlacement' AND pg_catalog.jsonb_typeof(e.value) IS DISTINCT FROM 'boolean')) THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    v_company := CASE WHEN p_changes ? 'bgcCompany' THEN nullif(pg_catalog.btrim(p_changes ->> 'bgcCompany'), '') ELSE b.bgc_company END;
    v_init := CASE WHEN p_changes ? 'initiatedOn' THEN (p_changes ->> 'initiatedOn')::date ELSE b.initiated_on END;
    v_done := CASE WHEN p_changes ? 'completedOn' THEN (p_changes ->> 'completedOn')::date ELSE b.completed_on END;
    v_helper := CASE WHEN p_changes ? 'helpedBy' THEN (p_changes ->> 'helpedBy')::uuid ELSE b.helped_by END;
    v_edu := CASE WHEN p_changes ? 'educationLevel' THEN nullif(pg_catalog.btrim(p_changes ->> 'educationLevel'), '') ELSE b.education_level END;
    v_emp := CASE WHEN p_changes ? 'employmentYears' THEN (p_changes ->> 'employmentYears')::smallint ELSE b.employment_years END;
    v_addr := CASE WHEN p_changes ? 'addressYears' THEN (p_changes ->> 'addressYears')::smallint ELSE b.address_years END;
    v_notes := CASE WHEN p_changes ? 'notes' THEN nullif(pg_catalog.btrim(p_changes ->> 'notes'), '') ELSE b.notes END;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END;
  IF v_helper IS NOT NULL AND v_helper IS DISTINCT FROM b.helped_by
     AND NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = v_helper AND u.status = 'active') THEN
    RAISE EXCEPTION 'invalid_helper' USING ERRCODE = 'check_violation';
  END IF;
  -- Server defaults for the dates a status change implies, unless given.
  IF to_st IS DISTINCT FROM b.status THEN
    IF coalesce(to_st = 'initiated', false) AND v_init IS NULL THEN v_init := CURRENT_DATE; END IF;
    IF coalesce(to_st IN ('cleared', 'failed'), false) AND v_done IS NULL THEN v_done := CURRENT_DATE; END IF;
  END IF;

  fail_pl := coalesce((p_changes -> 'failPlacement')::text = 'true', false);
  IF fail_pl AND to_st IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;

  BEGIN
    UPDATE eureka.bgc x
       SET status = to_st,
           status_reason = CASE WHEN to_st IS DISTINCT FROM b.status THEN reason ELSE x.status_reason END,
           bgc_company = v_company, initiated_on = v_init, completed_on = v_done, helped_by = v_helper,
           education_level = v_edu, employment_years = v_emp, address_years = v_addr, notes = v_notes
     WHERE x.id = b.id;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END;

  IF to_st IS DISTINCT FROM b.status THEN ch := ch || 'status'::text; END IF;
  IF v_company IS DISTINCT FROM b.bgc_company THEN ch := ch || 'bgc_company'::text; END IF;
  IF v_init IS DISTINCT FROM b.initiated_on THEN ch := ch || 'initiated_on'::text; END IF;
  IF v_done IS DISTINCT FROM b.completed_on THEN ch := ch || 'completed_on'::text; END IF;
  IF v_helper IS DISTINCT FROM b.helped_by THEN ch := ch || 'helped_by'::text; END IF;
  IF v_edu IS DISTINCT FROM b.education_level THEN ch := ch || 'education_level'::text; END IF;
  IF v_emp IS DISTINCT FROM b.employment_years THEN ch := ch || 'employment_years'::text; END IF;
  IF v_addr IS DISTINCT FROM b.address_years THEN ch := ch || 'address_years'::text; END IF;
  IF v_notes IS DISTINCT FROM b.notes THEN ch := ch || 'notes'::text; END IF;

  -- FR-PLC-06 through the one placement state machine (no duplicated rules).
  IF fail_pl THEN
    SELECT t.from_status, t.to_status, t.candidate_from, t.candidate_to INTO pl_from, pl_to, c_from, c_to
      FROM authz.transition_placement(p_placement, 'bgc_failed',
             coalesce(reason, (SELECT x.status_reason FROM eureka.bgc x WHERE x.id = b.id))) t;
  END IF;

  RETURN QUERY SELECT b.status::text, to_st,
    (SELECT x.version FROM eureka.bgc x WHERE x.id = b.id), ch, pl_from, pl_to, c_from, c_to;
END $$;

-- Notes and status reasons of one placement's items, only for a caller with
-- document:read over the placement (actor snapshot or owned candidate);
-- otherwise no rows. Called once per request, never from a policy.
CREATE FUNCTION authz.checklist_item_texts(p_placement uuid)
RETURNS TABLE (item_id uuid, notes text, status_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.id, i.notes, i.status_reason FROM eureka.checklist_item i
   WHERE i.placement_id = p_placement AND authz.current_user_id() IS NOT NULL
     AND coalesce(authz.placement_covered(p_placement, 'document:read'), false)
$$;

-- Template versions (all, newest first per kind/type) for callers holding
-- document:read at org scope (the paperwork roles); configuration only.
CREATE FUNCTION authz.checklist_templates()
RETURNS TABLE (kind text, placement_type text, version integer, items jsonb, published_at timestamptz, published_by uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_org('document:read'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT t.kind, t.placement_type, t.version, t.items, t.published_at, t.published_by
    FROM authz.checklist_template t ORDER BY t.kind, t.placement_type, t.version DESC;
END $$;

-- Publish a new template version (PW-10): document:verify at org scope.
-- p_expected_version is the caller's view of the current version (0 when
-- none), so two editors cannot silently overwrite each other.
CREATE FUNCTION authz.publish_checklist_template(p_kind text, p_type text, p_items jsonb, p_expected_version integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur integer; v integer;
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_org('document:verify'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IS NULL OR p_type IS NULL OR p_expected_version IS NULL
     OR NOT coalesce(p_kind IN ('paperwork', 'onboarding') AND p_type IN ('c2c', 'w2', '1099'), false) THEN
    RAISE EXCEPTION 'invalid_checklist_template' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('authz.checklist_template:' || p_kind || ':' || p_type));
  cur := coalesce((SELECT max(t.version) FROM authz.checklist_template t
                   WHERE t.kind = p_kind AND t.placement_type = p_type), 0);
  IF cur IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'version_mismatch' USING ERRCODE = 'serialization_failure';
  END IF;
  INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES (p_kind, p_type, p_items)
  RETURNING version INTO v;
  RETURN v;
END $$;

RESET ROLE;

CREATE TRIGGER checklist_item_history AFTER UPDATE ON eureka.checklist_item
  FOR EACH ROW EXECUTE FUNCTION authz.checklist_item_history();
CREATE TRIGGER bgc_history AFTER UPDATE ON eureka.bgc
  FOR EACH ROW EXECUTE FUNCTION authz.bgc_history();

REVOKE ALL ON FUNCTION authz.checklist_on_placement() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.checklist_template_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.checklist_item_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.bgc_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.placement_covered(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.update_checklist_item(uuid, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.update_bgc(uuid, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.checklist_templates() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.checklist_item_texts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.checklist_item_texts(uuid) TO eureka_app;
REVOKE ALL ON FUNCTION authz.publish_checklist_template(text, text, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.update_checklist_item(uuid, jsonb, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.update_bgc(uuid, jsonb, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.checklist_templates() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.publish_checklist_template(text, text, jsonb, integer) TO eureka_app;
