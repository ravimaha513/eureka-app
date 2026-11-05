---
name: eureka-int-test
description: Write Eureka API or database integration tests in apps/api/test (*.api.int.test.ts, *.db.int.test.ts) using the db-harness, fixtures and seed helpers. Use when adding tests for an endpoint, SQL function, RLS policy or guard, or when asked "write tests for X" / "cover the deny paths".
---

# Eureka integration test

## Harness (read the exports, not whole files)

- `test/db-harness.ts`: `createTestDb()` → `{ admin, app, worker, drop }` — a fresh DB copied
  from the migrated template, pools per role (`admin` = superuser, `app` = `eureka_app`,
  `worker` = `eureka_worker`). `asUser(pool, userId, fn, commit=false)` runs `fn` in a
  transaction with `eureka.user_id` set (rolled back by default).
  `ownedCandidateCalls(admin, userId, sql)` counts `authz.owned_candidate_ids` calls (rule 3).
- `test/fixtures.ts`: `seedFixtures(admin)`, users `U.*`, teams `T.*`, locations `LOC.*`,
  `COACHING`, `TECH_ID`, `CLIENT_ID`.
- Domain seeds: `placement-seed.ts`, `employee-seed.ts`, `notification-seed.ts`,
  `pipeline-seed.ts`, `portal-seed.ts`.
- API tests boot the app with `createApp(AppModule, config)` — copy the setup from a sibling
  `*.api.int.test.ts` in the same area.

## Pairing

- `<area>.db.int.test.ts` — SQL behaviour as each role: definer functions, guards, policies.
- `<area>.api.int.test.ts` — HTTP status codes, response shapes, audit rows.

## Skeleton (db)

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); await seedFixtures(db.admin); });
afterAll(async () => { await db?.drop(); });

describe("authz.update_x", () => {
  it("refuses a user outside scope with not_found", async () => {
    await expect(asUser(db.app, U.otherRecruiter, (c) =>
      c.query("SELECT * FROM authz.update_x($1, $2, 1)", [id, {}]))).rejects.toThrow(/not_found/);
  });
});
```

## What every new feature must cover

- [ ] Happy path per role that should succeed.
- [ ] **404** not visible (out of scope) — same as nonexistent id.
- [ ] **403** visible but lacking permission.
- [ ] 422 validation (strict schema rejects unknown keys); 409/412 stale version; 428 no If-Match.
- [ ] `eureka_app` cannot write the table directly (RLS / missing grant).
- [ ] Server-managed columns ignored/overwritten by the guard.
- [ ] NULL inputs don't bypass checks.
- [ ] RLS list query: `ownedCandidateCalls(...).calls === 1`.
- [ ] Audit / outbox rows contain no free text, rates, phones, emails.
- [ ] New write route → mass-assignment case (`eureka-mass-assignment`).

Run with `pnpm test:api test/<file> --reporter=dot` (`eureka-test-run`). If one file grows past a
couple of minutes, shard it (`eureka-shard-split`).
