/**
 * Restore-from-backup drill check (infra/README.md, "Restore drill"). Run
 * against a freshly restored copy of the database, never the live one:
 *   node dist/db/restore-check.js          (ECS: migrate task with DB_HOST overridden)
 *   MIGRATION_DATABASE_URL=... APP_DATABASE_URL=... pnpm --filter @eureka/api exec tsx src/db/restore-check.ts
 *
 * Read-only. Checks that every migration shipped in this image is applied,
 * that RLS is still enabled and forced on the protected tables, and smoke
 * tests the least-privilege app role: it can log in, sees rows only with a
 * user context, and none without. Prints one JSON line with row counts and the
 * newest write (for the RPO) and exits non-zero on any failure.
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { adminUrlFromEnv } from "./migrate.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/migrations");
export const PROTECTED_TABLES = ["person", "candidate", "submission", "interview", "audit_event", "placement"];
const COUNTED = ["app_user", "candidate", "submission", "interview", "placement", "audit_event"];

export interface RestoreCheck {
  ok: boolean;
  problems: string[];
  latestMigration: string | null;
  pendingMigrations: string[];
  counts: Record<string, number>;
  newestWrite: string | null;
  appRole: { rowsWithUser: number; rowsWithoutUser: number } | null;
}

/** The app role URL: APP_DATABASE_URL, or the admin URL's host with eureka_app and APP_DB_PASSWORD (ECS migrate task). */
export function appUrlFromEnv(adminUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.APP_DATABASE_URL) return env.APP_DATABASE_URL;
  if (!env.APP_DB_PASSWORD) return null;
  const u = new URL(adminUrl);
  u.username = "eureka_app";
  u.password = encodeURIComponent(env.APP_DB_PASSWORD);
  return u.toString();
}

export async function restoreCheck(adminUrl: string, appUrl: string | null, migrationsDir = MIGRATIONS_DIR): Promise<RestoreCheck> {
  const problems: string[] = [];
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let out: Omit<RestoreCheck, "ok" | "problems" | "appRole">;
  let probeUser: string | null = null;
  try {
    await admin.query("BEGIN READ ONLY");
    const applied = new Set((await admin.query<{ name: string }>(
      "SELECT name FROM public.schema_migration")).rows.map((r) => r.name));
    const shipped = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const pending = shipped.filter((f) => !applied.has(f));
    if (pending.length) problems.push(`migrations not applied: ${pending.join(", ")}`);

    const rls = (await admin.query<{ relname: string; on: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS on, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'eureka' AND c.relname = ANY($1)`, [PROTECTED_TABLES])).rows;
    for (const t of PROTECTED_TABLES) {
      const r = rls.find((x) => x.relname === t);
      if (!r) problems.push(`table eureka.${t} is missing`);
      else if (!r.on || !r.forced) problems.push(`RLS is not enabled and forced on eureka.${t}`);
    }

    const counts: Record<string, number> = {};
    for (const t of COUNTED) {
      counts[t] = (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM eureka.${t}`)).rows[0]!.n;
    }
    const newest = (await admin.query<{ at: Date | null }>(
      `SELECT greatest((SELECT max(at) FROM eureka.audit_event), (SELECT max(submitted_at) FROM eureka.submission),
                       (SELECT max(created_at) FROM eureka.candidate), (SELECT max(last_seen_at) FROM eureka.session)) AS at`)).rows[0]!.at;
    // A user who should see something: the recruiter of any candidate, else any active user.
    probeUser = (await admin.query<{ id: string }>(
      `SELECT coalesce((SELECT c.recruiter_id FROM eureka.candidate c JOIN eureka.app_user u ON u.id = c.recruiter_id
                        WHERE u.status = 'active' LIMIT 1),
                       (SELECT id FROM eureka.app_user WHERE status = 'active' LIMIT 1)) AS id`)).rows[0]?.id ?? null;
    await admin.query("COMMIT");
    out = {
      latestMigration: [...applied].sort().at(-1) ?? null,
      pendingMigrations: pending,
      counts,
      newestWrite: newest ? newest.toISOString() : null,
    };
  } finally {
    await admin.end();
  }

  let appRole: RestoreCheck["appRole"] = null;
  if (!appUrl) {
    problems.push("no app role credentials (APP_DATABASE_URL or APP_DB_PASSWORD): app role smoke test skipped");
  } else {
    const app = new pg.Client({ connectionString: appUrl });
    try {
      await app.connect();
      await app.query("BEGIN READ ONLY");
      const without = (await app.query<{ n: number }>("SELECT count(*)::int AS n FROM eureka.candidate")).rows[0]!.n;
      let withUser = 0;
      if (probeUser) {
        await app.query("SELECT set_config('eureka.user_id', $1, true)", [probeUser]);
        withUser = (await app.query<{ n: number }>("SELECT count(*)::int AS n FROM eureka.candidate")).rows[0]!.n;
      }
      await app.query("ROLLBACK");
      appRole = { rowsWithUser: withUser, rowsWithoutUser: without };
      if (without !== 0) problems.push(`app role sees ${without} candidates without a user context (RLS must fail closed)`);
      if (out.counts.candidate! > 0 && withUser === 0) problems.push("app role sees no candidates for a recruiter who has some");
    } catch (err) {
      problems.push(`app role smoke test failed: ${(err as Error).message}`);
    } finally {
      await app.end().catch(() => undefined);
    }
  }
  return { ok: problems.length === 0, problems, appRole, ...out };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const adminUrl = adminUrlFromEnv();
  const result = await restoreCheck(adminUrl, appUrlFromEnv(adminUrl));
  console.log(JSON.stringify({ msg: "restore check", ...result }));
  process.exitCode = result.ok ? 0 : 1;
}
