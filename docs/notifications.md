# Notifications: event types, delivery and the in-app inbox

Migration `0046_notifications.sql`. Design: A4 (notifications module), B2.5, B6; SRS FR-NTF-02..05 and 09..11.
Code: `apps/api/src/worker/notify-types.ts` (types, templates), `apps/api/src/worker/jobs/outbox.ts` (delivery),
`apps/api/src/worker/jobs/notifications.ts` (bench-time, inbox prune), `apps/api/src/modules/notifications` (API),
`apps/web/src/notifications/Inbox.tsx` (bell and panel).

## How it works

1. A module records an `outbox_event` row in the same transaction as the change, from a SECURITY DEFINER
   function owned by `authz_definer` (the outbox guard refuses every other writer). Payload: ids, dates,
   enum codes and counts only, never names, contacts, rates or free text (HANDOFF rule 5).
2. The worker job `outbox-delivery` (every tick, one `job_run` key per event) looks the type up in
   `EVENT_SPECS`, resolves the recipients in the database with `authz.notification_recipients(event)` and
   delivers each channel the type has:
   - **inbox**: one `eureka.notification` row per recipient plus the `inbox_fanout` marker, in one
     transaction (exactly once; the database refuses rows for anyone the resolver does not name, for a
     published event, or after the marker exists);
   - **email**: one `outbox_delivery` row per recipient, then the unchanged at-most-once send (re-check
     before each send, `sending` committed before the provider call, `in_doubt` never resent, rejection
     cap `OUTBOX_MAX_REJECTIONS`, `OUTBOX_DELIVER_SINCE` cut-off). One email per user even with several reasons.
3. The event is published when every channel is done. Without a mail mode (`OUTBOX_MAIL_MODE=disabled`) the
   job still runs: in-app-only events are delivered and published; events that also email get their inbox
   rows under the run key `inbox:<event id>` and stay unpublished until mail is enabled (as placement
   events always have). An event with no recipient stays unpublished and alerts (retried with backoff).
4. A type that is not in `EVENT_SPECS` is never delivered (and so never pruned): add the spec in the same
   change that starts emitting the type.

Deviation from design B2.5: there is no separate `notification_delivery` table. Email deliveries are the existing
`outbox_delivery` rows (per event and user); inbox rows are `notification` (per event and user, with
`entity_type`/`entity_id` as the entity ref and no `body` personal data).

Emails and inbox entries carry the event, enum labels, counts, an id reference and (email) a sign-in link
(`APP_PUBLIC_ORIGIN`). They never show names, rates, contacts, document types, expiry or end dates, or
reasons, even where the payload carries a date or code for validation.

## Event-type contract

`aggregate_type` / `aggregate_id` are free (the delivery reads the payload). All ids are uuids; dates are
`YYYY-MM-DD` strings; a payload that does not validate fails the event before anyone is notified.

| Type | SRS | Emitted by | Payload | Recipients (active users) | Channels | Inbox opens |
|---|---|---|---|---|---|---|
| `placement.created`, `placement.state_changed` | PL-7 | placements (0022/0023), on main | unchanged (`notify` groups) | holders of `hr`, `accounts`, `immigration` named in `notify` | email | — |
| `work_authorization.expiring` | FR-NTF-11, FR-VIS-03 | work authorization module (0042), daily job | `workAuthorizationId`, `candidateId`, `validTo`, `daysBefore` ∈ {90, 60, 30} | `hr`, `immigration` | email + inbox | candidate |
| `employee.exited` | FR-NTF-09, FR-EMP-04 (project exit, on assignment end) | employees/assignments (0045) | `assignmentId`, `placementId`, `candidateId`, `endDate`, `endReason` ∈ {`bgc_failed`, `completed`, `terminated`, `resigned`} | `hr`, `accounts`, `immigration` (admin teams), `bu_head`, `ceo` | email + inbox | placement |
| `employee.benched` | FR-NTF-05 (bench-time) | **this change**: job `bench-time`; others may emit the same shape | `candidateId`, `benchSince`, `benchDays`, `thresholdDays` | the candidate's recruiter, its team's lead, that lead's manager (reporting line), `ceo` | email + inbox | candidate |
| `candidate.assigned` | FR-NTF-10, FR-EMP-05 (team assigned) | employees (0045), bench → reassignment | `candidateId`, `teamId` (the new team), optional `fromTeamId` | the new team's lead and that lead's manager | email + inbox | candidate |
| `checklist.item_overdue` | FR-NTF-04 (paperwork pending), FR-NTF-03 / FR-VIS-04 (documents pending) | paperwork/BGC (0044), daily job | `checklistItemId`, `placementId`, `daysOverdue` (0..3650), optional `assigneeId` | the placement's recruiter, the lead of its team snapshot, that lead's manager; plus `assigneeId` when that user holds `documents_team` | email + inbox | placement |
| `assignment.ending_soon` | not in design B6 | employees/assignments (0045), daily job | `assignmentId`, `placementId`, `candidateId`, `endDate`, `daysBefore` (1..365) | `hr`, `accounts` (conservative default) | inbox only | placement |

