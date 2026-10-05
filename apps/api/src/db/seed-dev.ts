/**
 * Local development seed: applies migrations, then loads the same fictional
 * org and candidates the integration tests use. Refuses to run in production.
 *   MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/eureka pnpm db:seed
 */
import pg from "pg";
import { migrate } from "./migrate.js";
import { seedFixtures } from "../../test/fixtures.js";
import { seedDevPipeline } from "./dev-pipeline.js";
import { seedDevFacilities } from "./dev-facilities.js";
import { seedDevDatahub } from "./dev-datahub.js";
import { seedDevTraining } from "./dev-training.js";
import { seedDevInterviewsSettings } from "./dev-interviews-settings.js";
import { seedDevChat } from "./dev-chat.js";
import { seedDevApplications, seedDevJobs } from "./dev-jobs.js";

if (process.env.NODE_ENV === "production") throw new Error("seed-dev must not run in production");
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");

await migrate(url);
const admin = new pg.Pool({ connectionString: url });
const { rows } = await admin.query("SELECT count(*)::int AS n FROM eureka.app_user");
if (rows[0].n === 0) {
  const candidates = await seedFixtures(admin);
  // Seed-only backfill as superuser; triggers are skipped for this one statement's session.
  const c = await admin.connect();
  await c.query("SET session_replication_role = replica");
  await c.query(`UPDATE eureka.candidate SET marketing_start_date = current_date - (random() * 40)::int,
    priority = (ARRAY['P1','P2','P3'])[1 + floor(random() * 3)::int]`);
  await c.query("RESET session_replication_role");
  c.release();
  console.log(`seeded ${candidates.length} fictional candidates; sign in as e.g. r1a@eureka.example, l1@eureka.example, m1@eureka.example, locD@eureka.example`);
} else {
  console.log("database already has users; skipping fixtures");
}
// Fictional submissions, interviews, feedback and placements (skipped when submissions already exist).
if ((await admin.query("SELECT 1 FROM eureka.app_user WHERE id = '00000000-0000-0000-0000-000000000009'")).rowCount) {
  const p = await seedDevPipeline(admin);
  if (p.submissions) console.log(`seeded pipeline: ${p.submissions} submissions, ${p.interviews} interviews, ${p.feedback} feedback, ${p.placements} placements`);
  // training: fictional courses, one Dallas batch trained by the fixture coach, some progress
  const t = await seedDevTraining(admin);
  if (t.courses) console.log(`seeded training: ${t.courses} courses, ${t.students} students, ${t.completions} completed modules`);
  // Interview details, panels, scorecards, staff profiles (skipped once any panel exists).
  const s = await seedDevInterviewsSettings(admin);
  if (s.panels) console.log(`seeded interview details: ${s.panels} panels, ${s.scorecards} scorecards, ${s.profiles} staff profiles`);
}
// Fictional companies, facilities, utilities and bills (skipped when a company exists).
if ((await admin.query("SELECT 1 FROM eureka.app_user WHERE id = '00000000-0000-0000-0000-000000000014'")).rowCount) {
  const f = await seedDevFacilities(admin);
  if (f.companies) {
    console.log(`seeded facilities: ${f.companies} companies, ${f.facilities} facilities, ${f.utilities} utilities, ${f.bills} bills, ${f.employees} company employees` +
      " (sign in as locD@eureka.example or opsA@eureka.example)");
  }
}
// Fictional DataHub folders (skipped when folders already exist).
if ((await admin.query("SELECT 1 FROM eureka.app_user WHERE id = '00000000-0000-0000-0000-000000000016'")).rowCount) {
  const n = await seedDevDatahub(admin);
  if (n) console.log(`seeded DataHub: ${n} folders`);
}
// Fictional chats between the dev users (skipped when a conversation exists).
if ((await admin.query("SELECT 1 FROM eureka.app_user WHERE id = '00000000-0000-0000-0000-000000000009'")).rowCount) {
  const chat = await seedDevChat(admin);
  if (chat.conversations) console.log(`seeded chat: ${chat.conversations} conversations, ${chat.messages} messages`);
}
// jobs-portal: fictional jobs (client requirements and internal openings on the careers portal).
if ((await admin.query("SELECT 1 FROM eureka.app_user WHERE id = '00000000-0000-0000-0000-000000000016'")).rowCount) {
  const j = await seedDevJobs(admin);
  if (j.jobs) console.log(`seeded ${j.jobs} jobs, ${await seedDevApplications(admin, j.ids)} applications`);
}
// Development step-up ("Confirm it's you" without Google) needs this database switch as well as
// AUTH_MODE=dev in the API (migration 0043); no migration sets it, so other environments refuse it.
await admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on')
  ON CONFLICT (key) DO UPDATE SET value = 'on'`);
if (process.env.APP_DB_PASSWORD) {
  await admin.query(`ALTER ROLE eureka_app PASSWORD '${process.env.APP_DB_PASSWORD.replace(/'/g, "''")}'`);
}
if (process.env.WORKER_DB_PASSWORD) {
  await admin.query(`ALTER ROLE eureka_worker PASSWORD '${process.env.WORKER_DB_PASSWORD.replace(/'/g, "''")}'`);
}
await admin.end();
