/**
 * First-admin bootstrap (infra/README.md, "First admin"). A freshly deployed
 * stack has the role catalog and no users; this creates the first org_admin
 * account(s) for Google Workspace emails in the hosted domain, once.
 *
 *   node dist/db/bootstrap.js --admin "Ravi M <ravi@example.com>" --admin "second@example.com" [--demo-data]
 *   (ECS: one-off task on the migrate task definition, which has the master credentials and GOOGLE_HOSTED_DOMAIN)
 *   MIGRATION_DATABASE_URL=... GOOGLE_HOSTED_DOMAIN=... pnpm --filter @eureka/api exec tsx src/db/bootstrap.ts --admin ...
 *
 * - Break-glass only: refuses while an active org_admin exists, so it is no
 *   backdoor while the org is administered; re-running with exactly the
 *   current admins changes nothing (exit 0). After a first bootstrap, a run
 *   with no admin left (lock-out recovery) also needs --recover.
 * - Two admins by default: restricted roles (AD-3) need a second approver who
 *   is neither the requester nor the grantee, and org_admin itself is
 *   restricted, so a single admin could never get a second one through the
 *   app. One admin needs --single-admin.
 * - The admins hold org_admin only (rule 7). They sign in with Google; the
 *   first sign-in links the account by email, like any admin-created user.
 * - The database function (migration 0037) re-checks all of it and writes the
 *   audit rows in the same transaction (actor: system, no email).
 * - --demo-data adds a small FICTIONAL org (demo-data.ts) for staging demos;
 *   refused on anything that looks like production.
 *
 * Prints one JSON line (user ids, no emails). Exit codes: 0 done or unchanged,
 * 2 invalid arguments, 3 refused by a safety check, 1 any other error.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { adminUrlFromEnv } from "./migrate.js";
import { appUrlFromEnv } from "./restore-check.js";
import { checkDemoTarget, loadDemoData, type DemoResult } from "./demo-data.js";

export const USAGE = `usage: bootstrap --admin "<Name> <email>" [--admin "<Name> <email>" | --single-admin] [--recover] [--demo-data]
  --admin         an admin's Google Workspace email in GOOGLE_HOSTED_DOMAIN, optionally "Display Name <email>" (1 or 2 times)
  --single-admin  allow one admin (restricted roles then cannot be approved until a second admin exists)
  --recover       allow a bootstrap after an earlier one, when no active org_admin is left (lock-out recovery; audited)
  --demo-data     also load the small fictional demo org (never on production)`;

/** Refusals and argument errors carry an exit code; anything else exits 1. */
export class BootstrapError extends Error {
  constructor(message: string, readonly exitCode: 2 | 3) {
    super(message);
  }
}

export interface AdminSpec { email: string; displayName: string }
export interface BootstrapArgs { admins: AdminSpec[]; domain: string; demo: boolean; recover: boolean }

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** "Name <email>" or "email"; the display name defaults to the email's local part. */
export function parseAdmin(value: string, domain: string): AdminSpec {
  const v = value.trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(v);
  const email = (m ? m[2]! : v).trim().toLowerCase();
  const name = (m ? m[1]! : "").trim();
  // Messages name no email: they end up in CloudWatch.
  if (!EMAIL_RE.test(email)) throw new BootstrapError("--admin: a value is not an email address", 2);
  if (email.split("@")[1] !== domain) {
    throw new BootstrapError(`--admin: an email is not in the hosted domain ${domain} (only accounts there can sign in)`, 2);
  }
  const displayName = name || email.split("@")[0]!;
  if (displayName.length > 200 || CONTROL_RE.test(displayName)) throw new BootstrapError("--admin: invalid display name", 2);
  return { email, displayName };
}

