import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  ADMIN_COMPATIBLE_PERMISSIONS, ADMIN_PERMISSIONS, GRANTS, HOTLIST_VISIBILITY, ORG_SENSITIVE_PERMISSIONS, PERMISSIONS, RESTRICTED_PERMISSIONS, ROLES, ROLE_LABELS, ROLE_LADDER,
  ROLE_TRAITS,
} from "@eureka/shared";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/migrations");
export const FUNCTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/functions");

/** Advisory lock key held for a whole run, so a retried or overlapping migrate task waits instead of racing. */
const MIGRATE_LOCK = "eureka.migrate";

/**
 * A db/functions file takes effect right after the migration its `-- since: NNNN` line names, and
 * before every later one; a file without that line, after this one. Up to 0499 the order is
 * therefore the old one (every file after the migrations), so the existing set applies exactly as
 * before (architecture review G-05). From 0500 on, a migration always runs with the current file
 * bodies: on a fresh database (CI) as on staging and production.
 * A file whose new body needs a later migration (a column, a dropped old signature) says so with
 * `-- since: <that migration>`.
 */
export const FUNCTIONS_BASELINE = "0499";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const migrationNumber = (file: string) => file.slice(0, 4);

/** The migration a function file's body depends on: its `-- since: NNNN` line, else FUNCTIONS_BASELINE. */
export function functionSince(sql: string): string {
  return /^-- since: (\d{4})\s*$/m.exec(sql)?.[1] ?? FUNCTIONS_BASELINE;
}

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

export type MigrateStep = { kind: "migration" | "function"; file: string };

/**
 * The order of one run: pending migrations in name order, each pending function file just before
 * the first pending migration numbered above its `since`, the rest at the end. The same rule
 * places a file on a fresh database and on one that is already migrated, so a migration always
 * sees the same function bodies (G-05).
 */
export function planRun(pendingMigrations: string[], pendingFunctions: { file: string; since: string }[]): MigrateStep[] {
  const fns = [...pendingFunctions].sort((a, b) => a.since.localeCompare(b.since) || a.file.localeCompare(b.file));
  const steps: MigrateStep[] = [];
  let i = 0;
  for (const m of [...pendingMigrations].sort()) {
    while (i < fns.length && fns[i]!.since < migrationNumber(m)) steps.push({ kind: "function", file: fns[i++]!.file });
    steps.push({ kind: "migration", file: m });
  }
  while (i < fns.length) steps.push({ kind: "function", file: fns[i++]!.file });
  return steps;
}

/**
 * Puts the session back to its connection defaults before each file: a migration's plain `SET
 * search_path`, `SET ROLE` or temp table would otherwise carry into the next file on a fresh run,
 * while production applies a single new migration on a new connection (G-05).
 */
export async function resetSession(client: pg.Client | pg.PoolClient, lockTimeout: string): Promise<void> {
  await client.query("RESET ROLE");
  await client.query("RESET ALL");
  await client.query("DISCARD TEMP");
  await client.query(`SET lock_timeout = ${lockTimeout}`);
}

const quote = async (client: pg.Client | pg.PoolClient, v: string) =>
  (await client.query<{ q: string }>("SELECT quote_literal($1) AS q", [v])).rows[0]!.q;

/** Waits at most `wait` for the run lock; a hung or still-running earlier run fails this one with who holds it. */
async function takeRunLock(client: pg.Client, wait: string): Promise<void> {
  await client.query(`SET lock_timeout = ${await quote(client, wait)}`);
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATE_LOCK]);
  } catch (err) {
    if ((err as { code?: string }).code !== "55P03") throw err;
    const holders = (await client.query<{ pid: number; since: Date | null; state: string | null }>(
      `SELECT a.pid, a.backend_start AS since, a.state FROM pg_catalog.pg_locks l
         JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 AND l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext($1)::bigint`, [MIGRATE_LOCK])).rows;
    const who = holders.map((h) => `pid ${h.pid}${h.since ? ` connected ${h.since.toISOString()}` : ""}${h.state ? ` (${h.state})` : ""}`).join(", ");
    throw new Error(`Another migration run holds the ${MIGRATE_LOCK} lock${who ? ` (${who})` : ""}; waited ${wait} `
      + "(MIGRATION_LOCK_WAIT). Let it finish, or end it with pg_terminate_backend(pid), then retry");
  }
}

