/**
 * Staging only: the org a staged team workbook needs (docs/import.md "Upload page").
 * Staging starts empty, while the import credits every row to a recruiter account
 * and needs the candidates' location and technologies to exist. From a staged
 * batch's own cells (Manager, Team Lead, Recruiter, Technology, Source Tab) this
 * creates what is missing:
 *   - one location (--location, default "Head office") for everyone
 *   - the technologies named in the workbook (through the mapping's aliases)
 *   - placeholder staff: the manager, one lead and one team per tab prefix
 *     ("Rohit Submissions" -> team "Rohit"), and each recruiter in the team they
 *     logged most rows for; emails at staff.invalid (a reserved TLD), so nobody
 *     can sign in as them; only non-restricted roles (manager, lead, recruiter)
 *   - with --viewer EMAIL: that existing, non-admin account gets the Associate
 *     Director role and the manager reports to it, so it sees every team
 * Then re-analyse the batch on the Imports page: owners resolve by display name.
 * Re-running adds nothing twice. Runs where EUREKA_ENVIRONMENT is staging or local
 * only, and never on a host or database named like production (checkDemoTarget).
 *
 *   node dist/db/staging-team.js --batch <uuid> [--location "Head office"] [--viewer someone@example.com]
 * (ops-task workflow on staging; exit 0 done, 2 bad arguments, 3 refused)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isRestrictedRole } from "@eureka/shared";
import { canonicalNames } from "../import/team-workbook.js";
import { clean, labelKey } from "../import/normalize.js";
import { parseMapping, TEAM_WORKBOOK_MAPPING_PATH } from "../import/mapping.js";
import { checkDemoTarget } from "./demo-data.js";
import { adminUrlFromEnv } from "./migrate.js";

export const STAFF_EMAIL_DOMAIN = "staff.invalid";
const ROLES = { manager: "manager", lead: "lead", recruiter: "recruiter", viewer: "assoc_director" } as const;

export interface TeamArgs { batch: string; location: string; viewer: string | null }
export class TeamSetupError extends Error {
  constructor(message: string, readonly exitCode: 2 | 3) { super(message); }
}

export function parseTeamArgs(argv: string[]): TeamArgs {
  const out: TeamArgs = { batch: "", location: "Head office", viewer: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === "--batch" && v) { out.batch = v; i++; }
    else if (argv[i] === "--location" && v) { out.location = clean(v); i++; }
    else if (argv[i] === "--viewer" && v) { out.viewer = v.trim().toLowerCase(); i++; }
    else throw new TeamSetupError(`unknown or incomplete argument ${argv[i]}`, 2);
  }
  if (!/^[0-9a-f-]{36}$/i.test(out.batch)) throw new TeamSetupError("--batch <uuid> is required", 2);
  if (!out.location || out.location.length > 80) throw new TeamSetupError("--location must be 1-80 characters", 2);
  return out;
}

const slug = (s: string) => clean(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "").slice(0, 60);
const mostCommon = (xs: string[]) => {
  const n = new Map<string, number>();
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] ?? "";
};
/** Team = the tab name before its kind word ("Rohit Submissions" -> "Rohit"). */
const teamOfTab = (tab: string) => clean(tab.replace(/\s*(submissions?|interviews?|placements?)\s*$/i, ""));

export interface TeamResult {
  location: "created" | "existing"; technologies: number; users: number; teams: number; viewer: "linked" | "none";
}

