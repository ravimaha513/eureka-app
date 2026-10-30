import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  GRANTS, HOTLIST_VISIBILITY, ORG_SENSITIVE_PERMISSIONS, PERMISSIONS, RESTRICTED_PERMISSIONS, ROLES, ROLE_LABELS, ROLE_LADDER,
  ROLE_TRAITS,
} from "@eureka/shared";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/migrations");
export const FUNCTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/functions");

/** Advisory lock key held for a whole run, so a retried or overlapping migrate task waits instead of racing. */
const MIGRATE_LOCK = "eureka.migrate";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Every `*.sql` under dir, depth first, as paths relative to dir (sorted, so runs are deterministic). */
export function sqlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".sql")) out.push(relative(dir, join(d, e.name)));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Applies SQL migrations in order, then the repeatable function files (db/functions), then seeds
 * roles and grants from the authorization catalog (design B4.1: grants live in code, never edited
 * at runtime). Must run with a privileged connection (superuser / rds_superuser).
 *
 * Applied migrations are pinned by checksum: editing one that already ran fails the run instead of
 * being skipped silently. Each DDL statement waits at most MIGRATION_LOCK_TIMEOUT (default 10s) for
 * a table lock, so a migration queued behind a long transaction fails and can be retried rather than
 * blocking live traffic on that table.
 */
export async function migrate(
  adminUrl: string, opts: { production?: boolean } = { production: process.env.NODE_ENV === "production" },
): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATE_LOCK]);
    const lockTimeout = (await client.query<{ q: string }>("SELECT quote_literal($1) AS q",
      [process.env.MIGRATION_LOCK_TIMEOUT ?? "10s"])).rows[0]!.q;
    await client.query(`SET lock_timeout = ${lockTimeout}`);
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Rows written before checksums existed get the file's current hash on the next run.
    await client.query("ALTER TABLE public.schema_migration ADD COLUMN IF NOT EXISTS sha256 text");
    const applied = new Map(
      (await client.query<{ name: string; sha256: string | null }>("SELECT name, sha256 FROM public.schema_migration"))
        .rows.map((r) => [r.name, r.sha256]),
    );
    for (const file of sqlFiles(MIGRATIONS_DIR)) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const hash = sha256(sql);
      if (applied.has(file)) {
        const recorded = applied.get(file);
        if (recorded === null) {
          await client.query("UPDATE public.schema_migration SET sha256 = $2 WHERE name = $1", [file, hash]);
        } else if (recorded !== hash) {
          throw new Error(`Migration ${file} changed after it was applied; add a new migration instead`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("RESET ROLE");
        await client.query("INSERT INTO public.schema_migration (name, sha256) VALUES ($1, $2)", [file, hash]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await applyFunctions(client);
    await seedCatalog(client, opts);
  } finally {
    await client.end();
  }
}

/**
 * Applies each db/functions file whose content differs from the last applied one. A file holds one
 * function's current definition (CREATE OR REPLACE plus its grants), so changing a function is an
 * edit that git can show and conflict on, not another full copy in a new migration.
 */
export async function applyFunctions(client: pg.Client | pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_function (
    name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map(
    (await client.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM public.schema_function"))
      .rows.map((r) => [r.name, r.sha256]),
  );
  for (const file of sqlFiles(FUNCTIONS_DIR)) {
    const sql = readFileSync(join(FUNCTIONS_DIR, file), "utf8");
    const hash = sha256(sql);
    if (applied.get(file) === hash) continue;
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("RESET ROLE");
      await client.query(
        `INSERT INTO public.schema_function (name, sha256) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()`, [file, hash]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Function file ${file} failed: ${(err as Error).message}`);
    }
  }
}

/** Replaces role and role_permission rows and policy settings with the catalog contents. */
export async function seedCatalog(client: pg.Client | pg.PoolClient, opts: { production?: boolean } = {}): Promise<void> {
  await client.query("BEGIN");
  try {
    // Permissions first: role_permission references them (0311). Flags drive role.is_restricted.
    for (const key of PERMISSIONS) {
      await client.query(
        `INSERT INTO eureka.permission (key, is_restricted, is_org_sensitive) VALUES ($1,$2,$3)
         ON CONFLICT (key) DO UPDATE SET is_restricted = EXCLUDED.is_restricted, is_org_sensitive = EXCLUDED.is_org_sensitive`,
        [key, RESTRICTED_PERMISSIONS.includes(key), ORG_SENSITIVE_PERMISSIONS.includes(key)],
      );
    }
    // System roles: label, traits and ladder position come from the catalog on every run
    // (docs/roles-api.md); custom roles (is_system = false) are the admins' and stay untouched.
    for (const role of ROLES) {
      const t = ROLE_TRAITS[role];
      const l = ROLE_LADDER[role];
      await client.query(
        `INSERT INTO eureka.role (key, label, is_system, is_sales, is_location_bound, is_admin, is_recruiter, is_coach, track, level)
         VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, is_system = true, is_sales = EXCLUDED.is_sales,
           is_location_bound = EXCLUDED.is_location_bound, is_admin = EXCLUDED.is_admin, is_recruiter = EXCLUDED.is_recruiter,
           is_coach = EXCLUDED.is_coach, track = EXCLUDED.track, level = EXCLUDED.level, archived_at = NULL`,
        [role, ROLE_LABELS[role], t.sales, t.locationBound, t.admin, t.recruiter, t.coach, l.track, l.level],
      );
    }
    await client.query("DELETE FROM eureka.role_permission WHERE role_key = ANY ($1)", [[...ROLES]]);
    for (const role of ROLES) {
      for (const [permission, scope] of Object.entries(GRANTS[role])) {
        await client.query(
          "INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ($1,$2,$3)",
          [role, permission, scope],
        );
      }
    }
    // A permission dropped from the catalog goes once no custom role holds it; a held one stays
    // (its grant is dead, nothing checks it) and is listed by the Roles screen as unknown.
    await client.query(
      `DELETE FROM eureka.permission p WHERE NOT (p.key = ANY ($1))
         AND NOT EXISTS (SELECT 1 FROM eureka.role_permission rp WHERE rp.permission = p.key)`, [[...PERMISSIONS]]);
    await client.query("SELECT eureka.role_refresh_restricted(NULL)");
    const policy = await client.query(
      `INSERT INTO authz.policy_setting (key, value) VALUES ('hotlist_visibility', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [HOTLIST_VISIBILITY]);
    if (policy.rowCount !== 1) throw new Error("hotlist_visibility policy was not written");
    // The development step-up switch (migration 0043) never survives a production deploy,
    // whoever set it: the API refuses AUTH_MODE=dev there too, this is the database side.
    if (opts.production) await client.query(`DELETE FROM authz.policy_setting WHERE key = 'dev_step_up'`);
    // Password sign-in (migration 0083) exists only where EUREKA_ENVIRONMENT says staging or local;
    // every other environment, production included, has it switched off in the database too.
    const passwordEnv = process.env.EUREKA_ENVIRONMENT;
    if (passwordEnv === "staging" || passwordEnv === "local") {
      await client.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('password_login', 'on')
        ON CONFLICT (key) DO UPDATE SET value = 'on'`);
    } else {
      await client.query(`DELETE FROM authz.policy_setting WHERE key = 'password_login'`);
    }
    // Single-admin mode (migration 0084): off unless SINGLE_ADMIN_MODE=on. Written on every run so a
    // deploy can restore the second-approver rule (AD-3).
    await client.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('single_admin_mode', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [process.env.SINGLE_ADMIN_MODE === "on" ? "on" : "off"]);
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
