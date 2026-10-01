/**
 * Load-test seed (loadtest/README.md): a FICTIONAL org of ~170 users in 30
 * teams, ~50,000 candidates and a realistic pipeline (submissions, interviews,
 * placements) for the k6 test. Every name, phone (+1 555 ...) and email
 * (*@eureka.example) is made up; nothing is copied from anywhere.
 *
 *   LOAD_SEED_CONFIRM=<database host>/<database name> \
 *   MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/eureka_load \
 *     pnpm --filter @eureka/api db:seed-load
 *
 * Guards: refuses a host or database whose name contains "prod", and needs
 * LOAD_SEED_CONFIRM to name the exact target, so it never runs by accident.
 * Activity rows are written the way the app writes them: as each user (the
 * eureka.user_id setting), through the snapshot triggers and the
 * authz.transition_submission / authz.create_placement functions.
 *
 * Optional:
 *   LOAD_CANDIDATES=50000         candidates to create (default 50000)
 *   LOAD_SESSION_KEY=<32+ chars>  also mint one session per load user, with id
 *                                 hex(HMAC-SHA256(key, email)); k6 derives the
 *                                 same ids (AUTH=minted) where dev sign-in is off.
 *   LOAD_SESSION_HOURS=12         lifetime of minted sessions
 * Re-running skips the data (the load org exists) and only re-mints sessions.
 */
import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { adminUrlFromEnv, migrate } from "./migrate.js";

export const LOAD_DOMAIN = "eureka.example";
export const TEAMS = 30;
export const RECRUITERS_PER_TEAM = 4;
const MANAGERS = 6; // 5 leads each
const COACHES = 3;

/** Emails of the load users; loadtest/lib/users.js builds the same list. */
export function loadUsers(): { email: string; name: string; kind: string; n: number }[] {
  const out: { email: string; name: string; kind: string; n: number }[] = [];
  const add = (kind: string, count: number, pad: number) => {
    for (let n = 1; n <= count; n++) {
      const id = String(n).padStart(pad, "0");
      out.push({ email: `load-${kind}-${id}@${LOAD_DOMAIN}`, name: `Load ${kind} ${id}`, kind, n });
    }
  };
  add("manager", MANAGERS, 2);
  add("lead", TEAMS, 2);
  add("recruiter", TEAMS * RECRUITERS_PER_TEAM, 3);
  add("locadmin", 4, 2);
  add("coach", COACHES, 2);
  add("hr", 2, 2);
  add("accounts", 2, 2);
  return out;
}

/** Session id for a minted load session; must match loadtest/lib/auth.js. */
export const mintedSid = (key: string, email: string) => createHmac("sha256", key).update(email).digest("hex");

const LOCATIONS = [["Dallas", "TX"], ["Austin", "TX"], ["Houston", "TX"], ["Charlotte", "NC"]] as const;
const TECHNOLOGIES = ["Java", ".NET", "Python", "Data Engineering", "DevOps", "Salesforce", "QA Automation",
  "React", "Business Analyst", "SAP", "Cloud Engineering", "Data Science"];
const CLIENTS = ["Northwind Financial", "Contoso Health", "Fabrikam Retail", "Tailspin Airlines", "Adventure Works",
  "Wide World Importers", "Proseware", "Litware", "Woodgrove Bank", "Fourth Coffee", "Alpine Ski House",
  "Blue Yonder Airlines", "Coho Vineyard", "Graphic Design Institute", "Humongous Insurance", "Lucerne Publishing",
  "Margie's Travel", "Northwind Traders", "Relecloud", "School of Fine Art", "Southridge Video", "Trey Research",
  "VanArsdel", "Wingtip Toys"];
const VENDORS = ["Contoso Staffing", "Fabrikam Talent", "Litware Consulting", "Proseware Partners", "Tailspin Talent",
  "Woodgrove Solutions", "Lamna Staffing", "Bellows Consulting"];
