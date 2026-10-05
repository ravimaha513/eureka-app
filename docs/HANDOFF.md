# Handoff: state of Eureka and next tasks

Updated 2026-09-30. Read this first, then `docs/design.md`, `docs/implementation-plan.md`,
`docs/admin-api.md` and `docs/placements-api.md`.

## How to work in this repo

- `pnpm local` runs everything locally (Docker Postgres on 55432, seed, API :3000, web :5173).
- `pnpm -r typecheck` and `pnpm -r test` must pass before every commit (integration tests need
  PostgreSQL 16 at `TEST_PG_ADMIN_URL`, default `postgres://postgres:postgres@127.0.0.1:5432`).
- Browser journeys: `pnpm --filter @eureka/web e2e` against a running, freshly seeded stack.
- Migrations are append-only (`db/migrations/00NN_*.sql`, next is **0055**; 0040 and 0049 are unused) and must apply as a
  non-superuser (Amazon RDS master): CI checks this.
- Commit small and atomic; get an independent review of every security-relevant change.

### Rules the reviews kept enforcing (do not regress)

1. Every plpgsql `IF` must be NULL-safe (`coalesce`, `IS DISTINCT FROM`, explicit `x IS NULL OR`).
2. Every function in schemas `authz`/`eureka`: `REVOKE ALL ... FROM PUBLIC`, pinned
   `SET search_path = pg_catalog, pg_temp`, EXECUTE granted to exactly the role that needs it.
3. RLS read policies never call definer functions per row; use
   `col = ANY ((SELECT authz.x('perm'))::uuid[])` (InitPlan) for small sets (user, team, location
   ids), `col IN (SELECT pg_catalog.unnest((SELECT authz.x('perm'))))` (InitPlan feeding a hashed
   SubPlan: one hash probe per row) for large sets such as `owned_candidate_ids` (0034/0038; `= ANY`
   searches the array linearly per row), and `EXISTS` by primary key.
4. Clients never set server-managed columns (status, snapshots, timestamps): BEFORE INSERT guards.
5. No rates, phones, emails, free-text reasons or recording links in `audit_event` or `outbox_event`.
6. Writes to sensitive tables only through SECURITY DEFINER functions that re-check permission
   and scope in the database; the API checks too (read-before-write: 404 if not visible, 403 if not allowed).
7. Least privilege: `org_admin` holds no business role; restricted and org-wide-sensitive roles
   need a second approver; the worker role cannot become the API role.
8. E2E: form labels wrap their `<select>`, so address dropdowns with
   `getByRole("combobox", { name, exact: true })`, not `getByLabel(..., { exact: true })`.

## Built (on main, CI green)

- Sign-in (Google OIDC + dev sign-in), sessions, CSRF, 16-role RBAC enforced in API and RLS.
- Users & Access admin (roles with second approver, teams, reporting lines, team moves).
- Hot List (open to everyone, masked phones), candidates, profile with per-record `actions`.
- Submissions: state machine, duplicate warning, Submissions screen.
- Interviews: board API + screen, conflict check, consent, feedback; candidate feedback email
  (worker job) and public feedback form.
- Placements: schema (0022/0023), state machine, first-placement, assignments, outbox rows,
  idempotency keys, Placements screen and Create placement dialog; lookups with least privilege.
- Phase 2 audit and gap fixes (`docs/phase2-status.md`, migration 0035): paperwork checklist created with
  the placement from `authz.checklist_template` (no template content yet: open question), profile read-back of
  in-person preference and marketing contacts, interview board location filter, audited 90-day duplicate answer.
- Worker: lease-based job runner, nightly audit export to Object Lock storage.
- Outbox delivery (0024): placement events emailed to HR, Accounts, Immigration (one email per user per
  event, `outbox_delivery` dedupe marker, in-doubt never resent), daily prune of published rows
  (`OUTBOX_RETENTION_DAYS`, DB floor 7 days) and of Idempotency-Key rows older than 24 h. Enable with
  `OUTBOX_MAIL_MODE`, `OUTBOX_FROM_EMAIL`, `APP_PUBLIC_ORIGIN` (Terraform does not set them yet); set
  `OUTBOX_DELIVER_SINCE` on first enable. Hardening (0029): rejection cap (`failed`), lease-safe in-doubt,
  no-recipient alert, delete/truncate guards, job_run retention for outbox-delivery.
