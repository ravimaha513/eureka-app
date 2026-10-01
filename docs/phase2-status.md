# Phase 2 (MVP) status

Audit of 2026-10-01 against `docs/implementation-plan.md` Phase 2 and `docs/design.md` (B2–B7, Part C),
done by reading the code and the tests. The SRS text is not in this repository, so each FR group is
traced through design Part C and the implementation plan's bullet for it; where the design names
columns or rules for a group they are listed as separate rows.

Status: **Built** (code and tests), **Partial** (some of it is missing; see Gap), **Missing**,
**Blocked** (waiting on an open decision or another workstream; not decided here).
Line numbers are as of this commit.

## Candidates and batches (FR-CAN-01..10)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| FR-CAN-01 person and candidate record, create | Built | `db/migrations/0003_domain.sql:22`, `apps/api/src/modules/candidates/candidates.service.ts:435`, `apps/web/src/sales/CreateCandidateDialog.tsx` | — |
| FR-CAN-02 batches (plan, status, assign, filter) | Built | `db/migrations/0026_candidate_extras.sql:28`, `db/migrations/0032_candidate_extras_review.sql:197`, `apps/api/test/candidate-extras.api.int.test.ts` | — |
| FR-CAN-03 technical rating (location roles) | Built | `candidates.service.ts:409`, `PUT /candidates/{id}/technical-rating` | — |
| FR-CAN-04 `in_person_ok` | Built (closed now) | write `candidates.schemas.ts:40`; read back on GET `candidates.service.ts:141`; profile and prefilled edit `apps/web/src/sales/CandidateProfile.tsx`, `EditProfileDialog.tsx`; tests `apps/api/test/phase2-gaps.api.int.test.ts`, `apps/web/src/sales/Sales.test.tsx` | Was write-only: the profile never showed it, so Edit profile could not show the current value. |
| FR-CAN-04 `eligibility jsonb` | Missing (needs spec) | column absent (`0003_domain.sql:34`) | The design names the column but not its content (which eligibility facts, values, who edits). Needs the SRS field list; not guessed. |
| FR-CAN-05/06 marketing fields: priority, marketing start date, marketing email, VITEL number | Built (closed now) | `candidates.schemas.ts:40`, `candidates.service.ts:381`; marketing email and VITEL now read back on GET under the phone rule (`candidates.service.ts:141`) | Marketing email and VITEL were write-only. |
| FR-CAN-05/06 `marketing_locations`, `office`, `gh_location_id` editing, `everify_entity_id`, `offer_letter_entity_id`, `entity_1099_id` | Missing (needs spec / Phase 3) | columns absent except `gh_location_id` (`0003_domain.sql`) | Meaning and edit rights of marketing locations and office are not specified; the entity ids need `legal_entity` (AS-09, Phase 3 paperwork). |
| FR-CAN-07 resumes | Blocked (other workstream) | design B2.2 "Not built" | Resume upload is handled by the resumes workstream (needs the document quarantine pipeline). |
| FR-CAN-08 visibility rules, Open to all teams | Built | `db/migrations/0005_rls.sql:12`, `packages/shared/src/authz/engine.ts`, `apps/api/test/rls.int.test.ts` | — |
| FR-CAN-09 duplicate check (email, phone) | Built | `0026_candidate_extras.sql:306` (rewritten in 0032), `candidates.controller.ts`, `apps/api/test/candidate-extras.*` | — |
| FR-CAN-09 duplicate check by DOB blind index | Blocked (OD-04) | design B2.2 "Not built" | Waits for OD-04 (DOB visibility) and KMS field encryption. |
| FR-CAN-10 `candidate_event` timeline | Built | `0026_candidate_extras.sql:50`, `candidates.controller.ts:42`, `apps/web/src/sales/CandidateTimeline.tsx` | — |

