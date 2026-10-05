/**
 * Local development only (jobs-portal): fictional jobs on top of the dev
 * fixtures, written as the acting user through the app role (RLS, guards and
 * policies apply): client requirements by Lead l1 and Manager m1, internal
 * openings by HR, some of them published to the careers portal. Idempotent:
 * does nothing when jobs already exist.
 */
import type pg from "pg";

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const U = { m1: uid(4), l1: uid(6), l2: uid(7), hr: uid(16) };
const NORTHWIND = uid(601);

const p = (text: string) => ({ type: "p", runs: [{ text }] });
const ul = (...items: string[]) => ({ type: "ul", items: items.map((text) => [{ text }]) });
const doc = (...blocks: unknown[]) => JSON.stringify({ blocks });

export async function asAppUser<T>(admin: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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

interface SeedJob {
  by: string; kind: "client_requirement" | "internal_opening"; title: string; category: string; level: string;
  type: string; mode: string; status: string; location: string; skills: string[]; published?: boolean; manager?: string;
  company?: string; pay?: [number, string, string]; summary: string; bullets: string[];
}

const JOBS: SeedJob[] = [
  { by: U.l1, kind: "client_requirement", title: "Senior Java Developer", category: "engineering", level: "senior", type: "contract",
    mode: "hybrid", status: "open", location: "Dallas, TX", skills: ["Java", "Spring Boot", "Kafka"], manager: U.l1, pay: [68, "hourly", "USD"],
    summary: "Build payment services for a fictional bank client.", bullets: ["7+ years of Java", "Spring Boot microservices", "Kafka or similar"] },
  { by: U.m1, kind: "client_requirement", title: "Full Stack Developer", category: "engineering", level: "mid", type: "contract",
    mode: "remote", status: "open", location: "Remote (US)", skills: ["Java", "React"], manager: U.l2,
    summary: "Customer portal features end to end.", bullets: ["Java and React", "REST APIs"] },
  { by: U.hr, kind: "internal_opening", title: "HR Generalist", category: "hr", level: "mid", type: "full_time", mode: "on_site",
    status: "open", location: "Dallas, TX", skills: ["Onboarding", "HRIS"], published: true, manager: U.hr, company: "Eureka Info Tech", pay: [58000, "yearly", "USD"],
    summary: "Support hiring, onboarding and employee records for our consultants.", bullets: ["3+ years in HR", "US payroll basics"] },
  { by: U.hr, kind: "internal_opening", title: "Sales Development Representative", category: "sales", level: "entry", type: "full_time",
    mode: "on_site", status: "open", location: "Austin, TX", skills: ["CRM", "Cold calling"], published: true, manager: U.m1, company: "Endeavour Technology",
    summary: "Qualify inbound leads and book meetings for the sales team.", bullets: ["Clear communicator", "Comfortable with targets"] },
  { by: U.hr, kind: "internal_opening", title: "Customer Support Specialist", category: "customer_support", level: "junior", type: "part_time",
    mode: "remote", status: "open", location: "Remote", skills: ["Email support"], published: true, company: "Eureka Info Tech",
    summary: "Answer consultant questions by email and chat, document issues.", bullets: ["Patient and precise", "Good written English"] },
  { by: U.hr, kind: "internal_opening", title: "Payroll Analyst", category: "finance", level: "mid", type: "full_time", mode: "hybrid",
    status: "draft", location: "Dallas, TX", skills: ["Payroll"], summary: "Run payroll for W2 consultants.", bullets: ["Payroll experience"] },
];

export async function seedDevJobs(admin: pg.Pool): Promise<{ jobs: number; ids: Record<string, string> }> {
  const ids: Record<string, string> = {};
  if ((await admin.query("SELECT 1 FROM eureka.job LIMIT 1")).rowCount) return { jobs: 0, ids };
  // Companies come from dev-facilities.ts (seed-dev.ts runs it first); without them the openings stay unattached.
  const companies = new Map((await admin.query<{ id: string; name: string }>(
    `SELECT id, name FROM eureka.company WHERE name = ANY($1::text[])`, [["Eureka Info Tech", "Endeavour Technology"]])).rows.map((r) => [r.name, r.id]));
  for (const j of JOBS) {
    ids[j.title] = await asAppUser(admin, j.by, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO eureka.job (kind, title, category, experience_level, employment_type, work_mode, status, location, skills,
         client_id, hiring_manager_id, published_to_portal, pay_amount, pay_frequency, pay_currency, deadline, work_hours,
         description, requirements, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, CURRENT_DATE + 60, 40, $16::jsonb, $17::jsonb, $18) RETURNING id`,
      [j.kind, j.title, j.category, j.level, j.type, j.mode, j.status, j.location, j.skills,
        j.kind === "client_requirement" ? NORTHWIND : null, j.manager ?? null, j.published ?? false,
        j.pay?.[0] ?? null, j.pay?.[1] ?? null, j.pay?.[2] ?? null, doc(p(j.summary)), doc(ul(...j.bullets)),
        j.company ? companies.get(j.company) ?? null : null])).rows[0]!.id);
  }
  // Seed-only backfill: spread the posting dates over the last days ("posted 4 days ago").
  const c = await admin.connect();
  try {
    await c.query("SET session_replication_role = replica");
    await c.query(`UPDATE eureka.job j SET created_at = j.created_at - x.d, updated_at = j.updated_at - x.d, posted_at = j.posted_at - x.d
      FROM (SELECT id, random() * interval '9 days' AS d FROM eureka.job) x WHERE x.id = j.id`);
    await c.query("RESET session_replication_role");
  } finally {
    c.release();
  }
  return { jobs: JOBS.length, ids };
}

/**
 * Fictional applicants and applications on the seeded portal jobs (dev only):
 * rows are written as superuser with triggers off, since applicants normally
 * sign up by email link. Applicants cannot sign in without a mailbox here;
 * use the portal sign-up page and the dev mailbox (GET /api/portal/dev/mailbox).
 */
export async function seedDevApplications(admin: pg.Pool, ids: Record<string, string>): Promise<number> {
  if (!ids["HR Generalist"] || (await admin.query("SELECT 1 FROM eureka.applicant LIMIT 1")).rowCount) return 0;
  const c = await admin.connect();
  try {
    await c.query("SET session_replication_role = replica");
    const people = [["Emily", "Student", "emily.student@applicants.invalid", "+12125550111", "hired", "Sales Development Representative"],
      ["Venkat", "Rao", "venkat.rao@applicants.invalid", "+12125550112", "interview_scheduled", "HR Generalist"],
      ["Mina", "Park", "mina.park@applicants.invalid", "+12125550113", "applied", "HR Generalist"]] as const;
    for (const [f, l, email, phone, status, title] of people) {
      const a = (await c.query<{ id: string }>(
        `INSERT INTO eureka.applicant (first_name, last_name, email, phone_e164, email_verified_at) VALUES ($1,$2,$3,$4, now()) RETURNING id`, [f, l, email, phone])).rows[0]!.id;
      const app = (await c.query<{ id: string }>(
        `INSERT INTO eureka.job_application (job_id, applicant_id, status, applied_at) VALUES ($1,$2,$3, now() - interval '3 days') RETURNING id`, [ids[title], a, status])).rows[0]!.id;
      await c.query(`INSERT INTO eureka.application_event (application_id, kind, to_status) VALUES ($1, 'applied', 'applied')`, [app]);
      if (status === "interview_scheduled") {
        await c.query(`INSERT INTO eureka.application_interview (application_id, interview_type, round, lead_user_id, starts_at, duration_minutes, meeting_link, created_by)
          VALUES ($1, 'video', 'technical', $2, now() + interval '3 days', 30, 'https://meet.example.com/demo', $2)`, [app, "00000000-0000-0000-0000-000000000016"]);
      }
    }
    await c.query("RESET session_replication_role");
  } finally { c.release(); }
  return 3;
}
