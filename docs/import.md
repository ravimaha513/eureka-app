# Sheet migration: CSV import

Design B9. Code in `apps/api/src/import/` (CLI) and `apps/api/src/modules/imports/` (API),
schema in `db/migrations/0028_import_staging.sql`, `0033_import_hardening.sql`, `0041_import_review.sql` and
`0086_import_team_workbook.sql`, fictional fixtures in `apps/api/test/fixtures/import/`.

## Who does what

| Step | Who | How |
|---|---|---|
| Ticket | Operator: signed-in org admin (`access:manage`) | `POST /api/v1/imports/tickets` returns a one-time ticket (valid `import_config.ticket_hours`, default 24 h). Its creator is recorded as the batch's operator |
| Stage, re-analyse, dry run, commit, report, purge | The CLI, as `eureka_import` | `cli.ts stage --ticket ...` etc. The CLI never names a person |
| Review decisions | Signed-in org admin | `POST /api/v1/imports/{id}/decisions` `{sheet, rowNo, action: approve|reject|link, salesRowNo?}`; then `cli.ts reanalyse` |
| Preview | The approving org admin | `GET /api/v1/imports/{id}/preview`: per clean row the person, owner, visibility and target status; counts per owner; whether the batch loads placements; the database's verification problems; and the digest |
| Sign-off | A second signed-in org admin (not the operator) | `POST /api/v1/imports/{id}/approve` `{digest}` quoting the preview it approves; refused while verification finds problems; valid `import_config.approval_days` (default 7) |
| Read | Org admins | `GET /api/v1/imports/{id}` (counts, approval, expiry), `GET /api/v1/imports/{id}/review` (sheet row numbers and reasons, no personal data) |

There is no web screen yet; the API is enough to run a migration (curl with a session cookie and
the CSRF header, as the e2e tests do).

## Flow

1. Export the Sales (Hot List), Interview and Placement sheets to CSV and upload them to the
   migration S3 prefix.
2. The operator creates a ticket. **stage** parses, normalizes, matches people across sheets and
   writes everything to the `import_*` tables. Nothing touches live tables. The same files and
   mapping re-analyse the open batch; a committed batch is final, so later fixes go to a new batch
   (new ticket) and the ledger skips everything already loaded.
3. **review**: rows that fail normalization, ambiguous or missing matches, probable duplicates and
   statuses the app cannot reach wait with a reason. Decisions are API calls; each one withdraws
   an approval of the batch, and sign-off is refused (`needs_analysis`) until `cli.ts reanalyse`
   (one transaction, batch row locked) has applied them.
4. **commit** (no flag): dry run through the real database functions, always rolled back.
5. **preview and approve** (second admin). The database first re-checks what it can from the
   stored cells and the batch's own mapping (`authz.import_verify_batch`): state against reasons
   (clean means no reasons, review means some); each clean row's owner against the owner column;
   a sales row's target status and visibility against the status/row-colour mapping; the person
   link; live duplicates only with an approve decision that accepted them; placements only when
   the batch loads them. Any problem blocks approval. The approval quotes the preview's digest,
   which covers `placements_commit` and every row's id, sheet, row number, row key, person key,
   status key, state, normalized values and reasons. Row writes take the batch row `FOR SHARE`,
   so they serialize with approval; from then on the CLI cannot change the rows.
6. **commit --commit**: loads the clean rows. Each person is checked against the digest, the
   approval's expiry, the approver and operator (both still active org admins) and the decisions:
   rows rejected, linked elsewhere or decided after the approval are not loaded.
7. **report** at any point; **purge** any batch, and `purge --expired` for batches older than
   `import_config.purge_days` (default 30), whatever their status.

## Excel files and LLM column mapping

`stage` accepts `.xlsx` as well as CSV (first sheet; converted to CSV text, so hashes and row numbers
work as before; the header must be on row 1, otherwise staging says which row it is on). Because every
team keeps a different template, `cli.ts propose-mapping --file x.xlsx [--sheet S] [--kind sales] [--out m.json]`
asks an LLM (`ANTHROPIC_API_KEY`, `IMPORT_LLM_MODEL`, default `claude-sonnet-5-5`) which header is which field.
It needs no database. Rules (`apps/api/src/import/llm-mapper.ts`):

- The model gets headers and at most 5 shape-masked samples per column ("Asha Rao" -> "Aaaa Aaa"), never rows.
  Real values go only for small repeated vocabularies with nothing email-, phone- or id-like (statuses, technologies).
