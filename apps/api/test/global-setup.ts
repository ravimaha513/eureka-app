import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { GlobalSetupContext } from "vitest/node";
import { FUNCTIONS_DIR, MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";

const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
export const APP_PASSWORD = "eureka_app_test";

declare module "vitest" {
  export interface ProvidedContext { templateDb: string }
}

const root = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: `${ADMIN_BASE}/postgres` });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
};

const here = dirname(fileURLToPath(import.meta.url));
const SHARED_SRC = join(here, "../../../packages/shared/src");

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name)).sort();

/** Everything the migrated template is built from: SQL, the migrator and the seeded authz catalog. */
function templateHash(): string {
  const h = createHash("sha256");
  const inputs = [
    ...files(MIGRATIONS_DIR), ...files(FUNCTIONS_DIR), ...files(SHARED_SRC),
    join(here, "../src/db/migrate.ts"), join(here, "global-setup.ts"),
  ];
  for (const f of inputs) h.update(f).update(readFileSync(f));
  h.update(`${process.env.EUREKA_ENVIRONMENT ?? ""}|${process.env.SINGLE_ADMIN_MODE ?? ""}`);
  return h.digest("hex").slice(0, 16);
}

/**
 * Migrates one template database; each test file then copies it (CREATE DATABASE ... TEMPLATE), which
 * takes a fraction of a second instead of applying every migration again. The template is named after
 * a hash of its inputs and kept between runs, so a rerun with unchanged migrations skips migrating
 * (TEST_FRESH_TEMPLATE=1 forces a rebuild). The role passwords are cluster-wide, so they are set here
 * once rather than by each file.
 */
export default async function setup({ provide }: GlobalSetupContext) {
  const name = `eureka_tpl_${templateHash()}`;
  const exists = async () => (await root((c) => c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]))).rowCount === 1;
  if (process.env.TEST_FRESH_TEMPLATE) await root((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));

  if (!(await exists())) {
    // Build under a private name and rename when done, so a concurrent run never copies a half-built template.
    const build = `eureka_tplbuild_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await root((c) => c.query(`CREATE DATABASE ${build}`));
    try {
      await migrate(`${ADMIN_BASE}/${build}`);
      await root(async (c) => {
        try { await c.query(`ALTER DATABASE ${build} RENAME TO ${name}`); }
        catch (e) { if ((e as { code?: string }).code !== "42P04") throw e; } // another run won the race
      });
    } finally {
      await root((c) => c.query(`DROP DATABASE IF EXISTS ${build} WITH (FORCE)`));
    }
  }

  await root(async (c) => {
    await c.query(`ALTER ROLE eureka_app PASSWORD '${APP_PASSWORD}'`);
    await c.query(`ALTER ROLE eureka_worker PASSWORD '${APP_PASSWORD}'`);
    // Last use, so templates of other branches' migration sets can expire.
    await c.query(`COMMENT ON DATABASE ${name} IS '${Date.now()}'`);
    // Drop what killed runs left (per-file copies and half-built templates, named with their creation
    // time) after an hour, and other templates unused for three days. One still in use stays: DROP
    // without FORCE fails while it has connections.
    const dbs = (await c.query<{ datname: string; used: string | null }>(
      `SELECT datname, shobj_description(oid, 'pg_database') AS used FROM pg_database WHERE datname ~ '^eureka_(tpl|tplbuild|test)_'`)).rows;
    const now = Date.now();
    for (const { datname, used } of dbs) {
      if (datname === name) continue;
      const created = /^eureka_\w+?_(\d{13})_\d+$/.exec(datname)?.[1];
      const stale = created ? Number(created) < now - 3_600_000 : Number(used ?? 0) < now - 3 * 86_400_000;
      if (stale) await c.query(`DROP DATABASE IF EXISTS ${datname}`).catch(() => undefined);
    }
  });
  provide("templateDb", name);
}
