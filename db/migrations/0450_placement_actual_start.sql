-- Placement actual start date. The tentative start is a guess fixed at
-- creation; clearing the background check now records the confirmed start
-- (authz.update_bgc, actualStart). Nullable: placements before BGC clearance
-- (and older cleared ones) have none, and readers fall back to tentative_start.
-- Written only by authz_definer functions, like the status columns.

SET ROLE eureka_owner;

ALTER TABLE eureka.placement ADD COLUMN actual_start date
  CHECK (actual_start BETWEEN date '2000-01-01' AND date '2100-12-31');

-- Same guard as 0022, with actual_start among the columns that may move.
CREATE OR REPLACE FUNCTION eureka.placement_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'placement data changes only through placement functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'placement data is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'placement' THEN
    -- Only the status columns and the actual start move; snapshots and terms are fixed at creation.
    IF (to_jsonb(NEW) - ARRAY['status','status_reason','status_changed_at','status_changed_by','joined_at','actual_start','updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','status_reason','status_changed_at','status_changed_by','joined_at','actual_start','updated_at']) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_at := pg_catalog.now();
  ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'assignment' THEN
    IF (to_jsonb(NEW) - ARRAY['end_date','end_reason','updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['end_date','end_reason','updated_at']) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION eureka.placement_write_guard() FROM PUBLIC;
GRANT UPDATE (actual_start) ON eureka.placement TO authz_definer;