- Day/month order is detected locally from all rows. Status and row-colour meanings are not proposed (SRS Q6).
- Its answer is checked against the real headers and field list; invented fields/headers and reused headers are dropped and reported.
- Output is an ordinary mapping JSON passed through `parseMapping`; an admin reviews it, then `stage --mapping m.json`.
  Review, digest and second-person approval are unchanged. Run it where the files may be (the ECS task), not on a laptop.

## Team workbooks

Recruiting managers keep one Google Sheets workbook with a `Submissions`, `Interviews` and `Placements` tab
per team lead ("Rohit Submissions", ...), usually `IMPORTRANGE` copies of each team's own sheet. Download it
as `.xlsx` and stage it whole:

```sh
cli workbook --file team.xlsx [--as-of 2026-10-10]          # no database: how the tabs are read, counts only
cli stage --workbook team.xlsx --ticket <ticket> [--mapping m.json] [--as-of 2026-10-10]
```

Reading (`xlsx.ts`): cells hold the formulas' cached results (Google's export wraps every cell in
`IFERROR(__xludf.DUMMYFUNCTION("IMPORTRANGE(...)"), <value>)`); error results (`#VALUE!`, `#N/A`) are blank. Each
tab's `IMPORTRANGE` range (`Submissions!A:I`) says what it holds; a tab without one (pasted values) is classified
by its name, then by its headers. Other tabs are ignored and listed.

The adapter (`team-workbook.ts`) writes the importer's four sheets, so review, digest, sign-off and the loader are
unchanged. Everything it derives is in the generated rows (with `Source Tab` and `Source Row`):

| Generated | Rule |
|---|---|
| People (`sales`) | One row per candidate name across all tabs (`Candidate Ref` = the name's letters, matched like an email). Owner: the recruiter with the most submissions. `Active/All Teams` when more than one team submitted the candidate. Phone from the placement tab. Location: the owner's primary location (`sheets.sales.locationFromOwner`) |
| Submissions | One per row, `submitted_at` = noon of the row's date (mapping time zone), with its rate. Job title = technology (the tabs have none). "Implementer / End client" gives the end client |
| Interviews | The tabs have no client. If the candidate was submitted to exactly one client in the 30 days before, that client is filled in and marked `Client Inferred` (reason `inferred_client`, approvable); otherwise `missing:client` (review until the sheet gets a Client column). Call status: Scheduled after `--as-of`, else Completed. Time: `defaults.interviewTime` |
| Placements | Status from BGV status and joining date (Done/Cleared and joined by `--as-of`: Joined; cleared: Ready; ongoing: BGC; not cleared/failed: BGC Failed). Placement type and work mode are not in the tabs, so placements wait in review (`missing:placementType`, `missing:workMode`); `placements.commit` stays off |

The default mapping for workbooks is `mapping.team-workbook.json`:

- `owners`: recruiter names as typed -> user email, for spelling variants. A name that is exactly one active user's
  display name needs no entry. Owners resolve the same way in the analysis and in the database
  (`authz.import_owner`): email, then `owners`, then a unique display name; otherwise `unknown_owner` /
  `ambiguous_owner`.
- `references.create`: clients, vendors and implementation partners not in the lists are added by the loader
  (case-insensitively: "Fabrikam" and "fabrikam" are one vendor). The preview lists every new name
  (`newReferences`); verification refuses a new name the batch's mapping does not allow. `references.ignore`
  ("confidential", "not disclosed", ...) counts as blank, so those submissions wait as `missing:client`.
- `technologies`: aliases to the technology list. The list itself is reference data: a technology the org does not
  have (`unknown_technology`) holds the candidate and all their rows until it is added or aliased.

Re-staging a later download: people are recognised by `Candidate Ref` (`person_already_imported`), loaded rows by
their row key, and a submission row whose cells changed by its natural key (candidate, client, job title, vendor,
date), so nothing loads twice. Staging depends on `--as-of`; pass the same date to re-analyse an open batch.

## Where it runs

As a one-off ECS task in the VPC (the API image, command
`pnpm --filter @eureka/api exec tsx src/import/cli.ts ...`), reading the CSVs from a dedicated S3
prefix with a short lifecycle (delete after 7 days) and SSE-KMS. Never on a laptop: the files
hold candidates' personal data. Secrets come from Secrets Manager: `IMPORT_DATABASE_URL` (no
password in it; `PGPASSWORD`) and `IMPORT_HMAC_KEY` (at least 32 characters; keyed hashes of row
and identity keys; keep it for the whole migration, or re-runs stop recognising rows).

Runbook for the migration window (as the migration user, from the same task):

```sh
psql "$MIGRATION_DATABASE_URL"
  \password eureka_import                                   -- prompts; never on a command line
  ALTER ROLE eureka_import LOGIN VALID UNTIL '<end of window>';
```

