-- Own companies, facilities (guest houses), their utilities and bills
-- (Phase 3b; contract docs/facilities-api.md; permissions in
-- packages/shared/src/authz/catalog.ts: company:*, facility:*, utility:*,
-- utility.secret:read (restricted), bill:*; Location Ops Admin at location scope).
--
--   1. eureka.company / eureka.facility: the group's own legal entities and the
--      accommodation it rents, each in one location. Read: <kind>:read covering
--      the row's location; writes only through definer functions that re-check
--      <kind>:manage over the location (and over the new location on a move).
--   2. eureka.company_incharge / eureka.facility_incharge: app users in charge
--      (active users holding a current role at the owner's location).
--   3. eureka.company_employee: employees (eureka.employee) working for a company;
--      at most one open row per employee across all companies; the employee's
--      candidate must be in the company's location. eureka.employee is readable
--      only with employee:read at org scope, so names, dates and the employment
--      status reach company:read holders through authz.company_employees (and
--      the picker through authz.company_employee_options), never the table.
--   4. eureka.utility: per company or facility (exactly one). The portal password
--      is encrypted by the API (field class utility_password, FE-1/FE-2 of
--      docs/work-authorization-api.md) with an integrity MAC under the blind
--      index key (FE-3a); the app role has no column privilege on the ciphertext
--      or MAC: authz.utility_password_reveal re-checks utility.secret:read over
--      the location and a live step-up grant of the caller's session, rate-limits
--      (20/min, 200/day) and writes the audit row before returning them. The
--      monthly key-rotation job rotates the class (field_rotation_batch/apply
--      extended below; the worker gets no new grant).
--   5. eureka.utility_bill: bills of a utility; status is derived by the API;
--      "delete" voids (voided_* set once, excluded from lists and totals).
--      Invoices reuse the documents pipeline of 0043: eureka.document gains a
--      bill owner kind (bill_id; candidate_id becomes NULL for those rows),
--      internal classification, same file_object scan and download rules;
--      every download is in eureka.document_access and the audit log.
-- Rule 5: audit rows carry ids, codes, dates and field names only (never names,
-- addresses, owner contact, account numbers, usernames, passwords, notes, amounts
-- or void reasons); nothing here writes outbox_event.
-- Every IF is NULL-safe (rule 1). Every function: REVOKE ALL FROM PUBLIC, pinned
-- search_path, EXECUTE only where needed (rule 2).
SET search_path = eureka, public;

-- ---------- tables ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.company (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES eureka.location(id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  street      text CHECK (char_length(street) BETWEEN 1 AND 200 AND street !~ '[[:cntrl:]]'),
  city        text CHECK (char_length(city) BETWEEN 1 AND 80 AND city !~ '[[:cntrl:]]'),
  state       text CHECK (char_length(state) BETWEEN 1 AND 40 AND state !~ '[[:cntrl:]]'),
  zip         text CHECK (zip ~ '^[0-9A-Za-z][0-9A-Za-z -]{1,10}[0-9A-Za-z]$'),
  country     text NOT NULL DEFAULT 'USA' CHECK (char_length(country) BETWEEN 1 AND 60 AND country !~ '[[:cntrl:]]'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes       text CHECK (char_length(notes) BETWEEN 1 AND 2000),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by  uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NOT NULL REFERENCES eureka.app_user(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX company_name_unique ON eureka.company (location_id, lower(name));
CREATE INDEX company_list ON eureka.company (lower(name), id);

CREATE TABLE eureka.facility (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   uuid NOT NULL REFERENCES eureka.location(id),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  street        text CHECK (char_length(street) BETWEEN 1 AND 200 AND street !~ '[[:cntrl:]]'),
  city          text CHECK (char_length(city) BETWEEN 1 AND 80 AND city !~ '[[:cntrl:]]'),
  state         text CHECK (char_length(state) BETWEEN 1 AND 40 AND state !~ '[[:cntrl:]]'),
  zip           text CHECK (zip ~ '^[0-9A-Za-z][0-9A-Za-z -]{1,10}[0-9A-Za-z]$'),
  country       text NOT NULL DEFAULT 'USA' CHECK (char_length(country) BETWEEN 1 AND 60 AND country !~ '[[:cntrl:]]'),
  owner_name    text CHECK (char_length(owner_name) BETWEEN 1 AND 120 AND owner_name !~ '[[:cntrl:]]'),
  owner_email   text CHECK (char_length(owner_email) <= 254 AND owner_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  owner_phone   text CHECK (owner_phone ~ '^\+?[0-9][0-9 ().-]{5,28}[0-9]$'),
  rent          numeric(12,2) CHECK (rent >= 0),
  fee_frequency text CHECK (fee_frequency IN ('weekly', 'monthly', 'yearly')),
  capacity      integer CHECK (capacity BETWEEN 0 AND 10000),
  beds          integer CHECK (beds BETWEEN 0 AND 10000),
  baths         numeric(3,1) CHECK (baths >= 0),
  start_date    date CHECK (start_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  end_date      date CHECK (end_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes         text CHECK (char_length(notes) BETWEEN 1 AND 2000),
  row_version   integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by    uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL REFERENCES eureka.app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facility_dates CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  CONSTRAINT facility_rent_frequency CHECK (rent IS NULL OR fee_frequency IS NOT NULL)
);
CREATE UNIQUE INDEX facility_name_unique ON eureka.facility (location_id, lower(name));
CREATE INDEX facility_list ON eureka.facility (lower(name), id);

CREATE TABLE eureka.company_incharge (
  company_id  uuid NOT NULL REFERENCES eureka.company(id),
  user_id     uuid NOT NULL REFERENCES eureka.app_user(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid NOT NULL REFERENCES eureka.app_user(id),
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX company_incharge_user ON eureka.company_incharge (user_id);

CREATE TABLE eureka.facility_incharge (
  facility_id uuid NOT NULL REFERENCES eureka.facility(id),
  user_id     uuid NOT NULL REFERENCES eureka.app_user(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid NOT NULL REFERENCES eureka.app_user(id),
  PRIMARY KEY (facility_id, user_id)
);
CREATE INDEX facility_incharge_user ON eureka.facility_incharge (user_id);

CREATE TABLE eureka.company_employee (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES eureka.company(id),
  person_id  uuid NOT NULL REFERENCES eureka.employee(person_id),
  start_date date NOT NULL CHECK (start_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  end_date   date CHECK (end_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  created_by uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_by   uuid REFERENCES eureka.app_user(id),
  ended_at   timestamptz,
  CONSTRAINT company_employee_dates CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT company_employee_ended CHECK ((end_date IS NULL) = (ended_by IS NULL) AND (end_date IS NULL) = (ended_at IS NULL))
);
-- An employee works for one entity at a time.
CREATE UNIQUE INDEX company_employee_open ON eureka.company_employee (person_id) WHERE end_date IS NULL;
CREATE INDEX company_employee_company ON eureka.company_employee (company_id, end_date);
CREATE INDEX company_employee_person ON eureka.company_employee (person_id, start_date);

CREATE TABLE eureka.utility (
  id               uuid PRIMARY KEY,
  company_id       uuid REFERENCES eureka.company(id),
  facility_id      uuid REFERENCES eureka.facility(id),
  utility_type     text NOT NULL CHECK (utility_type IN ('electricity', 'water', 'gas', 'internet', 'phone', 'waste',
                     'sewage', 'hvac', 'security', 'cleaning', 'other')),
  service_provider text NOT NULL CHECK (char_length(service_provider) BETWEEN 1 AND 120 AND service_provider !~ '[[:cntrl:]]'),
  account_number   text CHECK (char_length(account_number) BETWEEN 1 AND 60 AND account_number !~ '[[:cntrl:]]'),
  website_url      text CHECK (char_length(website_url) <= 300 AND website_url ~ '^https://[^[:space:][:cntrl:]/?#]+([/?#][^[:space:][:cntrl:]]*)?$'),
  username         text CHECK (char_length(username) BETWEEN 1 AND 120 AND username !~ '[[:cntrl:]]'),
  password_enc     bytea,
  password_key_id  uuid REFERENCES eureka.field_key(id),
  password_mac     bytea,
  has_password     boolean GENERATED ALWAYS AS (password_enc IS NOT NULL) STORED,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes            text CHECK (char_length(notes) BETWEEN 1 AND 2000),
  row_version      integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by       uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL REFERENCES eureka.app_user(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT utility_owner CHECK (num_nonnulls(company_id, facility_id) = 1),
  CONSTRAINT utility_password_key CHECK ((password_enc IS NULL) = (password_key_id IS NULL)
                                         AND (password_enc IS NULL) = (password_mac IS NULL)),
  CONSTRAINT utility_password_format CHECK (
    password_enc IS NULL OR (
      pg_catalog.get_byte(password_enc, 0) = 1
      AND octet_length(password_enc) BETWEEN 50 AND 1000
      AND substring(password_enc FROM 2 FOR 16) = pg_catalog.uuid_send(password_key_id))),
  CONSTRAINT utility_password_mac CHECK (password_mac IS NULL OR octet_length(password_mac) = 32)
);
CREATE INDEX utility_company ON eureka.utility (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX utility_facility ON eureka.utility (facility_id) WHERE facility_id IS NOT NULL;
CREATE INDEX utility_password_key ON eureka.utility (password_key_id) WHERE password_key_id IS NOT NULL;

CREATE TABLE eureka.utility_bill (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id          uuid NOT NULL REFERENCES eureka.utility(id),
  payment_method      text NOT NULL CHECK (payment_method IN ('bank', 'card', 'ach', 'check', 'cash', 'autopay', 'other')),
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  billing_start       date NOT NULL CHECK (billing_start BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  billing_end         date NOT NULL CHECK (billing_end BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  due_date            date NOT NULL CHECK (due_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  paid_on             date CHECK (paid_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  voided_at           timestamptz,
  voided_by           uuid REFERENCES eureka.app_user(id),
  void_reason         text CHECK (char_length(void_reason) BETWEEN 1 AND 500),
  -- The current invoice (a document with bill_id = this bill); FK added below.
  invoice_document_id uuid,
  row_version         integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by          uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL REFERENCES eureka.app_user(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT utility_bill_period CHECK (billing_end >= billing_start),
  CONSTRAINT utility_bill_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX utility_bill_utility ON eureka.utility_bill (utility_id, billing_start DESC, id DESC);
CREATE INDEX utility_bill_period_live ON eureka.utility_bill (billing_start) WHERE voided_at IS NULL;

-- Invoices: a bill owner kind on the 0043 documents (exactly one owner).
ALTER TABLE eureka.document
  ALTER COLUMN candidate_id DROP NOT NULL,
  ADD COLUMN bill_id uuid REFERENCES eureka.utility_bill(id),
  ADD CONSTRAINT document_owner CHECK (num_nonnulls(candidate_id, bill_id) = 1 AND (bill_id IS NULL OR placement_id IS NULL));
CREATE INDEX document_bill ON eureka.document (bill_id, created_at DESC) WHERE bill_id IS NOT NULL;
ALTER TABLE eureka.utility_bill
  ADD CONSTRAINT utility_bill_invoice FOREIGN KEY (invoice_document_id) REFERENCES eureka.document(id);

-- Field class utility_password (field_key and the rotation log).
ALTER TABLE eureka.field_key DROP CONSTRAINT field_key_field_class_check,
  ADD CONSTRAINT field_key_field_class_check CHECK (field_class IN ('work_auth_number', 'dob', 'utility_password'));
ALTER TABLE eureka.field_rotation_log DROP CONSTRAINT field_rotation_log_field_class_check,
  ADD CONSTRAINT field_rotation_log_field_class_check CHECK (field_class IN ('work_auth_number', 'dob', 'utility_password'));

-- Reveal rate limit counted from the audit log (as 0047 for work authorization).
CREATE INDEX audit_event_utility_reveal ON eureka.audit_event (actor_id, at)
  WHERE action = 'utility.password_revealed';

-- ---------- write guards (rules 4 and 6) ----------
-- company, facility, utility, utility_bill: written only inside definer
-- functions with a user; the server sets ids of the actor, timestamps,
-- row_version and (at creation) status; nothing is deleted. Without a user
-- (the worker's key rotation) only a utility's ciphertext and its key change.
CREATE FUNCTION eureka.facilities_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION '% rows are written only by definer functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are not deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF actor IS NULL THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.row_version := 1;
    NEW.created_by := actor;
    NEW.updated_by := actor;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := pg_catalog.now();
    IF TG_TABLE_NAME IN ('company', 'facility', 'utility') THEN
      NEW.status := 'active';
    END IF;
    IF TG_TABLE_NAME = 'utility_bill' THEN
      NEW.voided_at := NULL;
      NEW.voided_by := NULL;
      NEW.void_reason := NULL;
      NEW.invoice_document_id := NULL;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF (NEW.id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'utility' THEN
    IF (NEW.company_id, NEW.facility_id) IS DISTINCT FROM (OLD.company_id, OLD.facility_id) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF actor IS NULL THEN
      IF (NEW.utility_type, NEW.service_provider, NEW.account_number, NEW.website_url, NEW.username, NEW.password_mac,
          NEW.status, NEW.notes, NEW.row_version, NEW.updated_by, NEW.updated_at)
         IS DISTINCT FROM
         (OLD.utility_type, OLD.service_provider, OLD.account_number, OLD.website_url, OLD.username, OLD.password_mac,
          OLD.status, OLD.notes, OLD.row_version, OLD.updated_by, OLD.updated_at)
         OR NEW.password_enc IS NULL OR OLD.password_enc IS NULL THEN
        RAISE EXCEPTION 'key rotation changes only the ciphertext' USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'utility_bill' THEN
    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'bill_voided' USING ERRCODE = 'check_violation';
    END IF;
    -- A bill stays with the owner (company or facility) of its utility.
    IF NEW.utility_id IS DISTINCT FROM OLD.utility_id AND (
         SELECT (u.company_id, u.facility_id) FROM eureka.utility u WHERE u.id = NEW.utility_id)
       IS DISTINCT FROM (SELECT (u.company_id, u.facility_id) FROM eureka.utility u WHERE u.id = OLD.utility_id) THEN
      RAISE EXCEPTION 'invalid_utility' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.void_reason IS NOT NULL THEN
      NEW.voided_at := pg_catalog.now();
      NEW.voided_by := actor;
    ELSE
      NEW.voided_at := NULL;
      NEW.voided_by := NULL;
    END IF;
    -- Attaching an invoice is not an edit of the bill's fields (the edit form keeps its If-Match).
    IF (NEW.utility_id, NEW.payment_method, NEW.amount, NEW.billing_start, NEW.billing_end, NEW.due_date, NEW.paid_on, NEW.void_reason)
       IS DISTINCT FROM
       (OLD.utility_id, OLD.payment_method, OLD.amount, OLD.billing_start, OLD.billing_end, OLD.due_date, OLD.paid_on, OLD.void_reason) THEN
      NEW.row_version := OLD.row_version + 1;
    ELSE
      NEW.row_version := OLD.row_version;
    END IF;
  ELSE
    NEW.row_version := OLD.row_version + 1;
  END IF;
  NEW.updated_by := actor;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER company_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.company
  FOR EACH ROW EXECUTE FUNCTION eureka.facilities_write_guard();
CREATE TRIGGER facility_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.facility
  FOR EACH ROW EXECUTE FUNCTION eureka.facilities_write_guard();
CREATE TRIGGER utility_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.utility
  FOR EACH ROW EXECUTE FUNCTION eureka.facilities_write_guard();
CREATE TRIGGER utility_bill_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.utility_bill
  FOR EACH ROW EXECUTE FUNCTION eureka.facilities_write_guard();

-- Incharges: added and removed by definer functions; the server stamps who and when; never changed.
CREATE FUNCTION eureka.incharge_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' OR actor IS NULL THEN
    RAISE EXCEPTION '% rows are written only by definer functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% rows are not changed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.assigned_at := pg_catalog.now();
  NEW.assigned_by := actor;
  RETURN NEW;
END $$;
CREATE TRIGGER company_incharge_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.company_incharge
  FOR EACH ROW EXECUTE FUNCTION eureka.incharge_write_guard();
CREATE TRIGGER facility_incharge_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.facility_incharge
  FOR EACH ROW EXECUTE FUNCTION eureka.incharge_write_guard();

-- Company employees: added and ended (once) by definer functions; nothing else changes.
CREATE FUNCTION eureka.company_employee_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' OR actor IS NULL THEN
    RAISE EXCEPTION 'company_employee rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company_employee rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.end_date := NULL;
    NEW.ended_by := NULL;
    NEW.ended_at := NULL;
    NEW.created_by := actor;
    NEW.created_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.company_id, NEW.person_id, NEW.start_date, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.person_id, OLD.start_date, OLD.created_by, OLD.created_at)
     OR OLD.end_date IS NOT NULL OR NEW.end_date IS NULL THEN
    RAISE EXCEPTION 'a company assignment only ends, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.ended_by := actor;
  NEW.ended_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER company_employee_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.company_employee
  FOR EACH ROW EXECUTE FUNCTION eureka.company_employee_write_guard();

CREATE FUNCTION eureka.facilities_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is not truncated', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER company_no_truncate BEFORE TRUNCATE ON eureka.company FOR EACH STATEMENT EXECUTE FUNCTION eureka.facilities_no_truncate();
CREATE TRIGGER facility_no_truncate BEFORE TRUNCATE ON eureka.facility FOR EACH STATEMENT EXECUTE FUNCTION eureka.facilities_no_truncate();
CREATE TRIGGER company_incharge_no_truncate BEFORE TRUNCATE ON eureka.company_incharge FOR EACH STATEMENT EXECUTE FUNCTION eureka.facilities_no_truncate();
CREATE TRIGGER facility_incharge_no_truncate BEFORE TRUNCATE ON eureka.facility_incharge FOR EACH STATEMENT EXECUTE FUNCTION eureka.facilities_no_truncate();
CREATE TRIGGER company_employee_no_truncate BEFORE TRUNCATE ON eureka.company_employee FOR EACH STATEMENT EXECUTE FUNCTION eureka.facilities_no_truncate();
CREATE TRIGGER utility_no_truncate BEFORE TRUNCATE ON eureka.utility FOR EACH STATEMENT EXECUTE FUNCTION eureka.facilities_no_truncate();
CREATE TRIGGER utility_bill_no_truncate BEFORE TRUNCATE ON eureka.utility_bill FOR EACH STATEMENT EXECUTE FUNCTION eureka.facilities_no_truncate();

-- document: the 0043 guard with the bill owner kind (internal types only, no placement).
CREATE OR REPLACE FUNCTION eureka.document_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE cls text;
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'document rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP IS DISTINCT FROM 'INSERT' THEN
    RAISE EXCEPTION 'document rows are not changed or deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.classification INTO cls FROM authz.document_type t WHERE t.key = NEW.doc_type;
  IF cls IS NULL OR NOT EXISTS (
       SELECT 1 FROM eureka.file_object f WHERE f.id = NEW.file_id AND f.classification = cls AND f.status = 'pending') THEN
    RAISE EXCEPTION 'document type and file do not match' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.placement_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM eureka.placement p WHERE p.id = NEW.placement_id AND p.candidate_id = NEW.candidate_id) THEN
    RAISE EXCEPTION 'placement belongs to another candidate' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.bill_id IS NOT NULL AND (cls IS DISTINCT FROM 'internal' OR NEW.candidate_id IS NOT NULL OR NEW.placement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a bill invoice is an internal document of the bill only' USING ERRCODE = 'check_violation';
  END IF;
  NEW.classification := cls;
  NEW.created_by := authz.current_user_id();
  NEW.created_at := pg_catalog.now();
  RETURN NEW;
END $$;

-- ---------- RLS ----------
ALTER TABLE eureka.company           ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.company           FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.facility          ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.facility          FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.company_incharge  ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.company_incharge  FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.facility_incharge ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.facility_incharge FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.company_employee  ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.company_employee  FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.utility           ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.utility           FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.utility_bill      ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.utility_bill      FORCE ROW LEVEL SECURITY;

-- Rule 3: the caller's location grants as InitPlans (a handful of ids), the
-- owner rows by primary key under their own policies.
CREATE POLICY company_read ON eureka.company FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('company:read'))
  OR location_id = ANY ((SELECT authz.location_ids('company:read'))::uuid[])
);
CREATE POLICY facility_read ON eureka.facility FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('facility:read'))
  OR location_id = ANY ((SELECT authz.location_ids('facility:read'))::uuid[])
);
-- Incharges and employee assignments are part of the owner: readable with it.
CREATE POLICY company_incharge_read ON eureka.company_incharge FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.company c WHERE c.id = company_incharge.company_id)
);
CREATE POLICY facility_incharge_read ON eureka.facility_incharge FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.facility f WHERE f.id = facility_incharge.facility_id)
);
CREATE POLICY company_employee_read ON eureka.company_employee FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.company c WHERE c.id = company_employee.company_id)
);
-- utility:read over the owner's location, and the owner readable.
CREATE POLICY utility_read ON eureka.utility FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.company c WHERE c.id = utility.company_id
           AND ((SELECT authz.has_org('utility:read')) OR c.location_id = ANY ((SELECT authz.location_ids('utility:read'))::uuid[])))
  OR EXISTS (SELECT 1 FROM eureka.facility f WHERE f.id = utility.facility_id
           AND ((SELECT authz.has_org('utility:read')) OR f.location_id = ANY ((SELECT authz.location_ids('utility:read'))::uuid[])))
);
-- bill:read over the owner's location, and the utility (hence the owner) readable.
CREATE POLICY utility_bill_read ON eureka.utility_bill FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.utility u WHERE u.id = utility_bill.utility_id AND (
    (SELECT authz.has_org('bill:read'))
    OR EXISTS (SELECT 1 FROM eureka.company c WHERE c.id = u.company_id
                AND c.location_id = ANY ((SELECT authz.location_ids('bill:read'))::uuid[]))
    OR EXISTS (SELECT 1 FROM eureka.facility f WHERE f.id = u.facility_id
                AND f.location_id = ANY ((SELECT authz.location_ids('bill:read'))::uuid[]))))
);
-- Invoices: readable with their bill (the candidate policy of 0043 never matches them).
CREATE POLICY document_bill_read ON eureka.document FOR SELECT TO eureka_app USING (
  bill_id IS NOT NULL AND EXISTS (SELECT 1 FROM eureka.utility_bill b WHERE b.id = document.bill_id)
);

CREATE POLICY definer_read   ON eureka.company FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.company FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.company FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.facility FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.facility FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.facility FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.company_incharge FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.company_incharge FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.company_incharge FOR DELETE TO authz_definer USING (true);
CREATE POLICY definer_read   ON eureka.facility_incharge FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.facility_incharge FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.facility_incharge FOR DELETE TO authz_definer USING (true);
CREATE POLICY definer_read   ON eureka.company_employee FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.company_employee FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.company_employee FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.utility FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.utility FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.utility FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.utility_bill FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.utility_bill FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.utility_bill FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);

-- The reveal and invoice download write their own audit rows (ids only); the
-- reveal limit counts the caller's reveal rows.
CREATE POLICY facilities_definer_audit ON eureka.audit_event FOR INSERT TO authz_definer WITH CHECK (
  actor_id IS NOT NULL AND actor_id = (SELECT authz.current_user_id())
  AND ((action = 'utility.password_revealed' AND entity_type = 'utility')
       OR (action = 'bill.invoice_downloaded' AND entity_type = 'utility_bill')));
CREATE POLICY utility_reveal_read ON eureka.audit_event FOR SELECT TO authz_definer
  USING (action = 'utility.password_revealed');

RESET ROLE;

REVOKE ALL ON eureka.company, eureka.facility, eureka.company_incharge, eureka.facility_incharge,
  eureka.company_employee, eureka.utility, eureka.utility_bill FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.facilities_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.incharge_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.company_employee_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.facilities_no_truncate() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.document_write_guard() FROM PUBLIC;

-- App: reads under RLS; no column privilege on the password ciphertext, its key or MAC.
GRANT SELECT ON eureka.company, eureka.facility, eureka.company_incharge, eureka.facility_incharge,
  eureka.company_employee, eureka.utility_bill TO eureka_app;
GRANT SELECT (id, company_id, facility_id, utility_type, service_provider, account_number, website_url, username,
  has_password, status, notes, row_version, created_by, created_at, updated_by, updated_at) ON eureka.utility TO eureka_app;

-- Definer: exactly what the functions below read and write.
GRANT SELECT, INSERT ON eureka.company, eureka.facility, eureka.company_employee, eureka.utility, eureka.utility_bill TO authz_definer;
GRANT SELECT, INSERT, DELETE ON eureka.company_incharge, eureka.facility_incharge TO authz_definer;
GRANT UPDATE (location_id, name, street, city, state, zip, country, status, notes, row_version, updated_by, updated_at)
  ON eureka.company TO authz_definer;
GRANT UPDATE (location_id, name, street, city, state, zip, country, owner_name, owner_email, owner_phone, rent, fee_frequency,
  capacity, beds, baths, start_date, end_date, status, notes, row_version, updated_by, updated_at)
  ON eureka.facility TO authz_definer;
GRANT UPDATE (end_date, ended_by, ended_at) ON eureka.company_employee TO authz_definer;
GRANT UPDATE (utility_type, service_provider, account_number, website_url, username, password_enc, password_key_id, password_mac,
  status, notes, row_version, updated_by, updated_at) ON eureka.utility TO authz_definer;
GRANT UPDATE (utility_id, payment_method, amount, billing_start, billing_end, due_date, paid_on, voided_at, voided_by, void_reason,
  invoice_document_id, row_version, updated_by, updated_at) ON eureka.utility_bill TO authz_definer;
GRANT SELECT (actor_id, action, at) ON eureka.audit_event TO authz_definer;
-- 0045 grants employee and 0011 person reads to the definer; repeated so this migration stands alone.
GRANT SELECT ON eureka.employee, eureka.person, eureka.candidate TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- p_perm covers p_location (org scope, or a location grant for it).
CREATE FUNCTION authz.location_allows(p_perm text, p_location uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_perm IS NOT NULL AND p_location IS NOT NULL
     AND coalesce(authz.has_org(p_perm) OR p_location = ANY (authz.location_ids(p_perm)), false)
$$;

-- The location of a company or facility (NULL when there is none).
CREATE FUNCTION authz.facilities_owner_location(p_kind text, p_owner uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'company'  THEN (SELECT c.location_id FROM eureka.company c WHERE c.id = p_owner)
    WHEN 'facility' THEN (SELECT f.location_id FROM eureka.facility f WHERE f.id = p_owner)
  END
$$;

-- Read-before-write in the database: the owner must exist and be readable
-- (<kind>:read and every p_reads permission over its location), else
-- not_found; p_manage (when given) must cover the location, else
-- not_permitted. Returns the location.
CREATE FUNCTION authz.facilities_scope(p_kind text, p_owner uuid, p_reads text[], p_manage text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE loc uuid; r text;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('company', 'facility') THEN
    RAISE EXCEPTION 'invalid_owner' USING ERRCODE = 'check_violation';
  END IF;
  loc := authz.facilities_owner_location(p_kind, p_owner);
  IF loc IS NULL OR NOT coalesce(authz.location_allows(p_kind || ':read', loc), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  FOREACH r IN ARRAY coalesce(p_reads, ARRAY[]::text[]) LOOP
    IF NOT coalesce(authz.location_allows(r, loc), false) THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
    END IF;
  END LOOP;
  IF p_manage IS NOT NULL AND NOT coalesce(authz.location_allows(p_manage, loc), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN loc;
END $$;

-- An active user holding a current role at the location (incharge candidates).
CREATE FUNCTION authz.facilities_location_user(p_location uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_location IS NOT NULL AND p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
     WHERE u.id = p_user AND u.status = 'active' AND ur.location_id = p_location AND ur.valid @> pg_catalog.now())
$$;

-- A location may be the target of a create or move: it exists and p_manage covers it.
CREATE FUNCTION authz.facilities_target_location(p_location uuid, p_manage text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_location IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.location l WHERE l.id = p_location) THEN
    RAISE EXCEPTION 'invalid_location' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(authz.location_allows(p_manage, p_location), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- ---- companies ----
CREATE FUNCTION authz.company_create(
  p_location uuid, p_name text, p_street text, p_city text, p_state text, p_zip text, p_country text, p_notes text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM authz.facilities_target_location(p_location, 'company:manage');
  BEGIN
    INSERT INTO eureka.company AS c (location_id, name, street, city, state, zip, country, notes, created_by, updated_by)
    VALUES (p_location, p_name, p_street, p_city, p_state, p_zip, coalesce(p_country, 'USA'), p_notes,
            authz.current_user_id(), authz.current_user_id())
    RETURNING c.id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'name_taken' USING ERRCODE = 'unique_violation';
  END;
  RETURN v_id;
END $$;

-- Replaces the editable fields (the API merges a partial update first).
-- Moving to another location needs company:manage there too, and no incharges
-- or open employee assignments (they are bound to the location).
CREATE FUNCTION authz.company_update(
  p_id uuid, p_row_version integer, p_location uuid, p_name text, p_street text, p_city text, p_state text, p_zip text,
  p_country text, p_status text, p_notes text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur eureka.company%ROWTYPE; out_version integer;
BEGIN
  PERFORM authz.facilities_scope('company', p_id, NULL, 'company:manage');
  SELECT * INTO cur FROM eureka.company c WHERE c.id = p_id FOR UPDATE;
  IF p_row_version IS NULL OR p_row_version IS DISTINCT FROM cur.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  IF p_location IS DISTINCT FROM cur.location_id THEN
    PERFORM authz.facilities_target_location(p_location, 'company:manage');
    IF EXISTS (SELECT 1 FROM eureka.company_incharge i WHERE i.company_id = p_id)
       OR EXISTS (SELECT 1 FROM eureka.company_employee e WHERE e.company_id = p_id AND e.end_date IS NULL) THEN
      RAISE EXCEPTION 'location_in_use' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  BEGIN
    UPDATE eureka.company c
       SET location_id = p_location, name = p_name, street = p_street, city = p_city, state = p_state, zip = p_zip,
           country = coalesce(p_country, 'USA'), status = p_status, notes = p_notes
     WHERE c.id = p_id RETURNING c.row_version INTO out_version;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'name_taken' USING ERRCODE = 'unique_violation';
  END;
  RETURN out_version;
END $$;

-- ---- facilities ----
CREATE FUNCTION authz.facility_create(
  p_location uuid, p_name text, p_street text, p_city text, p_state text, p_zip text, p_country text,
  p_owner_name text, p_owner_email text, p_owner_phone text, p_rent numeric, p_fee_frequency text,
  p_capacity integer, p_beds integer, p_baths numeric, p_start date, p_end date, p_notes text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM authz.facilities_target_location(p_location, 'facility:manage');
  BEGIN
    INSERT INTO eureka.facility AS f (location_id, name, street, city, state, zip, country, owner_name, owner_email, owner_phone,
                                      rent, fee_frequency, capacity, beds, baths, start_date, end_date, notes, created_by, updated_by)
    VALUES (p_location, p_name, p_street, p_city, p_state, p_zip, coalesce(p_country, 'USA'), p_owner_name, p_owner_email, p_owner_phone,
            p_rent, p_fee_frequency, p_capacity, p_beds, p_baths, p_start, p_end, p_notes,
            authz.current_user_id(), authz.current_user_id())
    RETURNING f.id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'name_taken' USING ERRCODE = 'unique_violation';
  END;
  RETURN v_id;
END $$;

CREATE FUNCTION authz.facility_update(
  p_id uuid, p_row_version integer, p_location uuid, p_name text, p_street text, p_city text, p_state text, p_zip text,
  p_country text, p_owner_name text, p_owner_email text, p_owner_phone text, p_rent numeric, p_fee_frequency text,
  p_capacity integer, p_beds integer, p_baths numeric, p_start date, p_end date, p_status text, p_notes text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur eureka.facility%ROWTYPE; out_version integer;
BEGIN
  PERFORM authz.facilities_scope('facility', p_id, NULL, 'facility:manage');
  SELECT * INTO cur FROM eureka.facility f WHERE f.id = p_id FOR UPDATE;
  IF p_row_version IS NULL OR p_row_version IS DISTINCT FROM cur.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  IF p_location IS DISTINCT FROM cur.location_id THEN
    PERFORM authz.facilities_target_location(p_location, 'facility:manage');
    IF EXISTS (SELECT 1 FROM eureka.facility_incharge i WHERE i.facility_id = p_id) THEN
      RAISE EXCEPTION 'location_in_use' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  BEGIN
    UPDATE eureka.facility f
       SET location_id = p_location, name = p_name, street = p_street, city = p_city, state = p_state, zip = p_zip,
           country = coalesce(p_country, 'USA'), owner_name = p_owner_name, owner_email = p_owner_email,
           owner_phone = p_owner_phone, rent = p_rent, fee_frequency = p_fee_frequency, capacity = p_capacity,
           beds = p_beds, baths = p_baths, start_date = p_start, end_date = p_end, status = p_status, notes = p_notes
     WHERE f.id = p_id RETURNING f.row_version INTO out_version;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'name_taken' USING ERRCODE = 'unique_violation';
  END;
  RETURN out_version;
END $$;

-- ---- incharges (company or facility) ----
CREATE FUNCTION authz.incharge_add(p_kind text, p_owner uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE loc uuid;
BEGIN
  loc := authz.facilities_scope(p_kind, p_owner, NULL, p_kind || ':manage');
  IF NOT coalesce(authz.facilities_location_user(loc, p_user), false) THEN
    RAISE EXCEPTION 'invalid_incharge' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind = 'company' THEN
    INSERT INTO eureka.company_incharge (company_id, user_id, assigned_by) VALUES (p_owner, p_user, authz.current_user_id())
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO eureka.facility_incharge (facility_id, user_id, assigned_by) VALUES (p_owner, p_user, authz.current_user_id())
    ON CONFLICT DO NOTHING;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'already_incharge' USING ERRCODE = 'unique_violation';
  END IF;
END $$;

CREATE FUNCTION authz.incharge_remove(p_kind text, p_owner uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM authz.facilities_scope(p_kind, p_owner, NULL, p_kind || ':manage');
  IF p_kind = 'company' THEN
    DELETE FROM eureka.company_incharge i WHERE i.company_id = p_owner AND i.user_id = p_user;
  ELSE
    DELETE FROM eureka.facility_incharge i WHERE i.facility_id = p_owner AND i.user_id = p_user;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- ---- company employees ----
-- An employee (not exited) whose candidate is in the company's location and
-- who has no open company assignment; the start is not before the end of
-- their previous assignment.
CREATE FUNCTION authz.company_employee_add(p_company uuid, p_person uuid, p_start date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE loc uuid; v_id uuid;
BEGIN
  loc := authz.facilities_scope('company', p_company, NULL, 'company:manage');
  IF p_person IS NULL OR NOT EXISTS (
       SELECT 1 FROM eureka.employee e JOIN eureka.candidate c ON c.id = e.candidate_id
        WHERE e.person_id = p_person AND e.status IS DISTINCT FROM 'exited' AND c.location_id = loc) THEN
    RAISE EXCEPTION 'invalid_employee' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company_employee:' || p_person::text, 0));
  IF EXISTS (SELECT 1 FROM eureka.company_employee x WHERE x.person_id = p_person AND x.end_date IS NULL) THEN
    RAISE EXCEPTION 'employee_assigned' USING ERRCODE = 'unique_violation';
  END IF;
  IF p_start IS NULL OR EXISTS (SELECT 1 FROM eureka.company_employee x WHERE x.person_id = p_person AND x.end_date > p_start) THEN
    RAISE EXCEPTION 'invalid_start_date' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.company_employee AS x (company_id, person_id, start_date, created_by)
  VALUES (p_company, p_person, p_start, authz.current_user_id())
  RETURNING x.id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION authz.company_employee_end(p_company uuid, p_person uuid, p_end date) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r eureka.company_employee%ROWTYPE;
BEGIN
  PERFORM authz.facilities_scope('company', p_company, NULL, 'company:manage');
  SELECT * INTO r FROM eureka.company_employee x
   WHERE x.company_id = p_company AND x.person_id = p_person AND x.end_date IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_end IS NULL OR NOT coalesce(p_end >= r.start_date, false) THEN
    RAISE EXCEPTION 'invalid_end_date' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.company_employee x SET end_date = p_end WHERE x.id = r.id;
  RETURN r.start_date;
END $$;

-- The company's employee assignments with names and employment status
-- (eureka.employee itself is org-scoped; B4.4). company:read over the company.
CREATE FUNCTION authz.company_employees(p_company uuid)
RETURNS TABLE (person_id uuid, first_name text, last_name text, start_date date, end_date date, employee_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM authz.facilities_scope('company', p_company, NULL, NULL);
  RETURN QUERY
  SELECT x.person_id, p.first_name, p.last_name, x.start_date, x.end_date, e.status
    FROM eureka.company_employee x
    JOIN eureka.person p ON p.id = x.person_id
    LEFT JOIN eureka.employee e ON e.person_id = x.person_id
   WHERE x.company_id = p_company
   ORDER BY (x.end_date IS NULL) DESC, x.start_date DESC, x.person_id
   LIMIT 1000;
END $$;

-- Employees that may be added (company:manage): see company_employee_add.
CREATE FUNCTION authz.company_employee_options(p_company uuid, p_q text, p_limit integer)
RETURNS TABLE (person_id uuid, first_name text, last_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE loc uuid; q text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_q, '')));
BEGIN
  loc := authz.facilities_scope('company', p_company, NULL, 'company:manage');
  RETURN QUERY
  SELECT e.person_id, p.first_name, p.last_name
    FROM eureka.employee e
    JOIN eureka.candidate c ON c.id = e.candidate_id
    JOIN eureka.person p ON p.id = e.person_id
   WHERE c.location_id = loc AND e.status IS DISTINCT FROM 'exited'
     AND NOT EXISTS (SELECT 1 FROM eureka.company_employee x WHERE x.person_id = e.person_id AND x.end_date IS NULL)
     AND (q = '' OR pg_catalog.strpos(pg_catalog.lower(p.first_name || ' ' || p.last_name), q) > 0)
   ORDER BY p.first_name, p.last_name, e.person_id
   LIMIT LEAST(GREATEST(coalesce(p_limit, 20), 1), 50);
END $$;

-- ---- utilities ----
-- A new password: a utility_password key, a header naming that key's version, a 32-byte MAC.
CREATE FUNCTION authz.utility_check_password(p_enc bytea, p_key uuid, p_mac bytea) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (p_enc IS NULL) IS DISTINCT FROM (p_key IS NULL) OR (p_enc IS NULL) IS DISTINCT FROM (p_mac IS NULL) THEN
    RAISE EXCEPTION 'invalid_password' USING ERRCODE = 'check_violation';
  END IF;
  IF p_key IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM eureka.field_key k WHERE k.id = p_key AND k.field_class = 'utility_password')
       OR NOT coalesce(authz.field_header_matches(p_enc, p_key), false)
       OR octet_length(p_mac) IS DISTINCT FROM 32) THEN
    RAISE EXCEPTION 'invalid_password' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- The id comes from the API because the ciphertext is bound to it.
CREATE FUNCTION authz.utility_create(
  p_id uuid, p_kind text, p_owner uuid, p_type text, p_provider text, p_account text, p_url text, p_username text,
  p_enc bytea, p_key uuid, p_mac bytea, p_notes text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM authz.facilities_scope(p_kind, p_owner, ARRAY['utility:read'], 'utility:manage');
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_utility' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM authz.utility_check_password(p_enc, p_key, p_mac);
  INSERT INTO eureka.utility (id, company_id, facility_id, utility_type, service_provider, account_number, website_url, username,
                              password_enc, password_key_id, password_mac, notes, created_by, updated_by)
  VALUES (p_id, CASE WHEN p_kind = 'company' THEN p_owner END, CASE WHEN p_kind = 'facility' THEN p_owner END,
          p_type, p_provider, p_account, p_url, p_username, p_enc, p_key, p_mac, p_notes,
          authz.current_user_id(), authz.current_user_id());
  RETURN 1;
END $$;

-- The owner of a utility as (kind, id); no row when the utility does not exist.
CREATE FUNCTION authz.utility_owner(p_utility uuid) RETURNS TABLE (kind text, owner uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN u.company_id IS NOT NULL THEN 'company' ELSE 'facility' END, coalesce(u.company_id, u.facility_id)
    FROM eureka.utility u WHERE u.id = p_utility
$$;

-- p_set_password false keeps the stored password; true with NULLs clears it.
CREATE FUNCTION authz.utility_update(
  p_id uuid, p_row_version integer, p_type text, p_provider text, p_account text, p_url text, p_username text,
  p_set_password boolean, p_enc bytea, p_key uuid, p_mac bytea, p_status text, p_notes text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o record; cur eureka.utility%ROWTYPE; out_version integer;
BEGIN
  SELECT * INTO o FROM authz.utility_owner(p_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM authz.facilities_scope(o.kind, o.owner, ARRAY['utility:read'], 'utility:manage');
  SELECT * INTO cur FROM eureka.utility u WHERE u.id = p_id FOR UPDATE;
  IF p_row_version IS NULL OR p_row_version IS DISTINCT FROM cur.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  IF p_set_password IS NULL THEN
    RAISE EXCEPTION 'invalid_utility' USING ERRCODE = 'check_violation';
  END IF;
  IF p_set_password THEN
    PERFORM authz.utility_check_password(p_enc, p_key, p_mac);
    UPDATE eureka.utility u
       SET utility_type = p_type, service_provider = p_provider, account_number = p_account, website_url = p_url,
           username = p_username, password_enc = p_enc, password_key_id = p_key, password_mac = p_mac,
           status = p_status, notes = p_notes
     WHERE u.id = p_id RETURNING u.row_version INTO out_version;
  ELSE
    UPDATE eureka.utility u
       SET utility_type = p_type, service_provider = p_provider, account_number = p_account, website_url = p_url,
           username = p_username, status = p_status, notes = p_notes
     WHERE u.id = p_id RETURNING u.row_version INTO out_version;
  END IF;
  RETURN out_version;
END $$;

-- Records one reveal and returns the ciphertext and MAC for the API to decrypt
-- and verify. utility.secret:read over the owner's location (and the utility
-- readable), a live step-up grant of the caller's own session, at most 20
-- reveals per user per minute and 200 per day across all API tasks; the audit
-- row (ids only, never the password) is written here, before decryption.
CREATE FUNCTION authz.utility_password_reveal(p_id uuid, p_session bytea)
RETURNS TABLE (enc bytea, mac bytea, step_up_grant uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_user_id(); o record; u eureka.utility%ROWTYPE; g uuid;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO o FROM authz.utility_owner(p_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM authz.facilities_scope(o.kind, o.owner, ARRAY['utility:read'], 'utility.secret:read');
  SELECT * INTO u FROM eureka.utility x WHERE x.id = p_id;
  IF u.password_enc IS NULL THEN
    RAISE EXCEPTION 'no_password' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.grant_id INTO g FROM authz.step_up_current(p_session) s;
  IF g IS NULL THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('utility_reveal:' || me::text, 0));
  IF (SELECT pg_catalog.count(*) FROM eureka.audit_event a
       WHERE a.actor_id = me AND a.action = 'utility.password_revealed'
         AND a.at > pg_catalog.now() - interval '1 minute') >= 20
     OR (SELECT pg_catalog.count(*) FROM eureka.audit_event a
       WHERE a.actor_id = me AND a.action = 'utility.password_revealed'
         AND a.at > pg_catalog.now() - interval '1 day') >= 200 THEN
    RAISE EXCEPTION 'too_many_reveals' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (me, 'utility.password_revealed', 'utility', p_id,
          pg_catalog.jsonb_build_object('ownerKind', o.kind, 'ownerId', o.owner, 'stepUpGrantId', g));
  RETURN QUERY SELECT u.password_enc, u.password_mac, g;
END $$;

-- ---- bills ----
-- The utility must belong to the owner named in the URL.
CREATE FUNCTION authz.bill_create(
  p_kind text, p_owner uuid, p_utility uuid, p_method text, p_amount numeric, p_start date, p_end date, p_due date, p_paid date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM authz.facilities_scope(p_kind, p_owner, ARRAY['utility:read', 'bill:read'], 'bill:manage');
  IF p_utility IS NULL OR NOT EXISTS (
       SELECT 1 FROM eureka.utility u WHERE u.id = p_utility
          AND ((p_kind = 'company' AND u.company_id = p_owner) OR (p_kind = 'facility' AND u.facility_id = p_owner))) THEN
    RAISE EXCEPTION 'invalid_utility' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.utility_bill AS b (utility_id, payment_method, amount, billing_start, billing_end, due_date, paid_on,
                                        created_by, updated_by)
  VALUES (p_utility, p_method, p_amount, p_start, p_end, p_due, p_paid, authz.current_user_id(), authz.current_user_id())
  RETURNING b.id INTO v_id;
  RETURN v_id;
END $$;

-- A bill's owner (kind, id) through its utility, after the scope checks of
-- facilities_scope with bill:read (not_found) and p_manage (not_permitted).
CREATE FUNCTION authz.bill_scope(p_bill uuid, p_manage text) RETURNS TABLE (kind text, owner uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o record;
BEGIN
  SELECT x.kind, x.owner INTO o FROM eureka.utility_bill b, authz.utility_owner(b.utility_id) x WHERE b.id = p_bill;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM authz.facilities_scope(o.kind, o.owner, ARRAY['utility:read', 'bill:read'], p_manage);
  RETURN QUERY SELECT o.kind, o.owner;
END $$;

CREATE FUNCTION authz.bill_update(
  p_id uuid, p_row_version integer, p_utility uuid, p_method text, p_amount numeric, p_start date, p_end date, p_due date, p_paid date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o record; cur eureka.utility_bill%ROWTYPE; out_version integer;
BEGIN
  SELECT * INTO o FROM authz.bill_scope(p_id, 'bill:manage');
  SELECT * INTO cur FROM eureka.utility_bill b WHERE b.id = p_id FOR UPDATE;
  IF cur.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'bill_voided' USING ERRCODE = 'check_violation';
  END IF;
  IF p_row_version IS NULL OR p_row_version IS DISTINCT FROM cur.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  IF p_utility IS NULL OR NOT EXISTS (
       SELECT 1 FROM eureka.utility u WHERE u.id = p_utility
          AND ((o.kind = 'company' AND u.company_id = o.owner) OR (o.kind = 'facility' AND u.facility_id = o.owner))) THEN
    RAISE EXCEPTION 'invalid_utility' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.utility_bill b
     SET utility_id = p_utility, payment_method = p_method, amount = p_amount, billing_start = p_start,
         billing_end = p_end, due_date = p_due, paid_on = p_paid
   WHERE b.id = p_id RETURNING b.row_version INTO out_version;
  RETURN out_version;
END $$;

-- "Delete" in the UI: the bill is voided (kept, excluded from lists and totals); final.
CREATE FUNCTION authz.bill_void(p_id uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur eureka.utility_bill%ROWTYPE; out_version integer;
BEGIN
  PERFORM authz.bill_scope(p_id, 'bill:manage');
  SELECT * INTO cur FROM eureka.utility_bill b WHERE b.id = p_id FOR UPDATE;
  IF cur.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'bill_voided' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR NOT coalesce(char_length(pg_catalog.btrim(p_reason)) BETWEEN 1 AND 500, false) THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.utility_bill b SET void_reason = pg_catalog.btrim(p_reason) WHERE b.id = p_id
  RETURNING b.row_version INTO out_version;
  RETURN out_version;
END $$;

-- Invoice upload (0043 pipeline): a pending internal document of the bill with
-- its file, made the bill's current invoice. bill:manage; at most three
-- uploads of the bill waiting for a scan.
CREATE FUNCTION authz.bill_invoice_upload(p_bill uuid, p_content_type text, p_size integer)
RETURNS TABLE (document_id uuid, file_id uuid, upload_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f_id uuid; f_exp timestamptz; d_id uuid;
BEGIN
  PERFORM authz.bill_scope(p_bill, 'bill:manage');
  IF EXISTS (SELECT 1 FROM eureka.utility_bill b WHERE b.id = p_bill AND b.voided_at IS NOT NULL) THEN
    RAISE EXCEPTION 'bill_voided' USING ERRCODE = 'check_violation';
  END IF;
  IF p_content_type IS NULL OR p_size IS NULL
     OR p_content_type NOT IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                               'image/png', 'image/jpeg')
     OR NOT coalesce(p_size BETWEEN 1 AND 15728640, false) THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bill_invoice:' || p_bill::text, 0));
  IF (SELECT pg_catalog.count(*) FROM eureka.document d JOIN eureka.file_object f ON f.id = d.file_id
       WHERE d.bill_id = p_bill AND f.status = 'pending') >= 3 THEN
    RAISE EXCEPTION 'too_many_pending' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.file_object AS f (classification, content_type, size_bytes, uploaded_by, upload_expires_at)
  VALUES ('internal', p_content_type, p_size, authz.current_user_id(), pg_catalog.now())
  RETURNING f.id, f.upload_expires_at INTO f_id, f_exp;
  INSERT INTO eureka.document AS d (candidate_id, placement_id, bill_id, doc_type, classification, file_id, created_by)
  VALUES (NULL, NULL, p_bill, 'other', 'internal', f_id, authz.current_user_id())
  RETURNING d.id INTO d_id;
  UPDATE eureka.utility_bill b SET invoice_document_id = d_id WHERE b.id = p_bill;
  RETURN QUERY SELECT d_id, f_id, f_exp;
END $$;

-- Authorizes one download of the bill's current invoice (bill:read) and logs
-- it (document_access + audit, same transaction). 'none' without an invoice,
-- 'not_available' while the file is not clean.
CREATE FUNCTION authz.bill_invoice_download(p_bill uuid)
RETURNS TABLE (outcome text, document_id uuid, file_id uuid, content_type text, access_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE d record; a_id uuid;
BEGIN
  PERFORM authz.bill_scope(p_bill, NULL);
  SELECT x.id, x.file_id, f.status, f.content_type INTO d
    FROM eureka.utility_bill b
    JOIN eureka.document x ON x.id = b.invoice_document_id AND x.bill_id = b.id
    JOIN eureka.file_object f ON f.id = x.file_id
   WHERE b.id = p_bill AND b.voided_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END IF;
  IF d.status IS DISTINCT FROM 'clean' THEN
    RETURN QUERY SELECT 'not_available'::text, d.id, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO eureka.document_access AS a (document_id, user_id, action, doc_type, classification, step_up_grant_id)
  VALUES (d.id, authz.current_user_id(), 'download', 'other', 'internal', NULL)
  RETURNING a.id INTO a_id;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'bill.invoice_downloaded', 'utility_bill', p_bill,
          pg_catalog.jsonb_build_object('documentId', d.id, 'fileId', d.file_id, 'accessId', a_id));
  RETURN QUERY SELECT 'ok'::text, d.id, d.file_id, d.content_type, a_id;
END $$;

-- ---- key rotation: field class utility_password (0042/0047 functions extended) ----
CREATE OR REPLACE FUNCTION authz.field_rotation_batch(p_class text, p_key uuid, p_after uuid, p_limit integer)
RETURNS TABLE (row_id uuid, enc bytea, key_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_class IS NULL OR p_class NOT IN ('work_auth_number', 'utility_password') THEN
    RAISE EXCEPTION 'unsupported field class' USING ERRCODE = 'check_violation';
  END IF;
  IF p_key IS NULL OR p_key IS DISTINCT FROM authz.field_key_newest(p_class) THEN
    RAISE EXCEPTION 'not_current_key' USING ERRCODE = 'check_violation';
  END IF;
  IF p_class = 'work_auth_number' THEN
    RETURN QUERY
    SELECT w.id, w.number_enc, w.number_key_id FROM eureka.work_authorization w
     WHERE w.number_enc IS NOT NULL AND w.number_key_id IS DISTINCT FROM p_key
       AND (p_after IS NULL OR w.id > p_after)
     ORDER BY w.id
     LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 500);
  ELSE
    RETURN QUERY
    SELECT u.id, u.password_enc, u.password_key_id FROM eureka.utility u
     WHERE u.password_enc IS NOT NULL AND u.password_key_id IS DISTINCT FROM p_key
       AND (p_after IS NULL OR u.id > p_after)
     ORDER BY u.id
     LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 500);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION authz.field_rotation_apply(p_class text, p_row uuid, p_old_enc bytea, p_new_enc bytea, p_new_key uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE new_version integer; old_version integer; old_key uuid;
BEGIN
  IF p_class IS NULL OR p_class NOT IN ('work_auth_number', 'utility_password') THEN
    RAISE EXCEPTION 'unsupported field class' USING ERRCODE = 'check_violation';
  END IF;
  IF p_row IS NULL OR p_old_enc IS NULL OR p_new_enc IS NULL
     OR p_new_key IS NULL OR p_new_key IS DISTINCT FROM authz.field_key_newest(p_class) THEN
    RAISE EXCEPTION 'not_current_key' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(authz.field_header_matches(p_new_enc, p_new_key), false) THEN
    RAISE EXCEPTION 'invalid_ciphertext' USING ERRCODE = 'check_violation';
  END IF;
  SELECT k.version INTO new_version FROM eureka.field_key k WHERE k.id = p_new_key;
  IF p_class = 'work_auth_number' THEN
    SELECT k.version, k.id INTO old_version, old_key FROM eureka.field_key k
      JOIN eureka.work_authorization w ON w.number_key_id = k.id WHERE w.id = p_row;
  ELSE
    SELECT k.version, k.id INTO old_version, old_key FROM eureka.field_key k
      JOIN eureka.utility u ON u.password_key_id = k.id WHERE u.id = p_row;
  END IF;
  IF old_version IS NULL OR NOT coalesce(new_version > old_version, false) THEN
    RETURN false;
  END IF;
  IF p_class = 'work_auth_number' THEN
    UPDATE eureka.work_authorization w SET number_enc = p_new_enc, number_key_id = p_new_key
     WHERE w.id = p_row AND w.number_enc = p_old_enc;
  ELSE
    UPDATE eureka.utility u SET password_enc = p_new_enc, password_key_id = p_new_key
     WHERE u.id = p_row AND u.password_enc = p_old_enc;
  END IF;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO eureka.field_rotation_log (field_class, row_id, from_key, to_key) VALUES (p_class, p_row, old_key, p_new_key);
  RETURN true;
END $$;

RESET ROLE;

-- Rule 2: no PUBLIC execute; the app gets exactly the functions the API calls;
-- the worker keeps the rotation functions it already had (0042/0047).
REVOKE ALL ON FUNCTION authz.location_allows(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.facilities_owner_location(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.facilities_scope(text, uuid, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.facilities_location_user(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.facilities_target_location(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.company_create(uuid, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.company_update(uuid, integer, uuid, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.facility_create(uuid, text, text, text, text, text, text, text, text, text, numeric, text, integer, integer, numeric, date, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.facility_update(uuid, integer, uuid, text, text, text, text, text, text, text, text, text, numeric, text, integer, integer, numeric, date, date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.incharge_add(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.incharge_remove(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.company_employee_add(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.company_employee_end(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.company_employees(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.company_employee_options(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.utility_check_password(bytea, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.utility_create(uuid, text, uuid, text, text, text, text, text, bytea, uuid, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.utility_owner(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.utility_update(uuid, integer, text, text, text, text, text, boolean, bytea, uuid, bytea, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.utility_password_reveal(uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.bill_create(text, uuid, uuid, text, numeric, date, date, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.bill_scope(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.bill_update(uuid, integer, uuid, text, numeric, date, date, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.bill_void(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.bill_invoice_upload(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.bill_invoice_download(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.field_rotation_batch(text, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.field_rotation_apply(text, uuid, bytea, bytea, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION authz.company_create(uuid, text, text, text, text, text, text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.company_update(uuid, integer, uuid, text, text, text, text, text, text, text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.facility_create(uuid, text, text, text, text, text, text, text, text, text, numeric, text, integer, integer, numeric, date, date, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.facility_update(uuid, integer, uuid, text, text, text, text, text, text, text, text, text, numeric, text, integer, integer, numeric, date, date, text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.incharge_add(text, uuid, uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.incharge_remove(text, uuid, uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.company_employee_add(uuid, uuid, date) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.company_employee_end(uuid, uuid, date) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.company_employees(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.company_employee_options(uuid, text, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.utility_create(uuid, text, uuid, text, text, text, text, text, bytea, uuid, bytea, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.utility_update(uuid, integer, text, text, text, text, text, boolean, bytea, uuid, bytea, text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.utility_password_reveal(uuid, bytea) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.bill_create(text, uuid, uuid, text, numeric, date, date, date, date) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.bill_update(uuid, integer, uuid, text, numeric, date, date, date, date) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.bill_void(uuid, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.bill_invoice_upload(uuid, text, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.bill_invoice_download(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.field_rotation_batch(text, uuid, uuid, integer) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.field_rotation_apply(text, uuid, bytea, bytea, uuid) TO eureka_worker;
-- location_allows, facilities_owner_location, facilities_scope, facilities_location_user,
-- facilities_target_location, utility_check_password, utility_owner and bill_scope are
-- called from definer functions only.