- Sheet migration (`docs/import.md`, migrations 0028, 0033, 0041 and 0054): CSV import CLI run as the
  `eureka_import` role (NOLOGIN outside the migration window, no role memberships). Normalizes and
  matches the Sales, interview and placement sheets into staging tables with a review queue and a
  reconciliation report. Tickets, review decisions and sign-off are authenticated API calls by org
  admins (`/api/v1/imports`, second person approves, digest-bound and expiring). Each person loads
  through `authz.import_load_person` (definer, same RLS checks, guards, transitions and audit as the
  API); a ledger with keyed hashes and natural keys keeps re-runs idempotent. The database verifies
  the rows before sign-off and the approver approves a per-row preview by its digest (0041).
  A batch's `source` (sheets/crewnex) and `historical` flag are fixed at stage, immutable and part
  of the digest (0054, CrewNex consolidation C1a.3); CrewNex batches dry-run but cannot be approved
  or committed until `policy_setting crewnex_commit = 'on'` (C1f).
  **Release note for 0054:** deploying it sends every approved-but-uncommitted import batch back to
  staged (its digest can never match again), so each needs a fresh second-admin approval; a partly
  loaded batch keeps its committed rows and loads the rest after re-approval. It also drops the
  4-argument `import_open_batch` (migrate task and CLI ship in one image).
  Append-only exception: the `GRANT eureka_app TO eureka_import` line was removed from 0028 after
  it was pushed, because no environment had applied it; 0033 revokes any copy and fails if it cannot.
- Resumes (FR-CAN-07, migration 0036, design B2.2 "Built in migration 0036"): presigned POST into
  `quarantine/resumes/<id>`, GuardDuty scan tag polled by the worker job `resume-scan`, size and
  magic-byte check, promotion to `clean/`, one current version per candidate, audited 60-second
  download links; `document:read`/`document:upload` over the candidate. Profile section in the web app.
  Without AWS: `LOCAL_STORAGE_DIR` (API serves a directory) and a fake scanner (EICAR = infected);
  `pnpm local` now runs the worker too.