const FIRST = ["Aarav", "Aditi", "Akash", "Ananya", "Arjun", "Bhavna", "Chetan", "Deepa", "Divya", "Gaurav", "Harini",
  "Isha", "Karthik", "Kavya", "Lakshmi", "Manoj", "Meera", "Naveen", "Neha", "Pooja", "Pranav", "Priya", "Rahul",
  "Ramya", "Rohan", "Sanjay", "Shreya", "Sneha", "Suresh", "Tanvi", "Varun", "Vidya", "Alex", "Jordan", "Taylor",
  "Morgan", "Casey", "Riley", "Jamie", "Avery"];
const LAST = ["Agarwal", "Bhat", "Chopra", "Desai", "Gupta", "Iyer", "Joshi", "Kapoor", "Kumar", "Mehta", "Menon",
  "Nair", "Patel", "Rao", "Reddy", "Shah", "Sharma", "Singh", "Verma", "Yadav", "Brooks", "Carter", "Ellis",
  "Foster", "Hayes", "Morgan", "Parker", "Quinn"];

const lit = (xs: readonly string[]) => `ARRAY[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(",")}]::text[]`;

/** Refuses anything that could be production, and anything not named in LOAD_SEED_CONFIRM. */
export function checkTarget(url: string, confirm: string | undefined): void {
  const u = new URL(url);
  const target = `${u.hostname}/${u.pathname.replace(/^\//, "")}`;
  if (/prod/i.test(target)) throw new Error(`seed-load refuses ${target}: looks like production`);
  if (confirm !== target) throw new Error(`Set LOAD_SEED_CONFIRM=${target} to seed fictional load data into this database`);
}

async function asUser<T>(pool: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function seedReference(db: pg.Pool) {
  for (const [name, state] of LOCATIONS) {
    await db.query(`INSERT INTO eureka.location (name, kind, state, timezone) VALUES ($1,'training',$2,'America/Chicago')
      ON CONFLICT (name) DO NOTHING`, [name, state]);
  }
  await db.query(`INSERT INTO eureka.technology (name) SELECT unnest(${lit(TECHNOLOGIES)}) ON CONFLICT (name) DO NOTHING`);
  await db.query(`INSERT INTO eureka.client (name) SELECT unnest(${lit(CLIENTS)}) ON CONFLICT (name) DO NOTHING`);
  await db.query(`INSERT INTO eureka.vendor (name) SELECT unnest(${lit(VENDORS)}) ON CONFLICT (name) DO NOTHING`);
}

async function seedOrg(db: pg.Pool) {
  const users = loadUsers();
  const id = new Map<string, string>();
  for (const u of users) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO eureka.app_user (email, display_name, designation) VALUES ($1,$2,$3) RETURNING id`, [u.email, u.name, u.kind]);
    id.set(`${u.kind}-${u.n}`, r.rows[0]!.id);
  }
  const locs = (await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM eureka.location WHERE name = ANY($1)`, [LOCATIONS.map(([n]) => n)])).rows;
  const locId = (i: number) => locs.find((l) => l.name === LOCATIONS[i % LOCATIONS.length]![0])!.id;
  const role = (userId: string, r: string, location: string | null = null) =>
    db.query(`INSERT INTO eureka.user_role (user_id, role_key, location_id) VALUES ($1,$2,$3)`, [userId, r, location]);

  for (let m = 1; m <= MANAGERS; m++) await role(id.get(`manager-${m}`)!, "manager");
  for (let l = 1; l <= 4; l++) await role(id.get(`locadmin-${l}`)!, "location_ops_admin", locId(l - 1));
  for (let c = 1; c <= COACHES; c++) await role(id.get(`coach-${c}`)!, "interview_coach");
  for (let h = 1; h <= 2; h++) await role(id.get(`hr-${h}`)!, "hr");
  for (let a = 1; a <= 2; a++) await role(id.get(`accounts-${a}`)!, "accounts");

  for (let t = 1; t <= TEAMS; t++) {
    const lead = id.get(`lead-${t}`)!;
    const manager = id.get(`manager-${Math.ceil(t / (TEAMS / MANAGERS))}`)!;
    await role(lead, "lead");
    await db.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ($1,$2)`, [lead, manager]);
    const team = (await db.query<{ id: string }>(
      `INSERT INTO eureka.team (name, lead_id, location_id) VALUES ($1,$2,$3) RETURNING id`,
      [`Load Team ${String(t).padStart(2, "0")}`, lead, locId(t)])).rows[0]!.id;
    for (let k = 1; k <= RECRUITERS_PER_TEAM; k++) {
      const r = id.get(`recruiter-${(t - 1) * RECRUITERS_PER_TEAM + k}`)!;
      await role(r, "recruiter");
      await db.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ($1,$2)`, [r, lead]);
      await db.query(`INSERT INTO eureka.team_member (team_id, user_id) VALUES ($1,$2)`, [team, r]);
    }
    await db.query(`INSERT INTO eureka.coach_assignment (coach_id, team_id) VALUES ($1,$2)`,
      [id.get(`coach-${1 + ((t - 1) % COACHES)}`)!, team]);
  }
}

