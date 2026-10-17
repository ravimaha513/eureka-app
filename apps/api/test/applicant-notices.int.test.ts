import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplicantNoticesService } from "../src/modules/applications/applicant-notices.service.js";
import { loadConfig } from "../src/platform/config.js";
import { DbService } from "../src/platform/db.service.js";
import type { MailPort, OutgoingMail } from "../src/platform/mail.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/** Applicant notice queue (migration 0190): durable, retried with backoff, claimed by one sender at a time. */
let db: TestDb;
let dbs: DbService;
let appId: string;
const EMAIL = "notice-applicant@example.com";

class FlakyMail implements MailPort {
  readonly kind = "dev" as const;
  sent: OutgoingMail[] = [];
  failNext = 0;
  async send(m: OutgoingMail) {
    if (this.failNext > 0) { this.failNext--; throw new Error("provider down"); }
    this.sent.push(m);
  }
}

const asDefiner = async (sql: string, params: unknown[] = []) => {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authz_definer");
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } finally { c.release(); }
};
const queue = (kind = "status", toStatus: string | null = "shortlisted") => asDefiner(
  `INSERT INTO eureka.applicant_notice (application_id, kind, to_status) VALUES ($1, $2, $3) RETURNING id`, [appId, kind, toStatus])
  .then((r) => r.rows[0].id as string);
const notice = (id: string) => db.admin.query(`SELECT status, attempts, next_attempt_at > now() AS leased FROM eureka.applicant_notice WHERE id = $1`, [id])
  .then((r) => r.rows[0]);
const makeDue = (id: string) => asDefiner(`UPDATE eureka.applicant_notice SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const cat = (await db.admin.query(`SELECT (regexp_match(pg_get_constraintdef(oid), '''([a-z_]+)'''))[1] AS v FROM pg_constraint WHERE conname = 'job_category_check'`)).rows[0].v;
  const raw = await db.admin.connect();
  try {
    await raw.query("BEGIN");
    await raw.query("SET LOCAL session_replication_role = replica");
    const job = (await raw.query(`INSERT INTO eureka.job (kind, title, category, experience_level, employment_type, work_mode, owner_id)
      VALUES ('internal_opening', 'Data Analyst', $1, 'mid', 'full_time', 'remote', $2) RETURNING id`, [cat, U.hr])).rows[0].id;
    const ap = (await raw.query(`INSERT INTO eureka.applicant (first_name, last_name, email) VALUES ('Nia', 'Rao', $1) RETURNING id`, [EMAIL])).rows[0].id;
    appId = (await raw.query(`INSERT INTO eureka.job_application (job_id, applicant_id) VALUES ($1, $2) RETURNING id`, [job, ap])).rows[0].id;
    await raw.query("COMMIT");
  } finally { raw.release(); }
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  dbs = new DbService(loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}` }));
});
afterAll(async () => { await dbs?.onModuleDestroy(); await db?.drop(); });

const sender = (mail: MailPort) => new ApplicantNoticesService(dbs, mail, loadConfig({
  NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123", DATABASE_URL: "postgres://x@127.0.0.1:1/z",
}));
const run = async (s: ApplicantNoticesService) => { s.kick(); await s.drain(); };

describe("applicant notices", () => {
  it("the app role cannot read or write the queue except through the functions", async () => {
    await expect(db.app.query(`SELECT * FROM eureka.applicant_notice`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`INSERT INTO eureka.applicant_notice (application_id, kind, to_status) VALUES ($1, 'status', 'hired')`, [appId]))
      .rejects.toThrow(/permission denied/);
    await expect(db.app.query(`SELECT authz.applicant_notice_sent(gen_random_uuid())`)).resolves.toBeDefined();
  });

  it("a failed send stays pending with a backoff lease, then is sent and marked when due again", async () => {
    const mail = new FlakyMail();
    const id = await queue();
    mail.failNext = 1;
    await run(sender(mail));
    expect(mail.sent).toEqual([]);
    expect(await notice(id)).toEqual({ status: "pending", attempts: 1, leased: true });
    await run(sender(mail)); // still leased: not retried yet
    expect(mail.sent).toEqual([]);
    await makeDue(id);
    await run(sender(mail));
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: EMAIL, subject: "Your application for Data Analyst: Shortlisted" });
    expect((await notice(id)).status).toBe("sent");
  });

  it("concurrent claims never return the same notice", async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, () => queue()));
    const claim = () => db.app.query<{ id: string }>(`SELECT id FROM authz.applicant_notice_claim(20)`).then((r) => r.rows.map((x) => x.id));
    const [a, b, c] = await Promise.all([claim(), claim(), claim()]);
    const all = [...a, ...b, ...c];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(ids.sort());
  });

  it("after eight unsuccessful attempts a notice is failed and no longer claimed", async () => {
    const id = await queue();
    const mail = new FlakyMail();
    mail.failNext = 100;
    for (let i = 0; i < 8; i++) { await makeDue(id); await run(sender(mail)); }
    expect(await notice(id)).toMatchObject({ status: "pending", attempts: 8 });
    await makeDue(id);
    await run(sender(mail));
    expect((await notice(id)).status).toBe("failed");
    mail.failNext = 0;
    await makeDue(id);
    await run(sender(mail));
    expect(mail.sent).toEqual([]);
  });
});