export function parseBootstrapArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): BootstrapArgs {
  const domain = (env.GOOGLE_HOSTED_DOMAIN ?? "").trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) {
    throw new BootstrapError("GOOGLE_HOSTED_DOMAIN must be set to the Google Workspace domain the API accepts", 2);
  }
  const raw: string[] = [];
  let single = false;
  let demo = false;
  let recover = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--admin") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new BootstrapError(`--admin needs a value\n${USAGE}`, 2);
      raw.push(v);
    } else if (a.startsWith("--admin=")) raw.push(a.slice("--admin=".length));
    else if (a === "--single-admin") single = true;
    else if (a === "--demo-data") demo = true;
    else if (a === "--recover") recover = true;
    else throw new BootstrapError(`unknown argument: ${a}\n${USAGE}`, 2);
  }
  const admins = raw.map((r) => parseAdmin(r, domain));
  if (admins.length === 0) throw new BootstrapError(`at least one --admin is required\n${USAGE}`, 2);
  if (admins.length > 2) throw new BootstrapError("at most two --admin (further admins go through the app with a second approver)", 2);
  if (new Set(admins.map((a) => a.email)).size !== admins.length) throw new BootstrapError("the two --admin emails must differ", 2);
  if (admins.length === 1 && !single) {
    throw new BootstrapError("give two --admin: restricted roles (org_admin, HR, Accounts, ...) need a second admin to approve. "
      + "Use --single-admin to create one anyway", 2);
  }
  if (admins.length === 2 && single) throw new BootstrapError("--single-admin conflicts with two --admin", 2);
  return { admins, domain, demo, recover };
}

/** Database refusals from authz.bootstrap_admins that are safety checks, not failures. */
const REFUSALS: Record<string, string> = {
  admin_exists: "refused: an active org_admin already exists; add administrators in the app (Users & Access) with a second approver",
  bootstrap_used: "refused: this stack was bootstrapped before; with no active org_admin left, re-run with --recover (audited)",
  read_committed_required: "refused: the bootstrap must run in a READ COMMITTED transaction",
  separation_of_duties: "refused: an --admin account already holds a role (an admin holds no business role, AD-3a); use a separate account",
  user_inactive: "refused: an --admin account exists but is inactive",
  email_domain: "refused: an --admin email is not in the hosted domain",
};

export interface BootstrapResult {
  outcome: "created" | "unchanged";
  admins: { userId: string; outcome: string }[];
  demo: DemoResult | null;
}

export async function bootstrap(
  adminUrl: string, args: BootstrapArgs, appUrl: string | null, env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapResult> {
  if (args.demo) await checkDemoTarget(adminUrl, env);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  let admins: { userId: string; outcome: string }[];
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      const { rows } = await c.query<{ user_id: string; outcome: string }>(
        "SELECT user_id, outcome FROM authz.bootstrap_admins($1::text[], $2::text[], $3, $4)",
        [args.admins.map((a) => a.email), args.admins.map((a) => a.displayName), args.domain, args.recover]);
      await c.query("COMMIT");
      admins = rows.map((r) => ({ userId: r.user_id, outcome: r.outcome }));
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      const msg = (err as Error).message;
      if (REFUSALS[msg]) throw new BootstrapError(REFUSALS[msg]!, 3);
      if (/function authz\.bootstrap_admins.*does not exist/.test(msg)) {
        throw new Error("authz.bootstrap_admins is missing: run the migrations (0037, 0039) first");
      }
      throw err;
    }
  } finally {
    await c.end();
  }
  const outcome = admins.every((a) => a.outcome === "unchanged") ? "unchanged" : "created";
  let demo: DemoResult | null = null;
  if (args.demo) {
    if (!appUrl) throw new Error("--demo-data needs the app role (APP_DATABASE_URL or APP_DB_PASSWORD) to write candidates through RLS");
    demo = await loadDemoData(adminUrl, appUrl, env);
  }
  return { outcome, admins, demo };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = parseBootstrapArgs(process.argv.slice(2));
    const adminUrl = adminUrlFromEnv();
    const result = await bootstrap(adminUrl, args, appUrlFromEnv(adminUrl));
    console.log(JSON.stringify({ msg: "bootstrap", ...result }));
    if (result.outcome === "created" && args.admins.length === 1) {
      console.log(JSON.stringify({ msg: "bootstrap: single admin; restricted roles cannot be approved until a second admin exists" }));
    }
  } catch (err) {
    const code = err instanceof BootstrapError ? err.exitCode : (err as { refused?: boolean }).refused ? 3 : 1;
    console.error(JSON.stringify({ msg: "bootstrap failed", error: (err as Error).message }));
    process.exitCode = code;
  }
}
