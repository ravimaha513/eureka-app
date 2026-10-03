/**
 * Local development only: a realistic fictional pipeline on top of the dev
 * fixtures, so Submissions, Interviews, Placements and the dashboards have
 * something to show. Submissions, interviews, feedback and placements are
 * written as the acting user through the app role (RLS, guards, definer
 * functions and candidate_event triggers all apply); afterwards a seed-only
 * backfill (triggers off) spreads the timestamps over the last few weeks and
 * marks past interviews completed or cleared, which the app only does as time
 * passes. Idempotent: does nothing when submissions already exist.
 */
import type pg from "pg";

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const U = { r1a: uid(9), r1b: uid(10), r2a: uid(11), r3a: uid(12), coach: uid(13), locD: uid(14), locA: uid(15), hr: uid(16) };
/** Fictional sample checklists for local development only (not product content). */
const SAMPLE_TEMPLATES: Record<string, { doc_type: string; owner_role: string; required?: boolean }[]> = {
  w2: [
    { doc_type: "sample_form_a", owner_role: "hr" },
    { doc_type: "sample_form_b", owner_role: "immigration" },
    { doc_type: "sample_form_c", owner_role: "accounts", required: false },
  ],
  c2c: [
    { doc_type: "sample_form_a", owner_role: "hr" },
    { doc_type: "sample_form_d", owner_role: "accounts" },
  ],
  "1099": [{ doc_type: "sample_form_e", owner_role: "accounts" }],
};
const NORTHWIND = uid(601);
const CLIENTS: [string, string][] = [
  [uid(602), "Contoso Health"], [uid(603), "Fabrikam Retail"], [uid(604), "Tailspin Airlines"], [uid(605), "Woodgrove Bank"],
];
const JOBS = ["Java Developer", "Senior Java Engineer", "Spring Boot Developer", "Backend Engineer",
  "Full Stack Developer", "Java Microservices Engineer", "API Developer", "Platform Engineer"];
const PATH = ["under_review", "interview_requested", "interview_scheduled", "interview_completed", "selected"];
/** How far each recruiter's n-th submission gets (index into PATH, -1 = just submitted); 9 = rejected, 8 = withdrawn. */
const DEPTH = [5, 4, 3, 2, 2, 1, 0, -1, 9, 3, 5, 8];
const PLACEMENT_STEPS = [["paperwork", "bgc", "ready", "joined"], ["paperwork", "bgc"], [], ["paperwork"], ["backout"]];

export interface DevPipelineResult { submissions: number; interviews: number; feedback: number; placements: number }

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

const daysAgo = (d: number, hour = 15) => {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() - d);
  t.setUTCHours(hour, 0, 0, 0);
  return t;
};

