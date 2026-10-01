/**
 * Small FICTIONAL demo org for staging demos (bootstrap --demo-data). Modeled
 * on the integration-test fixtures (test/fixtures.ts, which seed-dev loads):
 * the same three teams and two locations, a sales hierarchy, a coach and a
 * location admin, about 30 candidates and a few submissions. Every name and
 * phone (+1 555 01xx) is made up.
 *
 * - Demo users get placeholder emails at demo.invalid (a reserved TLD), never
 *   in the hosted domain, so nobody can sign in as them: Google sign-in only
 *   accepts hosted-domain accounts and links by that email.
 * - Only non-restricted roles: no second approver is bypassed. org_admin sees
 *   none of this data (rule 7); to show it, give a real account a business
 *   role in Users & Access (e.g. Location Ops Admin for "Demo Dallas").
 * - Org rows are written by the migration user (it owns the org tables).
 *   Candidates and submissions are written as the app role, as each demo
 *   recruiter, through RLS, the guards and audit, exactly like the API.
 * - Refuses databases that look like production, and stacks that already hold
 *   real candidates. Re-running completes what is missing and adds nothing twice.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { isRestrictedRole, type Role } from "@eureka/shared";

export const DEMO_EMAIL_DOMAIN = "demo.invalid";
const email = (key: string) => `demo-${key}@${DEMO_EMAIL_DOMAIN}`;

export const DEMO_LOCATIONS = ["Demo Dallas", "Demo Austin"] as const;
type Loc = (typeof DEMO_LOCATIONS)[number];
const TECHNOLOGIES = ["Java", ".NET", "Python"];
const CLIENTS = ["Northwind Financial", "Contoso Health"];

interface DemoUser { key: string; name: string; designation: string; role: Role; location?: Loc; manager?: string }

export const DEMO_USERS: readonly DemoUser[] = [
  { key: "ad", name: "Asha Rao (demo)", designation: "Associate Director", role: "assoc_director" },
  { key: "m1", name: "Manoj Iyer (demo)", designation: "Manager", role: "manager", manager: "ad" },
  { key: "m2", name: "Meera Shah (demo)", designation: "Manager", role: "manager", manager: "ad" },
  { key: "l1", name: "Rohit Verma (demo)", designation: "Lead", role: "lead", manager: "m1" },
  { key: "l2", name: "Anjali Nair (demo)", designation: "Lead", role: "lead", manager: "m1" },
  { key: "l3", name: "Vikram Desai (demo)", designation: "Lead", role: "lead", manager: "m2" },
  { key: "r1a", name: "Arjun Mehta (demo)", designation: "Recruiter", role: "recruiter", manager: "l1" },
  { key: "r1b", name: "Bhavna Joshi (demo)", designation: "Recruiter", role: "recruiter", manager: "l1" },
  { key: "r2a", name: "Chetan Kumar (demo)", designation: "Recruiter", role: "recruiter", manager: "l2" },
  { key: "r3a", name: "Divya Reddy (demo)", designation: "Recruiter", role: "recruiter", manager: "l3" },
  { key: "coach", name: "Karthik Menon (demo)", designation: "Interview Coach", role: "interview_coach" },
  { key: "locd", name: "Lakshmi Patel (demo)", designation: "Location Ops Admin", role: "location_ops_admin", location: "Demo Dallas" },
];

export const DEMO_TEAMS = [
  { name: "Team Rohit (demo)", lead: "l1", members: ["r1a", "r1b"], location: "Demo Dallas" as Loc },
  { name: "Team Anjali (demo)", lead: "l2", members: ["r2a"], location: "Demo Austin" as Loc },
  { name: "Team Vikram (demo)", lead: "l3", members: ["r3a"], location: "Demo Dallas" as Loc },
];
const COACHED_TEAM = "Team Anjali (demo)";

const FIRST = ["Aarav", "Aditi", "Akash", "Ananya", "Gaurav", "Harini", "Isha", "Kavya", "Naveen", "Neha", "Pooja",
  "Pranav", "Priya", "Rahul", "Ramya", "Sanjay", "Shreya", "Sneha", "Suresh", "Tanvi", "Varun", "Vidya", "Alex",
  "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery"];
const LAST = ["Agarwal", "Bhat", "Chopra", "Gupta", "Kapoor", "Singh", "Sharma", "Brooks", "Carter", "Ellis", "Foster", "Hayes"];
const PER_RECRUITER = 8;
/** Of each recruiter's candidates: how many go active, and how many of those get a submission. */
const ACTIVE = 6;
const SUBMITTED = 3;

