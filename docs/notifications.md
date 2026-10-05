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
     **Backlog cut-off (0051 review, F1):** an emailing event created before `OUTBOX_DELIVER_SINCE` is never
     emailed, whatever its channels: email-only types are published by `skipBacklog`; a type that also has an
     inbox gets its inbox rows (in-app, exactly once; low risk, and normally already delivered while mail was
     disabled) and is then published without `outbox_delivery` rows. An event whose emails had already started
     (delivery rows exist) is finished as before.
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

`aggregate_type` / `aggregate_id` are free (the delivery reads the payload; ids in the payload must be uuids, dates
`YYYY-MM-DD`). A payload that does not validate fails the event before anyone is notified (retried with backoff,
alert), so a producer and this registry cannot drift apart silently. The shapes below are what the merged
producers emit; `notifications.producers.int.test.ts` runs each producer through the delivery job end to end.

**Who decides the recipients: the registry, never the payload.** `authz.notification_recipients` resolves them
from the event type (role holders and/or the recruiter, team lead and manager around the record). A producer may
include a `notify` list (0042 and 0045 do); it is only checked to be a subset of the type's audience (listed in
the table), and a list naming anyone else, or not a list of strings, fails the event. A narrower list does not
narrow the audience. The one exception, kept from 0022-0024, is the placement events, whose `notify` groups select
among `hr`, `accounts`, `immigration`.

| Type | SRS | Producer | Payload | Recipients (active users; role holders valid now) | `notify` may name | Channels | Inbox opens |
|---|---|---|---|---|---|---|---|
| `placement.created`, `placement.state_changed` | PL-7 | placements (0022/0023) | unchanged | `hr`, `accounts`, `immigration` named in `notify` | those three | email | — |
| `work_authorization.expiring` | FR-NTF-11, FR-VIS-03 | 0042 job `visa-expiry` (`authz.work_auth_expiry_notices`) | `candidate_id`, `person_id`, `expires_on`, `threshold_days` (1..365, `WORK_AUTH_EXPIRY_NOTICE_DAYS`), `days_left` (0..threshold), `notify` | `hr`, `immigration` | `hr`, `immigration` | email + inbox | candidate |
| `employee.benched` | FR-NTF-09, FR-EMP-04 (project exit: an assignment ended, employee on the bench; bgc_failed after joining too) | 0045 trigger on assignment end (`authz.end_assignment`, `transition_placement`) | `personId`, `candidateId`, `assignmentId`, `placementId`, `endDate`, `endReason` ∈ {bgc_failed, completed, terminated, resigned}, `notify` | `hr`, `accounts`, `immigration` (admin teams), `bu_head`, `ceo` | those five | email + inbox | placement |
| `employee.exited` | exit from the company (same audience as FR-NTF-09) | 0045 `authz.exit_employee` | `personId`, `candidateId`, `lastAssignmentId`, `exitDate`, `exitReason` ∈ {resigned, terminated, other}, `notify` | `hr`, `accounts`, `immigration`, `bu_head`, `ceo` | those five | email + inbox | candidate |
| `assignment.ending_soon` | not in design B6 | 0045 job `assignment-ending-soon` (`authz.assignment_ending_soon_scan`) | `assignmentId`, `placementId`, `personId`, `candidateId`, `plannedEndDate`, `daysLeft` (0..365), `notify` | `hr`, `accounts` (conservative default) | `hr`, `accounts` | inbox only | placement |
| `employee.bench_time` | FR-NTF-05 (bench-time) | 0046 job `bench-time` (`authz.emit_bench_time`) | `candidateId`, `benchSince`, `benchDays`, `thresholdDays` | the candidate's recruiter, its team's lead, that lead's manager (reporting line), `ceo` | `recruiter`, `lead`, `manager`, `ceo` | email + inbox | candidate |
| `candidate.assigned` | FR-NTF-10, FR-EMP-05 (team assigned) | not emitted yet (team reassignment) | `candidateId`, `teamId` (the new team), optional `fromTeamId` | the lead of the candidate's current team (only while it equals `teamId`; otherwise nobody, the event alerts) and that lead's manager | `lead`, `manager` | email + inbox | candidate |
| `checklist.item_overdue` | FR-NTF-04 (paperwork pending), FR-NTF-03 / FR-VIS-04 (documents pending) | 0052 job `paperwork-overdue` (`authz.emit_paperwork_overdue`): outstanding (pending/received) items past `due_on` on placements not backed out, once per item and due date | `checklistItemId`, `placementId`, `daysOverdue` (0..3650), optional `assigneeId` | the placement's recruiter, the lead of its team snapshot, that lead's manager; plus `assigneeId` when that user holds `documents_team` and is the item's current assignee (checked by the resolver, 0052) | `recruiter`, `lead`, `manager`, `documents_team` | email + inbox | placement |
| `chat.direct_message` | internal chat (docs/chat-api.md CH-8) | 0070 `authz.chat_send`: a direct message whose recipient has not viewed the chat for 10 minutes and was not notified since their last view; never when muted, never for groups | `conversationId` (= aggregate id), `recipientId` | `recipientId` while a current member of that direct conversation | none | inbox | conversation (opens Chat) |

