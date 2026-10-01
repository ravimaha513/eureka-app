# Sheet migration: CSV import

Design B9. Code in `apps/api/src/import/`, schema in `db/migrations/0028_import_staging.sql`,
fictional fixtures in `apps/api/test/fixtures/import/`.

## Flow

1. Export the Sales (Hot List), Interview and Placement sheets to CSV.
2. **stage**: parse, normalize, match people across sheets and write everything to the
   `import_*` staging tables. Nothing touches live tables. Same files and mapping = same batch.
3. **review**: rows that fail normalization, ambiguous or missing matches, probable duplicates and
   statuses the app cannot reach wait in the review queue with a reason. Reviewers approve, reject
   or link rows; the batch is re-analysed after each decision.
4. **commit** (no flag): dry run. Loads every clean row through the real guards and rolls back,
   printing what would load and any failure.
5. **approve**: sign-off by an active org admin (`access:manage`) who did not stage the batch.
6. **commit --commit**: loads the clean rows. Re-runs never load a row twice.
7. **report** at any point; **purge** clears the stored cells once a batch is committed.

## Running it

The CLI connects as `eureka_import`, which is `NOLOGIN` by default. For the migration window:

```sh
psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE eureka_import LOGIN PASSWORD '<generated>'"
export IMPORT_DATABASE_URL=postgres://eureka_import:<generated>@<host>/<db>
cli() { pnpm --filter @eureka/api exec tsx src/import/cli.ts "$@"; }

cli stage --sales sales.csv --interviews interviews.csv --placements placements.csv \
          --operator you@company [--mapping my-mapping.json]
cli review  --batch <id>
cli resolve --batch <id> --sheet sales --row 5 --action approve --by reviewer@company
cli resolve --batch <id> --sheet interviews --row 6 --action link --sales-row 14 --by reviewer@company
cli commit  --batch <id>                   # dry run
cli approve --batch <id> --by org-admin@company
cli commit  --batch <id> --commit
cli report  --batch <id>                   # add --json for machine-readable output
cli purge   --batch <id>
# afterwards
psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE eureka_import NOLOGIN PASSWORD NULL"
```

Paths are relative to `apps/api` when run through `pnpm --filter`. The CLI refuses any
connection that is not `eureka_import`.

## Mapping file

design.md does not fix the sheet layouts, so `apps/api/src/import/mapping.default.json` holds
column headers per sheet, status texts, row colours, technology aliases (to names in the
technology list) and time-zone abbreviations. Labels are matched case- and spacing-insensitively.

**Statuses and row colours are placeholders until SRS Q6 is answered.** A `null` entry means
"known label, meaning not confirmed"; it goes to review exactly like an unmapped label. Only the
literal status names of design B2.6 are mapped (`Active/Remote` maps to `active`; there is no
`work_mode_pref` column yet, so the remote preference is not stored). Row colours are not in a
CSV export: add a helper column (for example with Apps Script) holding each row's background
colour and map it under `rowColors`. When text and colour are both mapped they must agree.

`placements.commit` is `false` by default: loading a placement runs `authz.create_placement`,
which also queues `placement.created` outbox events for HR, Accounts and Immigration (see open
questions). Until it is turned on, placement rows are staged and reconciled but held.

## Normalization and matching

| Field | Rule |
|---|---|
| Names | Trimmed; all-caps or all-lowercase cells title-cased; one "Name" cell may be `First Last` or `Last, First` |
| Emails | Lower-cased, `mailto:` removed; several addresses in one cell go to review |
| Phones | E.164; 10 digits or 11 starting with 1 are US/Canada (+1, valid area code and exchange); other countries need `+` or `00` |
| Dates | ISO, `D/M/Y` or `M/D/Y`, `4-Aug-2026`, `Aug 4, 2026`, Sheets serials. Day/month order is detected per row; when both parts are 12 or less and differ the row goes to review unless the sheet sets `dateOrder` |
| Interview times | Local date + time + zone (default `America/Chicago`), end time or duration (default 60 min) |
| Rates | Hourly only (`$65/hr`, `65`); annual or out-of-range values go to review |

People are matched across sheets (design B9) by email (marketing or personal), then phone, then
name + DOB; a name alone is only a suggestion for review. Each sales row is a person; a later
sales row sharing an email, phone or name + DOB with an earlier one is a probable duplicate. A
sales row whose email or phone belongs to a live candidate not created by the import goes to
review (`authz.import_live_match`, a yes/no answer only). People loaded by an earlier batch are
recognised through a ledger of SHA-256 identity hashes.

## Review reasons