export interface MigrateOptions {
  /** Production deploy: drops development-only switches (seedCatalog). */
  production?: boolean;
  /** Longest wait for another run's lock (default MIGRATION_LOCK_WAIT, else 5min). */
  lockWait?: string;
  /** Tests only: stop after this migration number, as a deploy of that release would (no catalog seed). */
  upTo?: string;
}

/**
 * Applies pending SQL migrations and changed repeatable function files (db/functions) in the order
 * planRun gives, then seeds roles and grants from the authorization catalog (design B4.1: grants
 * live in code, never edited at runtime). Must run with a privileged connection (superuser /
 * rds_superuser).
 *
 * Applied migrations are pinned by checksum: editing one that already ran fails the run instead of
 * being skipped silently. Each file starts from a reset session (resetSession). Each DDL statement
 * waits at most MIGRATION_LOCK_TIMEOUT (default 10s) for a table lock, so a migration queued behind
 * a long transaction fails and can be retried rather than blocking live traffic on that table; the
 * run itself waits at most MIGRATION_LOCK_WAIT (default 5min) for an earlier run.
 */
export async function migrate(
  adminUrl: string, opts: MigrateOptions = { production: process.env.NODE_ENV === "production" },
): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await takeRunLock(client, opts.lockWait ?? process.env.MIGRATION_LOCK_WAIT ?? "5min");
    const lockTimeout = await quote(client, process.env.MIGRATION_LOCK_TIMEOUT ?? "10s");
    await resetSession(client, lockTimeout);
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Rows written before checksums existed get the file's current hash on the next run.
    await client.query("ALTER TABLE public.schema_migration ADD COLUMN IF NOT EXISTS sha256 text");
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_function (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map(
      (await client.query<{ name: string; sha256: string | null }>("SELECT name, sha256 FROM public.schema_migration"))
        .rows.map((r) => [r.name, r.sha256]),
    );
    const appliedFns = new Map(
      (await client.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM public.schema_function"))
        .rows.map((r) => [r.name, r.sha256]),
    );
    const upTo = opts.upTo ?? "9999";

    const sources = new Map<string, { sql: string; hash: string }>();
    const pending: string[] = [];
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
      } else if (migrationNumber(file) <= upTo) {
        sources.set(`m:${file}`, { sql, hash });
        pending.push(file);
      }
    }
    const pendingFns: { file: string; since: string }[] = [];
    const allFns: { file: string; since: string }[] = [];
    for (const file of sqlFiles(FUNCTIONS_DIR)) {
      const sql = readFileSync(join(FUNCTIONS_DIR, file), "utf8");
      const hash = sha256(sql);
      const since = functionSince(sql);
      if (since > upTo) continue;
      allFns.push({ file, since });
      if (appliedFns.get(file) === hash) continue;
      sources.set(`f:${file}`, { sql, hash });
      pendingFns.push({ file, since });
    }

    for (const step of planRun(pending, pendingFns)) {
      const { sql, hash } = sources.get(`${step.kind === "migration" ? "m" : "f"}:${step.file}`)!;
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("RESET ROLE");
        if (step.kind === "migration") {
          await client.query("INSERT INTO public.schema_migration (name, sha256) VALUES ($1, $2)", [step.file, hash]);
        } else {
          await client.query(
            `INSERT INTO public.schema_function (name, sha256) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()`, [step.file, hash]);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(step.kind === "migration"
          ? `Migration ${step.file} failed: ${(err as Error).message}`
          : `Function file ${step.file} failed: ${(err as Error).message} (if its body needs a later migration, `
            + "add `-- since: NNNN` naming it; FUNCTIONS_BASELINE in migrate.ts)");
      }
      await resetSession(client, lockTimeout);
    }
    await assertFunctionsPresent(client, allFns.map((f) => f.file));
    if (opts.upTo === undefined) await seedCatalog(client, opts);
  } finally {
    await client.end();
  }
}

