import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Interviews under concurrent edits (docs/interviews-settings-api.md IS-12, IS-13):
 * optional If-Match on PATCH and clear-and-select (412 when stale), the
 * clear-and-select check serialised with result changes, coach / panel
 * double-booking (409 interviewer_conflict), and no free text in the audit (rule 5).
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U;
const sessions = new Map<string, { cookie: string; csrf: string }>();
async function login(key: Key) {
  const cached = sessions.get(key);
  if (cached) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}
async function call(key: Key, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}

/** A fresh r1a submission (Dallas) at `status`. */
async function submission(status = "interview_requested") {
  const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  return selectedSubmission(db, U.r1a, cand.id, status);
}
async function interview(body: Record<string, unknown>, submissionId?: string) {
  const res = await call("r1a", "POST", "/api/v1/interviews", { submissionId: submissionId ?? await submission(), round: "L1", durationMin: 60, ...body });
  return res;
}
async function created(body: Record<string, unknown>, submissionId?: string): Promise<string> {
  const res = await interview(body, submissionId);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const get = async (id: string) => (await call("r1a", "GET", `/api/v1/interviews/${id}`)).json();
const patch = (id: string, body: unknown, headers: Record<string, string> = {}, key: Key = "r1a") =>
  call(key, "PATCH", `/api/v1/interviews/${id}`, body, headers);

describe("If-Match on interview edits (IS-12)", () => {
  it("returns rowVersion; a matching If-Match succeeds and bumps it; no header behaves as before", async () => {
    const id = await created({ startsAt: "2033-01-10T14:00:00Z" });
    expect((await get(id)).rowVersion).toBe(1);
    const ok = await patch(id, { round: "L2" }, { "if-match": '"1"' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ round: "L2", rowVersion: 2 });
    const noHeader = await patch(id, { inviteReceived: true });
    expect(noHeader.statusCode).toBe(200);
    expect(noHeader.json().rowVersion).toBe(3);
  });

  it("a stale If-Match is 412 and changes nothing", async () => {
    const id = await created({ startsAt: "2033-01-11T14:00:00Z" });
    expect((await patch(id, { round: "L2" })).statusCode).toBe(200);
    const stale = await patch(id, { round: "Stale edit", panelIds: [U.r1b] }, { "if-match": "1" });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().detail).toBe("stale");
    const now = await get(id);
    expect(now).toMatchObject({ round: "L2", rowVersion: 2, panel: [] });
  });

  it("a malformed If-Match is 412 and changes nothing; `*` skips the check", async () => {
    const id = await created({ startsAt: "2033-01-12T14:00:00Z" });
    for (const tag of ["abc", '"x1"', "-1"]) {
      const bad = await patch(id, { round: "Bad tag" }, { "if-match": tag });
      expect([bad.statusCode, bad.json().detail]).toEqual([412, "stale"]);
    }
    expect((await get(id)).rowVersion).toBe(1);
    expect((await patch(id, { round: "Any" }, { "if-match": "*" })).statusCode).toBe(200);
  });

  it("the stale check follows the permission checks (404 / 403 / 422 first)", async () => {
    const id = await created({ startsAt: "2033-01-12T14:00:00Z" });
    expect([403, 404]).toContain((await patch(id, { round: "x" }, { "if-match": "9" }, "r2a")).statusCode);
    const field = await patch(id, { cleared: true }, { "if-match": "9" });
    expect(field.statusCode).toBe(422);
  });

  it("a panel-only change bumps the version (the guard owns it; clients cannot set it)", async () => {
    const id = await created({ startsAt: "2033-01-13T14:00:00Z" });
    const res = await patch(id, { panelIds: [U.r1b] }, { "if-match": "1" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().rowVersion).toBe(2);
    expect((await patch(id, { rowVersion: 1 } as never)).statusCode).toBe(422);
    const raw = await db.admin.query(`SELECT row_version FROM eureka.interview WHERE id = $1`, [id]);
    expect(raw.rows).toEqual([{ row_version: 2 }]);
  });

  it("clear-and-select takes an optional If-Match too", async () => {
    const id = await created({ startsAt: "2033-01-14T14:00:00Z" });
    expect((await patch(id, { inviteReceived: true })).statusCode).toBe(200);
    const stale = await call("r1a", "POST", `/api/v1/interviews/${id}/clear-and-select`, undefined, { "if-match": "1" });
    expect(stale.statusCode).toBe(412);
    expect((await get(id)).result).toBe("pending");
    const ok = await call("r1a", "POST", `/api/v1/interviews/${id}/clear-and-select`, undefined, { "if-match": "2" });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ result: "cleared", rowVersion: 3 });
  });
});

