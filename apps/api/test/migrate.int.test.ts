import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createTestDb, type TestDb } from "./db-harness.js";

const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";

describe("migration runner", () => {
  let db: TestDb;
  let url: string;
  beforeAll(async () => {
    db = await createTestDb();
    url = `${ADMIN_BASE}/${db.name}`;
  });
  afterAll(async () => db?.drop());

  it("records a checksum for every migration and function file, and a second run changes nothing", async () => {
    const before = (await db.admin.query(
      `SELECT (SELECT count(*) FROM public.schema_migration WHERE sha256 IS NULL)::int AS unhashed,
              (SELECT max(applied_at) FROM public.schema_function) AS fn_at`)).rows[0];
    expect(before.unhashed).toBe(0);
    await migrate(url, { production: false });
    const after = (await db.admin.query(`SELECT max(applied_at) AS fn_at FROM public.schema_function`)).rows[0];
    expect(after.fn_at).toEqual(before.fn_at);
  });

  it("backfills checksums recorded before they existed", async () => {
    await db.admin.query(`UPDATE public.schema_migration SET sha256 = NULL WHERE name LIKE '0001%'`);
    await migrate(url, { production: false });
    const { rows } = await db.admin.query(`SELECT sha256 FROM public.schema_migration WHERE name LIKE '0001%'`);
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to run when an applied migration was edited", async () => {
    const { rows } = await db.admin.query(`SELECT sha256 FROM public.schema_migration WHERE name LIKE '0002%'`);
    await db.admin.query(`UPDATE public.schema_migration SET sha256 = repeat('0', 64) WHERE name LIKE '0002%'`);
    try {
      await expect(migrate(url, { production: false })).rejects.toThrow(/0002_.*changed after it was applied/);
    } finally {
      await db.admin.query(`UPDATE public.schema_migration SET sha256 = $1 WHERE name LIKE '0002%'`, [rows[0].sha256]);
    }
  });

  it("re-applies a function file whose content differs from the applied one", async () => {
    // Simulate an out-of-band change: the body in the database is not the file's.
    await db.admin.query(`SET ROLE authz_definer;
      CREATE OR REPLACE FUNCTION authz.notification_entity(p_event uuid) RETURNS TABLE(entity_type text, entity_id uuid)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT NULL::text, NULL::uuid WHERE false $$;
      RESET ROLE;`);
    await db.admin.query(`UPDATE public.schema_function SET sha256 = 'stale' WHERE name = 'authz/notification_entity.sql'`);
    await migrate(url, { production: false });
    const { rows } = await db.admin.query(
      `SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'authz.notification_entity(uuid)'::regprocedure`);
    expect(rows[0].lanname).toBe("plpgsql");
  });

  it("serialises concurrent runs on one database", async () => {
    await expect(Promise.all([migrate(url, { production: false }), migrate(url, { production: false })])).resolves.toBeDefined();
  });
});
