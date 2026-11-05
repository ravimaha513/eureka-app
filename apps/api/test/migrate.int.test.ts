import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, resetSession, scramSha256Verifier, setRolePasswords } from "../src/db/migrate.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { APP_PASSWORD } from "./global-setup.js";

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

  it("fails with the holder's pid instead of waiting forever when another run holds the lock (G-05)", async () => {
    const holder = await db.admin.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext('eureka.migrate'))`);
      const pid = (await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      const started = Date.now();
      await expect(migrate(url, { production: false, lockWait: "300ms" }))
        .rejects.toThrow(new RegExp(`eureka\\.migrate lock \\(pid ${pid}.*waited 300ms`));
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock_all()`);
      holder.release();
    }
    await migrate(url, { production: false }); // lock free again: runs
  });

  it("resets search_path, role and temp tables between files (G-05)", async () => {
    const c = await db.admin.connect();
    try {
      await c.query(`SET search_path = eureka, public; SET ROLE eureka_owner; CREATE TEMP TABLE leak (x int)`);
      await resetSession(c, `'10s'`);
      const r = (await c.query(`SELECT current_setting('search_path') AS sp, current_user AS u, session_user AS s,
        current_setting('lock_timeout') AS lt, to_regclass('pg_temp.leak') AS t`)).rows[0];
      expect(r).toEqual({ sp: '"$user", public', u: r.s, s: r.s, lt: "10s", t: null });
    } finally {
      c.release();
    }
  });

  it("sets role passwords as SCRAM verifiers the server accepts, without the cleartext in the statement (G-06)", async () => {
    const before = (await db.admin.query(`SELECT rolpassword FROM pg_authid WHERE rolname = 'eureka_app'`)).rows[0].rolpassword as string;
    // Same password as the run's (global-setup), so concurrent files keep connecting.
    await setRolePasswords(url, { APP_DB_PASSWORD: APP_PASSWORD });
    const after = (await db.admin.query(`SELECT rolpassword FROM pg_authid WHERE rolname = 'eureka_app'`)).rows[0].rolpassword as string;
    expect(after).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(after).not.toBe(before); // a new salt
    // Our verifier equals the server's own for the same salt: the server would hash it identically.
    const [, iter, salt] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(after)!;
    expect(scramSha256Verifier(APP_PASSWORD, { salt: Buffer.from(salt!, "base64"), iterations: Number(iter) })).toBe(after);
    const u = new URL(url);
    const app = new pg.Client({ connectionString: `postgres://eureka_app:${APP_PASSWORD}@${u.host}${u.pathname}` });
    await app.connect();
    try { expect((await app.query(`SELECT current_user AS u`)).rows[0].u).toBe("eureka_app"); } finally { await app.end(); }
  });
});

/**
 * A database migrated in two deploys (up to 0300, then the rest on a new connection) ends with the
 * same schema, function bodies, grants and catalog seed as the one-shot template (G-05).
 */
describe("fresh and incremental runs", () => {
  const ROOT = `${ADMIN_BASE}/postgres`;
  const name = `eureka_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let template: TestDb;
  const exec = async (sql: string) => {
    const c = new pg.Client({ connectionString: ROOT });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
  };
  beforeAll(async () => { template = await createTestDb(); await exec(`CREATE DATABASE ${name}`); });
  afterAll(async () => { await template?.drop(); await exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); });

  const SNAPSHOT = `
    SELECT 'rel ' || c.oid::regclass || ' ' || c.relkind::text || ' ' || c.relrowsecurity || c.relforcerowsecurity || ' '
           || pg_get_userbyid(c.relowner) || ' ' || coalesce(c.relacl::text, '') FROM pg_class c
     WHERE c.relnamespace IN ('authz'::regnamespace, 'eureka'::regnamespace)
    UNION ALL SELECT 'col ' || a.attrelid::regclass || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' '
           || a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' ' || coalesce(a.attacl::text, '')
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relnamespace IN ('authz'::regnamespace, 'eureka'::regnamespace) AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'con ' || conrelid::regclass || ' ' || conname || ' ' || convalidated || ' ' || pg_get_constraintdef(oid)
      FROM pg_constraint WHERE connamespace IN ('authz'::regnamespace, 'eureka'::regnamespace)
    UNION ALL SELECT 'idx ' || indexdef FROM pg_indexes WHERE schemaname IN ('authz', 'eureka')
    UNION ALL SELECT 'pol ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' ' || roles::text || ' '
           || coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_policies WHERE schemaname IN ('authz', 'eureka')
    UNION ALL SELECT 'trg ' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace IN ('authz'::regnamespace, 'eureka'::regnamespace) AND NOT t.tgisinternal
    UNION ALL SELECT 'fn ' || p.oid::regprocedure || ' ' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '') || ' '
           || md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace IN ('authz'::regnamespace, 'eureka'::regnamespace)
    UNION ALL SELECT 'perm ' || role_key || ' ' || permission || ' ' || scope FROM eureka.role_permission
    UNION ALL SELECT 'set ' || key || ' ' || value FROM authz.policy_setting`;
  const snapshot = async (q: (sql: string) => Promise<{ rows: { s: string }[] }>) =>
    (await q(`SELECT s FROM (${SNAPSHOT}) x(s)`)).rows.map((r) => r.s).sort();

  it("two deploys end where one does", async () => {
    const dbUrl = `${ADMIN_BASE}/${name}`;
    await migrate(dbUrl, { production: false, upTo: "0300" });
    const c = new pg.Client({ connectionString: dbUrl });
    await c.connect();
    try {
      expect((await c.query(`SELECT max(name) AS m FROM public.schema_migration`)).rows[0].m).toMatch(/^0300_/);
      expect((await c.query(`SELECT count(*)::int AS n FROM public.schema_function`)).rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
    await migrate(dbUrl, { production: false });
    const two = new pg.Client({ connectionString: dbUrl });
    await two.connect();
    try {
      const got = await snapshot((sql) => two.query(sql));
      const want = await snapshot((sql) => template.admin.query(sql));
      expect(got.length).toBeGreaterThan(1000);
      expect(got.filter((s) => !want.includes(s))).toEqual([]);
      expect(want.filter((s) => !got.includes(s))).toEqual([]);
    } finally {
      await two.end();
    }
  }, 600_000);
});
