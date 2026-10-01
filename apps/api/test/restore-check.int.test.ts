import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restoreCheck } from "../src/db/restore-check.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { seedFixtures } from "./fixtures.js";

const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";

describe("restore drill check", () => {
  let db: TestDb;
  let adminUrl: string;
  let appUrl: string;

  beforeAll(async () => {
    db = await createTestDb();
    await seedFixtures(db.admin);
    adminUrl = `${ADMIN_BASE}/${db.name}`;
    const u = new URL(ADMIN_BASE);
    appUrl = `postgres://eureka_app:eureka_app_test@${u.host}/${db.name}`;
  });
  afterAll(async () => db?.drop());

  it("passes on a complete database: migrations applied, RLS forced, app role fails closed", async () => {
    const r = await restoreCheck(adminUrl, appUrl);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.pendingMigrations).toEqual([]);
    expect(r.latestMigration).toMatch(/^\d{4}_.+\.sql$/);
    expect(r.counts.candidate).toBeGreaterThan(0);
    expect(r.appRole!.rowsWithoutUser).toBe(0);
    expect(r.appRole!.rowsWithUser).toBeGreaterThan(0);
    expect(r.newestWrite).not.toBeNull();
  });

  it("fails when a shipped migration is missing from the restored database", async () => {
    const last = (await db.admin.query<{ name: string }>("SELECT max(name) AS name FROM public.schema_migration")).rows[0]!.name;
    await db.admin.query("DELETE FROM public.schema_migration WHERE name = $1", [last]);
    try {
      const r = await restoreCheck(adminUrl, appUrl);
      expect(r.ok).toBe(false);
      expect(r.pendingMigrations).toEqual([last]);
    } finally {
      await db.admin.query("INSERT INTO public.schema_migration (name) VALUES ($1)", [last]);
    }
  });

  it("fails when RLS is no longer forced on a protected table", async () => {
    await db.admin.query("ALTER TABLE eureka.interview NO FORCE ROW LEVEL SECURITY");
    try {
      const r = await restoreCheck(adminUrl, appUrl);
      expect(r.ok).toBe(false);
      expect(r.problems).toContain("RLS is not enabled and forced on eureka.interview");
    } finally {
      await db.admin.query("ALTER TABLE eureka.interview FORCE ROW LEVEL SECURITY");
    }
  });

  it("fails when the app role cannot log in", async () => {
    const r = await restoreCheck(adminUrl, appUrl.replace("eureka_app_test", "wrong-password"));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/app role smoke test failed/);
  });
});
