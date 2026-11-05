---
name: eureka-outbox-event
description: Add a notification event type, an outbox producer, or a scheduled worker job in Eureka. Use when a feature should "notify", "alert", "email", "remind", or run daily/periodically, or when touching apps/api/src/worker/**, eureka.outbox_event, notification_emit_once or docs/notifications.md.
---

# Eureka outbox event / worker job

Read first: `docs/notifications.md` sections "Event-type contract" and "Emitting a scheduled
reminder once" (grep the heading, read the range). Worker code: `apps/api/src/worker/`.

## Model

- Producers write `eureka.outbox_event (type, aggregate_type, aggregate_id, payload)` **from
  definer functions** — never from the API directly.
- The outbox-delivery job validates the payload against the registry, resolves recipients via
  `authz.notification_recipients` (registry decides, never the payload), sends email and/or inbox.
- A payload that fails validation fails the event (retried, alerts) — producers and registry
  can't drift silently.

## Payload rules (rule 5)

- Ids (uuid), type keys, enums, dates `YYYY-MM-DD`, small integers only.
- **Never** rates, phones, emails, names, free-text reasons, recording links. If the email needs
  details, read them at send time through a narrow definer fn (like `authz.interview_notice_details`).
- An optional `notify` list may only narrow within the type's audience; anything else fails.

## Steps for a new event type

1. Registry: add the type, payload validator and audience (see `src/worker/notify-types.ts`,
   `authz.notification_recipients` in `db/functions/authz/notification_recipients.sql` — edit that
   file, not a migration).
2. Recipient permission: `notify.<x>:receive` in `catalog.ts` (`eureka-authz-grant`).
3. Producer:
   - On a write: inside the definer function that does the write, `INSERT INTO eureka.outbox_event`.
   - Scheduled: a narrow definer fn (e.g. `authz.emit_<x>(p_day date, ...)`) granted to
     `eureka_worker` only, which calls `authz.notification_emit_once(job, key, type, agg_type,
     agg_id, payload)` for dedup (key ≤ 200 chars). Refuse future days.
4. Worker job: `src/worker/jobs/<x>.ts` exporting a `JobDefinition`; schedule via
   `src/worker/schedule.ts`; register in the runner; validate config ranges in the factory
   (see `benchTimeJob`).
5. Docs: add a row to the contract table in `docs/notifications.md`.
6. Tests: extend `test/notifications.producers.int.test.ts` (producer → delivery end-to-end);
   job behaviour in `test/worker.int.test.ts` or a module test. Assert payload has no PII keys.
