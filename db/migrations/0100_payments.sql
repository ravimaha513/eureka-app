-- Payments / incentive dashboard (gap L1; design B2 `invoice`, `payment`, view
-- `invoice_status`, B4.4 "Invoices, payments", B6 first-payment and
-- payment-delay; SRS FR-PAY-01..06, FR-NTF-07/08; docs/payments-api.md).
--
--   1. eureka.invoice: one row per invoice Accounts raises on a placement
--      (invoice number, invoice date, payment terms in days, timesheet date,
--      billing period, hours billed, invoice amount, incentive part). The
--      expected payment date is a generated column (invoice date + terms).
--      Everything else about the placement (candidate, technology, client,
--      implementation partner, vendor, rate, joining date, recruiter, team) is
--      read from the placement through joins, never copied.
--   2. eureka.payment: payments received against an invoice (date, amount),
--      voided instead of deleted.
--   3. eureka.invoice_status (security_invoker): the invoice with its derived
--      status (pending / delayed / received / void), the amount received, the
--      first and last payment dates and the delay in days (expected date vs the
--      last payment, or vs today in America/New_York while unpaid). Nothing that
--      can drift is stored.
--   4. RLS (rule 3): invoices are readable with invoice:read over the
--      placement's actor snapshot or its owned candidate, exactly like
--      placements and assignments (0038), and only where the placement itself
--      is readable (the EXISTS runs under placement_read). Payments are
--      readable with their invoice (EXISTS by primary key).
--   5. Writes only through SECURITY DEFINER functions (rule 6) that lock the
--      placement, re-check visibility (404) and invoice:update on the actor
--      snapshot (403), and validate every value NULL-safely (rule 1):
--        authz.invoice_create, authz.invoice_update (row_version), authz.invoice_void,
--        authz.payment_record, authz.payment_void.
--      A write guard refuses every other writer (owner included), stamps the
--      server-managed columns on INSERT (rule 4) and never allows DELETE or
--      TRUNCATE.
--   6. Notifications (ids and counts only, rule 5): authz.payment_record emits
--      `payment.first_received` the first time a payment is recorded for a
--      placement (ledger job `first-payment`, key = placement id, so a voided
--      and re-recorded payment does not notify twice); the daily worker job
--      `payment-delay` calls authz.emit_payment_delays(day), which emits
--      `payment.delayed` once per invoice and expected date for invoices past
--      their expected date and not fully received. The recipient resolver
--      (0070's, every branch carried over) adds both types: recruiter, team
--      lead and lead's manager for the first payment; recruiter and team lead
--      for a delay. Both open the placement from the inbox.
-- Every function: REVOKE ALL FROM PUBLIC, pinned search_path, EXECUTE only for
-- the role that needs it (rule 2).
SET search_path = eureka, public;

-- ---------- tables ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.invoice (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id           uuid NOT NULL REFERENCES eureka.placement(id),
  invoice_no             text CHECK (char_length(btrim(invoice_no)) BETWEEN 1 AND 60 AND invoice_no !~ '[[:cntrl:]]'),
  -- The day the approved timesheet reached Accounts.
  timesheet_submitted_on date CHECK (timesheet_submitted_on BETWEEN date '2000-01-01' AND date '2100-12-31'),
  period_start           date CHECK (period_start BETWEEN date '2000-01-01' AND date '2100-12-31'),
  period_end             date CHECK (period_end BETWEEN date '2000-01-01' AND date '2100-12-31'),
  invoice_date           date NOT NULL CHECK (invoice_date BETWEEN date '2000-01-01' AND date '2100-12-31'),
  -- Payment terms "Net N".
  terms_days             smallint NOT NULL CHECK (terms_days BETWEEN 0 AND 180),
  expected_date          date GENERATED ALWAYS AS (invoice_date + terms_days::integer) STORED,
  hours                  numeric(7,2) CHECK (hours > 0 AND hours <= 5000),
  amount                 numeric(12,2) CHECK (amount > 0 AND amount <= 10000000),
  -- Incentive part (design AS-10: entered, not computed).
  incentive_amount       numeric(12,2) CHECK (incentive_amount >= 0 AND incentive_amount <= 1000000),
  voided_at              timestamptz,
  voided_by              uuid REFERENCES eureka.app_user(id),
  row_version            integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL REFERENCES eureka.app_user(id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES eureka.app_user(id),
  CONSTRAINT invoice_period CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  CONSTRAINT invoice_void CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX invoice_placement ON eureka.invoice (placement_id);
CREATE INDEX invoice_list ON eureka.invoice (invoice_date DESC, id DESC);
CREATE INDEX invoice_open_expected ON eureka.invoice (expected_date) WHERE voided_at IS NULL;
-- Invoice numbers are unique among live invoices (case and surrounding blanks ignored).
CREATE UNIQUE INDEX invoice_number_live ON eureka.invoice (lower(btrim(invoice_no)))
  WHERE voided_at IS NULL AND invoice_no IS NOT NULL;

CREATE TABLE eureka.payment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES eureka.invoice(id),
  received_on date NOT NULL CHECK (received_on BETWEEN date '2000-01-01' AND date '2100-12-31'),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0 AND amount <= 10000000),
  voided_at   timestamptz,
  voided_by   uuid REFERENCES eureka.app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES eureka.app_user(id),
  CONSTRAINT payment_void CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX payment_invoice ON eureka.payment (invoice_id) WHERE voided_at IS NULL;

-- Only the payment functions (as authz_definer) write; the server stamps
-- timestamps and versions (rule 4); a voided row is final; nothing is deleted.
CREATE FUNCTION eureka.payments_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'payment data changes only through payment functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment data is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
    IF TG_TABLE_NAME = 'invoice' THEN
      NEW.row_version := 1;
      NEW.updated_at := NEW.created_at;
      NEW.updated_by := NEW.created_by;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'voided rows are final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'payment' THEN
    IF (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by'])
       OR NEW.voided_at IS NULL THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.voided_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.placement_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.id, OLD.placement_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.voided_at IS NOT NULL THEN
    NEW.voided_at := pg_catalog.now();
  END IF;
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.invoice
  FOR EACH ROW EXECUTE FUNCTION eureka.payments_write_guard();
CREATE TRIGGER payment_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.payment
  FOR EACH ROW EXECUTE FUNCTION eureka.payments_write_guard();

-- TRUNCATE skips row triggers: refuse it for everyone (owner included).
CREATE FUNCTION eureka.payments_truncate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'payment data is never truncated' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER invoice_truncate_guard BEFORE TRUNCATE ON eureka.invoice
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.payments_truncate_guard();
CREATE TRIGGER payment_truncate_guard BEFORE TRUNCATE ON eureka.payment
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.payments_truncate_guard();

ALTER TABLE eureka.invoice ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.invoice FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.payment ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.payment FORCE ROW LEVEL SECURITY;

-- App read policies (rule 3): invoice:read over the placement (actor snapshot,
-- or the owned candidate through a hashed SubPlan), the placement looked up by
-- primary key under its own policy; payments by their invoice's primary key.
CREATE POLICY invoice_read ON eureka.invoice FOR SELECT TO eureka_app USING (
  EXISTS (
    SELECT 1 FROM eureka.placement p
    WHERE p.id = invoice.placement_id
      AND ((SELECT authz.has_org('invoice:read'))
           OR p.recruiter_id = ANY ((SELECT authz.recruiter_ids('invoice:read'))::uuid[])
           OR p.team_id      = ANY ((SELECT authz.team_ids('invoice:read'))::uuid[])
           OR p.location_id  = ANY ((SELECT authz.location_ids('invoice:read'))::uuid[])
           OR p.candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('invoice:read'))))))
);
CREATE POLICY payment_read ON eureka.payment FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.invoice i WHERE i.id = payment.invoice_id));

