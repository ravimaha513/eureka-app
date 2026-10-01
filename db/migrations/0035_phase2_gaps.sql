-- Phase 2 gaps (docs/phase2-status.md), 2026-10-01.
--   1. Paperwork checklist created with the placement (implementation plan
--      Phase 2 "form with paperwork checklist creation"; design B2.4, B5.3,
--      B4.8 N2 "checklist items are inserted by definer functions tied to the
--      triggering action").
--        * authz.checklist_template: one row per (kind, placement type) with
--          the item list. Configuration owned by authz_definer like
--          authz.policy_setting: no app or worker grant; content is added by a
--          later migration once the product owner lists the documents (open
--          question in docs/phase2-status.md). With no template the placement
--          simply gets no checklist.
--        * eureka.checklist_item: the placement's own copy of the template
--          items (a later template change never rewrites existing
--          placements). Written only by the AFTER INSERT trigger on
--          eureka.placement, which runs inside authz.create_placement as
--          authz_definer. Append-only until Phase 3 adds document tracking
--          (status changes, document link).
--        * Read: wherever the placement is readable (EXISTS by primary key
--          under the caller's placement policy, rule 3).
--      Holds document types and role keys only: no names, contacts, rates.
-- Every IF is NULL-safe (see 0012/0015).
SET search_path = eureka, public;

-- ---------- template (configuration) ----------
SET ROLE authz_definer;

CREATE TABLE authz.checklist_template (
  kind           text NOT NULL CHECK (kind IN ('paperwork', 'onboarding')),
  placement_type text NOT NULL CHECK (placement_type IN ('c2c', 'w2', '1099')),
  -- [{ "doc_type": "offer_letter", "owner_role": "hr", "required": true }, ...] in display order.
  items          jsonb NOT NULL DEFAULT '[]'::jsonb
                 CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 50),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, placement_type)
);
REVOKE ALL ON authz.checklist_template FROM PUBLIC;

-- Every item is an object with a snake_case doc_type (unique in the template),
-- an existing role key as owner_role and an optional boolean required.
CREATE FUNCTION authz.checklist_template_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE it jsonb; seen text[] := ARRAY[]::text[];
BEGIN
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
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER checklist_template_check BEFORE INSERT OR UPDATE ON authz.checklist_template
  FOR EACH ROW EXECUTE FUNCTION authz.checklist_template_check();

RESET ROLE;

-- ---------- items ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.checklist_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id uuid NOT NULL REFERENCES eureka.placement(id),
  kind         text NOT NULL CHECK (kind IN ('paperwork', 'onboarding')),
  position     smallint NOT NULL CHECK (position BETWEEN 1 AND 50),
  doc_type     text NOT NULL CHECK (doc_type ~ '^[a-z][a-z0-9_]{0,59}$'),
  owner_role   text NOT NULL CHECK (owner_role ~ '^[a-z][a-z0-9_]{0,39}$'),
  required     boolean NOT NULL,
  -- Phase 3 (document tracking) widens this and adds the document link.
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (placement_id, kind, doc_type),
  UNIQUE (placement_id, kind, position)
);

-- Only the placement trigger (as authz_definer) writes items; the server sets
-- status and created_at. Never updated or deleted in Phase 2.
CREATE FUNCTION eureka.checklist_item_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'checklist items are written only by placement functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'checklist_item is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.status := 'pending';
  NEW.created_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER checklist_item_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.checklist_item
  FOR EACH ROW EXECUTE FUNCTION eureka.checklist_item_write_guard();

ALTER TABLE eureka.checklist_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.checklist_item FORCE ROW LEVEL SECURITY;

-- Readable wherever the placement is: the EXISTS runs under the caller's
-- placement policy (InitPlan scope arrays), probing by primary key.
CREATE POLICY checklist_item_read ON eureka.checklist_item FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.placement p WHERE p.id = checklist_item.placement_id));
CREATE POLICY definer_insert ON eureka.checklist_item FOR INSERT TO authz_definer WITH CHECK (true);

RESET ROLE;

REVOKE ALL ON eureka.checklist_item FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.checklist_item_write_guard() FROM PUBLIC;
GRANT SELECT ON eureka.checklist_item TO eureka_app;
GRANT INSERT ON eureka.checklist_item TO authz_definer;

-- ---------- creation with the placement ----------
SET ROLE authz_definer;

-- Copies the paperwork template for the placement type. Runs as authz_definer
-- (the only writer of eureka.placement, see placement_write_guard).
CREATE FUNCTION authz.checklist_on_placement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO eureka.checklist_item (placement_id, kind, position, doc_type, owner_role, required)
  SELECT NEW.id, t.kind, e.ord::smallint, e.item ->> 'doc_type', e.item ->> 'owner_role',
         coalesce((e.item ->> 'required')::boolean, true)
  FROM authz.checklist_template t
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(t.items) WITH ORDINALITY AS e(item, ord)
  WHERE t.kind = 'paperwork' AND t.placement_type = NEW.placement_type
  ORDER BY e.ord;
  RETURN NULL;
END $$;

RESET ROLE;

CREATE TRIGGER checklist_on_placement AFTER INSERT ON eureka.placement
  FOR EACH ROW EXECUTE FUNCTION authz.checklist_on_placement();

-- Internal: neither function is executable by the app or the worker.
REVOKE ALL ON FUNCTION authz.checklist_template_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.checklist_on_placement() FROM PUBLIC;