export async function setupTeam(adminUrl: string, args: TeamArgs, env: NodeJS.ProcessEnv = process.env): Promise<TeamResult> {
  await checkDemoTarget(adminUrl, env);
  const mapping = parseMapping(JSON.parse(readFileSync(TEAM_WORKBOOK_MAPPING_PATH, "utf8")));
  for (const r of Object.values(ROLES)) if (isRestrictedRole(r)) throw new Error(`${r} is restricted; placeholders must not bypass approval`);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query("BEGIN");
    const rows = (await c.query<{ raw: Record<string, string> }>(
      `SELECT raw FROM eureka.import_row WHERE batch_id = $1 AND raw IS NOT NULL AND sheet <> 'sales'`, [args.batch])).rows.map((r) => r.raw);
    if (rows.length === 0) throw new TeamSetupError(`batch ${args.batch} has no staged rows (wrong id, or purged)`, 2);
    const cell = (r: Record<string, string>, h: string) => clean(r[h] ?? "");

    // Location
    let loc = (await c.query<{ id: string }>(`SELECT id FROM eureka.location WHERE lower(name) = lower($1)`, [args.location])).rows[0]?.id;
    const locationState: TeamResult["location"] = loc ? "existing" : "created";
    loc ??= (await c.query<{ id: string }>(`INSERT INTO eureka.location (name, kind) VALUES ($1, 'office') RETURNING id`, [args.location])).rows[0]!.id;

    // Technologies: the mapping's canonical name when it has an alias, else the most frequent spelling.
    const techGroups = new Map<string, string[]>();
    for (const r of rows) {
      const t = cell(r, "Technology");
      if (!t) continue;
      const name = mapping.technologies[labelKey(t)] ?? t;
      techGroups.set(labelKey(name), [...(techGroups.get(labelKey(name)) ?? []), name]);
    }
    let techs = 0;
    for (const names of techGroups.values()) {
      const name = mostCommon(names);
      const r = await c.query(`INSERT INTO eureka.technology (name) SELECT $1 WHERE NOT EXISTS
        (SELECT 1 FROM eureka.technology WHERE lower(name) = lower($1))`, [name]);
      techs += r.rowCount ?? 0;
    }

    // Staff: manager, a lead per tab team, recruiters in the team they logged most rows for.
    const recruiterNames = canonicalNames(rows.map((r) => cell(r, "Recruiter")));
    const manager = mostCommon(rows.map((r) => cell(r, "Manager")));
    const teams = new Map<string, { lead: string; recruiters: Map<string, number> }>();
    for (const r of rows) {
      const team = teamOfTab(cell(r, "Source Tab"));
      if (!team) continue;
      const t = teams.get(team) ?? { lead: "", recruiters: new Map<string, number>() };
      const rec = recruiterNames.get(cell(r, "Recruiter")) ?? cell(r, "Recruiter");
      if (rec) t.recruiters.set(rec, (t.recruiters.get(rec) ?? 0) + 1);
      teams.set(team, t);
    }
    for (const [team, t] of teams) {
      t.lead = mostCommon(rows.filter((r) => teamOfTab(cell(r, "Source Tab")) === team).map((r) => cell(r, "Team Lead"))) || team;
    }
    const homeTeam = new Map<string, string>();
    for (const [team, t] of teams) {
      for (const [rec, n] of t.recruiters) {
        const cur = homeTeam.get(rec);
        if (!cur || (teams.get(cur)!.recruiters.get(rec) ?? 0) < n) homeTeam.set(rec, team);
      }
    }

    let users = 0;
    const userId = async (name: string, designation: string, role: string): Promise<string> => {
      const email = `${slug(name)}@${STAFF_EMAIL_DOMAIN}`;
      const have = (await c.query<{ id: string }>(`SELECT id FROM eureka.app_user WHERE email = $1`, [email])).rows[0]?.id;
      if (have) return have;
      const id = (await c.query<{ id: string }>(
        `INSERT INTO eureka.app_user (email, display_name, designation, primary_location_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [email, name, designation, loc])).rows[0]!.id;
      await c.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1,$2)`, [id, role]);
      users++;
      return id;
    };
    const reportsTo = async (user: string, mgr: string) => {
      await c.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) SELECT $1, $2 WHERE NOT EXISTS
        (SELECT 1 FROM eureka.reporting_line WHERE user_id = $1 AND valid @> now())`, [user, mgr]);
    };
    const mgrId = manager ? await userId(manager, "Manager", ROLES.manager) : null;
    let teamCount = 0;
    for (const [team, t] of teams) {
      const leadId = await userId(t.lead, "Team Lead", ROLES.lead);
      if (mgrId) await reportsTo(leadId, mgrId);
      let teamId = (await c.query<{ id: string }>(`SELECT id FROM eureka.team WHERE name = $1`, [team])).rows[0]?.id;
      if (!teamId) {
        teamId = (await c.query<{ id: string }>(`INSERT INTO eureka.team (name, lead_id, location_id) VALUES ($1,$2,$3) RETURNING id`,
          [team, leadId, loc])).rows[0]!.id;
        teamCount++;
      }
      for (const [rec, home] of homeTeam) {
        if (home !== team) continue;
        const rid = await userId(rec, "Recruiter", ROLES.recruiter);
        await reportsTo(rid, leadId);
        await c.query(`INSERT INTO eureka.team_member (team_id, user_id) SELECT $1, $2 WHERE NOT EXISTS
          (SELECT 1 FROM eureka.team_member WHERE user_id = $2 AND valid @> now())`, [teamId, rid]);
      }
    }

    // Viewer: an existing non-admin account sees every team through the hierarchy.
    let viewer: TeamResult["viewer"] = "none";
    if (args.viewer) {
      const v = (await c.query<{ id: string; admin: boolean }>(
        `SELECT u.id, EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = u.id AND ur.role_key = 'org_admin'
                 AND ur.valid @> now()) AS admin
           FROM eureka.app_user u WHERE lower(u.email::text) = $1 AND u.status = 'active'`, [args.viewer])).rows[0];
      if (!v) throw new TeamSetupError(`no active user ${args.viewer}: create it in Users & Access first`, 3);
      if (v.admin) throw new TeamSetupError(`${args.viewer} is an org admin, which holds no data role: use a separate account`, 3);
      await c.query(`INSERT INTO eureka.user_role (user_id, role_key) SELECT $1, $2 WHERE NOT EXISTS
        (SELECT 1 FROM eureka.user_role WHERE user_id = $1 AND role_key = $2 AND valid @> now())`, [v.id, ROLES.viewer]);
      if (mgrId) await reportsTo(mgrId, v.id);
      viewer = "linked";
    }
    await c.query(`INSERT INTO eureka.audit_event (actor_id, action, entity_type, changes) VALUES (NULL, 'admin.staging_team', 'app_user', $1)`,
      [{ actor: "system:staging-team", batchId: args.batch, users, teams: teamCount, technologies: techs, viewer }]);
    await c.query("COMMIT");
    return { location: locationState, technologies: techs, users, teams: teamCount, viewer };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await setupTeam(adminUrlFromEnv(), parseTeamArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ msg: "staging-team", ...result }));
  } catch (err) {
    const code = err instanceof TeamSetupError ? err.exitCode : (err as { refused?: boolean }).refused ? 3 : 1;
    console.error(JSON.stringify({ msg: "staging-team failed", error: (err as Error).message }));
    process.exitCode = code;
  }
}