export async function seedDevPipeline(admin: pg.Pool): Promise<DevPipelineResult> {
  const out: DevPipelineResult = { submissions: 0, interviews: 0, feedback: 0, placements: 0 };
  if ((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM eureka.submission")).rows[0]!.n > 0) return out;

  for (const [id, name] of CLIENTS) {
    await admin.query("INSERT INTO eureka.client (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [id, name]);
  }

  // Development only: clearly fictional sample paperwork templates (the real
  // content per placement type is an open product question; none ships).
  // Published by the dev HR user through the same definer function as the app.
  for (const [type, items] of Object.entries(SAMPLE_TEMPLATES)) {
    await asUser(admin, U.hr, async (c) => {
      const cur = (await c.query<{ v: number }>(
        `SELECT coalesce(max(version), 0)::int AS v FROM authz.checklist_templates() WHERE kind = 'paperwork' AND placement_type = $1`, [type])).rows[0]!.v;
      if (cur === 0) await c.query(`SELECT authz.publish_checklist_template('paperwork', $1, $2::jsonb, 0)`, [type, JSON.stringify(items)]);
    });
  }
  const clients = [NORTHWIND, ...CLIENTS.map(([id]) => id)];

  /** Timestamps to apply after the writes: [table, id, column, value]. */
  const backfill: [string, string, string, Date | boolean | string][] = [];
  const recruiters = [U.r1a, U.r1b, U.r2a, U.r3a];
  let g = 0;
  for (const rid of recruiters) {
    // Marketable candidates first; on-hold ones are moved back to active by their recruiter, as in the app.
    const cands = (await admin.query<{ id: string; team_id: string; location_id: string; marketing_status: string }>(
      `SELECT id, team_id, location_id, marketing_status FROM eureka.candidate
        WHERE recruiter_id = $1 AND marketing_status IN ('active','full_of_interviews','on_hold')
        ORDER BY marketing_status = 'on_hold', id LIMIT $2`, [rid, DEPTH.length])).rows;
    for (const [k, cand] of cands.entries()) {
      if (cand.marketing_status === "on_hold") {
        await asUser(admin, rid, (c) => c.query("SELECT authz.transition_candidate($1, 'active')", [cand.id]));
      }
      g++;
      const depth = DEPTH[k]!;
      const age = 2 + ((g * 5) % 26); // submitted 2-27 days ago
      const subId = await asUser(admin, rid, async (c) => (await c.query<{ id: string }>(
        `INSERT INTO eureka.submission (candidate_id, job_title, client_id, rate) VALUES ($1,$2,$3,$4) RETURNING id`,
        [cand.id, JOBS[g % JOBS.length], clients[g % clients.length], 55 + (g % 6) * 5])).rows[0]!.id);
      out.submissions++;
      backfill.push(["submission", subId, "submitted_at", daysAgo(age, 14)]);

      const steps = depth === 9 ? ["under_review", "rejected"] : depth === 8 ? ["under_review", "withdrawn"] : PATH.slice(0, depth + 1);
      let interviewId: string | null = null;
      for (const [i, to] of steps.entries()) {
        if (to === "interview_scheduled") {
          // Completed or selected: the interview is in the past; otherwise it is coming up this week.
          const past = depth >= 3;
          const start = past ? daysAgo(Math.max(1, age - 5), 15 + (g % 4)) : daysAgo(-(1 + (g % 5)), 14 + (g % 5));
          const coach = cand.team_id === uid(102) ? U.coach : null;
          interviewId = await asUser(admin, rid, async (c) => (await c.query<{ id: string }>(
            `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at, coach_id)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [subId, g % 3 ? "Technical round 1" : "Client round", start, new Date(start.getTime() + 3_600_000), coach])).rows[0]!.id);
          out.interviews++;
          if (past) {
            backfill.push(["interview", interviewId, "call_status", "completed"]);
            if (g % 2 === 0) {
              backfill.push(["interview", interviewId, "cleared", true]);
              backfill.push(["interview", interviewId, "cleared_at", new Date(start.getTime() + 2 * 3_600_000)]);
            }
          }
        }
        await asUser(admin, rid, (c) => c.query("SELECT authz.transition_submission($1,$2,$3)",
          [subId, to, to === "rejected" ? "Client chose another candidate" : null]));
        backfill.push(["submission", subId, "status_changed_at", daysAgo(Math.max(0, age - 2 * (i + 1)), 16)]);
      }

      // Feedback on past interviews: the recruiter relays the client's view; the coach adds theirs where they coach the team.
      // Every fifth past interview gets no feedback, so the dashboards' "without feedback" list has rows.
      if (interviewId && depth >= 3 && g % 5 !== 0) {
        await asUser(admin, rid, (c) => c.query(
          `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating, notes) VALUES ($1,$2,'client',$3,$4)`,
          [interviewId, rid, depth >= 4 ? 5 : 3, depth >= 4 ? "Strong on Spring and system design; client wants to move ahead."
            : "Good fundamentals, needs more depth on concurrency."]));
        out.feedback++;
        if (cand.team_id === uid(102)) {
          await asUser(admin, U.coach, (c) => c.query(
            `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating, notes) VALUES ($1,$2,'coach',4,$3)`,
            [interviewId, U.coach, "Prepared well; practise explaining past projects more concisely."]));
          out.feedback++;
        }
      }

      if (depth === 5) {
        const steps2 = PLACEMENT_STEPS[out.placements % PLACEMENT_STEPS.length]!;
        const start = daysAgo(-(10 + (g % 20)));
        const placementId = await asUser(admin, rid, async (c) => (await c.query<{ placement_id: string }>(
          "SELECT * FROM authz.create_placement($1,$2,$3,$4,$5,$6,$7::date,$8,$9::jsonb)",
          [subId, ["w2", "c2c", "1099"][g % 3], 60 + (g % 5) * 5, ["onsite", "hybrid", "remote"][g % 3],
            ["Dallas", "Austin", "Plano", "Irving"][g % 4], "TX", start.toISOString().slice(0, 10), null,
            JSON.stringify([
              { kind: "client_manager", name: "Pat Lee", email: "pat.lee@client.example" },
              { kind: "vendor_poc", name: "Sam Ortiz", email: "sam.ortiz@vendor.example", phone: "+15550100001" },
            ])])).rows[0]!.placement_id);
        out.placements++;
        for (const to of steps2) {
          await asUser(admin, rid, (c) => c.query("SELECT authz.transition_placement($1,$2,$3)",
            [placementId, to, to === "backout" ? "Candidate declined the offer" : null]));
        }
        // Some paperwork progress for the Paperwork & BGC screen (HR, through the definer functions).
        if (!steps2.includes("backout")) {
          await asUser(admin, U.hr, async (c) => {
            const items = (await c.query<{ id: string; owner_role: string }>(
              `SELECT id, owner_role FROM eureka.checklist_item WHERE placement_id = $1 ORDER BY position`, [placementId])).rows;
            if (items[0]) {
              await c.query(`SELECT authz.update_checklist_item($1, $2::jsonb, NULL)`, [items[0].id, JSON.stringify({
                status: "received", dueOn: daysAgo(3).toISOString().slice(0, 10),
                // Assignees must hold the item's owner role.
                ...(items[0].owner_role === "hr" ? { assigneeId: U.hr } : {}),
              })]);
            }
            if (items[1]) {
              await c.query(`SELECT authz.update_checklist_item($1, $2::jsonb, NULL)`, [items[1].id,
                JSON.stringify({ dueOn: daysAgo(-7).toISOString().slice(0, 10) })]);
            }
            if (steps2.includes("bgc")) {
              await c.query(`SELECT authz.update_bgc($1, $2::jsonb, NULL)`, [placementId,
                JSON.stringify({ status: "initiated", bgcCompany: "Fictional Checks LLC", employmentYears: 7, addressYears: 7 })]);
            }
            if (steps2.includes("joined")) {
              await c.query(`SELECT authz.update_bgc($1, '{"status":"cleared"}', NULL)`, [placementId]);
            }
          });
        }
      }
    }
  }

  // Seed-only backfill: spread dates over the past weeks (the app sets these to now()).
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    for (const [table, id, col, value] of backfill) {
      await c.query(`UPDATE eureka.${table} SET ${col} = $2 WHERE id = $1`, [id, value]);
    }
    await c.query(`UPDATE eureka.placement p SET created_at = s.status_changed_at + interval '1 hour'
                     FROM eureka.submission s WHERE s.id = p.submission_id`);
    // Joined placements opened their assignment (and the employee record, migration 0045) today:
    // start them a week after the placement was created, so the Employees screen shows real dates.
    await c.query(`UPDATE eureka.assignment a SET start_date = least(current_date - 1, (p.created_at + interval '7 days')::date)
                     FROM eureka.placement p WHERE p.id = a.placement_id`);
    await c.query(`UPDATE eureka.employee e SET employee_since = a.start_date, status_since = a.start_date
                     FROM eureka.assignment a WHERE a.person_id = e.person_id`);
    await c.query(`UPDATE eureka.employment_event ev SET effective_on = a.start_date
                     FROM eureka.assignment a WHERE a.id = ev.assignment_id AND ev.kind = 'started'`);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }

  // Employees (dev only): HR plans the end of the first joined assignment (ending soon) and records a
  // project exit on the second (the employee and candidate move to the bench), through the definer functions.
  const joined = (await admin.query<{ id: string }>(
    `SELECT a.id FROM eureka.assignment a ORDER BY a.start_date, a.id`)).rows;
  if (joined[0]) {
    await asUser(admin, U.hr, (c2) => c2.query("SELECT * FROM authz.set_assignment_end_date($1, current_date + 20)", [joined[0]!.id]));
  }
  if (joined[1]) {
    await asUser(admin, U.hr, (c2) => c2.query("SELECT * FROM authz.end_assignment($1, current_date - 1, 'completed')", [joined[1]!.id]));
  }
  return out;
}