Closing the window:

```sql
ALTER ROLE eureka_import NOLOGIN PASSWORD NULL;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'eureka_import';
```

```sh
cli() { pnpm --filter @eureka/api exec tsx src/import/cli.ts "$@"; }
cli stage --sales sales.csv [--submissions submissions.csv] --interviews interviews.csv --placements placements.csv --ticket <ticket> [--mapping m.json]
cli stage --workbook team.xlsx --ticket <ticket> [--as-of YYYY-MM-DD]   # see "Team workbooks"
cli review    --batch <id>
cli reanalyse --batch <id>          # after decisions made in the API
cli commit    --batch <id>          # dry run
cli commit    --batch <id> --commit # after approval
cli report    --batch <id>          # --json for machine-readable output
cli purge     --batch <id>   |   cli purge --expired
```

## Mapping file

design.md does not fix the sheet layouts, so `apps/api/src/import/mapping.default.json` holds
column headers per sheet, status texts, row colours, technology aliases (to names in the
technology list), time-zone abbreviations, the default phone region and per-column date orders
(`sheets.<sheet>.dateOrders`, e.g. `{"dob": "DMY"}`). Labels are matched case- and
spacing-insensitively.

**Statuses and row colours are placeholders until SRS Q6 is answered.** A `null` entry means
"known label, meaning not confirmed"; it goes to review exactly like an unmapped label. Only the
literal status names of design B2.6 are mapped (`Active/Remote` maps to `active`; there is no
`work_mode_pref` column yet). Row colours are not in a CSV export: add a helper column (for
example with Apps Script) holding each row's background colour and map it under `rowColors`.
When text and colour are both mapped they must agree.

`placements.commit` is `false` by default and is copied onto the batch when it opens
(`import_batch.placements_commit`, immutable, shown in the preview, part of the digest); changing
the mapping later does not change an open batch. Loading a placement runs `authz.create_placement`,
which queues `placement.created` outbox events for HR, Accounts and Immigration (open question).

## Normalization and matching

| Field | Rule |
|---|---|
| Names | Trimmed; all-caps or all-lowercase cells title-cased; one "Name" cell may be `First Last` or `Last, First`. Matching keys keep letters of every script |
| Emails | Lower-cased, `mailto:` removed; several addresses in one cell go to review |
| Phones | E.164. With `phoneRegion: "US"`, 10 digits (or 11 starting with 1) with an *assigned* +1 area code; anything else needs `+` or `00` and no trunk 0 after the country code (`+44 (0)20...` goes to review). With `phoneRegion: null` every number needs its country code |
| Dates | ISO, `D/M/Y` or `M/D/Y`, `4-Aug-2026`, `Aug 4, 2026`, Sheets serials. With `detect`, a part above 12 decides per row and ambiguous values go to review; a column configured `MDY`/`DMY` resolves them and flags contradicting values (`date_order_conflict`) |
| DOB | Only for matching: must be plausible (age 16 to 80); staging replaces the cell with a keyed hash (`#dob:<hmac>`), so no date of birth is stored |
| Interview times | Local date + time + zone (default `America/Chicago`), end time or duration (default 60 min) |
| Rates | Hourly only (`$65/hr`, `65`); annual or out-of-range values go to review |

People are matched across sheets (design B9) by email (marketing or personal), then phone. Name
+ DOB and a name alone are only suggestions for review (`name_dob_match`, `name_only_match`).
A sales row sharing an email, phone or name + DOB with an earlier one is a probable duplicate. A
sales row whose email or phone belongs to a live candidate not created by the import goes to
review (`authz.import_live_match(row id)`, yes/no only). People loaded earlier are recognised by
email or phone through a ledger of keyed identity hashes; a name + DOB match with one of them
goes to review (`matches_imported_person`).

## Review reasons

Field reasons are `<code>:<field>`, for example `ambiguous_date:dob` or `unknown_client:client`.
**approve** is accepted only when every reason on the row is approvable: problems in optional
fields (phone, emails, DOB, priority, marketing start date, vendor, implementation partner,
rate, project city or state, status reason; the value is dropped) and `probable_duplicate`,
`possible_duplicate_name`, `matches_existing_candidate`, `matches_imported_person`,
`name_only_match`, `name_dob_match`, `inferred_client` (the suggestion is accepted). The decision records the
reasons it accepted; re-analysis clears only those, so a new problem stays in review. Everything
else needs the sheet, the mapping or the reference lists fixed and a new stage. **link** attaches
an interview or placement row to a sales row (or marks a sales row as a duplicate of it);
**reject** drops a row. Decisions are kept per source row and survive re-staging.