/** Set-based: persons and candidates spread over the load teams, recruiters, locations and statuses. */
async function seedCandidates(db: pg.Pool, count: number) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query(`
      CREATE TEMP TABLE slot ON COMMIT DROP AS
      SELECT (row_number() OVER (ORDER BY t.name, m.user_id))::int - 1 AS slot, t.id AS team_id, m.user_id AS recruiter_id
      FROM eureka.team t JOIN eureka.team_member m ON m.team_id = t.id
      WHERE t.name LIKE 'Load Team %'`);
    await c.query(`
      CREATE TEMP TABLE gen ON COMMIT DROP AS
      SELECT i, gen_random_uuid() AS person_id, random() AS r_status, random() AS r_vis, random() AS r_rec
      FROM generate_series(1, $1::int) i`, [count]);
    await c.query(`
      INSERT INTO eureka.person (id, first_name, last_name, phone_e164, dob_year)
      SELECT g.person_id,
             (${lit(FIRST)})[1 + (g.i * 7) % ${FIRST.length}],
             (${lit(LAST)})[1 + (g.i * 13) % ${LAST.length}],
             '+1555' || lpad((1000000 + g.i)::text, 7, '0'),
             1985 + (g.i % 16)
      FROM gen g`);
    // Status mix: most of the bench is active or on hold; some placed, in training, stopped.
    await c.query(`
      INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, visibility,
        marketing_status, priority, marketing_start_date, technical_rating, bench_since)
      SELECT g.person_id,
             (SELECT array_agg(id ORDER BY name) FROM eureka.technology)[1 + g.i % (SELECT count(*) FROM eureka.technology)::int],
             s.team_id,
             CASE WHEN g.r_rec < 0.1 THEN NULL ELSE s.recruiter_id END,
             (SELECT array_agg(id ORDER BY name) FROM eureka.location WHERE name = ANY(${lit(LOCATIONS.map(([n]) => n))}))[1 + g.i % ${LOCATIONS.length}],
             CASE WHEN g.r_vis < 0.2 THEN 'all_teams' ELSE 'team' END,
             st.status,
             (ARRAY['P1','P2','P3'])[1 + g.i % 3],
             CASE WHEN st.status IN ('active','on_hold','full_of_interviews','confirmation') THEN current_date - (g.i % 120) END,
             CASE WHEN g.i % 3 = 0 THEN 1 + g.i % 5 END,
             CASE WHEN st.status = 'bench' THEN current_date - (g.i % 60) END
      FROM gen g
      JOIN slot s ON s.slot = g.i % (SELECT count(*) FROM slot)
      CROSS JOIN LATERAL (SELECT CASE
          WHEN g.r_status < 0.40 THEN 'active' WHEN g.r_status < 0.48 THEN 'on_hold'
          WHEN g.r_status < 0.55 THEN 'full_of_interviews' WHEN g.r_status < 0.70 THEN 'bench'
          WHEN g.r_status < 0.80 THEN 'in_training' WHEN g.r_status < 0.88 THEN 'stopped'
          WHEN g.r_status < 0.91 THEN 'confirmation' WHEN g.r_status < 0.98 THEN 'placed'
          ELSE 'terminated' END AS status) st`);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * As each recruiter: ~180 submissions over the last 90 days, walked along the
 * state machine; interviews for the ones past interview_requested; a few
 * placements from selected submissions.
 */
