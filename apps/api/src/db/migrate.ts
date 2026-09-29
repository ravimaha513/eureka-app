import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { GRANTS, HOTLIST_VISIBILITY, LOCATION_ROLES, ROLES, ROLE_LABELS, SALES_ROLES, isRestrictedRole } from "@eureka/shared";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/migrations");

/**
 * Applies SQL migrations in order, then seeds roles and grants from the
 * authorization catalog (design B4.1: grants live in code, never edited at runtime).
 * Must run with a privileged connection (superuser / rds_superuser).
 */
export async function migrate(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM public.schema_migration")).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("RESET ROLE");
        await client.query("INSERT INTO public.schema_migration (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await seedCatalog(client);
  } finally {
    await client.end();
  }
}

/** Replaces role and role_permission rows and policy settings with the catalog contents. */
export async function seedCatalog(client: pg.Client | pg.PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const role of ROLES) {
      await client.query(
        `INSERT INTO eureka.role (key, label, is_sales, is_location_bound, is_restricted) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, is_sales = EXCLUDED.is_sales,
           is_location_bound = EXCLUDED.is_location_bound, is_restricted = EXCLUDED.is_restricted`,
        [role, ROLE_LABELS[role], SALES_ROLES.includes(role), LOCATION_ROLES.includes(role), isRestrictedRole(role)],
      );
    }
    await client.query("DELETE FROM eureka.role_permission");
    for (const role of ROLES) {
      for (const [permission, scope] of Object.entries(GRANTS[role])) {
        await client.query(
          "INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ($1,$2,$3)",
          [role, permission, scope],
        );
      }
    }
    const policy = await client.query(
      `INSERT INTO authz.policy_setting (key, value) VALUES ('hotlist_visibility', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [HOTLIST_VISIBILITY]);
    if (policy.rowCount !== 1) throw new Error("hotlist_visibility policy was not written");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** Builds the admin URL from MIGRATION_DATABASE_URL or from RDS master secret parts (ECS migrate task). */
export function adminUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIGRATION_DATABASE_URL) return env.MIGRATION_DATABASE_URL;
  const { DB_HOST, DB_NAME, DB_MASTER_USERNAME, DB_MASTER_PASSWORD } = env;
  if (!DB_HOST || !DB_NAME || !DB_MASTER_USERNAME || !DB_MASTER_PASSWORD) {
    throw new Error("Set MIGRATION_DATABASE_URL, or DB_HOST, DB_NAME, DB_MASTER_USERNAME and DB_MASTER_PASSWORD");
  }
  const u = new URL(`postgres://${DB_HOST}:5432/${DB_NAME}`);
  u.username = encodeURIComponent(DB_MASTER_USERNAME);
  u.password = encodeURIComponent(DB_MASTER_PASSWORD);
  u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

/** Sets application role passwords from Secrets Manager values injected by ECS. */
export async function setRolePasswords(adminUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [role, pw] of [["eureka_app", env.APP_DB_PASSWORD], ["eureka_worker", env.WORKER_DB_PASSWORD]] as const) {
      if (!pw) continue;
      const lit = (await client.query<{ q: string }>("SELECT quote_literal($1) AS q", [pw])).rows[0]!.q;
      await client.query(`ALTER ROLE ${role} PASSWORD ${lit}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const url = adminUrlFromEnv();
  await migrate(url);
  await setRolePasswords(url);
  console.log("migrations applied");
}