Field reasons are `<code>:<field>`, for example `ambiguous_date:dob` or `unknown_client:client`.
A reviewer can **approve** a row only when every reason is approvable: problems in optional
fields (phone, emails, DOB, priority, marketing start date, vendor, implementation partner,
rate, project city or state, status reason; the value is dropped) and `probable_duplicate`,
`possible_duplicate_name`, `matches_existing_candidate`, `name_only_match` (the suggestion is
accepted). Everything else (`unmapped_status`, `unconfirmed_status`, `unmapped_row_color`,
`status_color_conflict`, `missing:*`, `unknown_owner`, `unknown_technology`, `unknown_client`,
`invalid_time`, `ambiguous_date` on required dates, `status_not_importable`,
`status_requires_placement`, `status_conflicts_with_placement`, `multiple_open_placements`,
`placement_status_not_importable`) needs the sheet, the mapping or the reference lists fixed and
a new `stage`. **link** attaches an interview or placement row to a sales row (or marks a sales
row as a duplicate of it); **reject** drops a row. Decisions are kept per source row, so they
survive re-staging.

Rows end in exactly one state: `clean`, `held` (fine, but its person cannot load, or placements
are off), `review`, `rejected` (`duplicate_row`, `rejected_by_reviewer`, `merged_into_row`),
`skipped` (`already_imported`, `person_already_imported`) or `committed`.

## What the commit does

For each person (a clean sales row and its clean interview and placement rows, or new activity
for a person loaded earlier), in one transaction, as `eureka_app` with `eureka.user_id` set to
the row's owner (the "Recruiter Email" column; interview and placement rows default to the
candidate's owner):

- creates the person and candidate exactly as `POST /candidates` does (team = the owner's team;
  recruiter = the owner if they hold the recruiter role), then the profile fields
- moves the status with `authz.transition_candidate` (in_training -> active -> sheet status);
  `Active/All Teams` sets visibility as the team's lead, as the app requires
- creates one submission per candidate, client and job title, walks it forward one step at a
  time with `authz.transition_submission` (to `interview_scheduled`, `interview_completed` or
  `selected`), inserts interviews and sets their call status; later activity on an imported
  submission acts as its submitter
- creates placements with `authz.create_placement` and walks them with
  `authz.transition_placement` (backouts use the sheet's reason or the configured default)
- writes the same audit events as the API, with `source: "import"` and the batch id

Any failure (an RLS refusal, an overlapping interview, an inactive owner) rolls back that person
only; the error is shown by `review` and the rows stay clean for the next run. The batch becomes
`committed` when no clean rows remain.

Imported interviews are history: 0028 replaces `eureka.feedback_due()` so the candidate
feedback-email job skips interviews recorded in the import ledger.

Not loaded: DOB (only used for matching; encrypted DOB is Phase 3), historical submission dates
(the database sets them), interview clearing and consent (location admin fields), placement
contacts, `bench` (no app path yet).

## Roles and safeguards

- `eureka_import`: `NOLOGIN` by default, no BYPASSRLS, owns nothing; reads reference lists and
  staff emails, reads and writes the `import_*` tables (RLS forced, no access for the API or
  worker roles), and may `SET ROLE eureka_app` (not inherited) to act for a row's owner.
- `import_batch.status` and approval columns are server-managed (trigger); only
  `authz.import_approve_batch` (executable by `eureka_app` only) approves. The ledger
  (`import_link`, `import_identity`) refuses rows of a batch that is not approved, and any review
  decision withdraws the approval of every batch holding that row.
- Staging holds personal data until `purge`; the ledger keeps only ids and hashes.

## Fixtures and tests

`apps/api/test/fixtures/import/*.csv` are fictional (the fixture org's users, `Java`, `Dallas`,
`Austin`, `Northwind Financial`). Hand counts: sales 19 rows (8 clean, 10 review, 1 exact
duplicate); interviews 12 (6 clean, 5 review, 1 held); placements 5 (2 clean, 3 review).
`test/import.int.test.ts` checks staging, review, sign-off, dry run, commit, idempotent re-runs,
reconciliation totals and that imported rows are visible per RLS exactly as the engine allows;
`src/import/*.test.ts` covers the parser, every normalizer and the matching rules.

## Open questions

- SRS Q6: the real status and row-colour mapping (placeholders in the mapping file).
- May historical placements emit `placement.created` outbox events (HR, Accounts, Immigration
  would be notified once delivery is built)? Hence `placements.commit: false` by default.
- `joined` placements start their assignment on the commit date (assignment start = the day
  marked joined); confirm, or record the sheet's join date.
- Sign-off by `access:manage` (org admin) as assumed here, or by a business owner?
- Acting as the API role: `eureka_import` can `SET ROLE eureka_app` (0019 removed this for the
  worker). It is limited to the migration window by `NOLOGIN`; confirm this is acceptable.
