-- MVP domain tables (design B2.2, B2.3). Every table holding personal data
-- gets RLS enabled and forced in 0005.
SET ROLE eureka_owner;
SET search_path = eureka, public;

CREATE TABLE technology (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name   text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE client (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

CREATE TABLE vendor (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

CREATE TABLE person (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  personal_email citext,
  phone_e164     text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  dob_enc        bytea,
  dob_bidx       bytea,
  dob_year       smallint,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE candidate (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id            uuid NOT NULL UNIQUE REFERENCES person(id),
  technology_id        uuid NOT NULL REFERENCES technology(id),
  team_id              uuid NOT NULL REFERENCES team(id),
  recruiter_id         uuid REFERENCES app_user(id),
  location_id          uuid NOT NULL REFERENCES location(id),
  gh_location_id       uuid REFERENCES location(id),
  marketing_status     text NOT NULL DEFAULT 'in_training' CHECK (marketing_status IN
    ('in_training','active','on_hold','stopped','full_of_interviews','confirmation','placed','bench','terminated')),
  visibility           text NOT NULL DEFAULT 'team' CHECK (visibility IN ('team','all_teams')),
  priority             text NOT NULL DEFAULT 'P2' CHECK (priority IN ('P1','P2','P3')),
  marketing_email      citext,
  vitel_number         text,
  marketing_start_date date,
  technical_rating     smallint CHECK (technical_rating BETWEEN 1 AND 5),
  in_person_ok         boolean,
  bench_since          date,
  row_version          int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX candidate_team ON candidate (team_id);
CREATE INDEX candidate_recruiter ON candidate (recruiter_id);
CREATE INDEX candidate_location ON candidate (location_id);
CREATE INDEX candidate_visibility ON candidate (visibility, marketing_status);

CREATE TABLE submission (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id               uuid NOT NULL REFERENCES candidate(id),
  recruiter_id               uuid NOT NULL REFERENCES app_user(id),  -- actor snapshot
  team_id                    uuid REFERENCES team(id),               -- actor's team snapshot
  location_id                uuid REFERENCES location(id),           -- candidate location snapshot
  submitted_at               timestamptz NOT NULL DEFAULT now(),
  job_title                  text NOT NULL,
  client_id                  uuid NOT NULL REFERENCES client(id),
  vendor_id                  uuid REFERENCES vendor(id),
  rate                       numeric(12,2) CHECK (rate > 0),
  status                     text NOT NULL DEFAULT 'submitted' CHECK (status IN
    ('submitted','under_review','interview_requested','interview_scheduled','interview_completed','selected','rejected','withdrawn')),
  rejection_reason           text
);
CREATE INDEX submission_dup ON submission (candidate_id, client_id, submitted_at);
CREATE INDEX submission_team ON submission (team_id);
CREATE INDEX submission_recruiter ON submission (recruiter_id);

CREATE TABLE interview (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id          uuid NOT NULL REFERENCES submission(id),
  candidate_id           uuid NOT NULL REFERENCES candidate(id),
  recruiter_id           uuid NOT NULL REFERENCES app_user(id),
  team_id                uuid REFERENCES team(id),
  location_id            uuid REFERENCES location(id),
  round                  text NOT NULL,
  starts_at              timestamptz NOT NULL,
  ends_at                timestamptz NOT NULL CHECK (ends_at > starts_at),
  coach_id               uuid REFERENCES app_user(id),
  invite_received        boolean NOT NULL DEFAULT false,
  call_status            text NOT NULL DEFAULT 'scheduled' CHECK (call_status IN
    ('scheduled','in_progress','completed','rescheduled','cancelled','no_invite')),
  cleared                boolean NOT NULL DEFAULT false,
  otter_url              text,
  recording_url          text,
  consent_captured       boolean NOT NULL DEFAULT false,
  feedback_email_sent_at timestamptz
);
CREATE INDEX interview_location_time ON interview (location_id, starts_at);
CREATE INDEX interview_team_time ON interview (team_id, starts_at);

CREATE TABLE audit_event (
  seq         bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  changes     jsonb,
  request_id  text,
  ip          inet
);

RESET ROLE;

GRANT SELECT ON technology, client, vendor TO eureka_app, eureka_worker;
GRANT SELECT, INSERT, UPDATE ON person, candidate, submission, interview TO eureka_app;
GRANT SELECT ON person, candidate, submission, interview TO authz_definer;
GRANT UPDATE (marketing_status, bench_since, updated_at, row_version) ON candidate TO authz_definer;
-- Audit is append-only for the app (design A6.4).
GRANT INSERT ON audit_event TO eureka_app, eureka_worker;
GRANT USAGE ON SEQUENCE audit_event_seq_seq TO eureka_app, eureka_worker;