/** A migration that dropped a file's function after the file was applied would leave it missing; fail loudly. */
async function assertFunctionsPresent(client: pg.Client, files: string[]): Promise<void> {
  const names = files.map((f) => f.replace(/\.sql$/, "").split("/"));
  const { rows } = await client.query<{ f: string }>(
    `SELECT s || '.' || n AS f FROM unnest($1::text[], $2::text[]) AS x(s, n)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
                         WHERE ns.nspname = x.s AND p.proname = x.n)`,
    [names.map((n) => n[0]), names.map((n) => n[1])]);
  if (rows.length) {
    throw new Error(`Functions missing after migrating: ${rows.map((r) => r.f).join(", ")}. A migration dropped them after `
      + "their db/functions file was applied; give the file `-- since: <that migration>`");
  }
}

/** Replaces role and role_permission rows and policy settings with the catalog contents. */
export async function seedCatalog(client: pg.Client | pg.PoolClient, opts: { production?: boolean } = {}): Promise<void> {
  await client.query("BEGIN");
  try {
    // Permissions first: role_permission references them (0311). Flags drive role.is_restricted
    // and the admin/data separation checks (0500).
    for (const key of PERMISSIONS) {
      await client.query(
        `INSERT INTO eureka.permission (key, is_restricted, is_org_sensitive, is_admin_only, is_admin_compatible) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET is_restricted = EXCLUDED.is_restricted, is_org_sensitive = EXCLUDED.is_org_sensitive,
           is_admin_only = EXCLUDED.is_admin_only, is_admin_compatible = EXCLUDED.is_admin_compatible`,
        [key, RESTRICTED_PERMISSIONS.includes(key), ORG_SENSITIVE_PERMISSIONS.includes(key),
          ADMIN_PERMISSIONS.includes(key), ADMIN_COMPATIBLE_PERMISSIONS.includes(key)],
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

const SCRAM_VERIFIER = /^SCRAM-SHA-256\$\d{4,7}:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;

/**
 * The SCRAM-SHA-256 verifier Postgres would store for this password (RFC 5802 / 7677, the
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` form of pg_authid.rolpassword).
 * Hashing on the client keeps the password out of the statement text, so `log_statement`, a
 * failing-statement log or pg_stat_statements never see it (security review G-06). Printable ASCII
 * only: Postgres SASLprep-normalises other passwords, which this does not reimplement.
 */
export function scramSha256Verifier(password: string, opts: { salt?: Buffer; iterations?: number } = {}): string {
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error("Role passwords must be non-empty printable ASCII");
  const salt = opts.salt ?? randomBytes(16);
  const iterations = opts.iterations ?? 4096;
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const hmac = (key: Buffer, msg: string) => createHmac("sha256", key).update(msg).digest();
  const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest();
  const serverKey = hmac(salted, "Server Key");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** ALTER ROLE ... PASSWORD with a client-side SCRAM verifier: the cleartext never reaches the server. */
export async function setRolePassword(client: pg.Client | pg.PoolClient | pg.Pool, role: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`Invalid role name ${role}`);
  const verifier = scramSha256Verifier(password);
  if (!SCRAM_VERIFIER.test(verifier)) throw new Error("Unexpected SCRAM verifier format");
  await client.query(`ALTER ROLE ${role} PASSWORD '${verifier}'`);
}

/** Sets application role passwords from Secrets Manager values injected by ECS. */
export async function setRolePasswords(adminUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [role, pw] of [["eureka_app", env.APP_DB_PASSWORD], ["eureka_worker", env.WORKER_DB_PASSWORD]] as const) {
      if (!pw) continue;
      await setRolePassword(client, role, pw);
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
