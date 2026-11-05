# Candidate interview feedback API (public)

The only unauthenticated write surface for candidates outside the jobs portal. After an
interview ends, the worker (`feedbackEmailJob`, `apps/api/src/worker/jobs/feedback-email.ts`)
emails the candidate a link `<web origin>/feedback/<token>`; the web form calls the two routes
below. Code: `apps/api/src/modules/feedback/feedback.controller.ts`; database:
`eureka.feedback_view` / `eureka.feedback_submit` (migration 0021). Machine-readable entry:
`docs/openapi.json` (`tags: ["feedback"]`).

| Method | Path | Posture | Success |
|---|---|---|---|
| GET | `/api/public/feedback/:token` | `@Public()` (no session, no CSRF) | 200 |
| POST | `/api/public/feedback/:token` | `@Public()` (no session, no CSRF) | 201 |

## Token

- 32 random bytes, base64url, no padding: exactly 43 characters of `[A-Za-z0-9_-]`.
- Only its SHA-256 hex digest is stored (`feedback_delivery.token_hash`) and only the digest is
  passed to the database or the rate limiter; the token itself is never logged.
- One token per interview time slot. It is usable while all of these hold: not yet used,
  less than 48 hours since it was created, the interview still has the start/end it had when
  the email was prepared (a reschedule voids the link), and the call status is not
  `cancelled`, `rescheduled` or `no_invite`.
- Single use: a successful POST marks it used and erases the stored ciphertext.

## GET `/api/public/feedback/:token`

Reads what the form shows. Response:

```json
{ "firstName": "Ada", "clientName": "Acme" , "startsAt": "2026-11-04T15:00:00.000Z", "expiresAt": "2026-11-06T16:05:00.000Z" }
```

`clientName` is `null` when the interview has no client. Nothing else about the candidate or
interview is returned.

## POST `/api/public/feedback/:token`

Body (strict: unknown keys are refused with 422):

| Field | Type | Rules |
|---|---|---|
| `rating` | integer | required, 1–5 |
| `notes` | string | optional, trimmed, ≤ 4000 |
| `format` | string | optional, trimmed, ≤ 80 |
| `topics` | string[] | optional, ≤ 20 items, each trimmed ≤ 100 |
| `difficultQuestions` | string | optional, trimmed, ≤ 4000 |
| `durationMin` | integer | optional, 0–1440 |
| `nextStep` | string | optional, trimmed, ≤ 1000 |

Response `{ "submitted": true }`. In one transaction the definer function writes an
`interview_feedback` row (`kind = 'candidate'`, no author), marks the token used, and queues an
in-app notice to the interview's recruiter and coach (`feedbackNotificationJob`).

## Errors (application/problem+json)

| Status | When |
|---|---|
| 404 `Feedback link unavailable` | malformed token, unknown, expired, already used, interview rescheduled or cancelled. All cases look the same, so a caller cannot tell a used link from a wrong one |
| 422 | body fails the schema above (`errors[]` lists `path` and `message`, never the submitted values) |
| 429 `Too many requests` | rate limit (below) |

## Rate limits

Per API instance, in memory (`RateLimiter`), checked before the token format so guessing
malformed tokens is throttled too:

- 30 requests per minute per client address key. The address is the CloudFront viewer address
  (`x-eureka-viewer-ip`, trusted only behind the origin guard) or the socket address; IPv6 is
  keyed by its /64 (`ipKey` in `platform/client-ip.ts`). A refused address never adds a token key.
- 30 requests per minute per token digest, in a separate map, so a flood of distinct tokens
  cannot evict the per-address windows.

Edge (WAF) rate limits apply on top in deployed environments.

## Known gaps (audit D-11 follow-ups)

- The SQL still runs in the controller (`db.system`); moving it to a `FeedbackService` is open.
- 404 and 429 responses emit no dedicated log line or counter; spray attempts show only in
  request metrics and WAF logs.