/** Refuses anything that could be production: host, database name or the server's current database. */
export async function checkDemoTarget(adminUrl: string): Promise<void> {
  const u = new URL(adminUrl);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  let current: string;
  try {
    current = (await c.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
  } finally {
    await c.end();
  }
  const target = `${u.hostname}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}/${current}`;
  if (/prod/i.test(target)) throw Object.assign(new Error(`demo data refused on ${target}: looks like production`), { refused: true });
}

export interface DemoResult { org: "created" | "existing"; candidatesCreated: number; submissionsCreated: number }

export async function loadDemoData(adminUrl: string, appUrl: string): Promise<DemoResult> {
  for (const u of DEMO_USERS) {
    if (isRestrictedRole(u.role)) throw new Error(`demo role ${u.role} is restricted; demo data must not bypass the second approver`);
  }
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let org: DemoResult["org"];
  const ids = new Map<string, string>();
  let teamOf = new Map<string, string>();
  let locIds = new Map<string, string>();
  let techIds: string[] = [];
  let clientIds: string[] = [];
  try {
    await admin.query("BEGIN");
    // Real candidates and demo data must never mix.
    const real = (await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM eureka.candidate c JOIN eureka.team t ON t.id = c.team_id
       JOIN eureka.app_user u ON u.id = t.lead_id WHERE u.email::text NOT LIKE $1`, [`%@${DEMO_EMAIL_DOMAIN}`])).rows[0]!.n;
    if (real > 0) throw Object.assign(new Error(`demo data refused: the database already holds ${real} real candidates`), { refused: true });

    const existing = await admin.query<{ id: string; email: string }>(
      `SELECT id, email::text FROM eureka.app_user WHERE email::text LIKE $1`, [`%@${DEMO_EMAIL_DOMAIN}`]);
    org = existing.rows.length > 0 ? "existing" : "created";
    if (org === "created") {
      for (const name of DEMO_LOCATIONS) {
        await admin.query(`INSERT INTO eureka.location (name, kind, state) VALUES ($1, 'training', 'TX') ON CONFLICT (name) DO NOTHING`, [name]);
      }
      for (const name of TECHNOLOGIES) await admin.query(`INSERT INTO eureka.technology (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
      for (const name of CLIENTS) await admin.query(`INSERT INTO eureka.client (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
    }
    locIds = new Map((await admin.query<{ id: string; name: string }>(
      `SELECT id, name FROM eureka.location WHERE name = ANY($1)`, [DEMO_LOCATIONS])).rows.map((r) => [r.name, r.id]));
    techIds = (await admin.query<{ id: string }>(`SELECT id FROM eureka.technology WHERE name = ANY($1) ORDER BY name`, [TECHNOLOGIES])).rows.map((r) => r.id);
    clientIds = (await admin.query<{ id: string }>(`SELECT id FROM eureka.client WHERE name = ANY($1) ORDER BY name`, [CLIENTS])).rows.map((r) => r.id);

    if (org === "created") {
      for (const u of DEMO_USERS) {
        const r = await admin.query<{ id: string }>(
          `INSERT INTO eureka.app_user (email, display_name, designation, primary_location_id) VALUES ($1,$2,$3,$4) RETURNING id`,
          [email(u.key), u.name, u.designation, u.location ? locIds.get(u.location)! : null]);
        ids.set(u.key, r.rows[0]!.id);
      }
      for (const u of DEMO_USERS) {
        await admin.query(`INSERT INTO eureka.user_role (user_id, role_key, location_id) VALUES ($1,$2,$3)`,
          [ids.get(u.key), u.role, u.location ? locIds.get(u.location)! : null]);
        if (u.manager) {
          await admin.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ($1,$2)`, [ids.get(u.key), ids.get(u.manager)]);
        }
      }
      for (const t of DEMO_TEAMS) {
        const team = (await admin.query<{ id: string }>(
          `INSERT INTO eureka.team (name, lead_id, location_id) VALUES ($1,$2,$3) RETURNING id`,
          [t.name, ids.get(t.lead), locIds.get(t.location)])).rows[0]!.id;
        for (const m of t.members) await admin.query(`INSERT INTO eureka.team_member (team_id, user_id) VALUES ($1,$2)`, [team, ids.get(m)]);
        if (t.name === COACHED_TEAM) {
          await admin.query(`INSERT INTO eureka.coach_assignment (coach_id, team_id) VALUES ($1,$2)`, [ids.get("coach"), team]);
        }
      }
      await admin.query(
        `INSERT INTO eureka.audit_event (actor_id, action, entity_type, changes) VALUES (NULL, 'admin.bootstrap_demo', 'app_user', $1)`,
        [{ actor: "system:bootstrap", users: DEMO_USERS.length, teams: DEMO_TEAMS.length }]);
    } else {
      for (const r of existing.rows) ids.set(r.email.slice("demo-".length, -(`@${DEMO_EMAIL_DOMAIN}`.length)), r.id);
    }
    teamOf = new Map((await admin.query<{ user_id: string; team_id: string }>(
      `SELECT m.user_id, m.team_id FROM eureka.team_member m WHERE m.valid @> now() AND m.user_id = ANY($1)`,
      [[...ids.values()]])).rows.map((r) => [r.user_id, r.team_id]));
    await admin.query("COMMIT");
  } catch (err) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await admin.end();
  }

  // Candidates and submissions: as each recruiter, through RLS and the guards.
  const app = new pg.Client({ connectionString: appUrl });
  await app.connect();
  let candidatesCreated = 0;
  let submissionsCreated = 0;
  try {
    let n = 0;
    for (const u of DEMO_USERS.filter((x) => x.role === "recruiter")) {
      const rid = ids.get(u.key);
      const teamId = rid ? teamOf.get(rid) : undefined;
      if (!rid || !teamId) throw new Error(`demo recruiter ${u.key} is missing or has no team`);
      const loc = locIds.get(DEMO_TEAMS.find((t) => t.members.includes(u.key))!.location)!;
      await app.query("BEGIN");
      try {
        await app.query("SELECT set_config('eureka.user_id', $1, true)", [rid]);
        const have = (await app.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM eureka.candidate WHERE recruiter_id = $1", [rid])).rows[0]!.n;
        if (have > 0) { await app.query("ROLLBACK"); n += PER_RECRUITER; continue; }
        for (let k = 0; k < PER_RECRUITER; k++) {
          n++;
          const personId = randomUUID();
          await app.query(`INSERT INTO eureka.person (id, first_name, last_name, phone_e164) VALUES ($1,$2,$3,$4)`,
            [personId, FIRST[(n * 7) % FIRST.length], LAST[(n * 5) % LAST.length], `+1555010${String(n).padStart(4, "0")}`]);
          const cand = (await app.query<{ id: string }>(
            `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`, [personId, techIds[n % techIds.length], teamId, rid, loc])).rows[0]!.id;
          await app.query(`INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id) VALUES ($1,'candidate.created','candidate',$2)`, [rid, cand]);
          candidatesCreated++;
          if (k >= ACTIVE) continue; // stays in training
          await app.query("SELECT authz.transition_candidate($1, 'active')", [cand]);
          if (k >= SUBMITTED) continue;
          const sub = (await app.query<{ id: string }>(
            `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,$2,$3) RETURNING id`,
            [cand, `${TECHNOLOGIES[n % TECHNOLOGIES.length]} Developer`, clientIds[n % clientIds.length]])).rows[0]!.id;
          await app.query(`INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id) VALUES ($1,'submission.created','submission',$2)`, [rid, sub]);
          submissionsCreated++;
          if (k === 0) await app.query("SELECT authz.transition_submission($1, 'under_review', NULL)", [sub]);
        }
        await app.query("COMMIT");
      } catch (err) {
        await app.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    }
  } finally {
    await app.end();
  }
  return { org, candidatesCreated, submissionsCreated };
}