-- Definer: exactly what the functions below do.
CREATE POLICY definer_read   ON eureka.invoice FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.invoice FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.invoice FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.payment FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.payment FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.payment FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);

-- Derived status and delay (design B2 "nothing stored that can drift"; B4.8:
-- security_invoker, so the caller's RLS applies to every row it reads).
CREATE VIEW eureka.invoice_status WITH (security_invoker = true) AS
SELECT i.id, i.placement_id, i.invoice_no, i.timesheet_submitted_on, i.period_start, i.period_end,
       i.invoice_date, i.terms_days, i.expected_date, i.hours, i.amount, i.incentive_amount,
       i.voided_at, i.row_version, i.created_at, i.created_by, i.updated_at,
       coalesce(pt.paid, 0)::numeric(12,2) AS paid_amount,
       coalesce(pt.n, 0) AS payment_count,
       pt.first_on AS first_received_on,
       pt.last_on AS last_received_on,
       CASE WHEN i.voided_at IS NOT NULL THEN 'void'
            WHEN coalesce(pt.n, 0) > 0 AND (i.amount IS NULL OR pt.paid >= i.amount) THEN 'received'
            WHEN i.expected_date < (pg_catalog.now() AT TIME ZONE 'America/New_York')::date THEN 'delayed'
            ELSE 'pending' END AS status,
       CASE WHEN i.voided_at IS NOT NULL THEN NULL
            WHEN coalesce(pt.n, 0) > 0 AND (i.amount IS NULL OR pt.paid >= i.amount)
              THEN GREATEST(pt.last_on - i.expected_date, 0)
            ELSE GREATEST((pg_catalog.now() AT TIME ZONE 'America/New_York')::date - i.expected_date, 0) END AS delay_days
FROM eureka.invoice i
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS n, sum(p.amount) AS paid, min(p.received_on) AS first_on, max(p.received_on) AS last_on
  FROM eureka.payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL) pt ON true;