`employee.benched` (0045) is the move to the bench at project exit; `employee.bench_time` (0046) is the reminder
once a candidate has been on the bench for N days. Emails and inbox rows never show the dates, reasons or codes
in these payloads; they are validated only.

### Emitting a scheduled reminder once

Daily detection jobs should not depend on outbox rows to deduplicate (they are pruned after
`OUTBOX_RETENTION_DAYS`). From a definer function owned by `authz_definer`:

```sql
PERFORM authz.notification_emit_once(
  'paperwork-overdue',                                  -- job name
  ci.id::text || ':' || ci.due_on::text,                -- once-only key per item and due date (<= 200 chars)
  'checklist.item_overdue', 'checklist_item', ci.id,
  pg_catalog.jsonb_build_object('checklistItemId', ci.id, 'placementId', ci.placement_id,
    'daysOverdue', p_day - ci.due_on));
```

It records `(job, key)` in `eureka.notification_ledger` and writes the event only the first time (returns the
event id, or NULL when already emitted). Nobody but `authz_definer` can execute it; expose your own narrow
definer function (like `authz.emit_bench_time(day, threshold)`) to `eureka_worker`, and refuse future days.

## Scheduled jobs (worker)

| Job | Schedule | Run key | Notes |
|---|---|---|---|
| `outbox-delivery` | every tick | event id, or `inbox:<id>` (mail disabled) | above |
| `paperwork-overdue` | daily 07:30 America/New_York | the New York date | Always on. One `checklist.item_overdue` per checklist item and due date (ledger key `<item>:<due date>`; a new due date re-arms it); the database refuses a future day |
| `bench-time` | daily 07:45 America/New_York | the New York date | Only when `NOTIFY_BENCH_DAYS` is set (threshold is OD-05, open). One `employee.bench_time` per candidate and bench period (ledger key `candidate:bench_since`, whatever the threshold; a changed threshold does not re-notify), only for candidates whose N-th bench day falls within the last `NOTIFY_BENCH_WINDOW_DAYS` (default 7) days, so a first enable does not notify the whole bench; a worker down longer than the window misses those crossings. The database refuses a future day (0051) |
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
| `POST /api/v1/notifications/read-all` | `{ updated }`; strict body `{ before?: ISO time }` (only rows created at or before it, compared at the millisecond precision `createdAt` is listed with, so sending the newest item's `createdAt` includes it) |

The database sets `read_at` (the first read time is kept); nothing else in a row can change. The web app polls
the unread count every 60 s (no websockets), announces growth in a polite live region and opens the
placement or candidate when the user has that screen.

## Privileges (migrations 0046, 0051)

- `eureka_app`: SELECT own `notification` rows, UPDATE (`read_at`) own rows. Nothing on `inbox_fanout` or the ledger.
- `eureka_worker`: EXECUTE `authz.notification_recipients`, `authz.emit_bench_time`, `authz.emit_paperwork_overdue` (0052); `notification` SELECT of
  the key columns only (never titles or bodies), INSERT during fan-out for named recipients, DELETE past 30 days;
  `inbox_fanout` SELECT/INSERT. An inbox row's `entity_type`/`entity_id` must equal `authz.notification_entity(event)`
  (derived from the type and payload, 0051). Residual: titles and bodies are rendered by the worker from the fixed
  templates in `notify-types.ts`; the database bounds them (length, no control characters) but does not check the text. Still no access to candidate or placement rows, no outbox INSERT.
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