## Hot List (FR-HOT-01..07)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| List, open to everyone with masked phones (OD-01) | Built | `db/migrations/0011_hotlist_function.sql:42`, `candidates.service.ts` `openHotlist` | — |
| Filters (name, technology, status, visibility) | Built | `apps/web/src/sales/ListControls.tsx:8`, `HotlistQuery` in `candidates.schemas.ts` | No location, team, priority or rating filter. Left alone: the list-performance workstream is changing the Hot List query; add them after it lands. |
| Saved views | Built | `db/migrations/0025_hotlist_extras.sql:10`, `apps/web/src/sales/HotListExtras.tsx:34` | — |
| Bulk status / visibility | Built | `apps/api/src/modules/hotlist/hotlist.controller.ts:36`, `apps/api/test/hotlist-extras.api.int.test.ts` | — |
| Quick view | Built | `apps/web/src/sales/HotListPage.tsx:104` (drawer), `Sales.test.tsx` | — |
| Export (capped, masked, audited) | Built | `hotlist.controller.ts:51`, `apps/api/test/hotlist-extras.api.int.test.ts` | — |
| Field policy (phone, rating) | Built | design B4.5/B4.6, `0011_hotlist_function.sql` | — |
| p95 < 500 ms at 120 users / 50k candidates | Partial (other workstream) | `loadtest/README.md` | First k6 run fails (Hot List p95 ~720 ms); list-performance workstream. |

## Submissions (FR-SUB-01..06)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Log a submission (visible candidate, D-01) | Built | `apps/api/src/modules/submissions/submissions.service.ts`, `apps/web/src/sales/LogSubmissionDialog.tsx` | — |
| State machine via definer, reasons | Built | `db/migrations/0017_pipeline.sql:76`, `apps/api/test/pipeline.*.int.test.ts` | — |
| 90-day duplicate warning | Built (audit added now) | `db/migrations/0008_duplicate_check.sql:4`, `submissions.service.ts:186`, `LogSubmissionDialog.tsx:11`, `apps/api/test/api.int.test.ts:273`, `phase2-gaps.api.int.test.ts` | The answer was not in the audit (design B3: every duplicate check is audited); `submission.created` now records `duplicateWarning` (yes/no only). The warning comes with the create response, not before it. |
| Submissions screen, filters, rate field policy | Built | `apps/web/src/pipeline/SubmissionsPage.tsx:20` | Unfiltered list for broad scopes is slow (list-performance workstream). |
| Skipping steps; auto `interview_scheduled` on scheduling | Blocked (open question) | HANDOFF "Open product questions" | Not decided here. |
| Outbox rows for submission events | Missing (not required yet) | design B2.6 "Not yet done" | No consumer is specified for submission events. |

## Interview board (FR-INT-01..10)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Schedule from a submission, snapshots, invite received | Built | `apps/api/src/modules/interviews`, `apps/web/src/interviews/InterviewsPage.tsx` | — |
| Cleared toggle (location roles; server sets who/when) | Built | `interviews.schemas.ts:44`, `0017_pipeline.sql:130`, `apps/api/test/pipeline.api.int.test.ts:399` | — |
| Otter / recording links only with consent (AS-12) | Built | `0017_pipeline.sql:134`, `pipeline.api.int.test.ts:367`, board hides links without consent | — |
| Consent flag, system name (location roles) | Built | `interviews.schemas.ts:44` | — |
| Location admin and coach feedback; client feedback by Sales | Built | `0017_pipeline.sql:243`, `pipeline.api.int.test.ts:413`, `:432` | — |
| Conflict check (overlap per candidate, across teams) | Built | `0017_pipeline.sql:139`, `apps/api/src/modules/submissions/pipeline.ts:67`, `pipeline.api.int.test.ts:346` | — |
| Candidate feedback email 60 min after the interview, public form, notify recruiter and coach | Built | `apps/api/src/worker/jobs/feedback-email.ts:8`, `0021_candidate_feedback.sql:9`, `apps/web/src/feedback/PublicFeedback.tsx:14`, `apps/api/test/feedback.int.test.ts` | — |
| Board filters (dates, status, cleared, client history, location) | Built (location added now) | `InterviewsPage.tsx:123`, `phase2-gaps.api.int.test.ts`, `InterviewsPage.test.tsx` | The API had `locationId` but the board offered no location filter. A team filter still needs a team lookup list (none exists). |
| Coach sees coached teams only; location admin their location | Built | `pipeline.api.int.test.ts:197` | — |
| p95 < 500 ms on the board | Partial (other workstream) | `loadtest/` | Load results pending (performance workstream). |