RESET ROLE;

REVOKE ALL ON eureka.invoice, eureka.payment, eureka.invoice_status FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.payments_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.payments_truncate_guard() FROM PUBLIC;

-- App: read only (amounts are filtered by the API field policy: rate:read).
GRANT SELECT ON eureka.invoice, eureka.payment, eureka.invoice_status TO eureka_app;
-- Definer: exactly what the functions write.
GRANT SELECT, INSERT ON eureka.invoice TO authz_definer;
GRANT UPDATE (invoice_no, timesheet_submitted_on, period_start, period_end, invoice_date, terms_days, hours, amount,
              incentive_amount, voided_at, voided_by, row_version, updated_at, updated_by)
  ON eureka.invoice TO authz_definer;
GRANT SELECT, INSERT ON eureka.payment TO authz_definer;
GRANT UPDATE (voided_at, voided_by) ON eureka.payment TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- Locks the placement and applies the shared checks: visible for invoice:read
-- and placement:read (as the read policies) else p_missing (404), then
-- invoice:update on the actor snapshot else not_permitted (403). Internal.
CREATE FUNCTION authz.invoice_placement_lock(p_placement uuid, p_missing text)
RETURNS TABLE (id uuid, joined_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p record;
BEGIN
  SELECT pl.* INTO p FROM eureka.placement pl WHERE pl.id = p_placement FOR UPDATE;
  IF p.id IS NULL OR authz.current_user_id() IS NULL
     OR NOT coalesce(
       (authz.owns('invoice:read', p.recruiter_id, p.team_id, p.location_id)
        OR authz.candidate_owned(p.candidate_id, 'invoice:read'))
       AND (authz.owns('placement:read', p.recruiter_id, p.team_id, p.location_id)
            OR authz.candidate_owned(p.candidate_id, 'placement:read')), false) THEN
    RAISE EXCEPTION '%', coalesce(p_missing, 'not_found') USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('invoice:update', p.recruiter_id, p.team_id, p.location_id), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT p.id, p.joined_at;
END $$;

-- The invoice's placement, locked and checked, then the invoice row locked. Internal.
CREATE FUNCTION authz.invoice_lock(p_invoice uuid)
RETURNS SETOF eureka.invoice
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE pid uuid;
BEGIN
  SELECT x.placement_id INTO pid FROM eureka.invoice x WHERE x.id = p_invoice;
  PERFORM 1 FROM authz.invoice_placement_lock(pid, 'invoice_not_found');
  RETURN QUERY SELECT x.* FROM eureka.invoice x WHERE x.id = p_invoice FOR UPDATE;
END $$;

-- Value checks shared by create and update (the table CHECKs repeat them).
CREATE FUNCTION authz.invoice_values_ok(
  p_no text, p_invoice_date date, p_terms integer, p_timesheet date, p_start date, p_end date,
  p_hours numeric, p_amount numeric, p_incentive numeric)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE today date := (pg_catalog.now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF p_invoice_date IS NULL OR p_terms IS NULL
     OR NOT coalesce(p_invoice_date BETWEEN date '2000-01-01' AND today AND p_terms BETWEEN 0 AND 180, false)
     OR NOT coalesce(p_timesheet IS NULL OR p_timesheet BETWEEN date '2000-01-01' AND today, false)
     OR NOT coalesce(p_start IS NULL OR p_start BETWEEN date '2000-01-01' AND date '2100-12-31', false)
     OR NOT coalesce(p_end IS NULL OR p_end BETWEEN date '2000-01-01' AND date '2100-12-31', false)
     OR NOT coalesce(p_start IS NULL OR p_end IS NULL OR p_end >= p_start, false)
     OR NOT coalesce(p_hours IS NULL OR (p_hours > 0 AND p_hours <= 5000), false)
     OR NOT coalesce(p_amount IS NULL OR (p_amount > 0 AND p_amount <= 10000000), false)
     OR NOT coalesce(p_incentive IS NULL OR (p_incentive >= 0 AND p_incentive <= 1000000), false)
     OR NOT coalesce(p_no IS NULL OR (pg_catalog.char_length(p_no) BETWEEN 1 AND 60 AND p_no !~ '[[:cntrl:]]'), false) THEN
    RAISE EXCEPTION 'invalid_invoice' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- FR-PAY-01..03: Accounts raises an invoice on a joined placement. Returns the id.
CREATE FUNCTION authz.invoice_create(
  p_placement uuid, p_no text, p_invoice_date date, p_terms integer, p_timesheet date,
  p_start date, p_end date, p_hours numeric, p_amount numeric, p_incentive numeric)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p record; no text := nullif(pg_catalog.btrim(p_no), ''); new_id uuid;
BEGIN
  SELECT * INTO p FROM authz.invoice_placement_lock(p_placement, 'placement_not_found');
  IF p.joined_at IS NULL THEN
    RAISE EXCEPTION 'placement_not_joined' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM authz.invoice_values_ok(no, p_invoice_date, p_terms, p_timesheet, p_start, p_end, p_hours, p_amount, p_incentive);
  IF no IS NOT NULL AND EXISTS (SELECT 1 FROM eureka.invoice x
       WHERE x.voided_at IS NULL AND lower(pg_catalog.btrim(x.invoice_no)) = lower(no)) THEN
    RAISE EXCEPTION 'invoice_no_exists' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.invoice (placement_id, invoice_no, timesheet_submitted_on, period_start, period_end,
      invoice_date, terms_days, hours, amount, incentive_amount, created_by)
  VALUES (p.id, no, p_timesheet, p_start, p_end, p_invoice_date, p_terms, p_hours, p_amount, p_incentive,
      authz.current_user_id())
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

-- Partial update (keys of p_fields present = fields to change; JSON null clears
-- an optional field) with optimistic concurrency on row_version. Returns the
-- new row_version.
CREATE FUNCTION authz.invoice_update(p_invoice uuid, p_version integer, p_fields jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  i eureka.invoice;
  k text;
  t text;
  v_no text; v_date date; v_terms integer; v_ts date; v_start date; v_end date;
  v_hours numeric; v_amount numeric; v_inc numeric;
  paid numeric;
  ver integer;
BEGIN
  SELECT * INTO i FROM authz.invoice_lock(p_invoice);
  IF i.id IS NULL THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF i.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_void' USING ERRCODE = 'check_violation';
  END IF;
  IF p_version IS NULL OR i.row_version IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'serialization_failure';
  END IF;
  IF p_fields IS NULL OR pg_catalog.jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR p_fields = '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_invoice' USING ERRCODE = 'check_violation';
  END IF;
  FOR k, t IN SELECT e.key, pg_catalog.jsonb_typeof(e.value) FROM pg_catalog.jsonb_each(p_fields) e LOOP
    IF NOT coalesce(
         (k IN ('invoiceDate') AND t = 'string')
         OR (k IN ('termsDays') AND t = 'number')
         OR (k IN ('invoiceNo', 'timesheetSubmittedOn', 'periodStart', 'periodEnd') AND t IN ('string', 'null'))
         OR (k IN ('hours', 'amount', 'incentiveAmount') AND t IN ('number', 'null')), false) THEN
      RAISE EXCEPTION 'invalid_invoice' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  BEGIN
    v_no    := CASE WHEN p_fields ? 'invoiceNo' THEN nullif(pg_catalog.btrim(p_fields ->> 'invoiceNo'), '') ELSE i.invoice_no END;
    v_date  := CASE WHEN p_fields ? 'invoiceDate' THEN (p_fields ->> 'invoiceDate')::date ELSE i.invoice_date END;
    v_terms := CASE WHEN p_fields ? 'termsDays' THEN (p_fields ->> 'termsDays')::integer ELSE i.terms_days END;
    v_ts    := CASE WHEN p_fields ? 'timesheetSubmittedOn' THEN (p_fields ->> 'timesheetSubmittedOn')::date ELSE i.timesheet_submitted_on END;
    v_start := CASE WHEN p_fields ? 'periodStart' THEN (p_fields ->> 'periodStart')::date ELSE i.period_start END;
    v_end   := CASE WHEN p_fields ? 'periodEnd' THEN (p_fields ->> 'periodEnd')::date ELSE i.period_end END;
    v_hours := CASE WHEN p_fields ? 'hours' THEN (p_fields ->> 'hours')::numeric ELSE i.hours END;
    v_amount := CASE WHEN p_fields ? 'amount' THEN (p_fields ->> 'amount')::numeric ELSE i.amount END;
    v_inc   := CASE WHEN p_fields ? 'incentiveAmount' THEN (p_fields ->> 'incentiveAmount')::numeric ELSE i.incentive_amount END;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'invalid_invoice' USING ERRCODE = 'check_violation';
  END;
  PERFORM authz.invoice_values_ok(v_no, v_date, v_terms, v_ts, v_start, v_end, v_hours, v_amount, v_inc);
  IF v_no IS NOT NULL AND EXISTS (SELECT 1 FROM eureka.invoice x
       WHERE x.voided_at IS NULL AND x.id <> i.id AND lower(pg_catalog.btrim(x.invoice_no)) = lower(v_no)) THEN
    RAISE EXCEPTION 'invoice_no_exists' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT coalesce(sum(p.amount), 0) INTO paid FROM eureka.payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL;
  IF v_amount IS NOT NULL AND paid > v_amount THEN
    RAISE EXCEPTION 'amount_below_received' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL AND p.received_on < v_date) THEN
    RAISE EXCEPTION 'invalid_invoice_date' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.invoice x
     SET invoice_no = v_no, invoice_date = v_date, terms_days = v_terms, timesheet_submitted_on = v_ts,
         period_start = v_start, period_end = v_end, hours = v_hours, amount = v_amount, incentive_amount = v_inc,
         updated_by = authz.current_user_id()
   WHERE x.id = i.id
  RETURNING x.row_version INTO ver;
  RETURN ver;
END $$;

-- Void an invoice raised in error (row_version checked). Payments must be voided first.
CREATE FUNCTION authz.invoice_void(p_invoice uuid, p_version integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i eureka.invoice;
BEGIN
  SELECT * INTO i FROM authz.invoice_lock(p_invoice);
  IF i.id IS NULL THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF i.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_void' USING ERRCODE = 'check_violation';
  END IF;
  IF p_version IS NULL OR i.row_version IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'serialization_failure';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL) THEN
    RAISE EXCEPTION 'invoice_has_payments' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.invoice x SET voided_at = pg_catalog.now(), voided_by = authz.current_user_id(),
         updated_by = authz.current_user_id()
   WHERE x.id = i.id;
END $$;

-- FR-PAY-04/05: a payment received (date, amount) against a live invoice. The
-- date is on or after the invoice date and not in the future; the total
-- received never exceeds the invoice amount (when one is set). The first
-- payment ever recorded for the placement emits `payment.first_received`
-- (once per placement, ledger job `first-payment`).
CREATE FUNCTION authz.payment_record(p_invoice uuid, p_received date, p_amount numeric)
RETURNS TABLE (payment_id uuid, first_payment boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  i eureka.invoice;
  paid numeric;
  new_id uuid;
  ev uuid;
BEGIN
  SELECT * INTO i FROM authz.invoice_lock(p_invoice);
  IF i.id IS NULL THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF i.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_void' USING ERRCODE = 'check_violation';
  END IF;
  IF p_received IS NULL OR NOT coalesce(p_received >= i.invoice_date
       AND p_received <= (pg_catalog.now() AT TIME ZONE 'America/New_York')::date, false) THEN
    RAISE EXCEPTION 'invalid_payment_date' USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount IS NULL OR NOT coalesce(p_amount > 0 AND p_amount <= 10000000, false) THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(p.amount), 0) INTO paid FROM eureka.payment p WHERE p.invoice_id = i.id AND p.voided_at IS NULL;
  IF i.amount IS NOT NULL AND paid + p_amount > i.amount THEN
    RAISE EXCEPTION 'overpayment' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.payment (invoice_id, received_on, amount, created_by)
  VALUES (i.id, p_received, p_amount, authz.current_user_id())
  RETURNING id INTO new_id;
  ev := authz.notification_emit_once('first-payment', i.placement_id::text, 'payment.first_received', 'placement',
          i.placement_id, pg_catalog.jsonb_build_object('placementId', i.placement_id, 'invoiceId', i.id, 'paymentId', new_id));
  RETURN QUERY SELECT new_id, ev IS NOT NULL;
END $$;

-- Void a payment recorded in error. Returns the invoice id.
CREATE FUNCTION authz.payment_void(p_payment uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE inv uuid; i eureka.invoice; pv timestamptz;
BEGIN
  SELECT x.invoice_id INTO inv FROM eureka.payment x WHERE x.id = p_payment;
  SELECT * INTO i FROM authz.invoice_lock(inv);
  IF i.id IS NULL THEN
    RAISE EXCEPTION 'payment_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT x.voided_at INTO pv FROM eureka.payment x WHERE x.id = p_payment FOR UPDATE;
  IF i.voided_at IS NOT NULL OR pv IS NOT NULL THEN
    RAISE EXCEPTION 'payment_void' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.payment x SET voided_at = pg_catalog.now(), voided_by = authz.current_user_id() WHERE x.id = p_payment;
  RETURN i.id;
END $$;

-- FR-PAY-06 / FR-NTF-08 payment-delay: for every live invoice past its
-- expected date (before p_day, the worker's America/New_York date; a future
-- day is refused) and not fully received, one `payment.delayed` event, once
-- per invoice and expected date (a changed invoice date or terms re-arms it).
-- Returns the number of events written. Ids and a count only.
CREATE FUNCTION authz.emit_payment_delays(p_day date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer := 0; r record;
BEGIN
  IF p_day IS NULL OR NOT coalesce(p_day <= (pg_catalog.now() AT TIME ZONE 'America/New_York')::date, false) THEN
    RAISE EXCEPTION 'invalid payment-delay run' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN
    SELECT i.id, i.placement_id, i.expected_date, i.id::text || ':' || i.expected_date::text AS k
      FROM eureka.invoice i
     WHERE i.voided_at IS NULL AND i.expected_date < p_day
       AND NOT EXISTS (
         SELECT 1 FROM (SELECT count(*) AS c, coalesce(sum(p.amount), 0) AS paid FROM eureka.payment p
                         WHERE p.invoice_id = i.id AND p.voided_at IS NULL) s
          WHERE s.c > 0 AND (i.amount IS NULL OR s.paid >= i.amount))
       AND NOT EXISTS (SELECT 1 FROM eureka.notification_ledger l
                        WHERE l.job = 'payment-delay' AND l.key = i.id::text || ':' || i.expected_date::text)
     ORDER BY i.expected_date, i.id
     LIMIT 5000
  LOOP
    IF authz.notification_emit_once('payment-delay', r.k, 'payment.delayed', 'invoice', r.id,
         pg_catalog.jsonb_build_object('invoiceId', r.id, 'placementId', r.placement_id,
           'daysLate', LEAST(p_day - r.expected_date, 3650))) IS NOT NULL THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- ---------- notification registry: payment.first_received, payment.delayed ----------
-- The resolver as last replaced by 0089 (every branch carried over unchanged),
-- with the two payment types: the placement's recruiter and team lead, and
-- for the first payment also the lead's manager; only while the payload's
-- invoice belongs to the payload's placement. A later migration replacing
-- this function must carry the branches over.
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
  v_no_mgr  boolean := false;
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
  ELSIF v_type = 'interview.requested' THEN
    -- interview-alerts (0089): the support team that coordinates interviews.
    v_roles := ARRAY['interview_coordinator'];
  ELSIF v_type = 'contract.created' THEN
    -- interview-alerts (0086): invoicing and the closure documents.
    v_roles := ARRAY['hr', 'associate_hr', 'accounts'];
  ELSIF v_type = 'staff.birthdays_today' THEN
    -- interview-alerts (0087): the CEO's morning digest.
    v_roles := ARRAY['ceo'];
  ELSIF v_type IN ('payment.first_received', 'payment.delayed') THEN
    -- 0100: FR-NTF-07 (recruiter, TL, manager) and FR-NTF-08 (recruiter, TL).
    SELECT p.recruiter_id, p.team_id INTO v_rec, v_team
      FROM eureka.placement p JOIN eureka.invoice i ON i.placement_id = p.id
     WHERE p.id = (v_payload ->> 'placementId')::uuid AND i.id = (v_payload ->> 'invoiceId')::uuid;
    v_no_mgr := v_type = 'payment.delayed';
  ELSE
    RETURN;
  END IF;

  IF v_team IS NOT NULL THEN
    SELECT t.lead_id INTO v_lead FROM eureka.team t WHERE t.id = v_team;
  END IF;
  IF v_lead IS NOT NULL AND NOT v_no_mgr THEN
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

-- 0089's entity mapping (every branch carried over) with the two payment
-- types, which open the placement.
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
  ELSIF v_type IN ('employee.benched', 'assignment.ending_soon', 'checklist.item_overdue', 'contract.created',
                   'payment.first_received', 'payment.delayed') THEN
    RETURN QUERY SELECT 'placement'::text, (v_payload ->> 'placementId')::uuid;
  ELSIF v_type IN ('employee.exited', 'employee.bench_time', 'candidate.assigned') THEN
    RETURN QUERY SELECT 'candidate'::text, (v_payload ->> 'candidateId')::uuid;
  ELSIF v_type = 'application.received' THEN
    RETURN QUERY SELECT 'application'::text, (v_payload ->> 'applicationId')::uuid;
  ELSIF v_type = 'chat.direct_message' THEN
    RETURN QUERY SELECT 'conversation'::text, (v_payload ->> 'conversationId')::uuid;
  ELSIF v_type = 'interview.requested' THEN
    RETURN QUERY SELECT 'interview'::text, (v_payload ->> 'interviewId')::uuid;
  ELSIF v_type = 'staff.birthdays_today' THEN
    RETURN QUERY SELECT 'digest'::text, p_event;
  END IF;
END $$;

RESET ROLE;

-- Rule 2: no PUBLIC execute; the API's functions to eureka_app, the delay scan
-- to eureka_worker, the internal helpers to nobody (definer functions run as
-- their owner). CREATE OR REPLACE keeps the resolvers' grants; restated.
REVOKE ALL ON FUNCTION authz.invoice_placement_lock(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.invoice_lock(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.invoice_values_ok(text, date, integer, date, date, date, numeric, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.invoice_create(uuid, text, date, integer, date, date, date, numeric, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.invoice_update(uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.invoice_void(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.payment_record(uuid, date, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.payment_void(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.emit_payment_delays(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_recipients(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_entity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  authz.invoice_create(uuid, text, date, integer, date, date, date, numeric, numeric, numeric),
  authz.invoice_update(uuid, integer, jsonb), authz.invoice_void(uuid, integer),
  authz.payment_record(uuid, date, numeric), authz.payment_void(uuid)
  TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.emit_payment_delays(date) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.notification_recipients(uuid, uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.notification_entity(uuid) TO eureka_worker;
