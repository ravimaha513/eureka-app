# CrewNex consolidation into Eureka

Design of record for moving the CrewNex app's data and features into Eureka. Written 2026-10-04 (consolidation
Phase C0: documentation only; no code, no migrations, no connection to any CrewNex database or AWS account).

Phase names here carry a **C** prefix (C0, C1a, C2.3, ...) so they are not confused with the build phases of
`docs/implementation-plan.md`.

Sources read: Eureka `docs/HANDOFF.md`, `docs/design.md`, `docs/import.md`, `docs/implementation-plan.md`,
`packages/shared/src/authz/{catalog,state-machines}.ts`, `db/migrations/0003`, `0022`, `0041`, `0045`,
`infra/README.md` "Cost"; CrewNex `CLAUDE.md`, `prisma/schema.prisma` (commit `84bc7d5`), `docs/reference/*.md`,
`docs/Vendors.md`, `vercel.json`. CrewNex file and symbol names below refer to that commit.

## Assumption

**CrewNex and Eureka serve the same IT staffing firm** (owner's assumption, Q1). CrewNex's consultants are Eureka's
candidates; its offshore marketing chain is Eureka's Sales organisation; its onboarding companies are Eureka's
legal entities (AS-09). If this is wrong, nothing below applies: two firms would need `org_id` predicates in RLS
(design A10, AS-03) rather than a migration.

## 1. Decision

| | |
|---|---|
| **Decision** | Eureka is the system of record. CrewNex is retired by a **strangler migration**: one slice at a time is imported, reconciled, cut over and frozen in CrewNex; CrewNex keeps running, unchanged, for every slice not yet cut over. Exactly one system is the writer of a slice at any moment. |
| **Status** | Proposed (C0). Building can start now on fixtures; Ravi's answers to Q1–Q6 are needed before the first real-data dry run of C1b. |
| **Slices** | C1 marketing data (people, submissions, interviews, placements) cut over together at C1f; C2 feature ports one by one; C3 the LMS, after a decision. |
| **Commit model (D1)** | **Nothing is committed to Eureka production until the whole C1 chain is built and approved.** Every run during the overlap window is a **dry run** (`cli.ts commit` without `--commit`, always rolled back) plus a reconciliation report. There is exactly **one committed import**, at the C1f cutover, from the frozen CrewNex snapshot. Reason: committed rows in Eureka during the overlap would need update-in-place re-imports (a second write path into every table, with backwards status moves to arbitrate) and a read-only lock to stop Eureka users editing them; one final commit needs neither. |
| **After C1f (D7)** | The LMS stays in CrewNex (C3 default), so CrewNex still creates consultants, decides when training ends and deactivates leavers. Default: a **one-way CrewNex → Eureka feed** of three things only: new consultants (person rows, skipped if already in the ledger), **readiness events** and **deactivations** (typed event rows applied by their own forward-only definer, ledger keyed by the CrewNex event id). Eureka refuses the transitions CrewNex owns on CrewNex-sourced candidates. Column ownership after cutover is in 5.4. Nothing flows back (Q31). |

Why Eureka and not CrewNex:

| Reason | Detail |
|---|---|
| Authorization in the database | Eureka enforces every row twice: the API engine and FORCE RLS with SECURITY DEFINER writers (HANDOFF rules 1–7). CrewNex's boundary is a Prisma `where` per call site; its own `CLAUDE.md` records the same class of leak recurring (spread/`OR` clobbering a scope filter in six files, `== null` on an unloaded column, a picker wider than its page, a Server Action trusting its page). Each was found by hand. RLS makes that class unreachable. |
| Two scoping axes are already one model | CrewNex keeps the location chain and the offshore chain as two hierarchies "deliberately not merged" plus ten direct-FK rules, and warns that a third axis is now expensive. Eureka has one scope model (own/team/coached/hierarchy/location/org) over teams, reporting lines and locations. |
| AWS, one bill, ~$30 | Eureka runs in the firm's AWS account (section 7). CrewNex spreads over Supabase, Vercel, Vercel Blob, Upstash, Cloudflare R2/Worker/Turnstile, Sentry and Google SMTP, each with its own credentials (`docs/Vendors.md`; the cost column there is still TODO). |
| Compliance features exist | Field encryption, restricted documents with step-up, append-only audit with Object Lock export, malware-scanned uploads (Eureka migrations 0036–0047). CrewNex stores documents in Vercel Blob with no backup and no scan (deferred by decision). |

Alternatives rejected:

| Alternative | Rejected because |
|---|---|
| CrewNex becomes the system of record | App-level filters (above), multi-vendor hosting, and the sheets migration already targets Eureka. |
| Big-bang migration | One cutover of ~69 models, 19 roles and a live LMS; no partial rollback. |
| Two-way sync / dual write | Two writers per row means conflict resolution and an audit trail split across two systems. |
| Shared database | Prisma `cuid` text keys, no RLS for the app role (it owns tables with BYPASSRLS), and a different role model; sharing would weaken Eureka to CrewNex's level. |
| Merge the codebases (Next.js + NestJS) | A rewrite of one of them in all but name. |

## 2. Entity mapping

Target column: **existing** (built table), **design** (named in `design.md`, not built), **NEW** (needs a
migration). Phase: **C1** data import, **C2** feature port, **C3** decide with the LMS, **Drop** (not migrated;
archived where noted).

### 2.1 Organisation and people

| CrewNex | Eureka | Phase | Semantic differences |
|---|---|---|---|
| `User` role CONSULTANT | `person` + `candidate` (existing) | C1b | A consultant is a **signing-in user** in CrewNex (LMS, `/my-marketing`, profile requests, own documents). Eureka has no candidate sign-in (design A1 non-goal). `candidate.team_id` and `technology_id` are NOT NULL; CrewNex `technology` is free text with "Other": aliases live in `mapping.crewnex.json` `technologies` (the sheet mechanism), not in the exporter, so a new alias is a reviewed mapping change; unmatched values and consultants with no Team Lead go to review. |
| `User` staff roles | `app_user` + `user_role` (existing) | C1b | Eureka users sign in with Google Workspace (A6.1, linked by `sub`); CrewNex uses username or email + argon2. Staff need a Workspace account in the hosted domain. Role assignments are not imported (section 3). |
| `User.offshoreLeadId`, `offshoreManagerId`, `offshoreDirectorId` | `reporting_line` (existing) | C1b | Effective-dated; closure rebuilt by trigger. |
| Offshore Team Lead + recruiters with `offshoreLeadId` | `team` (lead) + `team_member` (existing) | C1b | One team per Team Lead. |
| `User.offshoreTeamLeadId`, `offshoreRecruiterId` (on the consultant) | `candidate.team_id`, `candidate.recruiter_id` (existing) | C1b | Team from the lead, owner per the owner rule (section 3). Trap B is already refused by `candidate_team_invariant` (0006). |
| `User.coordinatorId`, `managerId`, `locationManagerId` | none | Drop | Location-chain links; Eureka location roles scope by `location_id` (Q5). |
| `User.trainerUserId`, `otterTeamUserId` | none | C3 | LMS reviewers. |
| `User.immigrationUserId` | none | Drop | Eureka Immigration is org-scoped (Q6). |
| `User.supportTechnologies` | `coach_assignment` (existing), approximated | C2.3 | Technology scope has no Eureka equivalent (Q7). |
| `Location` | `location` kind `training` (existing) | C1a | CrewNex `code` is unique, `name` is **not**; Eureka `location.name` is UNIQUE (0003). The exporter matches by code and stops on two active CrewNex locations with the same name. Kind confirmed by Q24. |
| `User.locationId` NULL on a consultant | review (`no_location`) | C1b | Eureka `candidate.location_id` is NOT NULL; no default location is guessed. |
| `OffshoreOffice` enum (LOCATION_1, LOCATION_2) and `User.offshoreOffice`, `coveredOffices` | `location` kind `office` (existing) + `candidate.office` (design, NEW column) | C1a / C1b | Office scoping becomes hierarchy scoping (a Director sees the Managers who report to them, not "offices"). `coveredOffices` is dropped; reporting lines replace it. |
| `OnboardingCompany` (+ `OnboardingCompanyLocation` opt-ins) | `legal_entity` (design AS-09, NEW) | C1a.5 | Opt-ins per location have no home: kept as `legal_entity_location` (NEW) only if Q25 says the rule matters. `accountsUserId`, `hrUserId`, `associateHrUserId`, `contractsUserId` (per-company staff) are dropped with Q6. |
| `User.onboardingCompanyId` | `candidate.onboarding_entity_id` (NEW; design has `offer_letter_entity_id`, `everify_entity_id`, `entity_1099_id`) | C1b | Which design column it is, is Q25. |
| `User.marketingEmail`, `vitelGlobalNumber` | `candidate.marketing_email`, `candidate.vitel_number` (existing) | C1b | Company-issued and **reissued** between consultants (CrewNex releases them on deactivation), so they are **not identity** for CrewNex batches (D3): excluded from identity hashes, and exported only for ACTIVE consultants so a reissued address is never loaded twice. |
| `User.email`, `phone` (personal) | `person.personal_email`, `person.phone_e164` (existing) | C1b, gated | CrewNex restricts these to the location chain; Eureka shows phone to every recruiter of the team. **Matched, not loaded** until Q9 (D4): identity-only columns (C1a.4) replace the cell with a keyed-hash token at staging, like DOB, and the loader writes NULL. |
| `User.dateOfBirth` | `person.dob_enc`, `dob_bidx` (existing, unused) | after OD-04 | Hash for matching only (as the sheet import does); never stored until OD-04 / Q11. |
| `User.visaType`, `visaExpiresAt` | `work_authorization` (`auth_type`, `valid_to`; existing, 0042) | C1b.4 | CrewNex has no document number, so `number_enc` stays NULL. Type list differs (section 4.4). |
| `User.status` DEACTIVATED / DELETED, `deletedAt` | `candidate.marketing_status = terminated` / not imported | C1b | Q17. |
| `User.calendlyLink` | none | C3 | Demo booking for the LMS. |
| `User.acceptedPolicyVersion` | none | C2.9 | Eureka has no acceptable-use gate (Q27). |
| `Session`, `UserToken` | none | Drop | Google OIDC sessions. |
| `CustomFieldDefinition`, `CustomFieldValue` | none | Drop (archive) | Unless Q21 names fields in use; then typed columns, not a key-value table. |

### 2.2 Marketing activity

| CrewNex | Eureka | Phase | Semantic differences |
|---|---|---|---|
| `VendorCompany` (277 seeded, `mergedIntoId`) | `vendor` (existing) | C1a | Merged rows resolve to their survivor; only survivors are exported. The import matches reference names by exact `lower(trim(name))` (`apps/api/src/import/stage.ts:43-46`), so near-duplicates (`Acme Inc` / `Acme, Inc.`, CrewNex `nameNormalised` collisions) are flagged by the lookups sheet as `near_duplicate_name` and go to review rather than becoming two vendors. Curation rights are a C2.8 port. |
| `VendorSubmittal.endClientName` (text) | `client` (existing) | C1a | Same rule: exact lower-case match, near-duplicates to review, unknown names `unknown_client`. |
| `VendorSubmittal` | `submission` (existing) | C1c | Eureka requires `recruiter_id` (actor snapshot) and sets `submitted_at` itself; CrewNex rows are often entered by the consultant and carry `submittedOn` (date). Natural key today is candidate + client + job title, which collapses two CrewNex submittals to one client through different vendors (fixed by `sourceId`, D3). `submitted_at`: the insert guard (`eureka.submission_insert_guard`, `0019_review_hardening.sql:25-35`) checks status and reason but **not** `submitted_at`, and `authz_definer` may insert only `(candidate_id, job_title, client_id, vendor_id)` (`0033_import_hardening.sql:354`). C1c.3 closes the gap (a client-set `submitted_at` is refused unless `import_active()`) **and** grants `INSERT (submitted_at)` to `authz_definer`. |
| `VendorSubmittal.createdByUserId`, `updatedByUserId` | none | Drop | The actor snapshot is the owner (section 3); who typed the row (often the consultant) has no Eureka meaning. |
| `VendorSubmittal.rateUsd` | `submission.rate` (existing) | C1c | Read tiers differ (section 8). The sheet rule "out-of-range rate → review, approvable, value dropped" (`docs/import.md`) is wrong for CrewNex: a rate is never silently dropped. The exporter lists rates outside (0, 1000] (the placement CHECK, 0022) in its exceptions file and the CrewNex mapping marks `rate` not approvable. |
| `VendorSubmittal.submittalType` (C2C, TEN99) | `submission.rate_type` (design, NEW) | C1c.4 | |
| `VendorSubmittal.vendorContactName/Phone/Email` | `submission_contact` (NEW, like `placement_contact`) | C1c.5 | Withheld from Location Manager/Admin in CrewNex; column policy needed. |
| `VendorSubmittal.intermediateLayers` (text[]) | `submission.implementation_partner_id` (first layer, existing) + `submission_layer` (NEW, ordered) | C1c.6 | |
| `VendorSubmittal.vendorJobId`, `jobDescription`, `jobLocation`, `statedLocation`, `followUpOn` | `submission` columns (NEW) | C1c.7 | `followUpOn` drives no Eureka job yet. |
| `VendorSubmittal.duplicateOfId` | none | Drop | Eureka's 90-day duplicate warning replaces it. |
| `VendorSubmittalNote`, `InterviewNote` (`staffOnly`) | `activity_note` (NEW; design `candidate_note` is the nearest) | C2.2 | Free text: never in audit or outbox (rule 5). Archived until ported (Q20). |
| `SubmittalImportBatch`, `SubmittalImportRow` | none | Drop | CrewNex's own staged import. |
| `ConsultantInterview` | `interview` (existing) | C1d | Eureka `submission_id` NOT NULL; CrewNex `vendorSubmittalId` is optional (orphan interviews get a synthesised submission, Q14). Eureka needs `ends_at` (CrewNex has only `scheduledAt`: default 60 min). |
| `ConsultantInterview.inviteReceivedAt` | none | Drop | Eureka keeps the boolean only; the date adds nothing a screen uses. |
| `ConsultantInterview.stage` + `round` | `interview.round` (text, existing) | C1d | `"L2"`, `"Technical screening 1"` etc., **at most 40 characters** (`analyze.ts:337`, `interviews.schemas.ts:29`): the label map in `mapping.crewnex.json` uses short forms. A typed `stage` column is C1d.3. |
| `.mode`, `.interviewerName`, `.meetingLink`, `.technology` | `interview` columns (NEW) | C1d.3 | `meetingLink` is not `otter_url`/`recording_url` (those need consent, AS-12). `technology` decides Interview Support visibility in CrewNex (C2.3). |
| `.inviteReceived` | `interview.invite_received` (existing) | C1d | |
| `.outcome` | `interview.call_status` + submission status | C1d | Section 4.3. |
| `.rescheduledFromId` | `interview.rescheduled_from_id` (NEW) | C1d.4 | CrewNex: a reschedule is a new row pointing back. |
| `.debrief`, `.debriefNotes` | `interview_feedback` kind `candidate` (existing) | C1d.5 | Feedback is append-only; debrief notes are free text (archive until decided). |
| `.attendanceConfirmedAt` | none | C3 | Consultant self-service. |
| `InterviewTechCheck`, `InterviewTechCheckTick`, `TechCheckItem` | `interview_tech_check` (NEW) | C2.3 | Tech Support role gap (Q8). |
| `Placement` | `placement` + `assignment` (+ `employee`) (existing) | C1e | CrewNex has no pre-join states: a placement is open (`endedAt` null) or ended. Eureka requires a `selected` submission, `work_mode` and `tentative_start` (NOT NULL), and creates the assignment on the day it is marked joined (Q14). |
| `Placement.billRateUsd`, `payRateUsd` | `placement.rate` (one column, existing) → `bill_rate`, `pay_rate` (NEW) | C1e.4 | Q13. |
| `Placement.onboardingCompanyId` | `assignment.payroll_entity_id` (design, NEW) | C1e | Decided from the CrewNex schema (D9): "payroll is the onboarding company by definition" (`prisma/schema.prisma:2761`). |
| `Placement.placedFromCompanyId` | `placement.paperwork_entity_id` (design, NEW) | C1e | It replaced `placedFromCompanyName`, "the company named on the paperwork the consultant was placed under" (`schema.prisma:2751`). The dead text columns `placedFromCompanyName`, `payrollCompanyName` are not exported. |
| `Placement.vendorCompanyId` | `placement.vendor_id` (existing, snapshot from the submission in `authz.create_placement`) | C1e | A CrewNex placement whose vendor differs from its submittal's goes to review (`vendor_mismatch`). |
| `Placement.expectedEndDate` | `assignment_plan.planned_end_date` (existing, 0045) | C1e | Drives `assignment.ending_soon`; not set for ended placements. |
| `Placement.placedByUserId` | none | Drop | The placement's actor is the owner (section 3); the CrewNex placer is in the audit archive. |
| Placement with no `vendorSubmittalId` | synthesised submission (C1e.3) | C1e | Needs end client and role title (both NOT NULL in CrewNex, so always possible); outcome `selected`. |
| `Placement.vendorContact*` | `placement_contact` kind `vendor_poc` (existing) | C1e.6 | The sheet import does not load contacts today. |
| `Placement.intermediateLayers`, `clientLocation`, `paymentTerms`, `payFrequency`, `timesheetPortal`, `poReference`, `notes` | `placement` columns (NEW) / `project_city`, `project_state` (existing) for `clientLocation` | C1e.7 | `clientLocation` is free text: parse to city/state or review. `notes` is free text (archive). |
| `Placement.endedAt`, `endReason`, `endNote` | `assignment.end_date`, `end_reason` (existing) | C1e.3 | CONTRACT_ENDED→`completed`, TERMINATED→`terminated`, RESIGNED→`resigned`, OTHER→review. `endNote` free text: archive. |
| `PlacementEndRequest` | none | Drop / C3 | Consultant-raised; resolve every PENDING request before C1f. |
| `MarketingStatusEvent` | `candidate_event` (existing, trigger-written only) | Drop (archive) | History cannot be back-dated into `candidate_event` (write guard). Q22. |

### 2.3 Compliance and files

| CrewNex | Eureka | Phase | Semantic differences |
|---|---|---|---|
| `ConsultantDocument` | `document` + `file_object` (existing, 0043) | C2.1 | Category map in 4.5; PASSPORT, STATE_ID, I20, OPT_EAD need new restricted types (catalog change, Q12). Files go through the scan pipeline; some may be rejected (macros, active PDF content). |
| `ConsultantResume` + `ConsultantResumeVersion` + `ResumeEvent` + `ResumeReviewer` + `ResumeWriterLead` | `resume` (existing, one current version per candidate) | C2.1 (files), C2.6 (workflow) | CrewNex: several named resumes per consultant, each versioned with a review state. Default: the newest version of the most recently APPROVED resume becomes current; other versions load as superseded. Review workflow and Resume Team are C2.6 (Q8). |
| `ConsultantContract` | `contract` (NEW, own permission set) | C2.1 | **Never a `document` type**: CrewNex keeps contracts out of `DOCUMENT_ROLES` so uploaders (Team Lead, Offshore Manager) do not gain passports. Same rule here: `contract:read/upload/review`, snapshotted to the legal entity. |
| `ChecklistItem`, `ChecklistAssignment`, `ChecklistAssignmentTarget`, `ChecklistEvidence` | `readiness_item`, `readiness_assignment`, `readiness_evidence` (NEW) | C2.5 | **Not** Eureka's `checklist_item`, which is placement paperwork. CrewNex's checklist is pre-marketing readiness and gates IN_TRAINING → IN_MARKETING. |
| `Form`, `FormField*`, `FormSubmission`, `FormAnswer`, `FormFileUpload`, `FormAccessGrant` | `intake_form`, `intake_response` (NEW) | C2.7 | Public intake with uploads, Turnstile and upload sessions. Responses are converted or rejected in CrewNex before C1f; not imported. |
| `AuditLog` | none (archive) | Drop (archive) | Actors and metadata do not map to `audit_event`. A final JSONL export goes to the Object Lock audit bucket under `crewnex-archive/` (Q19). |
| `Notification`, `NotificationPreference` | `notification` (existing) | Drop | Transient. Eureka has no per-user preferences (open in HANDOFF). |
| `IssueReport` | none | Drop (archive) | |
| `ProfileChangeRequest` | none | Drop | Consultant self-service; resolve before C1f. |

### 2.4 LMS, reporting, platform

| CrewNex | Eureka | Phase | Notes |
|---|---|---|---|
| `TrainingPath`, `Course`, `Video`, `TrainingPathCourse`, `CourseVideo`, `ConsultantTrainingAssignment`, `ConsultantExtraCourse`, `VideoCompletion` | none | C3 | 213 GB of video in R2 under an indefinite lock. |
| `Quiz`, `QuizQuestion`, `QuizOption`, `QuizAttempt`, `QuizAnswer`, `QuizAttemptAllowance` | none | C3 | |
| `Assignment`, `RubricCriterion`, `RubricScore`, `AssignmentSubmission`, `Resource` | none | C3 | |
| `PracticeVideo` | none | C3 | `practice/` keys purge after 30 days anyway. |
| `TrainerFeedback`, `OtterFeedback` | none | C3 | Their READY verdicts drive the readiness gate (C2.5 depends on this). |
| `AiSettings`, `AiUsage`, `AiChatMessage` | none | Drop | No AI features in Eureka's scope. |
| `SavedView`, `UserTablePreference`, `UserDashboardPreference` | `hotlist_view` (existing) | Drop | Screens differ; users recreate views. |
| `DailyMetricSnapshot` | none | Drop | Eureka dashboards compute live. |
| `DataHealthCheckRun`, `DataHealthAcknowledgement` | reconciliation report | Drop | Constraints and RLS replace most checks; C1f reconciliation covers the migration. |

## 3. Role mapping

CrewNex has 19 values of `enum Role`; Eureka has 16 (`ROLES` in `packages/shared/src/authz/catalog.ts`). **Role
assignments are never imported.** The exporter produces a roster (name, work email, CrewNex role, proposed Eureka
role, proposed team and manager); an org admin assigns roles in Users & Access, with the second approver that
restricted roles require (A6.2). Importing them would bypass that control.

**Ordering gate before C1b (D6).** Sign-in, email linking and the dev path all require `app_user.status = 'active'`
(`apps/api/src/modules/identity/auth.controller.ts:81`, `:88`, `:110`), and the import loader acts only as an
**active** Sales user (`docs/import.md` "What the commit does"). So before any consultant row can load:

1. Staff are created **active** from the roster (C1b.1), each with a Workspace email in the hosted domain.
2. Org admins assign roles in Users & Access (second approver for restricted roles); teams and reporting lines exist.
3. Only then does a consultant batch dry-run clean.

Owner rule (who the loader acts as, and who becomes `recruiter_id` / the submission's actor snapshot):

| CrewNex | Eureka owner |
|---|---|
| Consultant's `offshoreRecruiterId` is active and a member of the Team Lead's team | that recruiter |
| No recruiter, or recruiter deactivated/deleted/departed | the consultant's **current Team Lead** (`teamLeadEmail`); `recruiter_id` NULL. Default (Q32); alternative: a system import actor recorded as acting `on_behalf_of` the departed recruiter, audited, which keeps the historical submitter but adds a non-human Sales actor to RLS. |
| Team Lead inactive or missing | review (`no_active_owner`) |

`candidate.team_id` comes from `teamLeadEmail` (the lead's team), never from the owner's team, so a consultant
whose recruiter left stays on their lead's desk.

Role defaults (D8): **no role is granted by default where the Eureka role is wider than the CrewNex one**; such
users get an account and no role until Ravi answers.

| CrewNex role | Eureka role | Scope change | Status |
|---|---|---|---|
| CEO | `ceo` | Same breadth; Eureka CEO is read-only on Sales data and sees no DOB or restricted documents (B4.2). CrewNex CEO writes everything. | Mapped; narrowing accepted unless Q3 says otherwise |
| OFFSHORE_DIRECTOR | `assoc_director` | Offices → hierarchy (reporting lines). | Default, Q4 |
| OFFSHORE_MANAGER | `manager` | Office desk → hierarchy. | Mapped |
| OFFSHORE_TEAM_LEAD | `lead` | Same: the lead's team. | Mapped |
| OFFSHORE_RECRUITER | `recruiter` | Eureka recruiter sees the whole team's candidates (CrewNex: own consultants) but only own submissions/interviews/placements. | Mapped; widening of candidate reads noted |
| LOCATION_MANAGER | `location_incharge` | Location. **Loses** consultant creation and stage moves (Eureka location roles hold no `candidate:create` and no status transition; CrewNex `/users/new` and `canSetMarketingStatus` give them both). | Mapped; loss is **Q33** |
| LOCATION_ADMIN | `location_ops_admin` | Location. Same loss. | Mapped; **Q33** |
| COORDINATOR | **none** (default) | `location_ops_admin` would widen own consultants → whole location. | **Q5** |
| CONSULTANT | none (candidate record) | No sign-in. | **Q2, Q3** |
| HR | **none** until Q6 (candidate: `hr`) | `hr` would widen onboarding-company consultants → org and add DOB and restricted documents (`candidate.dob:read`, `document.restricted:read`). | **Q6** |
| ASSOCIATE_HR | **none** until Q6 (candidate: `associate_hr`) | Company → org. | **Q6** |
| ACCOUNTS | **none** until Q6 (candidate: `accounts`) | Company → org; adds `rate:read`, restricted documents. | **Q6** |
| IMMIGRATION | **none** until Q6 (candidate: `immigration`) | Assigned consultants → org; adds `visa:update`. | **Q6** |
| INTERVIEW_SUPPORT | **none** until Q7 (candidate: `interview_coach`) | Technology → coached teams, and **loses** interview editing: `interview_coach` holds no `interview:update`, while CrewNex Interview Support edits time, stage, link and outcome (`updateInterviewAction`). | **Q7**, **Q34** |
| TECH_SUPPORT | none | Every interview, tech check only. | **Q8** gap |
| CONTRACTS | none | Company contracts. | **Q8** gap (C2.1 `contract:review`) |
| RESUME_WRITER (Resume Team) | none | Linked Team Leads' consultants. | **Q8** gap (C2.6) |
| TRAINER | none | Technology + assigned consultants. | C3 |
| OTTER_TEAM | none | Assigned consultants. | C3 |
| (none) | `offshore_manager` (org read-only), `documents_team`, `bu_head`, `org_admin` | Eureka-only. | `org_admin`: two named admins (bootstrap). Who in CrewNex holds `documents_team`/`bu_head` duties: Q4 |

Duties carried by staff in CrewNex (an Offshore Director holding a company's contracts, a staff member with a
support duty since 2026-09-27) have no Eureka equivalent: Eureka grants come from roles only. They are listed in
the roster for Ravi, not mapped.

### Hierarchies onto teams, lines and locations

```
CrewNex offshore chain                         Eureka
Director ──offshoreDirectorId──▶ Manager       reporting_line(manager → director)            roles assoc_director, manager
Manager  ──offshoreManagerId───▶ Team Lead     reporting_line(lead → manager)                role lead; team(lead_id = lead)
Team Lead ─offshoreLeadId──────▶ Recruiter     reporting_line(recruiter → lead) + team_member role recruiter
Team Lead ─offshoreTeamLeadId──▶ Consultant    candidate.team_id = the lead's team
Recruiter ─offshoreRecruiterId─▶ Consultant    candidate.recruiter_id (must be a member of team_id)
offshoreOffice (LOCATION_1/2)                  location kind office; candidate.office; team.location_id = lead's office

CrewNex location chain                         Eureka
Location                                       location kind training; candidate.location_id
Location Manager / Admin (locationId)          user_role location_incharge / location_ops_admin with location_id
Coordinator ─coordinatorId─▶ Consultant        dropped (Q5)
```

CrewNex's chain-break traps map as follows. **Trap A** (lead whose manager is gone hides the desk from everyone
above): in Eureka the lead simply has no reporting line and the manager's hierarchy scope stops at them; the same
invisibility. C1f reconciliation lists every lead with no manager line. **Trap B** (recruiter on another lead's
desk): already refused by the existing trigger `candidate_team_invariant` (`db/migrations/0006_guards.sql:59-71`:
`recruiter_id` must be a current member or the lead of `team_id`); the exporter flags such rows so they reach
review instead of failing at commit. No new trigger is needed.

**Director offices vs one reporting line.** A CrewNex Director scopes by `coveredOffices` (possibly both offices);
in Eureka a Director sees only the Managers who report to them. Reconciliation item (C1f.1): every Manager whose
office is not in their Director's `coveredOffices`, every covered office with Managers reporting to a different
Director, and every Director covering an office through `coveredOffices` alone. Each is a scope difference to
resolve by a reporting line or accept.

## 4. Status and state mapping

### 4.1 Consultant marketing status → `candidate.marketing_status`

| CrewNex `MarketingStatus` | Eureka | Notes |
|---|---|---|
| IN_TRAINING | `in_training` | |
| IN_MARKETING | `active` | |
| PLACED | `placed` only through a joined placement (C1e) | Eureka reaches `placed` only via the placement path (PL-5). A PLACED consultant with no open placement in CrewNex (the stage set by hand) goes to review. |
| (user DEACTIVATED) | `terminated` | Q17 |

No CrewNex source for `on_hold`, `stopped`, `full_of_interviews`, `confirmation`, `bench`. CrewNex's project end
(`endPlacement()`: back to IN_TRAINING with checklist items un-verified) maps to Eureka's `placed → bench` via
`assignment.end_date`; the readiness reset has no Eureka counterpart until C2.5.

### 4.2 `SubmittalOutcome` → `submission.status`

Eureka steps forward one at a time (`authz.transition_submission`); the importer walks the path
(`import_walk_submission`).

| CrewNex | Eureka | `rejection_reason` (fixed code) |
|---|---|---|
| SUBMITTED | `submitted` | |
| SHORTLISTED_BY_VENDOR | `under_review` | |
| MOVED_TO_INTERVIEW | `interview_requested`; `interview_scheduled` if an interview row exists; `interview_completed` if one completed | |
| SELECTED | `selected` | |
| PLACED | `selected` + placement (C1e) | |
| REJECTED_BY_VENDOR | `rejected` | `rejected_by_vendor` |
| REJECTED_BY_CLIENT | `rejected` | `rejected_by_client` |
| RATE_NOT_AGREED | `rejected` | `rate_not_agreed` |
| NO_RESPONSE | `rejected` (default) | `no_response` (Q16) |
| REQUIREMENT_CLOSED | `withdrawn` (default) | none; Q16 |
| WITHDRAWN_BY_CONSULTANT | `withdrawn` | |

The rejection codes keep CrewNex's "why did it die" analytics as fixed strings in a column Eureka already has;
a typed `outcome_detail` column is a later increment if Q16 asks for it.

### 4.3 `InterviewOutcome` → `interview.call_status` (+ submission)

| CrewNex | Eureka `call_status` | Submission effect |
|---|---|---|
| SCHEDULED | `scheduled` | walk to `interview_scheduled` |
| COMPLETED | `completed` | walk to `interview_completed` |
| SELECTED | `completed` | submission `selected` (from the submittal outcome) |
| REJECTED | `completed` | submission `rejected` (from the submittal outcome) |
| CANCELLED | `cancelled` | none |
| RESCHEDULED | `rescheduled` | none; the replacement row is its own interview |
| NO_SHOW | **unmappable** (default `cancelled` + review flag) | Q16 |

Eureka's `in_progress` and `no_invite` have no CrewNex source. `InterviewDebrief` (WENT_WELL/MIXED/WENT_BADLY) has
no `call_status` meaning: C1d.5.

Overlaps: Eureka refuses two live interviews of one candidate overlapping in time (exclusion constraint). CrewNex
allows it; such rows go to review (`interview_conflict`).

### 4.4 Placements, work authorisation, documents

| CrewNex | Eureka |
|---|---|
| Placement open (`endedAt` null), `startDate` ≤ load date | `joined`, assignment `start_date` = CrewNex `startDate` (replay 4.6) |
| Placement open, `startDate` in the future | `ready` (default; Q14) |
| Placement ended with a reason | `joined`, then assignment ended on `endedAt` with the mapped reason (replay 4.6) |
| Placement ended **without** a reason, or ended before it started | `backout` (replay 4.6) |
| `SubmittalType` C2C / TEN99 | `placement_type` `c2c` / `1099` (CrewNex has no W2) |
| `PlacementWorkMode` REMOTE / HYBRID / ONSITE | `remote` / `hybrid` / `onsite`; NULL → review (Eureka NOT NULL) |
| `VisaType` CPT, INITIAL_OPT, STEM_OPT, H1B, H4EAD, GC, US_CITIZEN | `auth_type` slugs (`WORK_AUTH_TYPES`, `packages/shared/src/workAuthorization.ts`): `f1_cpt`, `f1_opt`, `f1_stem_opt`, `h1b`, `h4_ead`, `green_card`; **US_CITIZEN unmappable** (not a work authorisation: no record, Q12). `status` is NOT NULL (`0042:86`): loaded as `valid` (expired is derived from `valid_to`). `visaExpiresAt` NULL (CrewNex: "does not expire") → `valid_to` NULL. |

Historical side effects are handled by the replay rules in 4.6.

### 4.5 Document categories → `authz.document_type`

| CrewNex `DocumentCategory` | Eureka type | Classification |
|---|---|---|
| WORK_AUTHORIZATION, OPT_EAD | `work_authorization` | restricted |
| DRIVERS_LICENSE | `drivers_license` | restricted |
| PASSPORT, STATE_ID, I20 | `passport`, `state_id`, `i20` (NEW types) | restricted (Q12) |
| IDENTITY (legacy coarse) | review | restricted until classified |
| CERTIFICATION, NDA, OTHER | `other` | **restricted until classified** (D8): an "other" upload in CrewNex can be anything, including identity papers; reclassifying down is a later, reviewed step |
| RESUME, CONTRACT (retired in CrewNex) | `resume` / `contract` tables | not documents |

### 4.6 Historical replay (D5)

Eureka's state machines move one step at a time and fire side effects on every step. A CrewNex history has to be
**replayed per candidate, in order**, through the same definer functions (`authz.transition_submission`,
`authz.create_placement`, `authz.transition_placement`, `authz.end_assignment`, `authz.return_employee_to_market`),
in **historical mode**. The replay is a pure function of the exported rows (`replayPlan(candidate)` in the
importer, unit-tested on fixtures) whose output is the ordered step list the loader executes; the dry run and the
preview show that list.

Order of steps for one candidate:

| # | Step | Rule |
|---|---|---|
| 1 | Person and candidate | Created `in_training` (server default); `in_training → active` if the candidate ever reached IN_MARKETING or has any submittal. A consultant who is IN_TRAINING **now** but has submittals and no ended placement (moved back by hand, not by a project end) goes to review as `status_regressed`: Eureka has no `active → in_training` edge, so the replay cannot end where CrewNex is. |
| 2 | Submissions | Created in `submittedOn` order, each walked forward only to the furthest **non-terminal** state its interviews and outcome require (4.2). |
| 3 | Interviews | Inserted in `scheduledAt` order under their submission while it is still open (Eureka refuses an interview on a terminal submission, migration 0017). An orphan interview (no submittal) gets a synthesised submission only when it has a vendor or end client **and** a role title; otherwise review (`orphan_interview_incomplete`). |
| 4 | Terminal submission outcomes | `rejected` / `withdrawn` / `selected` applied **after** step 3 for that submission. |
| 5 | Placements | In `startDate` order (ties by `createdAt`). Each: `create_placement` from its `selected` submission (needs the candidate `active`/`full_of_interviews`), walk to `joined`. A placement with no submittal: synthesised submission (C1e.3) or review. |
| 6 | End of a placement with a reason | `authz.import_end_assignment(endedAt, reason)` → candidate `placed → bench` (0045). Ended placements never stay live. The API's `authz.end_assignment` cannot be used: it needs `assignment:update` **and** org-wide `employee:read` (`0045_employees.sql:302-303`) while the loader acts only as a Sales user (`authz.import_act_as`, `0033_import_hardening.sql:606-613`), so every ended placement would fail `not_permitted`. The import variant (C1e.1) skips that permission check and is executable only by `authz_definer` inside a historical load (below). |
| 7 | Between placements | Before the next placement's step 5: `bench → active` through `authz.import_return_to_market` (C1e.1), for the same reason: `return_employee_to_market` needs org-wide `employee:read` (`0045:385`). |
| 8 | End before start (`endedAt` < `startDate`) | `backout` before `joined` (reason code `ended_before_start`); candidate back to `active`. |
| 9 | Ended with a NULL `endReason` | CrewNex's correction path (leaving PLACED through the stage control writes no reason, CrewNex `CLAUDE.md`): the placement fell through. `backout` (reason code `crewnex_correction`); review if it lasted more than 30 days. |
| 10 | Final status | Last placement open → `placed`. Last placement ended and CrewNex status IN_MARKETING → walk `bench → active`. CrewNex IN_TRAINING after a project end (`endPlacement()` resets to training) → stays `bench`: Eureka has no `bench → in_training` edge and the readiness reset waits for C2.5. Deactivated → `terminated` last (Q17). |

Historical mode = `authz.import_historical()`: true only inside an import call (`authz.import_active()`) for a
batch whose `historical` column is set (immutable, part of the digest, C1a.3). It must hold in **dry runs too**:
`import_session.verified_batch` is written only on the real commit path (`0041_import_review.sql:516`, inside the
not-dry branch), so keying on it would make every dry run take the normal path and diverge from the commit it is
meant to preview. C1a.3 therefore adds `import_session.active_batch`, set by `import_load_person` at the start of
**every** call, dry or not, and `import_historical()` reads the batch's flag through it. The import-only variants
(`import_end_assignment`, `import_return_to_market`) refuse unless `import_historical()` is true. In this mode,
every side effect that would be wrong for the past is suppressed or back-dated:

| Side effect | Normal | Historical mode |
|---|---|---|
| `placement.created`, `placement.state_changed` outbox rows (`0022`, `0023`) | emitted | not emitted |
| `employee.benched`, `employee.exited` outbox rows (`0045` triggers) | emitted | not emitted |
| `work_authorization.expiring` notices | daily job | not emitted for dates already past at load |
| Candidate feedback email | 1 h after an interview | never (already true for interviews ended before load, `docs/import.md`) |
| Paperwork checklist on create (0035) | items `pending` | items `waived`, reason code `historical_import` |
| `placement.joined_at`, `status_changed_at`, `submission.status_changed_at`, `assignment.start_date` | `now()` / the day marked joined | back-dated to the CrewNex dates (`startDate`, `endedAt`, `submittedOn`) |
| `is_first_placement` | computed | computed, correct because placements replay in start order |
| `candidate_event` rows | written by triggers at `now()` | written at `now()` (append-only, no back-dating, Q22); the timeline shows the import day |

## 5. Import path

### 5.1 Shape

```
CrewNex production DB (Supabase session pooler, role crewnex_export: BYPASSRLS + column grants)
   │ TLS, SELECT only, one REPEATABLE READ snapshot
   ▼
crewnex-export task (ECS one-off, Eureka prod account)  ── writes ──▶ s3://<docs bucket>/migration/crewnex/<run>/
   sales.csv  staff.csv  lookups.csv  submissions.csv  interviews.csv  placements.csv              (SSE-KMS, 7-day lifecycle)
   control-totals.json  mapping.crewnex.json  manifest.json (sha256 per file, column fingerprint)
                                                                  │
                                                                  ▼
                              existing import CLI as eureka_import (stage → review → dry run → 2nd-admin digest approval → commit)
```

The exporter **writes the existing sheet format plus new columns**; the pipeline stays the one control point
(review queue, digest approval, ledger, definer loaders). Nothing writes Eureka tables except
`authz.import_load_person` and the new loaders the increments add.

### 5.2 The exporter (D2)

A **separate SQL tool** (`tools/crewnex-export/`, plain `pg` + hand-written `SELECT`s against a pinned column
list) built and tested in Eureka's CI and run as an ECS one-off task. **Not** a Prisma script inside CrewNex: a
CrewNex script would run wherever CrewNex code runs (Vercel, laptops with `.env` pointing at production, per
CrewNex's own `CLAUDE.md`), would load every column Prisma selects by default, and would be reviewed under
CrewNex's rules rather than the importer's.

| Rule | How |
|---|---|
| Never on a laptop | It reads production PII (names, contacts, DOB, visa). It runs in the Eureka **production** account, same pattern as the import (`docs/import.md` "Where it runs"). Eureka dev and staging only ever see fictional fixtures (implementation-plan rule 5). |
| Source role | `crewnex_export`, created by a CrewNex-side change (Q26) with `LOGIN` only during the migration window (CrewNex `scripts/audit-lockdown.mjs` pattern). **`BYPASSRLS`** is required: every CrewNex table has deny-all RLS and the app reads only because it owns the tables (CrewNex `CLAUDE.md` "A new Prisma model arrives with no Row Level Security"); CrewNex already grants `BYPASSRLS` to `crewnex_app`/`crewnex_maintenance` the same way (`docs/Audit-Lockdown.md`). No table-level `SELECT`: **column-level `GRANT SELECT (…)`** only, so the database itself withholds what the exporter must not read. |
| Columns withheld by the database | `User.passwordHash`, `pendingEmail`, every `Session`/`UserToken`/AI/`AuditLog` column (the audit archive at C1f.4 uses a separate one-time grant), every note and free-text body (`VendorSubmittalNote.body`, `InterviewNote.body`, `ConsultantInterview.debriefNotes`, `Placement.notes`, `Placement.endNote`, `PlacementEndRequest.note`), `vendorContactName/Phone/Email` on submittals and placements, `ConsultantInterview.meetingLink`, every `storagePathname`. Each is granted only in the increment whose loader needs it (C1c.5, C1d.3, C1e.6, C2.x). |
| Right database (server-side) | `crewnex_export_identity()` (SQL function, `EXECUTE` to `crewnex_export` only) returns the project's ref. It is created **per environment by a script that is given the ref and checks it against the connection**, in the shape of CrewNex `scripts/audit-lockdown.mjs <env>`, never by a Prisma migration: a migration is the same file for e2e, staging and production, so it cannot know which ref to return, and a function that returns whatever it was told is no check. The exporter refuses unless it returns `ihixojcfxuvoyehuwlnd`. Checking the URL alone is client-side and is how CrewNex's `.env` → production trap happens. |
| Right schema | Fingerprint = SHA-256 over `information_schema.columns` (table, column, type, nullability) of the **exported tables** plus `pg_enum` labels of the exported enums, compared with the value pinned in the exporter. Not the `_prisma_migrations` head: a `prisma db push` changes the schema without a migration row (CrewNex `CLAUDE.md`, the crewnex-v2 drift). Any difference stops the run. |
| Snapshot | One `REPEATABLE READ READ ONLY` transaction for every file. |
| Empty tables | The run fails if any expected table returns zero rows (`User` consultants, `VendorSubmittal`, `ConsultantInterview`, `Placement`, `Location`, `VendorCompany`): a missing grant or a wrong database shows up as an empty export, never as "nothing to migrate". |
| Control totals | Computed by a second path in the same snapshot: plain `count(*) … GROUP BY` on the base tables (no export joins, no filters), cross-checked against `pg_class.reltuples` within a tolerance. The reconciliation (C1f.1) compares Eureka with these, so an exporter join bug cannot hide in both sides. |
| Connection | Supabase **session pooler** (IPv4; the direct host is IPv6-only and Eureka tasks have public IPv4 only), `sslmode=verify-full`. Session mode keeps the one transaction on one backend. Connection string in SSM SecureString, deleted after C1f (and after each D7 feed run, re-created by hand). |
| Network | Tasks run in public subnets with a public IP (no NAT, infra/README); Supabase network restrictions, if enabled, need the task's IP for the run. |
| Files | Streamed to `migration/crewnex/<run>/` (SSE-KMS, 7-day lifecycle); the task has `s3:PutObject` on that prefix only; the import task reads it. No local disk beyond the task's ephemeral storage. |

### 5.3 Format extensions (each a separate increment)

The current sheet format cannot carry these. Each line is one PR in section 6.

| Gap | Why the sheet format fails | Minimal extension |
|---|---|---|
| Stable source ids (D3) | Row keys hash the cells (`rowKeyOf`, `analyze.ts:98`), so an edited CrewNex row gets a new key and loses its review decisions between dry runs; natural keys (candidate + client + job title) collapse distinct submittals | `sourceId` on **every** CrewNex sheet (person, submission, interview, placement): row key = `h("src:crewnex:" + sheet + id)`, decisions survive edits, the ledger records the CrewNex id. No update-in-place (D1): a ledger hit on a source id is `skipped` (C1a.2). |
| Identity-only columns (D4) | Personal email and phone are loaded into `person` when present | Per-column `identityOnly` in the mapping: staging replaces the cell with `#email:<hmac>` / `#phone:<hmac>` exactly as DOB is replaced today (`#dob:<hmac>`), matching uses the hash, the loader writes NULL (C1a.4). |
| Standalone submissions | Submissions exist only implicitly from interview/placement rows (keyed candidate + client + job title) | A `submissions` sheet; interviews and placements reference `submissionSourceId` (C1a.1, C1c.2) |
| Historical dates | `submitted_at` is server-set; assignment start = day marked joined | Import-only `submittedOn` / `startDate` honoured by the loader, audited as `source: import` (C1c.3, C1e.2) |
| Team vs owner | Team derives from the owner; a consultant with a lead and no recruiter has no owner | `teamLeadEmail` column; owner falls back to the lead (C1b.3) |
| Explicit time zone | Sheet default is `America/Chicago` | Exporter writes ISO-8601 UTC instants (`Z`) and `mapping.crewnex.json` sets `timeZone: "Etc/UTC"`; calendar dates (`@db.Date`) as `YYYY-MM-DD` read in UTC (C1a.8) |
| Vendor contact | No column; contacts not loaded | `submission_contact` + `placement_contact` loading (C1c.5, C1e.6) |
| Rate type, layers | No columns | C1c.4, C1c.6 |
| Interview stage, mode, link, interviewer, reschedule chain | `round` text only | C1d.3, C1d.4 |
| Bill vs pay rate | One `rate` | C1e.4 |
| Entities | No `legal_entity` | C1a.5, C1b.2, C1e.5 |
| Work authorisation | Not in sheets | C1b.4 (own loader; acts with `visa:update` semantics) |
| Office, marketing email, Vitel number | Only marketing email mapped | C1b.3 |

### 5.4 Identity, idempotency, overlap, cutover

| Topic | Rule |
|---|---|
| Identity matching (D3) | Primary key for a CrewNex row is its `sourceId`. Person matching as `docs/import.md` (personal email, then phone, as keyed hashes; name + DOB and name alone are review suggestions), **without** marketing email or Vitel number for CrewNex batches (reissued, see 2.1). **Today a sales row whose email or phone hits the ledger is `skipped` as `person_already_imported` (`apps/api/src/import/analyze.ts:451-453`)**: right for a re-exported sheet row, wrong for a CrewNex consultant who arrived earlier through the sheets, whose CrewNex submissions would then never load. CrewNex-batch rule (C1b.3): a ledger hit with the **same** CrewNex `sourceId` is skipped; a hit on a person loaded from the **sheets** (or another source id) goes to review as `matches_imported_person`, and a `link` decision attaches the CrewNex rows to that person; a live candidate not created by any import goes to review as today (`authz.import_live_match`). Never a second person, never a silent skip. |
| Idempotency | One committed import (D1), so no update-in-place is needed. The ledger (`import_link`, `import_identity`, `import_natural_key`) still makes the cutover commit restartable: a person whose load failed is retried by the next `commit --commit` of the same batch, and anything already loaded is skipped. After C1f the D7 feed adds only new CrewNex ids; a CrewNex id already in the ledger is skipped, never updated. |
| Overlap window | CrewNex is the only writer for marketing data until C1f; Eureka holds **no** CrewNex rows. Weekly runs are export → stage → review → dry run → reconciliation report; review decisions persist per source row across re-staging (`import_decision`), so the review queue shrinks run by run. Batches are purged (`purge --expired`). `IMPORT_HMAC_KEY` must stay the same for the whole window or decisions and identity hashes stop matching. |
| Cutover | C1f: (1) announce; (2) **freeze week**: daily export → stage → review → dry run; go requires the last two dry runs at **zero** open review items and zero unexplained reconciliation differences; (3) cutover day: CrewNex marketing writes frozen (a CrewNex flag that turns the marketing actions read-only, Q26); (4) **re-export from the frozen snapshot** (never reuse a freeze-week file); (5) stage, review, dry run, second-admin approval, **the one commit**: **no-go** (unfreeze CrewNex, try another day) if the re-export raises more than 10 new review items, if any is still open at 16:00 ET, or if reconciliation shows any unexplained difference; (6) reconciliation signed off; (7) CrewNex marketing pages stay read-only and link to Eureka; the D7 feed starts. Target: one business day. |
| Reconciliation | The exporter writes `control-totals.json` (per consultant: submittals by outcome, interviews by outcome, placements open/ended; per status totals). `cli.ts report --reconcile` compares them with what the ledger loaded and lists every difference by source id (no personal data), plus every row still in review, held or rejected, Trap A leads and consultants without a team. Sign-off needs zero unexplained differences. |
| Rollback | Before step 4's commit: unfreeze CrewNex; Eureka holds nothing. After the commit: within the first week, unfreeze CrewNex and re-key Eureka edits in CrewNex by hand (the audit trail lists entities changed since the commit). Imported rows are never deleted (Eureka has no delete path for candidates or their history); a second cutover would need a delta design, which D1 deliberately does not build. |

Ownership after C1f (who may change what, for a CrewNex-sourced candidate):

| Data | Owner after C1f | How the other side learns of it |
|---|---|---|
| Creating a consultant | CrewNex | Feed: new person rows (daily) |
| End of training: `in_training → active`, and `bench → active` for a consultant CrewNex shows IN_TRAINING (retraining after a project end) | CrewNex | Feed: readiness event, applied to whichever of the two edges matches the candidate's current Eureka status; Eureka refuses both edges by hand (C1f.2) |
| Deactivation (leaver) | CrewNex (it holds the LMS login) | Feed: deactivation event → `terminated` |
| Team Lead / recruiter (re)assignment | Eureka | Not fed back; CrewNex values go stale on frozen pages |
| Submissions, interviews, placements, stages from `active` on | Eureka | Not fed back |
| Technology, location | CrewNex at creation, Eureka afterwards | Later CrewNex changes are not fed; C1f.1's report, run monthly, lists drift for a person to resolve |
| Onboarding company, marketing email, Vitel number | Eureka after creation | Not fed back |
| Work authorisation, documents | Eureka (Immigration/HR) | Not fed back |

Feed cadence (default): **daily on business days**, so a new consultant or a readiness event reaches Eureka within
one business day. Each feed batch is a normal import batch (dry run, second-admin approval, commit), which is a
daily approval chore; to keep it small, the feed uses a **standing** CrewNex role `crewnex_feed` whose column grants
cover only the new-consultant columns, `MarketingStatusEvent` and user status, replacing the window-only
`crewnex_export` login after C1f.

## 6. Phase plan

Every increment is one PR, reviewable and revertible on its own. Common gates (implementation-plan "How we
build"): `pnpm -r typecheck` and `pnpm -r test` green; integration tests on real PostgreSQL 16; every new table
with RLS enabled **and forced**, a differential RLS test and the RLS coverage check; authorization-matrix rows for
any new permission; migrations append-only from **0054**, applying as a non-superuser; independent review for
anything security-relevant. Fixtures are fictional (the existing import fixture org). Rollback of a migration
increment is roll-forward (no down migrations, matching both repos); code increments revert.

**Prerequisites, split honestly.** Every C1 increment is code, migrations and tests against **fictional
fixtures** in CI PostgreSQL, so all of them are startable **now**, before Eureka production exists. What needs
Eureka production (HANDOFF "Waiting on Ravi": AWS bootstrap, Workspace domain, OAuth client) is only the
**real-data dry runs** (from C1a.7 on) and the cutover. The real-data runs also need the CrewNex-side role (Q26).

Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** about a week (one engineer, tests included).

### Phase C1: data import

Order matters: C1a builds the generic pipeline changes, C1b–C1e add one loader each, C1f closes. **First PRs: C1a.3** (it changes the digest and so withdraws pending approvals; land it before anything else touches the batch), **then C1a.2, then C1a.1**; C1a.0 is independent. **C1b.3, C1c.2 and C1e.3 serialize**: each rewrites `authz.import_load_person`, so they cannot be reviewed or merged in parallel. Every
migration-bearing increment is roll-forward only; "Revert" means revert the code and leave the inert schema.

| # | Increment | What changes | Tests | Size | Startable now? |
|---|---|---|---|---|---|
| C1a.0 | Cost guardrails | Terraform: AWS Budget, tag budget, anomaly monitor, log retention, RDS alarms (section 7 "Cost guardrails"). | `terraform validate`, Checkov | S | **Built** (`infra/modules/stack/cost.tf`, `alarms.tf`); applies in steps, infra/README "Cost guardrails" |
| C1a.1 | Sheet-type registry | Migration: widen the `sheet` CHECKs on `import_row` and `import_decision` (`0028_import_staging.sql:51`, `:70`) and `import_link.sheet`/`entity_type` (`0028:83-85`) to the new sheets (`staff`, `lookups`, `submissions`, `work_authorizations`, `crewnex_events`); `import_natural_key.kind` (`0033_import_hardening.sql:83-85`) is **not** widened (source ids replace natural keys for CrewNex rows); `mapping.ts`/`stage.ts` parse the sheets; **no loader yet**: `authz.import_verify_batch` reports an explicit problem `unsupported_sheet` per row of a sheet with no loader, so approval is refused by the existing "problems block approval" rule. | Old fixtures stage, digest and commit byte-identically; new sheets stage and are refused at approval with `unsupported_sheet` | M | Yes |
| C1a.2 | `sourceId` row keys (D3) | Mapping `sourceId` column per sheet; row key `h("src:crewnex:"+sheet+id)`; decisions survive edits; ledger hit on the same source id → `skipped`. | Edited row keeps its key and decision; sheet batches unaffected | M | Yes |
| C1a.3 | Batch `source` + `historical` | `import_batch.source` (`sheets`/`crewnex`) and `historical`, fixed at `import_open_batch`, immutable (guard), part of `authz.import_batch_digest` exactly like `placements_commit` (`0041_import_review.sql:36`, `:87`), so every pending approval is withdrawn when it lands (its digest no longer matches). Adds `import_session.active_batch` (set on every `import_load_person` call, dry or not) and `authz.import_historical()`. | Digest changes when either flag would; guard refuses updates; `import_historical()` true in a dry run of a historical batch | S | Yes |
| C1a.4 | Identity-only columns (D4) | Mapping `identityOnly` per column → `#email:`/`#phone:` hash tokens in staged rows; loader writes NULL; for `source = crewnex` marketing email and Vitel number are excluded from identity hashes. **Live match:** `authz.import_live_match_norm` compares plaintext stored cells with live `person`/`candidate` (`0041_import_review.sql:122-133`), so with tokens matching against hand-created candidates would silently stop. Chosen: the **CLI stays the matcher** for identity-only values. At stage/reanalyse and again at commit it re-reads the run's CSVs from S3 (their hashes are in the batch's `files`, hence in the digest), and passes the normalized values to a new definer `authz.import_live_match_values(email, phone)`, which answers yes or no and stores nothing. A person whose answer changed since approval is held. Rejected: a database-side blind index on `person`, because the import HMAC key would have to live in the database. | Staged rows hold no plain personal contact; a hand-created candidate with the same email is still caught at stage **and** at commit; sheet batches unchanged | M | Yes |
| C1a.5 | `legal_entity` | Migration: table (name unique, kinds, status), FORCE RLS, definer create/archive, lookups read. | RLS differential, guard, lookups API, matrix | S | Yes |
| C1a.6 | Lookups loader | `lookups` sheet: create-only rows for location (by CrewNex code), client, vendor, implementation partner, legal entity through definer functions; `near_duplicate_name` review; `authz.import_verify_batch` checks non-person rows; `commit.ts` loads lookups **before** persons; digest covers them. | Dry run, approval, re-run creates nothing, near-duplicates held | M | Yes |
| C1a.7 | Exporter core (D2) | `tools/crewnex-export`: identity function check (function created per environment by a CrewNex-side script, 5.2), column fingerprint, one snapshot, empty-table failure, manifest, control totals by the second path, exceptions file (rates out of range, duplicate location names, unknown enums); exports `lookups.csv` only. | Against a **fictional CrewNex-shaped schema** in CI PG (DDL from CrewNex's migrations, fictional rows, deny-all RLS, column grants): wrong identity, changed column, empty table, unknown enum each stop the run | L | Yes (real data: needs prod + Q26) |
| C1a.8 | `mapping.crewnex.json` | Statuses (4.1–4.3), technology aliases, `timeZone: "Etc/UTC"`, ISO dates, round labels ≤ 40, `rate` not approvable, identity-only columns. | Normaliser tests incl. DST instants and `@db.Date` values | S | Yes |
| C1a.9 | Exporter infra | Task definition, task role (`s3:PutObject` on `migration/crewnex/*`, one SSM parameter), prefix lifecycle 7 days, log group 14 days, `Workstream=crewnex` tags. | `terraform validate`, Checkov | S | Yes (applies after deploy) |
| C1b.1 | Staff loader (D6) | `staff` sheet: `app_user` **active**, `team`, `team_member`, `reporting_line`; never `user_role`. Exporter `staff.csv` + roster report (proposed roles for Users & Access). | Cycle check, one team per member, closure correct, no `user_role` written, inactive CrewNex staff not created | M | Yes |
| C1b.2 | Candidate columns | Migration: `candidate.office`, `candidate.onboarding_entity_id`; column guard and write schemas. | Column guard, mass assignment, RLS unchanged | S | Yes |
| C1b.3 | Consultant loader | Exporter `sales.csv` from consultants; loader: team from `teamLeadEmail`, owner rule (section 3), Trap B pre-flag, `no_location`, CrewNex identity rule (ledger hit from the sheets → review, D3), deactivated → `terminated`, deleted not exported, marketing contacts for ACTIVE only. | Each rule; RLS: imported candidates visible exactly per engine | L | Yes |
| C1b.4 | Work authorisation loader | `work_authorizations` sheet keyed by the consultant's `sourceId`; `import_verify_batch` checks each row's person source id resolves to a clean `sales` row of the batch (or a ledger entry), else problem `unknown_person`; import-only definer (slugs, `status = valid`, NULL `valid_to`), audited without values, no notices for past dates. | Type map, US_CITIZEN skipped, orphan row blocks approval, RLS `visa:read` | M | Yes |
| C1c.1 | `replayPlan()` | Pure TypeScript: ordered steps per candidate from the exported rows (4.6); dry run and preview print it. | Table-driven unit tests for every row of 4.6 | M | Yes |
| C1c.2 | Loader v2: submissions | `authz.import_load_person` rewritten to execute the plan: standalone `submissions` sheet keyed by `sourceId`, walk to the furthest non-terminal state, terminal outcomes after interviews, reason codes (4.2). | Two submittals to one client via two vendors stay two; every outcome; existing sheet fixtures still load identically | L | Yes |
| C1c.3 | Historical `submitted_at` | Close the guard gap (`0019_review_hardening.sql:25-35` does not check `submitted_at`): refuse a client-set value unless `import_active()`; `GRANT INSERT (submitted_at)` to `authz_definer` (today `0033:354` omits it); loader sets `submittedOn`. | API cannot set it (new mass-assignment row); import can; 90-day duplicate warning uses it | S | Yes |
| C1c.4 | Rate type | `submission.rate_type`. | Matrix unchanged | S | Yes |
| C1c.5 | Submission contacts | `submission_contact` (FORCE RLS: submission readable **and** not via location grants); exporter column grant for `vendorContact*`. | Location roles see no contacts; differential RLS | M | Yes |
| C1c.6 | Layers | `submission_layer` (ordered) + first layer as implementation partner. | | S | Yes |
| C1c.7 | Requirement fields | vendor job id, description, job location, follow-up date. | | S | Yes |
| C1d.1 | Loader v2: interviews | Interviews by `submissionSourceId`, UTC, 60-minute default, overlaps → review, inserted before terminal outcomes. | Overlap held; no feedback email; call status per 4.3 | M | Yes |
| C1d.2 | Orphan interviews | Synthesised submission when vendor-or-client and role title exist, else `orphan_interview_incomplete`. | Both paths | S | Yes |
| C1d.3 | Interview details | `stage`, `mode`, `interviewer_name`, `meeting_url`, `technology`; exporter grant for `meetingLink`. | Column grants per role; `meeting_url` not consent-gated | M | Yes |
| C1d.4 | Reschedule chain | `rescheduled_from_id`. | | S | Yes |
| C1d.5 | Debrief | Debrief rating as `interview_feedback` kind `candidate`. | Append-only kept | S | Yes |
| C1e.1 | Historical mode: side effects and import-only employment writers | In `authz.create_placement`, `authz.transition_placement` and the 0045 employee triggers: when `import_historical()`, no `placement.*` / `employee.*` outbox rows, checklist items `waived` (`historical_import`). New definers `authz.import_end_assignment` and `authz.import_return_to_market` (owner `authz_definer`, no EXECUTE for any login role, refuse unless `import_historical()`), which reuse the 0045 state rules without the `assignment:update` / org `employee:read` check the Sales-acting loader cannot pass. | Each suppression on and off, in dry run and commit; the variants refused outside a historical load and from the API role; normal API path unchanged | L | Yes |
| C1e.2 | Historical mode: dates | Same gate: `joined_at`, `status_changed_at` (placement and submission), `assignment.start_date` back-dated from the plan. | API cannot back-date; import can only in historical batches | M | Yes |
| C1e.3 | Loader v2: placements | Placements in start order, `bench → active` between them, ends, `ended_before_start` and `crewnex_correction` backouts, synthesised submission for placements with no submittal, `vendor_mismatch`, `planned_end_date`. | Every replay row of 4.6; first-placement detection | L | Yes |
| C1e.4 | Bill and pay rate | `bill_rate`, `pay_rate`, `rate:read`-gated. | Matrix | S | Yes |
| C1e.5 | Placement entities | `placement.paperwork_entity_id`, `assignment.payroll_entity_id` (D9). | | S | Yes |
| C1e.6 | Placement contacts | Load `vendor_poc`; exporter grant. | | S | Yes |
| C1e.7 | Placement extras | layers, terms, pay frequency, timesheet portal, PO. | | S | Yes |
| C1f.1 | Reconciliation | `report --reconcile` vs `control-totals.json`; plus Trap A leads, Director coverage (section 3), review/held lists; ids only. | Fixture with seeded differences | M | Yes |
| C1f.2 | Feed and ownership locks (D7) | Feed batches: new person rows (ledger skip); a typed `crewnex_events` sheet (event `sourceId`, consultant `sourceId`, kind `readiness`/`deactivated`, `eventAt`) applied by `authz.import_apply_crewnex_event`, which only moves forward (`in_training → active`, `bench → active`, `→ terminated`) and records a no-op otherwise, ledger keyed by event id; `authz.transition_candidate` refuses those edges by hand for CrewNex-sourced candidates; `crewnex_feed` role script. | Event applied once; replay of the same event is a no-op; manual edges refused; backwards event reported, not applied | L | Yes |
| C1f.3 | Rehearsal | End to end on the fictional CrewNex-shaped fixture: export → stage → review → dry run → approve → commit → reconcile, in CI PostgreSQL (or a temporary staging stack, section 7). | The rehearsal itself, in CI | M | Yes |
| C1f.4 | Cutover | Runbook `docs/crewnex-cutover.md` (5.4), CrewNex freeze PR, `AuditLog` archive to the Object Lock bucket under `crewnex-archive/`, delete pre-cutover snapshots and SSM secrets. | Dry rehearsal of the runbook | S | Runbook yes; cutover needs prod |

### Phase C2: feature ports, by value

| # | Port | Depends on |
|---|---|---|
| C2.1 | Files: documents (new restricted types), resumes (latest approved current), contracts (NEW `contract` + permissions); a file-copy task streams Blob objects into `quarantine/` so every file is scanned | Q12, C1b |
| C2.2 | Submission and interview notes (`activity_note`, staff-only flag) | Q20 |
| C2.3 | Interview readiness: tech check, Tech Support role, technology-scoped support | Q7, Q8 |
| C2.4 | Notifications: interview tomorrow, weekly marketing digest, work-auth reminders (exists), tech-check reminders, as typed events in the 0046 registry | C1d |
| C2.5 | Marketing readiness checklist and gate (`in_training → active`) | C3 decision (the gate reads trainer/Otter verdicts) |
| C2.6 | Resume Team workflow (named resumes, versions, review, writer–lead links) | Q8 |
| C2.7 | Public intake forms → candidate creation (Turnstile, upload sessions, noindex) | design for a second public surface |
| C2.8 | Vendor master curation (merge, rename, archive) | C1a |
| C2.9 | Acceptable-use gate, issue reporting | Q27 |

Each port follows Eureka's definition of done (catalog permission, golden expectations, matrix rows, forced RLS,
Playwright journey) and is cut over like a C1 slice: CrewNex feature frozen, data delta imported, CrewNex page
read-only.

### Phase C3: the LMS decision

Options: **(A)** keep CrewNex as an LMS-only app (marketing pages removed, consultants keep signing in there);
**(B)** port the LMS into Eureka; **(C)** buy a hosted LMS and move content.

| Criterion | Why it decides |
|---|---|
| Consultant sign-in | Eureka authenticates Google Workspace accounts in the firm's domain (AS-04, A6.1). Consultants are not Workspace users. (B) needs a second identity provider or magic links, and a candidate-facing surface the design declares a non-goal. |
| Video delivery cost | R2 egress is free; CloudFront egress for ~800k delivered minutes/month is the largest line in section 7. |
| Coupling to marketing | The readiness gate (C2.5) reads trainer/Otter verdicts; under (A) or (C) the gate needs a feed from the LMS. |
| Data sensitivity | Quiz attempts, assignments, practice interview recordings: lower than documents; CrewNex's protections (lock, signed URLs, HMAC Worker) are adequate there. |
| Team capacity | (B) is ~30 models, a video pipeline, a Worker, grading and AI grading. |
| Cost retired | Only (B) or (C) retires Supabase and Vercel completely. |

Default recommendation for the decision meeting: **(A)** until the marketing slices are cut over, then decide
between (A) and (C) on measured usage; (B) only if consultant sign-in is wanted in Eureka for other reasons.

## 7. AWS cost

Baseline: **~$30/month** (infra/README "Cost": RDS db.t4g.micro single-AZ 20 GB, one 0.25 vCPU / 0.5 GB API task,
KMS, CloudFront + WAF on the Free flat-rate plan). The worker already runs on `FARGATE_SPOT`
(`infra/modules/stack/app.tf:760`): about **$2.5 + $3.65 IPv4** a month on top of the table, regardless of
CrewNex. Prices are us-east-1 list prices; verify before committing. Sources: aws.amazon.com/cloudfront/pricing,
docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html (Free: 1M requests,
100 GB; Pro: 10M requests, 50 TB; no overage charges, sustained overuse degrades instead),
aws.amazon.com/about-aws/whats-new/2025/02/amazon-guardduty-malware-protection-s3-price-reduction.

Volume assumptions (CrewNex publishes no counts; replace with real ones at C1a.7, whose manifest carries them):
2,000 consultants, 60,000 submittals, 15,000 interviews, 500 placements, 300,000 audit rows per year after
cutover, 20 GB of documents/resumes/contracts.

| Phase | Incremental Eureka cost / month | Basis |
|---|---|---|
| C1 build (C1a–C1f.3) | **+$0–35** | All increments test in CI PostgreSQL ($0). A temporary staging stack for rehearsals costs ~$25–35/month **while it exists** (infra/README); default: rehearse in CI (C1f.3) and create staging only if a real-AWS rehearsal is wanted, then destroy it. Real-data dry runs: export + import tasks (1 vCPU / 2 GB, ~30 min weekly) ≈ $0.10/month plus IPv4 while running. |
| C1f cutover onward | **+$15–22** | **CloudFront Pro flat-rate ($15)**: the Free plan's 1M requests a month will not carry the offshore Sales organisation moving in; enrol **before** cutover traffic (an upgrade is immediate and prorated). API Gateway ~$1 per million requests; CloudWatch logs and access-log ingestion a few dollars. Data: ~80k rows ≈ 0.1–0.3 GB, fits the 20 GB volume. |
| Audit growth | +$0 | 300k rows/year ≈ 0.3 GB/year; Object Lock export objects are small. |
| C2.1 files | **+$0.5–1**, plus **~$3–5 one-time** | S3 Standard 20 GB ≈ $0.46. GuardDuty Malware Protection for S3 at ~$0.09/GB scanned (after the 2025 price cut) plus a per-object charge: ~$3–5 for the 20 GB backlog, then upload volume. |
| C2.4 email | **+$1–3** | SES $0.10 per 1,000; CrewNex's 13 cron schedules (reminders, digests, every-30-minute tech-check reminders) estimated 10k–30k emails/month. |
| C2 general | **+$0–12** | API task to 1 GB if exports or the file copy need it (~+$3.5); `db.t4g.small` (+~$12) only if `CPUCreditBalance` keeps falling (guardrail alarm). |
| C3 (A) keep CrewNex LMS | +$0 on AWS | CrewNex keeps Supabase, Vercel, R2. |
| C3 (B) port LMS, video stays on R2 + Worker | **+$15–30** | **Cheapest.** Consultants sign in: second API task (+~$11), `db.t4g.small` (+~$12); R2 ~$3 (213 GB × $0.015) + Workers paid plan $5 stay on Cloudflare. |
| C3 (B) port LMS, video on S3 behind the **same** distribution under flat-rate Pro | **~$4–20** | S3 213 GB ≈ $3.75 after the plan's 50 GB S3 credit; transfer inside Pro's 50 TB allowance; risk: 10M requests a month shared with the app (Range requests per viewing minute) and a sustained overage degrades every user of the distribution, not just video. |
| C3 (B) video on pay-as-you-go CloudFront | **$250–2,000** | CrewNex videos are untranscoded (~1.3 GB per object, 2–5 Mbit/s): 800k min ≈ 12–30 TB a month at ~$0.06–0.085/GB. The distribution is `PriceClass_100` (`infra/modules/stack/edge.tf:219`), so viewers in India are served from North American/European edges at those rates (and with more latency). **Never** (guardrail). Measure real egress from R2 analytics before C3. |

CrewNex costs retired (list prices; actual plans are TODO in CrewNex `docs/Vendors.md`, Q28):

| Service | List price | Retired at |
|---|---|---|
| Supabase staging and e2e projects | ~$10 each on a Pro org (compute) | **C1f**, if CrewNex is reduced to LMS maintenance: the e2e project only serves CrewNex's E2E suite and staging its demo data. Cost of retiring: LMS changes after C1f run without CrewNex's E2E job. |
| Vercel seats | $20 per seat/month | **C1f**: down to one seat (the `*/30` cron still needs Pro) |
| Supabase Pro production | $25/month org + compute | Only when the last slice leaves: C3 (B) or (C). Under (A) it stays, with a smaller dataset. |
| Vercel Pro (last seat) + usage | $20 + usage | Same as Supabase production |
| Vercel Blob | ~$0.023/GB-month + operations | C2.1 for documents/resumes/contracts; LMS files at C3 |
| Upstash Redis | likely **$0** (free tier at this request volume) | With Vercel |
| Cloudflare R2 + Worker | ~$3–8 | Never under (A) or (B with R2); at C3 (C) |
| Sentry | free or Team plan | With Vercel |
| Turnstile | free | C2.7 (if Eureka takes intake) |

C1 and C2 retire little (two Supabase projects and Vercel seats); the bill drops substantially only at C3.

### Cost guardrails (C1a.0, first increment)

**Built.** `infra/modules/stack/cost.tf` (budgets, anomaly monitor, `local.migration_tags`, opt-in
`aws_ce_cost_allocation_tag`) and `alarms.tf` (SNS + alarms); runbook and thresholds in infra/README "Cost
guardrails". Two choices beyond the table: budgets and the monitor are created only once
`cost_allocation_tags_active` is set (step 3 below), and the SNS topics are unencrypted, because CloudWatch
cannot publish to the AWS-managed SNS key and a CMK costs $1/month per region for alarm names.

The production account is shared with spokenly (`infra/live/production/env.hcl`, account `637423353261`), so
account-wide budgets and per-service anomaly monitors would fire on spokenly's spend. Everything is **tag-scoped**:
provider default tags already set `Project = "Eureka"` (`infra/terragrunt.hcl:32-38`); C1a.0 adds
`Workstream = "crewnex"` to the resources the consolidation creates.

Tag activation is a sequence, not one apply: a cost-allocation tag can be activated only after the key has appeared
on **billed** usage, so `aws_ce_cost_allocation_tag` fails on a fresh key; activation takes up to 24 hours and is
not retroactive. Order: (1) deploy the tagged resources; (2) wait for the key to show in Billing; (3) apply the
activation and the tag-filtered budgets and monitor. If the account is a member of an AWS Organization, activation,
Budgets on linked accounts and Cost Explorer settings may need the payer account (Q35).

| Guardrail | Setting |
|---|---|
| Budget `Project=Eureka` | `cost_filter { name = "TagKeyValue", values = ["user:Project$Eureka"] }`; **$40/month** until C1f, **~$60** from C1f (baseline ~$30 + C1f $15–22 + worker ~$6); alerts at 50 %, 80 %, 100 % actual and 100 % forecast |
| Budget for **untagged** spend | `values = ["user:Project$"]` (no `Project` tag): ~$10/month. Catches SES, some data transfer, support/tax and anything else that carries no tag, including spokenly's until spokenly tags itself `Project=spokenly` (ask; until then this budget is noisy and the threshold is set from the first month's actuals) |
| Budget `Workstream=crewnex` | $15/month; covers the **migration tasks only** (exporter, import, rehearsal stack), not the steady-state cost of running Eureka |
| Anomaly detection | `CUSTOM` monitor with a Tags selector `Project=Eureka`; subscription threshold `ANOMALY_TOTAL_IMPACT_ABSOLUTE >= 10` (not a `DIMENSIONAL`/`SERVICE` monitor, which would see spokenly) |
| RDS alarms | `CPUCreditBalance < 50` and `FreeableMemory < 128 MB` for 15 minutes → `aws_sns_topic` with an email subscription (confirming the subscription is a hand step) |
| CloudFront | Alarm on `BytesDownloaded` above ~1 TB/month (video or a scrape on the app distribution); a monthly check that the distribution is still on the Pro plan |
| Log retention | The new exporter and import log groups set **7–14 days explicitly**; the existing groups use `var.log_retention_days` = 30 (`env.hcl:32`), which must not be inherited |
| Monthly review | Cost Explorer grouped by `Project` with "No tag key" visible, once a month |
| Rules | No task in a private subnet (it would need a NAT, $33/month each); delete pre-cutover manual RDS snapshots and the export SSM secret at C1f.4; video is **never** served on pay-as-you-go CloudFront; CloudFront Pro enrolled before cutover |

## 8. Risks and invariants

CrewNex `CLAUDE.md` traps the migration must not regress, and the Eureka mechanism that holds each.

| CrewNex invariant | Eureka mechanism | Where |
|---|---|---|
| DOB withheld from Trainer/Otter; visible to Offshore Recruiters by decision | DOB masked for everyone without `candidate.dob:read` (HR, Immigration); not stored until OD-04. Recruiters **lose** DOB (narrowing). | Q11 |
| Visa type/expiry withheld from Offshore Recruiter, Trainer, Otter; Director/Manager/Lead see it | `work_authorization` RLS `visa:read` (HR, Immigration). Leads and Managers **lose** it (narrowing). | Q10 |
| Personal email/phone only on the location chain; offshore works marketing email/Vitel | Eureka `candidate.phone:read` covers recruiters' teams: loading personal contacts **widens** access. Hashes only until decided. | Q9 |
| Rate tiers FULL / SAFE / ONSITE built by omission; per-row consultant visibility; no rate sort, filter or aggregate where withheld | `rate:read` grant + RLS/column policy; submission contacts behind their own policy (C1c.5); the "no sort/filter/aggregate on a withheld column" rule carries over to every new list endpoint (review checklist). Offshore recruiters and leads **lose** rates they see today (HANDOFF open question). | Q13 |
| Documents ≠ resumes ≠ contracts; offshore roles never in `DOCUMENT_ROLES` | Separate tables and permissions (`document:*`, `resume` under `document:read`, NEW `contract:*`); restricted documents need `document.restricted:read` + step-up. | C2.1 |
| Audit metadata holds field names, never values (except company identifiers) | HANDOFF rule 5 (no rates, phones, emails, free text in `audit_event`/`outbox_event`); import audit rows carry ids and statuses. CrewNex's value-history exemption for `marketingEmail`/Vitel is **not** carried: Eureka would need it as a column history, not audit (Q29). | C1b |
| Audit trail cannot be switched off | `audit_event` INSERT-only, Object Lock export; CrewNex audit archived under Object Lock. | C1f.4 |
| A Server Action is the boundary, not the page | Definer functions re-check permission and scope (rule 6); read-before-write 404/403. | all |
| Scope filters clobbered by spread / `OR` | Not reachable: scope is RLS, not a composed `where`. | — |
| `mode: insensitive` is a pattern match | `citext` equality; exporter does exact comparisons only. | C1a.7 |
| New table without RLS is public | FORCE RLS on every table + RLS coverage check in CI. | every migration |
| Enum added through a two-branch ternary; guards as allowlists | Exporter enum maps are exhaustive `Record`s and stop on an unknown value; mapping statuses are allowlists (unknown → review); CHECK constraints in Eureka. | C1a.7, C1a.8 |
| `endPlacement()` is the one project-end write path and resets readiness | `assignment.end_date` through the employee definer functions; readiness reset waits for C2.5. | C1e.3 |
| One open placement per consultant | One open pre-join placement per candidate (partial unique); joined placements → assignments. | C1e |
| Office changes only through `assignment.ts`; Trap A/B | Team moves through `team:move_member` definers; Trap B by the existing `candidate_team_invariant` (0006); Trap A and Director coverage reported at reconciliation. | C1b, C1f.1 |
| Soft delete fires no FK action; severing children | Eureka has no user delete; deactivation revokes sessions; reporting lines end by `valid` range. | C1b.1 |
| Single-session consultants | No consultant sign-in in C1–C2. | C3 |
| ET (America/New_York) for every timestamp; `datetime-local` has no zone | UTC storage; user zone plus **ET** (America/New_York, with daylight saving) for interviews. Design AS-05 says "EST"; CrewNex's trap is exactly a fixed UTC-5 reading an hour off for eight months, so Eureka screens must use the zone, not the abbreviation (check when C1d lands). Exporter writes UTC instants explicitly; `mapping.crewnex.json` sets `timeZone: "Etc/UTC"`, never relying on the import default `America/Chicago`. | C1a.8 |
| Calendar dates read in UTC | `@db.Date` exported as `YYYY-MM-DD` from the UTC value. | C1a.7 |
| Month-first date display | Eureka web formatting; ISO in all migration files. | — |
| Blob private; pathnames re-pinned on every read | S3 private, presigned GET 60 s / 5 min, fixed keys `clean/…/<id>`, no client-chosen paths. | C2.1 |
| Uploads two-phase; reaper | Quarantine prefix + 2-day lifecycle; scan job. | C2.1 |
| Nothing indexed; `/robots.txt` public | Eureka SPA behind sign-in; public feedback form; intake port must add noindex (C2.7). | C2.7 |
| Credential and policy gates | Google OIDC (no passwords); policy gate: Q27. | — |
| A test whose assertions sit behind an `if` | Every C-increment regression test is shown failing on the broken code before merge. | all |

Migration-specific risks:

| Risk | Mitigation |
|---|---|
| Real PII handled outside production | Exporter only in the prod ECS task; S3 prefix 7-day lifecycle; no laptop runs; fixtures fictional. Staged `import_row.raw`/`norm` hold the cells (personal contacts only as hash tokens, D4) until purge: `import_config.purge_days` default **30** (`0033_import_hardening.sql:66`), not 7; weekly dry runs therefore keep up to ~4 staged copies. Default: set `purge_days` to 7 for the CrewNex window and purge each batch after its reconciliation report. |
| CrewNex schema moves during the window (it ships daily) | Fingerprint check stops the export; exporter updated by PR. |
| Two writers during the overlap | Not possible: Eureka holds no CrewNex rows before the one commit (D1). After it, CrewNex writes only through the one-way feed (D7). |
| Same person from the sheets and from CrewNex | Ledger + live-match review; never auto-merge. |
| Users lose functions at cutover (consultant self-entry, DOB, visa, rates for offshore staff) | Listed in Q2, Q3, Q9–Q13 and answered before C1f, not discovered after. |
| CrewNex's per-company scoping for HR/Accounts/Immigration becomes org-wide | Q6; second approver for restricted roles still applies. |
| Eureka production not yet deployed | Only real-data dry runs and the cutover wait for it; every C1 increment is built and tested on fictional fixtures meanwhile (section 6). |
| A second cutover | Not designed (D1): after the one commit, Eureka edits cannot be re-derived from CrewNex. A rollback later than the first week, or a second import of the same data, needs a delta design first; until then it is not an option. |

## 9. Open questions for Ravi

Ask, don't guess (HANDOFF). Each has the default this plan uses until answered.

1. **Same firm?** Default: yes (owner's assumption); otherwise stop and redesign for multi-tenancy.
2. **Do consultants become Eureka users?** Default: no, through C2 (design A1 non-goal; consultants are not Workspace users). They keep signing in to CrewNex for training.
3. **Consultant self-entry of submissions and interviews after C1f.** CrewNex lets consultants log and edit their own. Default: recruiters enter them in Eureka; consultants lose self-entry and keep a read-only CrewNex view until C3.
4. **Offshore Director → `assoc_director` or `offshore_manager`?** And who holds `documents_team` / `bu_head`. Default: `assoc_director` (hierarchy scope matches the chain; `offshore_manager` is org-wide read-only).
5. **Coordinators.** Default (D8): account, no role. `location_ops_admin` would widen from own consultants to the whole location.
6. **HR, Associate HR, Accounts, Immigration widen from per-company / per-consultant to org scope**, and HR/Accounts gain DOB/restricted documents/rates per Eureka's grants. Default (D8): accounts, no roles, until answered (per-company scope would be a third axis).
7. **Interview Support's technology scope.** Default (D8): account, no role. Candidate mapping: `interview_coach` with coach assignments to the teams whose consultants are in their technologies.
8. **Tech Support, Contracts, Resume Team: new Eureka roles?** Default: no role until their port (C2.3, C2.1, C2.6); they keep CrewNex until then.
9. **Personal email and phone visible to offshore recruiters?** Default (D4): matched, not loaded (identity-only columns, C1a.4) until answered; the candidate feedback email, which needs `personal_email`, does not reach CrewNex-sourced candidates meanwhile.
10. **Visa type/expiry for Leads and Managers** (CrewNex shows it; Eureka: HR and Immigration only). Default: Eureka's narrower rule.
11. **DOB (OD-04).** Default: hash for matching, never stored.
12. **Document types:** add restricted `passport`, `state_id`, `i20`? US_CITIZEN as a non-record? Default: yes to the three types; US citizens get no work-authorisation record.
13. **Rates:** placement bill vs pay rate, and which one `rate` means until C1e.4; recruiters/leads lose rate visibility (existing HANDOFF question). Default: `rate` = bill rate; Eureka's `rate:read` grants unchanged.
14. **Placement states and orphans:** open placement with a past start → `joined` with assignment start = CrewNex start date; future start → `ready`; a placement or interview with no submittal gets a synthesised submission. Default: as stated.
15. **Historical placements:** no outbox notifications, paperwork items waived. Default: yes (C1a.3, C1e.1).
16. **Unmappable outcomes:** NO_RESPONSE → `rejected`/`no_response`, REQUIREMENT_CLOSED → `withdrawn`, NO_SHOW → `cancelled` + flag; is a typed outcome column wanted? Default: as stated, no new column.
17. **Deactivated and deleted consultants.** Default: DEACTIVATED → `terminated` (history kept); DELETED → not imported.
18. **Consultants with no Team Lead.** Default: review queue; the operator assigns a team before load.
19. **CrewNex audit log.** Default: final JSONL archive in the audit Object Lock bucket (3 years), not loaded into `audit_event`.
20. **Free-text notes** (submittal, interview, debrief, placement notes). Default: archived, loaded only with C2.2.
21. **Custom fields in use?** Default: none ported; values archived.
22. **Marketing status history** (`MarketingStatusEvent`) back-dated into `candidate_event`? Default: no (append-only, trigger-written); archived.
23. **Who signs off CrewNex batches:** org admins (import default) or also a business owner? Default: org admins, with the CEO reviewing the reconciliation report.
24. **CrewNex `Location` kind** (`training`, `gh`, `office`, `remote`) and offshore offices as `office` locations. Default: `training` and `office`.
25. **Legal entities on the candidate and per-location opt-ins.** (Placement side decided from the schema, D9.) Is `User.onboardingCompanyId` the candidate's offer-letter, E-Verify or 1099 entity in design terms, and do per-location opt-ins matter? Default: a NEW `candidate.onboarding_entity_id`; opt-ins dropped.
26. **Changes to CrewNex itself:** a per-environment script (audit-lockdown shape) that creates the `crewnex_export` role (`BYPASSRLS`, column-level grants, login only in the window) and the `crewnex_export_identity()` function, and a marketing write-freeze flag at C1f. Default: yes, as small CrewNex PRs when C1a.7 runs against real data and when C1f starts.
27. **Acceptable-use policy gate and issue reporting in Eureka?** Default: not ported; decide with C2.9.
28. **Actual CrewNex vendor costs** (Vendors.md business columns are TODO). Default: list prices in section 7.
29. **Marketing email / Vitel number holder history** (CrewNex keeps old and new values in audit). Default: not carried; add a holder-history table if "who held this number in June" must stay answerable.
30. **LMS direction (C3).** Default: (A) keep CrewNex as LMS-only, revisit after C1f with measured usage.
31. **Who creates consultants, ends training and deactivates leavers after C1f?** Default (D7): CrewNex, with a daily one-way feed of new consultants, readiness events and deactivations; Eureka refuses those transitions by hand for CrewNex-sourced candidates; column ownership as in 5.4. Alternative: Eureka creates candidates and CrewNex learns of them, which needs a feed the other way.
32. **Owner for consultants whose recruiter left.** Default (D6): the current Team Lead acts and owns; `recruiter_id` NULL. Alternative: a system import actor with an audited `on_behalf_of`.
33. **Location Manager and Location Admin lose consultant creation and stage moves** (Eureka location roles have no `candidate:create` or status transition). Accept, or add location-scoped grants to the catalog? Default: accept until C1f; consultant creation stays in CrewNex anyway (D7).
34. **Interview Support loses interview editing** (`interview_coach` has no `interview:update`). Accept, or a catalog change? Default: accept; they keep CrewNex until C2.3.
35. **AWS Organizations:** is account `637423353261` a member of an Organization? If so, cost-allocation tag activation, Budgets and Cost Explorer settings may need the payer account. Default: assume standalone; C1a.0's apply finds out.
