---
name: eureka-mass-assignment
description: Add mass-assignment test cases for new or changed POST/PUT/PATCH routes in apps/api/test/mass-assignment.cases.ts. Use when adding any write endpoint, when the mass-assignment coverage test fails, or when checking that clients can't set server-managed fields (ids, status, snapshots, timestamps, row_version, owner/team).
---

# Mass-assignment cases

`apps/api/test/mass-assignment.cases.ts` is **large** — never read it whole. Grep for a
neighbouring route of the same module and read that range.

## What it tests

For every POST/PUT/PATCH route registered in `AppModule`, the request carries — one at a time —
server-managed or foreign fields (ids, status, owner/recruiter/team/location snapshots,
timestamps, row_version, audit and scope fields) on top of an otherwise valid body. Expect
**422** from the strict schema, the unknown key as the only issue, and **no change** in the
rows the endpoint writes or in the audit log. Routes with no body: the effect must come from the
URL and session only.

The route list is read from controllers, so **a new write route with no case fails the
coverage test** — that's usually how you get here.

## Steps

1. `grep -n "interface RejectCase\|^const SERVER_MANAGED\|^const IGNORED\|^const CASES\|route: \"[A-Z]* /api/v1/<area>" apps/api/test/mass-assignment.cases.ts`
   — locate the case type, the shared field set, and a sibling case.
2. Read the sibling (and its `<area>Cases()` function / `<AREA>_FORBIDDEN` map, ~40 lines).
   Each `RejectCase` has:
   - `route`: `"METHOD /path"` exactly as the controller declares it (`:id` params included);
   - `actor`: fixture user key allowed to call it (or `null`);
   - `prepare()`: returns `{ url, body, state, headers? }` — a valid body, and `state()` reading
     the rows the endpoint writes (compared before/after);
   - `forbidden`: endpoint-specific foreign/server-managed fields (`SERVER_MANAGED` is always added);
   - optional `notPermitted` (schema knows the field but this caller may not set it → 422 `detail`)
     and `reports` (`"errors"` default or `"detail"`).
3. `forbidden`: every field of the target the client must not set (`status`, `createdBy`,
   `updatedAt`, `row_version`, snapshots, `teamId`/`locationId`/`recruiterId`, …) plus foreign
   ids (`FOREIGN_ID`). Reuse an existing `<AREA>_FORBIDDEN` map when one fits.
4. Ensure the zod schema is `.strict()`; a legitimately writable field must not be in `forbidden`.
   Routes that truly take no body/need no case go in `IGNORED` with a reason — rarely.
5. Shards: cases distribute automatically via `shard.mine`; nothing to change in
   `mass-assignment.{0..3}.api.int.test.ts`.
6. Run only the shard(s) that pick up your case, then all four:
   ```bash
   pnpm test:api test/mass-assignment.0.api.int.test.ts test/mass-assignment.1.api.int.test.ts \
     test/mass-assignment.2.api.int.test.ts test/mass-assignment.3.api.int.test.ts --reporter=dot 2>&1 | tail -30
   ```
