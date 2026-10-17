import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/platform/config.js";
import { DbService } from "../src/platform/db.service.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { seedFixtures, U } from "./fixtures.js";

describe("DbService statement timeouts", () => {
  let db: TestDb;
  let svc: DbService;
  beforeAll(async () => {
    db = await createTestDb();
    await seedFixtures(db.admin);
    const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
    svc = new DbService(loadConfig({
      NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
      DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
    }));
  });
  afterAll(async () => { await svc?.onModuleDestroy(); await db?.drop(); });

  const timeout = (c: { query: DbService["pool"]["query"] }) =>
    c.query<{ statement_timeout: string }>("SHOW statement_timeout").then((r) => r.rows[0]!.statement_timeout);

  it("ordinary transactions keep 5s; exports get 60s for that transaction only", async () => {
    expect(await svc.withUser(U.acct, timeout)).toBe("5s");
    expect(await svc.withUserExport(U.acct, timeout)).toBe("1min");
    expect(await svc.withUser(U.acct, timeout)).toBe("5s");
  });
});