- Paperwork progress and BGC (Phase 3, migration 0044, contract `docs/paperwork-api.md`): checklist items move
  `pending → received → verified` / `waived` (reason) / back to `pending` (returned or reopened, reason) with owner role,
  assignee (must hold the owner role), due date, notes and a document link, only through `authz.update_checklist_item`
  (receive/notes need `document:upload` or `document:verify`; everything else `document:verify`), with history rows.
  One BGC record per placement (`not_started → initiated → in_progress → cleared | failed`, `cleared → failed` after the
  fact) through `authz.update_bgc` (`bgc:update`, HR); `failPlacement` moves the placement to `bgc_failed` by calling
  `authz.transition_placement`, so its rules are not duplicated. Paperwork/BGC visibility is `document:read` over the
  placement (B4.4); items stay readable wherever the placement is. Templates are append-only versions (publish:
  `document:verify` at org scope); placements keep the version they copied. "Paperwork & BGC" screen (work queue,
  drawer, templates tab) and checklist progress + BGC status in the placement drawer. No template content ships; the dev
  seed publishes fictional `sample_form_*` templates.
  Document link (with 0043): `checklist_item.document_id REFERENCES eureka.document(id)`; `authz.update_checklist_item`
  accepts only a document of the item's candidate filed on no placement or on this placement, whose file is not blocked
  (`pending`/`clean`) and which the caller can read under the download rules (restricted documents only with
  `document.restricted:read`); anything else is 422 `invalid_document`. The item dialog has a document picker (the
  candidate's documents) and the drawer embeds the documents section for uploads.
  Item notes and reasons have no app column privilege: they are read through `authz.checklist_item_texts`
  (document:read over the placement), because items themselves stay readable to every `placement:read` holder.
  Overdue reminder (migration 0052): the daily worker job `paperwork-overdue` (07:30 New York) emits one
  `checklist.item_overdue` per outstanding item past its due date, once per item and due date (re-armed when the due
  date changes), through `authz.emit_paperwork_overdue` (the worker's only new grant); recipients per `docs/notifications.md`.
- Notifications (migration 0046, `docs/notifications.md`): in-app inbox (`notification`, own rows only, written by the
  worker; bell and panel in the web top bar, unread count polled every 60 s), outbox delivery generalised to typed
  events with recipients resolved in the database and email and/or inbox channels (placement emails unchanged; the
  inbox channel runs even with `OUTBOX_MAIL_MODE=disabled`), bench-time job (FR-NTF-05, off until
  `NOTIFY_BENCH_DAYS` is set; type `employee.bench_time`), inbox prune. Delivered producers: 0042
  `work_authorization.expiring`, 0045 `employee.benched` (project exit), `employee.exited`, `assignment.ending_soon`;
  `candidate.assigned` and `checklist.item_overdue` await their producers. The registry, not a payload's `notify`,
  decides recipients (shapes and rules in `docs/notifications.md`; `authz.notification_emit_once` for once-only reminders).
- Paperwork and restricted documents with step-up (FR-PPR-01 to 03, migration 0043, design B2.4 "Built in
  migration 0043"): typed documents on a candidate or placement (`document`, `file_object`, type keys in
  `authz.document_type` = `DOCUMENT_TYPES`), the resume scan pipeline generalised (`document-scan`), restricted
  files under `restricted/documents/` with the restricted KMS key, opened only by HR, Accounts and Immigration
  after a step-up of the session (Google `max_age=0`/`auth_time`, or the dev step-up behind `AUTH_MODE=dev` and
  the `dev_step_up` database switch), every opening in `document_access` and the audit export. Web: documents
  on the candidate profile and placement drawer, "Confirm it's you", access log. Add
  `/api/auth/step-up/callback` to the Google OAuth client's redirect URIs (infra/README.md).
- Field encryption and work authorization (FR-VIS-01 to 03, migration 0042, `docs/work-authorization-api.md`):
  AES-256-GCM envelope encryption with KMS data keys per field class (`eureka.field_key`, AAD = table, column,
  row id), local key provider for development (refused in production), blind index helper (separate KMS HMAC
  key `bidx`, `BIDX_KMS_KEY_ARN`), monthly `key-rotation` worker job. Work authorization records per person
  (number encrypted, masked; audited reveal needs the shared step-up of migration 0043), RLS read = `visa:read` over the
  candidate (HR, Immigration), writes through definer functions (`visa:update`, Immigration), `If-Match` on PATCH.
  Daily `visa-expiry` job inserts `work_authorization.expiring` outbox rows (90/60/30, ids and dates only);
  delivery and inbox belong to the notification jobs. Profile section in the web app. IAM: the task roles may use
  the restricted key directly only with the field encryption context (purpose `field`, the field classes each role
  needs, no other context keys); the restricted key's policy denies decrypt/data keys to every principal but the
  API and worker task roles and an optional break-glass role (`restricted_break_glass_role_arn`, default empty).
  The key-rotation worker can decrypt every value of the classes it rotates, by design (infra/README.md
  "Known risks"); it cannot forge one unnoticed (integrity MAC, 0047). Add `dob` to `api_field_classes` /
  `rotated_field_classes` in `infra/modules/stack/kms.tf` when DOB is written.
  Review follow-ups (migration 0047): rotation keys only for the current UTC month, an integrity MAC per number
  (blind index key, which the worker lacks) checked on every reveal, a rotation log with alerts, provider/key and
  header-version checks, reveal limits counted in the database (20/minute, 200/day). 0047 validates
  `number_mac` against existing rows: a local database holding numbers from before it needs a reseed.
  Left: DOB is not read or written anywhere (OD-04); when it is, encrypt with class `dob`, set `dob_bidx` with
  `dobBlindIndex`, add `dob` to the rotation job (definer functions like `work_auth_number`) and use the index in
  the duplicate check.
- AWS infra (~$30/month) and OIDC deploy workflow, never applied (see infra/README.md).
- First-admin bootstrap (migrations 0037, 0039): `dist/db/bootstrap.js` as a one-off migrate task creates two
  `org_admin` users for hosted-domain emails; break-glass only: refuses while an active `org_admin` exists
  (exit 3; idempotent for the same admins; after a first bootstrap a lock-out recovery needs `--recover`),
  audited as system without email; first Google sign-in links by email (the email must be in the domain).
  Optional `--demo-data` loads a fictional org (`@demo.invalid`, cannot sign in) only where `EUREKA_ENVIRONMENT`
  is `staging`/`local` and the stack has no real users or candidates.
  Runbook: infra/README.md "First admin (bootstrap)".

## Next tasks (Phase 2 to MVP), in suggested order

1. **(Done, see Built.) Outbox delivery job (worker):** grant the worker SELECT and UPDATE(published_at) on
   `outbox_event` with a narrow policy (the 0022 write guard currently blocks this); deliver
   `placement.created` / `placement.state_changed` to HR, Accounts and Immigration via SES; prune
   published rows after N days. Also a job deleting `idempotency_key` rows older than 24 h (add an index on created_at).
2. **Hot List extras:** saved views, bulk actions, export (capped, masked, audited).
3. **Candidate extras:** batches, `candidate_event` timeline, full duplicate check (email, phone;
   DOB blind index open), resumes (done, migration 0036).
4. **Dashboards:** manager, lead and location views with activity counts and "needs attention".
5. **Sheet migration:** built (see Built). Left: the SRS Q6 status/row-colour mapping, a decision
   on loading historical placements (`placements.commit`), weekly dry runs on real exports.
6. **Launch checks:** tooling is in place, nothing has been run against AWS yet.
   k6: `loadtest/` + `db:seed-load` (50k fictional candidates; minted sessions for stacks
   without dev sign-in). ZAP: manual `zap-baseline` workflow + `.zap/rules.tsv`. Restore drill:
   `infra/scripts/restore-drill.sh` + `dist/db/restore-check.js` (infra/README.md). First local
   k6 run does NOT pass: Hot List p95 ~720 ms, and the unfiltered submissions list for broad
   scopes (manager, location admin) takes ~2 s idle and hit the 5 s statement timeout under load
   (loadtest/README.md). Tuned since (0027 list-order indexes; 0034 hashed owned-candidate set in
   the activity read policies, custom-planned `authz.hotlist_page`): all three lists < 60 ms p95
   idle for manager, location admin and lead; 0038 does the same for placements/assignments and
   `authz.hotlist_export`. Local k6 re-run (120 VUs) now passes: p95 156 ms overall, Hot List
   113 ms, board 214 ms, 0% failed (loadtest/README.md). Next: run on staging (raise its WAF
   per-IP limit first).
7. ~~Fix older dialogs' focus after a failed submit~~ Done: Create candidate and Log submission
   use `useFocusAfterFailure` (sales/ui.tsx): after a validation or API error, focus goes to the
   first invalid field, else to the `role="alert"` form error. Use it in new forms too.

## Open product questions (ask Ravi, don't guess)

- Can recruiters see the rate on their own submissions/placements (they lack `rate:read`)?
- Can a submission skip steps? Should scheduling an interview advance the submission automatically?
- Placement: assignment start date = day marked `joined` or a user-entered date? Rate cap/unit for W2?
- May a candidate who failed BGC after joining be re-placed into the same job?
- Should the manual candidate edge `active → confirmation` be removed now that placements drive it?
- Does a pre-join `bgc_failed` count as an earlier placement for first-placement detection?
- Paperwork checklist content per placement type (documents, owner role, required), candidate `eligibility`
  fields, marketing locations and office: see `docs/phase2-status.md`.
- Paperwork and BGC (migration 0044; conservative defaults built, see `docs/paperwork-api.md`):
  - Who manages templates? Built: `document:verify` at org scope (HR, Immigration, Documents Team), no new permission.
    A dedicated permission (e.g. HR only) would be a catalog change.
  - Should items carry a default due date (e.g. N days after placement creation) in the template? Built: none, set by hand.
  - Item state machine: may a verifier jump `pending → verified` without "received"? May Accounts (no
    `document:upload`) update the items it owns? May recruiters mark items received (built: yes, `document:upload` own)?
  - BGC: the brief named statuses `requested/in_progress/clear/consider/failed`; design B2.4 says
    `not_started/initiated/in_progress/cleared/failed` (built). Is a vendor "consider" (needs adjudication) state needed?
    Allowed list for `education_level` (built: free text ≤ 60), is `bgc_company` a fixed vendor list or `legal_entity`?
    Can a failed check be re-run (built: `failed` is final)?
  - Should `bgc → ready` require a cleared BGC, and should HR recording `failed` move the placement to `bgc_failed`
    automatically? Built: neither (no gating; HR lacks `placement.bgc_status:update`, so a Manager/AD marks the placement;
    one request does both only for a user holding both rights).
  - Paperwork after `bgc_failed`/`joined`: built as still editable (closing out); only `backout` placements are frozen.
- Placement emails: should Associate HR (and the Lead/Manager, design C flow 3) also receive them, and may
  they name the candidate or client? Today: `hr`, `accounts`, `immigration` only, ids and statuses only.
- Sheet import (`docs/import.md`): status and row-colour mapping (SRS Q6); may historical
  placements emit outbox notifications; joined placements' assignment start date; who signs off a
  batch (org admin assumed); may the sheet set `all_teams` visibility without a lead?

- Resumes: today they follow `document:read` (B4.4), so a recruiter sees resumes of their own
  candidates only, not a teammate's, and Open-to-all-teams viewers, location roles, coaches and the
  CEO see none. Is that right for marketing (other teams submitting an open candidate need the resume)?
  How long are superseded versions kept (OD-03)? Should the uploader get an email when a file is blocked?

- Notifications (`docs/notifications.md`): FR-NTF-02 (what is a candidate "response", N, message to the candidate),
  the bench threshold (OD-05) and the "POC" recipient of FR-NTF-05, whether Associate HR is an "admin team" for
  project exit, recipients/channels of `assignment.ending_soon` (not in the design), per-user preferences (none in
  the design), and whether placement events should also reach the inbox.
- Documents (migration 0043): which paperwork document types exist besides the restricted I-9, driving
  license and work-authorization copies (today also `offer_letter`, `other`), and which are restricted (BGC
  reports? SSN cards? offer letters with rates?). May the Documents Team and Associate HR upload restricted
  documents they cannot open (today: no, upload needs `document.restricted:read`)? Should HR, Accounts and
  Immigration see each other's openings in the access log (today: yes, for restricted documents they can read;
  org admins see everything)? Should a recruiter see internal paperwork of their own candidates (today: yes,
  `document:read` own)? Retention of documents and of the access log (OD-03; I-9 federal minimum).
- Step-up: the Phase 0 spike must confirm Google honours `max_age=0`/`prompt=login` and returns `auth_time`;
  if not, the WebAuthn fallback and the 15-minute idle timeout for restricted roles (design A6.1) are needed.
  Should approving restricted role grants also require step-up (A6.1 lists it; not built)?
- Work authorization (migration 0042): who may see the records? Design B4.4 says `document:read` scope over the
  candidate (would include Documents Team, Associate HR, Accounts and Sales over their own candidates); built
  conservatively as `visa:read` only (HR, Immigration), number reveal also `visa:read`. Confirm the type list
  (placeholder: H-1B, H-4 EAD, L-1, L-2 EAD, F-1 OPT/STEM OPT/CPT, EAD, green card, TN, O-1, other), whether
  `valid_to` is required for some types, whether an "expired" notice (day 0) is wanted, and whether the
  expiry notices may name the candidate (today: ids and dates only).

- CrewNex consolidation: `docs/crewnex-consolidation.md` is the design of record (Eureka as system of record,
  strangler migration of the CrewNex app through the import pipeline); its 35 open questions (section 9) gate the first real-data dry run; every C1 increment can be built now on fixtures.

## Waiting on Ravi (not code)

- One-time AWS bootstrap, Google Workspace domain, Google OAuth client (infra/README.md).
- Confirm the 3-year COMPLIANCE audit lock before the first production deploy (cannot be shortened).
