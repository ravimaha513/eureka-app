-- Staff birthdays and the CEO's morning digest (interview-alerts package;
-- contract docs/alerts-calendar-birthdays.md BD-1..BD-5).
--   1. eureka.staff_profile gains birth_month / birth_day (both or neither;
--      a real calendar day; never the year, so no age is stored). The owner
--      writes their own (Settings, 0081 policies); holders of
--      staff.birthday:manage (HR) write anyone's through
--      authz.set_staff_birthday. Read: the owner and staff.contact:read
--      holders (0081 policy, unchanged).
--   2. authz.emit_birthdays(day): one `staff.birthdays_today` outbox event per
--      New York day on which at least one active staff member has a birthday
--      (29 February is celebrated on 28 February in other years), through
--      the notification ledger (key = the day). Payload: the day, user ids
--      and a count. Recipients: the CEO (resolver replaced in 0089).
--   3. authz.birthday_names(event): the display names for the email, read by
--      the worker at send time (staff names, not candidate data).
-- Every IF is NULL-safe (rule 1); functions pin search_path, no PUBLIC execute (rule 2).
SET search_path = eureka, public;

SET ROLE eureka_owner;
ALTER TABLE eureka.staff_profile
  ADD COLUMN birth_month smallint,
  ADD COLUMN birth_day   smallint,
  ADD CONSTRAINT staff_profile_birthday CHECK (
    (birth_month IS NULL) = (birth_day IS NULL)
    AND (birth_month IS NULL OR (birth_month BETWEEN 1 AND 12 AND birth_day BETWEEN 1 AND
      CASE birth_month WHEN 2 THEN 29 WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END)));
CREATE INDEX staff_profile_birthday ON eureka.staff_profile (birth_month, birth_day) WHERE birth_month IS NOT NULL;
RESET ROLE;

-- Own row (0081 policies): the new columns join phone and bio.
GRANT INSERT (birth_month, birth_day), UPDATE (birth_month, birth_day) ON eureka.staff_profile TO eureka_app;
-- Definer: authz.set_staff_birthday only (FORCE RLS: explicit policies).
GRANT SELECT, INSERT (user_id, birth_month, birth_day), UPDATE (birth_month, birth_day) ON eureka.staff_profile TO authz_definer;
CREATE POLICY definer_read   ON eureka.staff_profile FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.staff_profile FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.staff_profile FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);

SET ROLE authz_definer;

-- HR (staff.birthday:manage at org scope) sets or clears another staff member's birthday.
CREATE FUNCTION authz.set_staff_birthday(p_user uuid, p_month integer, p_day integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL OR p_user IS NULL OR NOT coalesce(authz.has_org('staff.birthday:manage'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_month IS NULL) IS DISTINCT FROM (p_day IS NULL) THEN
    RAISE EXCEPTION 'invalid_birthday' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_user AND u.status = 'active') THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO eureka.staff_profile (user_id, birth_month, birth_day) VALUES (p_user, p_month, p_day)
  ON CONFLICT (user_id) DO UPDATE SET birth_month = EXCLUDED.birth_month, birth_day = EXCLUDED.birth_day;
END $$;

-- The birthday-digest job: p_day is the job's America/New_York date, never a future day.
-- Returns 1 when an event was written, 0 when nobody has a birthday or the day was done already.
CREATE FUNCTION authz.emit_birthdays(p_day date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ids  uuid[];
  m    integer;
  d    integer;
  leap boolean;
BEGIN
  IF p_day IS NULL OR NOT coalesce(p_day <= (pg_catalog.now() AT TIME ZONE 'America/New_York')::date, false) THEN
    RAISE EXCEPTION 'invalid birthday-digest run' USING ERRCODE = 'check_violation';
  END IF;
  m := EXTRACT(MONTH FROM p_day)::integer;
  d := EXTRACT(DAY FROM p_day)::integer;
  leap := EXTRACT(DAY FROM (pg_catalog.date_trunc('year', p_day::timestamp) + interval '2 months' - interval '1 day'))::integer = 29;
  SELECT coalesce(pg_catalog.array_agg(u.id ORDER BY u.display_name, u.id), '{}'::uuid[]) INTO ids
    FROM eureka.staff_profile sp
    JOIN eureka.app_user u ON u.id = sp.user_id
   WHERE u.status = 'active' AND sp.birth_month = m
     AND (sp.birth_day = d OR (m = 2 AND d = 28 AND sp.birth_day = 29 AND NOT leap));
  IF coalesce(pg_catalog.cardinality(ids), 0) = 0 THEN
    RETURN 0;
  END IF;
  IF authz.notification_emit_once('birthday-digest', p_day::text, 'staff.birthdays_today', 'birthday_digest',
       pg_catalog.gen_random_uuid(),
       pg_catalog.jsonb_build_object('day', p_day, 'userIds', pg_catalog.to_jsonb(ids), 'count', pg_catalog.cardinality(ids),
         'notify', pg_catalog.jsonb_build_array('ceo'))) IS NULL THEN
    RETURN 0;
  END IF;
  RETURN 1;
END $$;

-- The names behind an unpublished digest event, for the email (worker, send time).
CREATE FUNCTION authz.birthday_names(p_event uuid)
RETURNS TABLE (display_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_payload jsonb;
BEGIN
  SELECT e.payload INTO v_payload FROM eureka.outbox_event e
   WHERE e.id = p_event AND e.type = 'staff.birthdays_today' AND e.published_at IS NULL;
  IF v_payload IS NULL OR pg_catalog.jsonb_typeof(v_payload -> 'userIds') IS DISTINCT FROM 'array' THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT u.display_name FROM eureka.app_user u
     WHERE u.id IN (SELECT x::uuid FROM pg_catalog.jsonb_array_elements_text(v_payload -> 'userIds') x)
       AND u.status = 'active'
     ORDER BY u.display_name, u.id;
END $$;
RESET ROLE;

REVOKE ALL ON FUNCTION authz.set_staff_birthday(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.emit_birthdays(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.birthday_names(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_staff_birthday(uuid, integer, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.emit_birthdays(date) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.birthday_names(uuid) TO eureka_worker;