Rows end in exactly one state: `clean`, `held` (fine, but its person cannot load, or placements
are off), `review`, `rejected` (`duplicate_row`, `rejected_by_reviewer`, `merged_into_row`),
`skipped` (`already_imported`, `person_already_imported`) or `committed`.

## What the commit does

For each person, the CLI calls `authz.import_load_person(batch, row, dry_run)` (SECURITY DEFINER,
executable only by `eureka_import`). In one transaction it:

- checks the batch is approved, the approval has not expired and the rows match the approved
  digest; selects the person's clean rows, leaving out rows rejected, linked elsewhere or decided
  after the approval
- checks each acting owner (the "Recruiter Email" column; interview and placement rows default to
  the candidate's owner; later activity on an imported submission acts as its submitter) is
  active and holds a Sales role, and acts as them only while the call runs
- inserts the person and candidate under the same checks as `POST /candidates` (policies for the
  definer mirror the API role's), with the sheet's visibility (`Active/All Teams`) as part of the
  approved batch; then the profile fields through the column guard
- moves statuses only with `authz.transition_candidate`, `authz.transition_submission`,
  `authz.create_placement` and `authz.transition_placement`, one step at a time
- writes the API's audit events with `source: "import"`, the batch and the operator
- records the ledger: source rows, keyed identity hashes, and natural keys (interview: candidate,
  client, job title, round, start date; placement: submission, tentative start). An edited sheet
  row whose natural key exists updates that interview's time or call status, or moves that
  placement forward, instead of creating a second one

A failure (an RLS refusal, an overlapping interview, an inactive owner) rolls back that person
only; `review` shows the error and the rows stay clean for the next run. The batch becomes
`committed` when no clean rows remain. Imported interviews that had already ended when loaded
never trigger the candidate feedback email.

Not loaded: DOB, historical dates of submissions created from interview or placement rows (a
`submissions` sheet row keeps its date), interview clearing and consent (location admin fields),
placement contacts, `bench` (no app path yet). From team workbooks also not loaded yet (kept in
staging): interview type beyond the round name, support person, client and candidate feedback,
rejection reason, BGV status, marketing and E-Verify companies (no fields for them yet).

## Roles and safeguards

- `eureka_import`: `NOLOGIN` outside the window, no BYPASSRLS, no role memberships, owns nothing.
  It reads reference lists, staff emails and the `import_*` tables, writes rows only while a batch
  is staged, and executes four functions: `import_open_batch`, `import_live_match`,
  `import_load_person`, `import_finish_batch`. It cannot create tickets, decide, approve, or read
  or write live tables. In its sessions `authz.current_user_id()` returns NULL unless an import
  call is running in the same transaction and backend: `eureka.import_session` has a row for it,
  written only by `authz_definer` (`import_begin` / `import_end`). The loader's insert policies
  check the same marker. The role cannot write the marker. It is never a member of another role:
  0033 revokes any such grant (and fails if it cannot), and the API refuses to start and the
  restore drill reports a problem if a membership exists.
- The API role executes `import_create_ticket`, `import_decide`, `import_approve_batch`,
  `import_batch_summary`, `import_review_rows`, `import_load_preview`; each re-checks
  `access:manage` in the database. The preview holds names and owner emails: org admins only.
- Staging holds personal data (no DOB) until purged; the ledger keeps only ids and keyed hashes.

## Fixtures and tests

`apps/api/test/fixtures/import/*.csv` are fictional (the fixture org's users, `Java`, `Dallas`,
`Austin`, `Northwind Financial`). Hand counts: sales 19 rows (8 clean, 10 review, 1 exact
duplicate); interviews 12 (5 clean, 6 review, 1 held); placements 5 (2 clean, 3 review).
`test/import.int.test.ts` covers tickets, staging, the review queue and sign-off through the API,
dry run, commit, idempotent re-runs, natural-key updates of edited rows, decisions after
approval, approval expiry and digest checks, purge, that `eureka_import` cannot act as anyone,
and that imported rows are visible per RLS exactly as the engine allows. `src/import/*.test.ts`
covers the parser, every normalizer and the matching rules.

## Open questions

- SRS Q6: the real status and row-colour mapping (placeholders in the mapping file).
- May historical placements emit `placement.created` outbox events? Hence `placements.commit: false`.
- `joined` placements start their assignment on the commit date; confirm, or record the sheet's date.
- Sign-off by `access:manage` (org admin) as assumed here, or by a business owner?
- Visibility `all_teams` from the sheet is set by the import (approved batch) rather than by a lead.
