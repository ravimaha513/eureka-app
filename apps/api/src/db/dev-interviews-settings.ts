/**
 * Local development only (interviews-settings package): fictional interview
 * details, panels, scorecards, staff profiles and one notification
 * preference on top of the dev pipeline, written as the acting users through
 * the app role (RLS, guards and authz.set_interview_panel apply). Meeting
 * links point at meet.example.com and phones use the fictional 555-01xx
 * range. Idempotent: does nothing once any panel exists.
 */
import type pg from "pg";

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const U = {
  l1: uid(6), l2: uid(7), l3: uid(8), r1a: uid(9), r2a: uid(11), coach: uid(13), locD: uid(14), hr: uid(16), admin: uid(18),
};
const TYPES = ["video", "phone", "in_person"] as const;
const SCORES = [[4, 4, 3, 5], [5, 4, 4, 4], [3, 4, 3, 4], [4, 5, 4, 5]];

export interface DevInterviewsSettingsResult { panels: number; scorecards: number; profiles: number }

async function asUser<T>(admin: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE eureka_app");
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

export async function seedDevInterviewsSettings(admin: pg.Pool): Promise<DevInterviewsSettingsResult> {
  const out: DevInterviewsSettingsResult = { panels: 0, scorecards: 0, profiles: 0 };
  if ((await admin.query("SELECT 1 FROM eureka.interview_panelist LIMIT 1")).rowCount) return out;

  // Interview details and panels, as the recruiter who owns each interview.
  const { rows } = await admin.query<{ id: string; recruiter_id: string; team_id: string | null; lead_id: string | null; call_status: string }>(
    `SELECT i.id, i.recruiter_id, i.team_id, t.lead_id, i.call_status FROM eureka.interview i
     LEFT JOIN eureka.team t ON t.id = i.team_id ORDER BY i.starts_at DESC, i.id LIMIT 16`);
  let n = 0;
  for (const r of rows) {
    const type = TYPES[n % TYPES.length]!;
    const panel = [...new Set([U.coach, r.lead_id ?? U.l1])];
    await asUser(admin, r.recruiter_id, async (c) => {
      await c.query(`UPDATE eureka.interview SET interview_type = $2, meeting_url = $3 WHERE id = $1`,
        [r.id, type, type === "video" ? `https://meet.example.com/eureka-dev-${n + 1}` : null]);
      await c.query(`SELECT authz.set_interview_panel($1, $2::uuid[], $3)`, [r.id, panel, U.coach]);
    });
    out.panels++;
    n++;
  }

  // Scorecards: the coach on coached interviews (Team Anjali), recruiters relaying client feedback on their own.
  const coached = await admin.query<{ id: string }>(
    `SELECT i.id FROM eureka.interview i JOIN eureka.coach_assignment ca ON ca.team_id = i.team_id AND ca.coach_id = $1
     WHERE i.starts_at < now() ORDER BY i.starts_at DESC LIMIT 3`, [U.coach]);
  for (const [k, r] of coached.rows.entries()) {
    const [t, c, p, a] = SCORES[k % SCORES.length]!;
    await asUser(admin, U.coach, (cl) => cl.query(
      `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating, notes, technical_skills, communication, problem_solving, attitude)
       VALUES ($1,$2,'coach',$3,$4,$5,$6,$7,$8)`,
      [r.id, U.coach, Math.round((t! + c! + p! + a!) / 4), "Fictional coaching notes: clear examples, practise system design.", t, c, p, a]));
    out.scorecards++;
  }
  const own = await admin.query<{ id: string }>(
    `SELECT id FROM eureka.interview WHERE recruiter_id = $1 AND starts_at < now() ORDER BY starts_at DESC LIMIT 2`, [U.r1a]);
  for (const [k, r] of own.rows.entries()) {
    const [t, c, p, a] = SCORES[(k + 1) % SCORES.length]!;
    await asUser(admin, U.r1a, (cl) => cl.query(
      `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, technical_skills, communication, problem_solving, attitude)
       VALUES ($1,$2,'client',$3,$4,$5,$6)`, [r.id, U.r1a, t, c, p, a]));
    out.scorecards++;
  }

  // Staff profiles (fictional 555-01xx numbers) and designations shown in Users & Access.
  const profiles: [string, string, string][] = [
    [U.r1a, "+14695550101", "Java and cloud hiring for Team Rohit (fictional)."],
    [U.l1, "+14695550102", "Leads Team Rohit (fictional)."],
    [U.coach, "+14695550103", "Interview coach for Team Anjali (fictional)."],
    [U.hr, "+14695550104", "HR operations (fictional)."],
  ];
  for (const [user, phone, bio] of profiles) {
    await asUser(admin, user, (c) => c.query(
      `INSERT INTO eureka.staff_profile (user_id, phone_e164, bio) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING`, [user, phone, bio]));
    out.profiles++;
  }
  // Seed-only: designations are display labels (no app write path outside admin create).
  await admin.query(`UPDATE eureka.app_user SET designation = v.d FROM (VALUES ($1::uuid,'Senior Recruiter'),($2::uuid,'Team Lead'),($3::uuid,'Interview Trainer'),($4::uuid,'HR Manager'))
    AS v(id, d) WHERE app_user.id = v.id AND app_user.designation IS NULL`, [U.r1a, U.l1, U.coach, U.hr]);

  // HR mutes one optional in-app type, to show the Settings toggle in a non-default state.
  await asUser(admin, U.hr, (c) => c.query(
    `INSERT INTO eureka.notification_preference (user_id, type, in_app) VALUES ($1,'assignment.ending_soon',false)
     ON CONFLICT (user_id, type) DO NOTHING`, [U.hr]));
  return out;
}