async function seedPipeline(db: pg.Pool) {
  const recruiters = (await db.query<{ id: string }>(
    `SELECT id FROM eureka.app_user WHERE email LIKE 'load-recruiter-%' ORDER BY email`)).rows.map((r) => r.id);
  const coaches = (await db.query<{ id: string }>(
    `SELECT id FROM eureka.app_user WHERE email LIKE 'load-coach-%' ORDER BY email`)).rows.map((r) => r.id);
  const step = (from: string, to: string, share: number) =>
    `SELECT count(authz.transition_submission(id, '${to}', NULL)) FROM eureka.submission
     WHERE recruiter_id = authz.current_user_id() AND status = '${from}' AND random() < ${share}`;
  let i = 0;
  for (const rid of recruiters) {
    i++;
    await asUser(db, rid, async (c) => {
      await c.query(`
        INSERT INTO eureka.submission (candidate_id, job_title, client_id, vendor_id, rate, submitted_at)
        SELECT c.id,
               (ARRAY['Java Developer','Senior .NET Engineer','Data Engineer','DevOps Engineer','Salesforce Developer',
                      'QA Automation Engineer','React Developer','Business Analyst'])[1 + (k + abs(hashtext(c.id::text))) % 8],
               (SELECT array_agg(id ORDER BY name) FROM eureka.client)[1 + abs(hashtext(c.id::text || k)) % (SELECT count(*) FROM eureka.client)::int],
               CASE WHEN k % 2 = 0 THEN (SELECT array_agg(id ORDER BY name) FROM eureka.vendor)[1 + abs(hashtext(c.id::text)) % (SELECT count(*) FROM eureka.vendor)::int] END,
               55 + abs(hashtext(c.id::text || k)) % 40,
               now() - make_interval(days => abs(hashtext(c.id::text || k)) % 90, mins => abs(hashtext(c.id::text)) % 600)
        FROM eureka.candidate c CROSS JOIN generate_series(1, 2) k
        WHERE c.recruiter_id = $1 AND c.marketing_status IN ('active','full_of_interviews','on_hold','confirmation','placed')`, [rid]);
      await c.query(step("submitted", "under_review", 0.7));
      await c.query(step("under_review", "interview_requested", 0.5));
      await c.query(step("interview_requested", "interview_scheduled", 0.8));
      // Interviews (for submissions now at interview_scheduled): business hours from 30 days ago to 14 days ahead; overlapping slots for one candidate are skipped.
      await c.query(`
        INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at, coach_id, invite_received)
        SELECT s.id, (ARRAY['L1','L2','Client','Final'])[1 + abs(hashtext(s.id::text)) % 4], t.at, t.at + interval '1 hour',
               CASE WHEN abs(hashtext(s.id::text)) % 3 = 0 THEN ($2::uuid[])[1 + abs(hashtext(s.id::text)) % array_length($2::uuid[], 1)] END,
               abs(hashtext(s.id::text)) % 4 <> 0
        FROM eureka.submission s
        CROSS JOIN LATERAL (SELECT date_trunc('hour', now()) - interval '30 days'
          + make_interval(days => abs(hashtext(s.id::text)) % 44, hours => abs(hashtext(s.id::text || 'h')) % 9) AS at) t
        WHERE s.recruiter_id = $1 AND s.status = 'interview_scheduled'
        ON CONFLICT DO NOTHING`, [rid, coaches]);
      // Interviews can't be added to a closed (selected/rejected) submission, so close some only now.
      await c.query(step("interview_scheduled", "interview_completed", 0.5));
      await c.query(step("interview_completed", "selected", 0.15));
      await c.query(`SELECT count(authz.transition_submission(id, 'rejected', 'Client chose another candidate'))
        FROM eureka.submission WHERE recruiter_id = authz.current_user_id() AND status = 'under_review' AND random() < 0.3`);
      // Placements from selected submissions whose candidate is still placeable.
      await c.query(`
        SELECT count(p.*) FROM (
          SELECT DISTINCT ON (s.candidate_id) s.id FROM eureka.submission s
          JOIN eureka.candidate c ON c.id = s.candidate_id
          WHERE s.recruiter_id = $1 AND s.status = 'selected' AND c.marketing_status IN ('active','full_of_interviews')
          ORDER BY s.candidate_id, s.submitted_at) sel
        CROSS JOIN LATERAL authz.create_placement(sel.id, (ARRAY['w2','c2c','1099'])[1 + abs(hashtext(sel.id::text)) % 3],
          60 + abs(hashtext(sel.id::text)) % 30, (ARRAY['onsite','remote','hybrid'])[1 + abs(hashtext(sel.id::text || 'm')) % 3],
          'Dallas', 'TX', current_date + abs(hashtext(sel.id::text)) % 30, NULL, NULL) p`, [rid]);
    });
    if (i % 20 === 0) console.log(`  pipeline: ${i}/${recruiters.length} recruiters`);
  }
}