### Emitting a scheduled reminder once

Daily detection jobs should not depend on outbox rows to deduplicate (they are pruned after
`OUTBOX_RETENTION_DAYS`). From a definer function owned by `authz_definer`:

```sql
PERFORM authz.notification_emit_once(
  'visa-expiry',                                   -- job name
  wa.id::text || ':' || wa.valid_to::text || ':60',  -- once-only key (<= 200 chars)
  'work_authorization.expiring', 'work_authorization', wa.id,
  pg_catalog.jsonb_build_object('workAuthorizationId', wa.id, 'candidateId', c.id,
    'validTo', wa.valid_to, 'daysBefore', 60));
```

It records `(job, key)` in `eureka.notification_ledger` and writes the event only the first time (returns the
event id, or NULL when already emitted). Nobody but `authz_definer` can execute it; expose your own narrow
definer function (like `authz.emit_bench_time(day, threshold)`) to `eureka_worker`, and refuse future days.

## Scheduled jobs (worker)

| Job | Schedule | Run key | Notes |
|---|---|---|---|
| `outbox-delivery` | every tick | event id, or `inbox:<id>` (mail disabled) | above |
| `bench-time` | daily 07:45 America/New_York | the New York date | Only when `NOTIFY_BENCH_DAYS` is set (threshold is OD-05, open). One `employee.benched` per candidate and bench period (`bench_since`) once on bench ≥ N days; the database refuses a future day |
| `notification-prune` | daily 04:30 America/New_York | UTC date (maintenance) | Deletes inbox rows older than `NOTIFICATION_RETENTION_DAYS` (default 180); the database refuses fewer than 30 days |

All are covered by time-travel tests on a fixed clock (`apps/api/test/notifications.int.test.ts`).

## In-app inbox API

All routes need a session; writes need the CSRF token. Every query names the session user and RLS
(`notification_own_read`, `notification_own_mark`) enforces the same.

| Route | Result |
|---|---|
| `GET /api/v1/notifications?limit=1..50&cursor=&unread=true` | `{ items: [{ id, type, title, body, entity: { type, id }, createdAt, readAt }], nextCursor }`, newest first |
| `GET /api/v1/notifications/unread-count` | `{ unread, capped }` (counted up to 1000) |
| `POST /api/v1/notifications/:id/read` / `/unread` | 204; body ignored; 404 when the row is not the caller's |
| `POST /api/v1/notifications/read-all` | `{ updated }`; strict body `{ before?: ISO time }` (only rows created at or before it) |

The database sets `read_at` (the first read time is kept); nothing else in a row can change. The web app polls
the unread count every 60 s (no websockets), announces growth in a polite live region and opens the
placement or candidate when the user has that screen.

## Privileges (migration 0046)

- `eureka_app`: SELECT own `notification` rows, UPDATE (`read_at`) own rows. Nothing on `inbox_fanout` or the ledger.
- `eureka_worker`: EXECUTE `authz.notification_recipients`, `authz.emit_bench_time`; `notification` SELECT of
  the key columns only (never titles or bodies), INSERT during fan-out for named recipients, DELETE past 30 days;
  `inbox_fanout` SELECT/INSERT. Still no access to candidate or placement rows, no outbox INSERT.
- `authz_definer`: SELECT (`id`, `type`, `payload`, `published_at`) on `outbox_event`; the ledger.
- Triggers refuse every other write (owner and superuser included): notification inserts only by the worker,
  updates only of `read_at` by the app, deletes only by the worker past 30 days, no TRUNCATE; markers go only
  with their pruned event; the ledger is append-only.

## Open questions and follow-ups

- **Preferences:** the design defines no per-user notification preferences (channel or type opt-out). Not built.
- **FR-NTF-02 candidate-unresponsive** ("warn candidate after N days without response"): not built. Nothing in
  the data records a candidate's response, the threshold is OD-05, and warning the candidate means emailing an
  external address with content to agree. Needs: what counts as a response, N, the message, and whether the
  recruiter is told instead or as well.
- **Bench POC (FR-NTF-05):** design lists "POC, TL, recruiter, manager, CEO"; who the POC is is undefined, so it is
  not a recipient. Threshold N (OD-05): the job is off until `NOTIFY_BENCH_DAYS` is set.
- **Admin teams (FR-NTF-09):** taken as HR, Accounts, Immigration; Associate HR is not included (same open
  question as for placement emails).
- **`assignment.ending_soon`:** not in the design; recipients (HR, Accounts) and inbox-only are a conservative
  default. Lead/Manager? Email?
- **Placement events:** still email-only to HR, Accounts, Immigration (HANDOFF open question unchanged). Adding the
  inbox channel is a one-line change in `EVENT_SPECS` once decided.
- **Retention:** inbox rows 180 days by default; the reminder ledger is kept (small); align both with AS-13.
