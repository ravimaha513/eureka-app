/**
 * Sets (or resets) sign-in passwords for test users on staging and local
 * (migration 0083). The way to give restricted-role users (org_admin, HR,
 * Accounts, Immigration, Location Ops Admin) a password: the in-app admin
 * screen refuses those, as it would bypass the second approver.
 *
 *   EUREKA_ENVIRONMENT=staging MIGRATION_DATABASE_URL=... \
 *     tsx src/db/set-password.ts --email hr@example.com [--email other@example.com] [--keep]
 *   (ECS: one-off task on the migrate task definition, with EUREKA_NEW_PASSWORD set; not printed)
 *
 * - Refuses unless EUREKA_ENVIRONMENT is staging or local (and the database
 *   switch authz.policy_setting password_login is on).
 * - The password comes from EUREKA_NEW_PASSWORD, or is generated and shown
 *   once when stdout is a terminal. It is never printed in a non-interactive
 *   run (CloudWatch). The user must change it at first sign-in unless --keep.
 * - The database stores only a bcrypt hash.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { adminUrlFromEnv } from "./migrate.js";

export function parseArgs(argv: string[]): { emails: string[]; keep: boolean } {
  const emails: string[] = [];
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--email") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--email needs a value");
      emails.push(v.trim().toLowerCase());
    } else if (a === "--keep") keep = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (emails.length === 0) throw new Error("at least one --email is required");
  return { emails, keep };
}

export function generatePassword(): string {
  return `${randomBytes(12).toString("base64url")}9a`; // 16+ chars, a letter and a digit
}

export async function setPasswords(adminUrl: string, emails: string[], password: string, mustChange: boolean, env: NodeJS.ProcessEnv = process.env) {
  const e = env.EUREKA_ENVIRONMENT;
  if (e !== "staging" && e !== "local") throw new Error(`refused: EUREKA_ENVIRONMENT must be staging or local (got ${e === undefined ? "nothing" : JSON.stringify(e)})`);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query("BEGIN");
    for (const email of emails) {
      const u = await c.query<{ id: string }>(`SELECT id FROM eureka.app_user WHERE status = 'active' AND lower(email::text) = $1`, [email]);
      if (!u.rows[0]) throw new Error("no active user for one of the emails (create the user first)");
      await c.query(`SELECT authz.password_store($1, $2, $3)`, [u.rows[0].id, password, mustChange]);
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const { emails, keep } = parseArgs(process.argv.slice(2));
    const supplied = process.env.EUREKA_NEW_PASSWORD;
    if (!supplied && !process.stdout.isTTY) throw new Error("set EUREKA_NEW_PASSWORD (a generated password is only shown on a terminal)");
    const password = supplied ?? generatePassword();
    await setPasswords(adminUrlFromEnv(), emails, password, !keep);
    console.log(JSON.stringify({ msg: "set-password", users: emails.length, mustChange: !keep }));
    if (!supplied) console.log(`Password (shown once): ${password}`);
  } catch (err) {
    console.error(JSON.stringify({ msg: "set-password failed", error: (err as Error).message }));
    process.exitCode = 1;
  }
}