describe("clear-and-select vs a concurrent rejection (E-04)", () => {
  /** Waiters on advisory locks right now. */
  const waiting = async () => Number((await db.admin.query(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n);
  const until = async (n: number) => {
    for (let i = 0; i < 200 && (await waiting()) < n; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await waiting()).toBe(n);
  };

  it("a sibling round rejected while the clear waits is seen: 422 round_rejected", async () => {
    const sub = await submission("interview_scheduled");
    const first = await created({ startsAt: "2033-02-01T14:00:00Z" }, sub);
    const second = await created({ startsAt: "2033-02-02T14:00:00Z", round: "L2" }, sub);
    const holder = await db.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('interview_result:' || $1::text, 0))`, [sub]);
      const reject = patch(first, { result: "rejected" });
      await until(1);
      const clear = call("r1a", "POST", `/api/v1/interviews/${second}/clear-and-select`);
      await until(2);
      await holder.query("COMMIT");
      expect((await reject).statusCode).toBe(200);
      const cleared = await clear;
      expect(cleared.statusCode).toBe(422);
      expect(cleared.json().detail).toBe("round_rejected");
    } finally {
      holder.release();
    }
    const row = await db.admin.query(`SELECT status FROM eureka.submission WHERE id = $1`, [sub]);
    expect(row.rows[0].status).toBe("interview_scheduled");
  });
});

describe("coach and panel double-booking (IS-13)", () => {
  it("refuses a coach booked into an overlapping live interview; adjacent slots are fine", async () => {
    await created({ startsAt: "2033-03-01T14:00:00Z", coachId: U.coach });
    const clash = await interview({ startsAt: "2033-03-01T14:30:00Z", coachId: U.coach });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().detail).toBe("interviewer_conflict");
    expect(clash.json().detail).not.toMatch(/[0-9a-f]{8}-/); // never names the other interview
    await created({ startsAt: "2033-03-01T15:00:00Z", coachId: U.coach });
    // Nothing of the refused create remains.
    const n = await db.admin.query(`SELECT count(*)::int AS n FROM eureka.interview WHERE coach_id = $1 AND starts_at = '2033-03-01T14:30:00Z'`, [U.coach]);
    expect(n.rows[0].n).toBe(0);
  });

  it("counts panel members both ways (coach elsewhere, panelist elsewhere)", async () => {
    await created({ startsAt: "2033-03-02T14:00:00Z", panelIds: [U.r1b, U.coach], leadId: U.r1b });
    const asCoach = await interview({ startsAt: "2033-03-02T14:15:00Z", coachId: U.coach });
    expect(asCoach.statusCode).toBe(409);
    const asPanel = await interview({ startsAt: "2033-03-02T14:15:00Z", panelIds: [U.r1b] });
    expect(asPanel.statusCode).toBe(409);
    const other = await interview({ startsAt: "2033-03-02T14:15:00Z", panelIds: [U.l1] });
    expect(other.statusCode, other.body).toBe(201);
  });

  it("checks PATCH moves, coach changes and added panel members; cancelled interviews book nobody", async () => {
    const a = await created({ startsAt: "2033-03-03T14:00:00Z", coachId: U.coach });
    const b = await created({ startsAt: "2033-03-03T16:00:00Z", panelIds: [U.coach] });
    const move = await patch(b, { startsAt: "2033-03-03T14:30:00Z", durationMin: 60 });
    expect(move.statusCode).toBe(409);
    expect((await get(b)).startsAt).toBe("2033-03-03T16:00:00.000Z");
    const c = await created({ startsAt: "2033-03-03T14:30:00Z" });
    expect((await patch(c, { coachId: U.coach })).statusCode).toBe(409);
    expect((await patch(c, { panelIds: [U.coach] })).statusCode).toBe(409);
    expect((await patch(a, { callStatus: "cancelled" })).statusCode).toBe(200);
    expect((await patch(c, { coachId: U.coach })).statusCode).toBe(200);
    // Bringing the cancelled one back books its coach again.
    const revive = await patch(a, { callStatus: "scheduled" });
    expect(revive.statusCode).toBe(409);
  });

  it("an existing overlap (from before the check) does not block unrelated edits", async () => {
    const a = await created({ startsAt: "2033-03-04T14:00:00Z", coachId: U.coach });
    const b = await created({ startsAt: "2033-03-04T16:00:00Z" });
    // Legacy data: the coach is put on an overlapping slot directly.
    await db.admin.query(`ALTER TABLE eureka.interview DISABLE TRIGGER USER`);
    try {
      await db.admin.query(`UPDATE eureka.interview SET coach_id = $2, starts_at = '2033-03-04T14:30:00Z', ends_at = '2033-03-04T15:30:00Z' WHERE id = $1`, [b, U.coach]);
    } finally {
      await db.admin.query(`ALTER TABLE eureka.interview ENABLE TRIGGER USER`);
    }
    expect((await patch(b, { round: "L2", inviteReceived: true })).statusCode).toBe(200);
    expect((await patch(a, { panelIds: [U.r1b] })).statusCode).toBe(200);
  });

  it("only a writer of the interview may run the check", async () => {
    const id = await created({ startsAt: "2033-03-05T14:00:00Z" });
    const { rows } = await db.admin.query(`SELECT has_function_privilege('eureka_worker', 'authz.assert_interview_staff_free(uuid, uuid[])', 'EXECUTE') AS w,
      has_function_privilege('eureka_app', 'authz.assert_interview_staff_free(uuid, uuid[])', 'EXECUTE') AS a`);
    expect(rows[0]).toEqual({ w: false, a: true });
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE eureka_app");
      await c.query(`SELECT set_config('eureka.user_id', $1, true)`, [U.r2a]);
      await expect(c.query(`SELECT authz.assert_interview_staff_free($1, ARRAY[$2]::uuid[])`, [id, U.coach])).rejects.toThrow(/not_permitted/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

describe("interview audit holds no free text (E-08, rule 5)", () => {
  it("round and system name are audited as set / changed / cleared", async () => {
    const id = await created({ startsAt: "2033-04-01T14:00:00Z", round: "Fictional Person Round" });
    expect((await patch(id, { round: "Another Fictional Name" })).statusCode).toBe(200);
    expect((await patch(id, { systemName: "Fictional desk 7", consentCaptured: true }, {}, "locD")).statusCode).toBe(200);
    expect((await patch(id, { systemName: null }, {}, "locD")).statusCode).toBe(200);
    const { rows } = await db.admin.query<{ action: string; changes: Record<string, unknown> }>(
      `SELECT action, changes FROM eureka.audit_event WHERE entity_id = $1 ORDER BY seq`, [id]);
    expect(rows.map((r) => [r.action, r.changes.round, r.changes.systemName])).toEqual([
      ["interview.created", "set", undefined],
      ["interview.updated", "changed", undefined],
      ["interview.updated", undefined, "set"],
      ["interview.updated", undefined, "cleared"],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/Fictional/);
  });
});