## Placements (FR-PLC-01..07)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Placement form from a selected submission; contacts; numeric rate | Built | `db/migrations/0022_placements.sql:261`, `:38`, `apps/web/src/pipeline/CreatePlacementDialog.tsx:28` | — |
| Paperwork checklist created with the placement | Built (closed now), content Blocked | `db/migrations/0035_phase2_gaps.sql:71`, `:126`, `apps/api/src/modules/placements/placements.service.ts:190`, `apps/web/src/pipeline/PlacementsPage.tsx:229`; tests `apps/api/test/phase2-gaps.db.int.test.ts` (copy, validation, closed writes, RLS differential), `phase2-gaps.api.int.test.ts`, `Placements.test.tsx` | Mechanism built. No template content is shipped: which documents per placement type, their owner role and whether each is required is product data (question below). Until a template is added, placements get no checklist and the drawer says so. Item status changes and document links are Phase 3. |
| First-placement detection | Built | `0022_placements.sql:310` | Whether a pre-join `bgc_failed` counts is an open question. |
| State machine incl. `bgc_failed` after joining, assignment | Built | `0022_placements.sql:347`, `apps/api/test/placements.*.int.test.ts` | Assignment start date rule is an open question (built as the day marked joined). |
| Notifications to HR, Accounts, Immigration | Built | `0022_placements.sql:66`, `0024_outbox_delivery.sql:79`, `apps/api/src/worker/jobs/outbox.ts:303`, `apps/api/test/outbox.int.test.ts` | Lead/Manager/Associate HR recipients and naming the candidate are open questions. |
| Idempotency-Key on create | Built | `placements.service.ts`, `placements.api.int.test.ts` | — |
| `paperwork_entity_id` (legal entity) | Missing (Phase 3 dependency) | `legal_entity` table absent | Needs the `legal_entity` list (AS-09) and its values; Phase 3 paperwork. |

## Dashboards

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Manager, lead, location dashboards with activity counts | Built | `apps/api/src/modules/dashboard/dashboard.service.ts:120`, `apps/web/src/dashboard/DashboardPage.tsx:61`, `apps/api/test/dashboard.api.int.test.ts`, `docs/dashboards-api.md` | — |
| "Needs attention" lists | Built, thresholds Blocked | `dashboard.service.ts:171` | Thresholds are placeholders until OD-05. |

## Worker

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| `job_run` lease-based runner | Built | `db/migrations/0016_worker_jobs.sql:17`, `0020_worker_lease.sql:8`, `apps/api/test/worker.int.test.ts` | — |
| Outbox relay (placement events) and prune | Built | `apps/api/src/worker/jobs/outbox.ts`, migrations 0024, 0029 | — |
| Feedback-email job | Built | `apps/api/src/worker/jobs/feedback-email.ts` | — |
| SES integration | Built | `apps/api/src/worker/feedback-mail.ts`, `apps/api/test/ses-mail.test.ts` | Not yet enabled in Terraform for every setting (HANDOFF). |

## Data migration (listed for completeness)

Import pipeline, review queue and reconciliation are built (`docs/import.md`); the status/row-colour
mapping (SRS Q6), historical placements and sign-off questions are open; import hardening is another
workstream.

## Open product questions raised by this audit (ask Ravi, not decided here)

- **Paperwork checklist content:** for C2C, W2 and 1099 placements, which documents make up the
  paperwork checklist, which role owns each (HR, Accounts, Immigration, Documents Team, ...) and which
  are required? Answer goes into `authz.checklist_template` through a migration (`SET ROLE authz_definer;
  INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork', 'w2',
  '[{"doc_type":"offer_letter","owner_role":"hr","required":true}]')`); items are validated (snake_case
  document type, existing role key, boolean required, no other keys).
- **Candidate eligibility (FR-CAN-04):** which facts make up `eligibility` (work authorization type,
  relocation, travel, ...), with which values, and who may edit them?
- **Marketing locations and office (FR-CAN-05/06):** meaning, allowed values and who edits them.
- Field policy chosen for the marketing email and VITEL number on the profile: shown under the phone
  rule (`candidate.phone:read` over an owned candidate; never through Open to all teams). Confirm or
  widen.

Existing open questions in `docs/HANDOFF.md` (rates for recruiters, skipping submission steps, assignment
start date, re-placement after BGC failure, the manual `active → confirmation` edge, pre-join
`bgc_failed` and first placement, placement email recipients, import questions) and OD-04/OD-05 remain
open and are not touched by this work.
