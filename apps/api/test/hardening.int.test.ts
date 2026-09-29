import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";

/** Regression tests for migration 0019 (independent review of 0016 and 0017). */
let db: TestDb;
let candidates: FixtureCandidate[];

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
}, 90_000);

afterAll(async () => {
  await db?.drop();
});

const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.marketingStatus === "active")!;

describe("worker role", () => {
  it("cannot switch to the API role", async () => {
    const c = await db.worker.connect();
    try {
      await expect(c.query("SET ROLE eureka_app")).rejects.toThrow(/permission denied/);
    } finally {
      c.release();
    }
  });
});

describe("audit_event", () => {
  it("the server assigns at and seq; back-dated rows are impossible", async () => {
    await asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.audit_event (seq, at, action, entity_type) VALUES (987654, '2020-01-01', 'forged', 'candidate')`), true);
    const { rows } = await db.admin.query(`SELECT seq, at FROM eureka.audit_event WHERE action = 'forged'`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].seq)).not.toBe(987654);
    expect(Date.now() - new Date(rows[0].at).getTime()).toBeLessThan(60_000);
  });
});

describe("submission insert", () => {
  it.each([
    ["status", `'selected'`, "status"],
    ["rejection reason", `'no'`, "rejection_reason"],
    ["status_changed_by", `'${U.ceo}'`, "status_changed_by"],
    ["status_changed_at", `'2020-01-01'`, "status_changed_at"],
  ])("cannot set %s at insert", async (_n, value, col) => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id, ${col}) VALUES ($1, 'Dev', $2, ${value})`,
      [own().id, CLIENT_ID]))).rejects.toThrow(/server_managed_field/);
  });

  it("a plain submission still inserts", async () => {
    await asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1, 'Dev', $2)`, [own().id, CLIENT_ID]));
  });
});

describe("interview limits", () => {
  let sub: string;
  let iv: string;
  beforeAll(async () => {
    sub = await asUser(db.app, U.r1a, async (c) => {
      const id = (await c.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      await c.query(`INSERT INTO eureka.submission (id, candidate_id, job_title, client_id) VALUES ($1, $2, 'Dev', $3)`,
        [id, own().id, CLIENT_ID]);
      return id;
    }, true);
    iv = await asUser(db.app, U.r1a, async (c) => {
      const id = (await c.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      await c.query(`INSERT INTO eureka.interview (id, submission_id, round, starts_at, ends_at)
        VALUES ($1, $2, 'R1', '2031-03-01T10:00Z', '2031-03-01T11:00Z')`, [id, sub]);
      return id;
    }, true);
  });

  it.each([
    ["longer than 12 hours", "2031-01-01T10:00Z", "2031-01-02T10:00Z", /interview_duration/],
    ["before 2000", "1900-01-01T10:00Z", "1900-01-01T11:00Z", /interview_start_sane/],
  ])("refuses an interview %s", async (_n, s, e, err) => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1, 'R1', $2, $3)`, [sub, s, e])))
      .rejects.toThrow(err);
  });

  it("refuses system_name at insert (location-only field)", async () => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at, system_name)
       VALUES ($1, 'R1', '2031-02-01T10:00Z', '2031-02-01T11:00Z', 'SYS-9')`, [sub])))
      .rejects.toThrow(/server_managed_field/);
  });

  it("refuses non-https or overlong links even with consent", async () => {
    // Triggers off (replica mode) so the table CHECK itself is what refuses the value.
    const c = await db.admin.connect();
    try {
      for (const url of ["javascript:alert(1)", "http://x.example", `https://x.example/${"a".repeat(600)}`]) {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica");
        await expect(c.query(`UPDATE eureka.interview SET consent_captured = true, otter_url = $2 WHERE id = $1`, [iv, url]))
          .rejects.toThrow(/interview_links_https/);
        await c.query("ROLLBACK");
      }
    } finally {
      c.release();
    }
  });
});

describe("activity list performance", () => {
  it("submission and interview read policies resolve candidate ownership once per statement", async () => {
    const { rows } = await db.admin.query<{ polname: string; def: string }>(
      `SELECT polname, pg_get_expr(polqual, polrelid) AS def FROM pg_policy WHERE polname IN ('submission_read', 'interview_read')`);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.def, r.polname).not.toMatch(/candidate_owned\(/);
      expect(r.def, r.polname).toMatch(/owned_candidate_ids/);
    }
  });
});