async function mintSessions(db: pg.Pool, key: string, hours: number) {
  if (key.length < 32) throw new Error("LOAD_SESSION_KEY must be at least 32 characters");
  const users = loadUsers();
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query(`DELETE FROM eureka.session WHERE user_id IN (SELECT id FROM eureka.app_user WHERE email = ANY($1))`,
      [users.map((u) => u.email)]);
    for (const u of users) {
      const hash = createHash("sha256").update(mintedSid(key, u.email)).digest();
      await c.query(
        `INSERT INTO eureka.session (id_hash, user_id, expires_at, auth_time, access_version)
         SELECT $1, id, now() + make_interval(hours => $3), now(), access_version
         FROM eureka.app_user WHERE email = $2 AND status = 'active'`, [hash, u.email, hours]);
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  console.log(`minted ${users.length} load sessions valid for ${hours} h (idle timeout still applies: start k6 soon)`);
}

export async function seedLoad(url: string, opts: { candidates: number; sessionKey?: string; sessionHours: number }) {
  await migrate(url);
  const db = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const exists = (await db.query(`SELECT 1 FROM eureka.app_user WHERE email = $1`, [loadUsers()[0]!.email])).rowCount;
    if (exists) {
      console.log("load org already present; skipping data");
    } else {
      const t0 = Date.now();
      await seedReference(db);
      await seedOrg(db);
      console.log(`org: ${loadUsers().length} users, ${TEAMS} teams`);
      await seedCandidates(db, opts.candidates);
      console.log(`candidates: ${opts.candidates}`);
      await seedPipeline(db);
      await db.query("ANALYZE");
      const n = (await db.query<{ s: number; i: number; p: number }>(`SELECT
        (SELECT count(*) FROM eureka.submission)::int AS s, (SELECT count(*) FROM eureka.interview)::int AS i,
        (SELECT count(*) FROM eureka.placement)::int AS p`)).rows[0]!;
      console.log(`pipeline: ${n.s} submissions, ${n.i} interviews, ${n.p} placements (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
    if (opts.sessionKey) await mintSessions(db, opts.sessionKey, opts.sessionHours);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const url = adminUrlFromEnv();
  checkTarget(url, process.env.LOAD_SEED_CONFIRM);
  await seedLoad(url, {
    candidates: Number(process.env.LOAD_CANDIDATES ?? 50_000),
    sessionKey: process.env.LOAD_SESSION_KEY || undefined,
    sessionHours: Number(process.env.LOAD_SESSION_HOURS ?? 12),
  });
}
