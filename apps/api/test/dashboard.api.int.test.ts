import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, ownsCandidate, resolveScope, type Role } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { DASHBOARD_REQUESTS_PER_MINUTE, DASHBOARD_THRESHOLDS, NEEDS_ATTENTION_LIMIT } from "../src/modules/dashboard/dashboard.config.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { createPlacement, extraUser, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Dashboards (docs/dashboards-api.md). A small, hand-built data set with
 * hand-calculated totals per role scope, a differential check against the
 * list endpoints for every fixture user, an RLS-only check, and the
 * "needs attention" lists.
 */
let db: TestDb;
let app: NestFastifyApplication;
let bu: { id: string };
const SECRET = "test-secret-test-secret-test-secret-123";

const P_FROM = "2030-03-01T00:00:00.000Z";
const P_TO = "2030-03-08T00:00:00.000Z";
const PERIOD = `from=${encodeURIComponent(P_FROM)}&to=${encodeURIComponent(P_TO)}`;
/** An instant inside the period: day 1..7 of March 2030, hour 0..23. */
const inP = (day: number, hour: number) => `2030-03-0${day}T${String(hour).padStart(2, "0")}:00:00Z`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Superuser write with triggers off (test setup only). */
async function force(sql: string, params: unknown[]) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

async function submit(actor: string, candidateId: string, submittedAt: string): Promise<string> {
  const id = await asUser(db.app, actor, async (c) => (await c.query<{ id: string }>(
    `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'Java Developer',$2) RETURNING id`,
    [candidateId, CLIENT_ID])).rows[0]!.id, true);
  await force(`UPDATE eureka.submission SET submitted_at = $2 WHERE id = $1`, [id, submittedAt]);
  return id;
}

let slot = 0;
/** An interview through the app role (snapshots from the submission), then moved to the given times and state. */
async function interview(actor: string, submissionId: string, startsAt: string, endsAt: string,
  state: { callStatus?: string; clearedAt?: string } = {}): Promise<string> {
  const placeholder = new Date(Date.parse("2035-01-01T00:00:00Z") + slot++ * 2 * HOUR);
  const id = await asUser(db.app, actor, async (c) => (await c.query<{ id: string }>(
    `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1,'L1',$2,$3) RETURNING id`,
    [submissionId, placeholder.toISOString(), new Date(placeholder.getTime() + HOUR).toISOString()])).rows[0]!.id, true);
  await force(`UPDATE eureka.interview SET starts_at = $2, ends_at = $3, call_status = $4, cleared = $5, cleared_at = $6 WHERE id = $1`,
    [id, startsAt, endsAt, state.callStatus ?? "scheduled", state.clearedAt !== undefined, state.clearedAt ?? null]);
  return id;
}

async function placement(actor: string, cand: Parameters<typeof newCandidate>[1],
  state: { createdAt: string; status?: string; joinedAt?: string; tentativeStart?: string }): Promise<string> {
  const c = await newCandidate(db, cand);
  await force(`UPDATE eureka.candidate SET created_at = '2020-01-01' WHERE id = $1`, [c.id]);
  const sub = await selectedSubmission(db, actor, c.id);
  await force(`UPDATE eureka.submission SET submitted_at = '2030-01-01' WHERE id = $1`, [sub]);
  const { id } = await createPlacement(db, actor, sub, { start: "2031-01-05" });
  await force(`UPDATE eureka.placement SET created_at = $2, status = $3, joined_at = $4, tentative_start = $5 WHERE id = $1`,
    [id, state.createdAt, state.status ?? "confirmed", state.joinedAt ?? null, state.tentativeStart ?? "2031-01-05"]);
  return id;
}

const joinedInP: string[] = [];
const candidatesInP: string[] = [];
const attention = { stale: "", feedback: [] as string[], placements: [] as string[] };

/**
 * Period data set (actor; actor team; candidate owner team/recruiter/location):
 *   C1 t1/r1a/dallas  C2 t1/r1b/austin  C3 t1/-/dallas  C4 t2/r2a/austin
 *   C5 t3/r3a/dallas (all teams)  C6 t3/r3a/austin. C1, C3, C4, C5, C6 are added in the period.
 * Submissions in the period: SA1, SA2 r1a→C1; SB r1b→C2; SC l1→C3; SD r2a→C4; SE r2a→C5; SF r3a→C6.
 *   Outside: SA0 r1a→C1 (before), SF2 r3a→C6 (after).
 * Interviews: I1 on SA1 (cleared), I2 on SA2 (cancelled), I3 on SB, I4 on SD (cleared), I5 on SE,
 *   I6 on SF (held before the period, cleared in it).
 * Placements: PA r1a, cand t1/r1a/dallas (created + joined in P); PB r2a, cand t3/r3a/austin (created);
 *   PC r3a, cand t3/r3a/dallas (created before, joined in P); PD l1, cand t1/-/austin (created).
 */
async function seedPeriod() {
  const cand = async (teamId: string, recruiterId: string | null, locationId: string, addedInP: boolean, visibility: "team" | "all_teams" = "team") => {
    const c = await newCandidate(db, { teamId, recruiterId, locationId, visibility });
    await force(`UPDATE eureka.candidate SET created_at = $2 WHERE id = $1`, [c.id, addedInP ? inP(2, 9) : "2020-01-01"]);
    if (addedInP) candidatesInP.push(c.id);
    return c.id;
  };
  const C1 = await cand(T.t1, U.r1a, LOC.dallas, true);
  const C2 = await cand(T.t1, U.r1b, LOC.austin, false);
  const C3 = await cand(T.t1, null, LOC.dallas, true);
  const C4 = await cand(T.t2, U.r2a, LOC.austin, true);
  const C5 = await cand(T.t3, U.r3a, LOC.dallas, true, "all_teams");
  const C6 = await cand(T.t3, U.r3a, LOC.austin, true);

  const SA1 = await submit(U.r1a, C1, inP(1, 10));
  const SA2 = await submit(U.r1a, C1, inP(2, 10));
  await submit(U.r1a, C1, "2030-02-20T10:00:00Z");
  const SB = await submit(U.r1b, C2, inP(3, 10));
  await submit(U.l1, C3, inP(4, 10));
  const SD = await submit(U.r2a, C4, inP(5, 10));
  const SE = await submit(U.r2a, C5, inP(6, 10));
  const SF = await submit(U.r3a, C6, inP(7, 23));
  await submit(U.r3a, C6, "2030-03-10T10:00:00Z");

  await interview(U.r1a, SA1, inP(2, 14), inP(2, 15), { callStatus: "completed", clearedAt: inP(3, 9) });
  await interview(U.r1a, SA2, inP(3, 14), inP(3, 15), { callStatus: "cancelled" });
  await interview(U.r1b, SB, inP(4, 14), inP(4, 15));
  await interview(U.r2a, SD, inP(5, 14), inP(5, 15), { callStatus: "completed", clearedAt: inP(6, 9) });
  await interview(U.r2a, SE, inP(6, 14), inP(6, 15));
  await interview(U.r3a, SF, "2030-02-25T14:00:00Z", "2030-02-25T15:00:00Z", { callStatus: "completed", clearedAt: inP(1, 9) });

  joinedInP.push(await placement(U.r1a, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas },
    { createdAt: inP(1, 12), status: "joined", joinedAt: inP(5, 9) }));
  await placement(U.r2a, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin, visibility: "all_teams" }, { createdAt: inP(2, 12) });
  joinedInP.push(await placement(U.r3a, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas },
    { createdAt: "2030-02-01T12:00:00Z", status: "joined", joinedAt: inP(4, 9) }));
  await placement(U.l1, { teamId: T.t1, recruiterId: null, locationId: LOC.austin }, { createdAt: inP(3, 12) });
}

/** "Needs attention" rows, relative to now, all for r1a's candidates in Dallas (team t1). */
async function seedAttention() {
  const mk = async () => {
    const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    await force(`UPDATE eureka.candidate SET created_at = '2020-01-01' WHERE id = $1`, [c.id]);
    return c.id;
  };
  const N1 = await mk();
  attention.stale = await submit(U.r1a, N1, ago(10 * DAY));
  const fresh = await submit(U.r1a, N1, ago(2 * DAY));
  const closed = await submit(U.r1a, N1, ago(20 * DAY));
  await force(`UPDATE eureka.submission SET status = 'withdrawn', status_changed_at = $2 WHERE id = $1`, [closed, ago(20 * DAY)]);

  const end = (msAgo: number) => [ago(msAgo + HOUR), ago(msAgo)] as const;
  const F1 = await interview(U.r1a, fresh, ...end(3 * DAY), { callStatus: "completed" }); // no feedback: flagged
  const F2 = await interview(U.r1a, fresh, ...end(4 * DAY), { callStatus: "completed" }); // client feedback: fine
  await db.admin.query(`INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating) VALUES ($1,$2,'client',4)`, [F2, U.r1a]);
  await interview(U.r1a, fresh, ...end(2 * HOUR)); // inside the grace period
  await interview(U.r1a, fresh, ...end(5 * DAY), { callStatus: "cancelled" }); // did not happen
  await interview(U.r1a, fresh, ...end(40 * DAY)); // beyond the lookback
  const F6 = await interview(U.r1a, fresh, ...end(6 * DAY)); // only the candidate's own feedback: flagged
  await db.admin.query(`INSERT INTO eureka.interview_feedback (interview_id, kind, rating) VALUES ($1,'candidate',5)`, [F6]);
  attention.feedback = [F6, F1];

  const own = { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas };
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  const Q1 = await placement(U.r1a, own, { createdAt: ago(10 * DAY) }); // no progress
  const Q2 = await placement(U.r1a, own, { createdAt: ago(1 * DAY), tentativeStart: yesterday }); // start date passed
  await placement(U.r1a, own, { createdAt: ago(1 * DAY) }); // on track
  await placement(U.r1a, own, { createdAt: ago(30 * DAY), status: "joined", joinedAt: ago(20 * DAY) }); // done
  attention.placements = [Q1, Q2];
}

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await force(`UPDATE eureka.candidate SET created_at = '2020-01-01'`, []);
  await seedPeriod();
  await seedAttention();
  bu = await extraUser(db, "bu", "bu_head");
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U | "bu";
const sessions = new Map<string, string>();
async function get(key: Key, url: string) {
  let cookie = sessions.get(key);
  if (!cookie) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    expect(res.statusCode).toBe(204);
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    sessions.set(key, cookie);
  }
  return app.inject({ method: "GET", url, headers: { cookie } });
}

interface Dashboard {
  period: { from: string; to: string };
  groupBy: string;
  metrics: string[];
  totals: Record<string, number>;
  groups: { id: string | null; name: string | null; counts: Record<string, number> }[];
  needsAttention: {
    thresholds: Record<string, number>;
    sections: { kind: string; total: number; items: { id: string; ageDays: number; status: string; detail: Record<string, string | null>; candidate: { name: string | null } }[] }[];
  };
}
async function dashboard(key: Key, query = PERIOD): Promise<Dashboard> {
  const res = await get(key, `/api/v1/dashboard?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Dashboard;
}

const all = (s: number, is: number, ic: number, pc: number, pj: number, ca: number) => ({
  submissions: s, interviewsScheduled: is, interviewsCleared: ic, placementsCreated: pc, placementsJoined: pj, candidatesAdded: ca,
});

/** Hand-calculated from the data set above (see seedPeriod). */
const EXPECTED: Record<string, { groupBy: string; totals: Record<string, number> }> = {
  r1a: { groupBy: "recruiter", totals: all(2, 1, 1, 1, 1, 1) }, // own only: candidates the recruiter owns, not the team's
  r1b: { groupBy: "recruiter", totals: all(1, 1, 0, 0, 0, 0) },
  r2a: { groupBy: "recruiter", totals: all(2, 2, 1, 1, 0, 1) },
  r3a: { groupBy: "recruiter", totals: all(2, 1, 1, 1, 1, 2) }, // sees r2a's work on their candidates
  l1: { groupBy: "recruiter", totals: all(4, 2, 1, 2, 1, 2) },
  l2: { groupBy: "recruiter", totals: all(2, 2, 1, 1, 0, 1) },
  l3: { groupBy: "recruiter", totals: all(2, 1, 1, 1, 1, 2) },
  m1: { groupBy: "team", totals: all(6, 4, 2, 3, 1, 3) },
  m2: { groupBy: "team", totals: all(2, 1, 1, 1, 1, 2) },
  ad: { groupBy: "team", totals: all(7, 4, 3, 3, 2, 5) },
  om: { groupBy: "location", totals: all(7, 4, 3, 3, 2, 5) },
  ceo: { groupBy: "location", totals: all(7, 4, 3, 3, 2, 5) },
  locD: { groupBy: "location", totals: all(4, 2, 1, 1, 2, 3) },
  locA: { groupBy: "location", totals: all(3, 2, 2, 2, 0, 2) },
  // No submission or interview access: those metrics are absent, not zero.
  hr: { groupBy: "location", totals: { placementsCreated: 3, placementsJoined: 2, candidatesAdded: 5 } },
  acct: { groupBy: "location", totals: { placementsCreated: 3, placementsJoined: 2, candidatesAdded: 5 } },
  bu: { groupBy: "location", totals: { placementsCreated: 3, placementsJoined: 2 } },
};

describe("dashboard totals per role scope (hand-calculated)", () => {
  it.each(Object.keys(EXPECTED))("%s", async (key) => {
    const d = await dashboard(key as Key);
    expect(d.totals).toEqual(EXPECTED[key]!.totals);
    expect(d.metrics).toEqual(Object.keys(EXPECTED[key]!.totals));
    expect(d.groupBy).toBe(EXPECTED[key]!.groupBy);
    expect(d.period).toEqual({ from: P_FROM, to: P_TO });
    // Groups add up to the totals.
    for (const m of d.metrics) expect(d.groups.reduce((n, g) => n + (g.counts[m] ?? 0), 0), m).toBe(d.totals[m]);
  });

  it("a manager's dashboard is grouped by their teams", async () => {
    const d = await dashboard("m1");
    expect(d.groups).toEqual([
      { id: T.t2, name: "Team Anjali", counts: all(2, 2, 1, 1, 0, 1) },
      { id: T.t1, name: "Team Rohit", counts: all(4, 2, 1, 2, 1, 2) },
    ]);
  });

  it("a lead's dashboard is grouped by recruiter, unassigned candidates last", async () => {
    const d = await dashboard("l1");
    expect(d.groups).toEqual([
      { id: U.l1, name: "l1", counts: all(1, 0, 0, 1, 0, 0) },
      { id: U.r1a, name: "r1a", counts: all(2, 1, 1, 1, 1, 1) },
      { id: U.r1b, name: "r1b", counts: all(1, 1, 0, 0, 0, 0) },
      { id: null, name: null, counts: all(0, 0, 0, 0, 0, 1) },
    ]);
  });

  it("a location admin sees only their location and can regroup by team", async () => {
    expect((await dashboard("locD")).groups).toEqual([{ id: LOC.dallas, name: "Dallas", counts: all(4, 2, 1, 1, 2, 3) }]);
    const byTeam = await dashboard("locD", `${PERIOD}&groupBy=team`);
    expect(byTeam.groupBy).toBe("team");
    expect(byTeam.groups.map((g) => [g.name, g.counts.submissions])).toEqual([["Team Anjali", 1], ["Team Rohit", 3], ["Team Vikram", 0]]);
  });

  it("refuses roles without report:read", async () => {
    for (const key of ["coach", "admin", "imm"] as const) {
      expect((await get(key, `/api/v1/dashboard?${PERIOD}`)).statusCode, key).toBe(403);
    }
  });

  it("validates the period and grouping", async () => {
    const bad = [
      `from=${encodeURIComponent(P_TO)}&to=${encodeURIComponent(P_FROM)}`,
      "from=2029-01-01&to=2030-03-01",
      "groupBy=client",
      "teamId=00000000-0000-0000-0000-000000000101",
      "from=yesterday",
    ];
    for (const q of bad) expect((await get("m1", `/api/v1/dashboard?${q}`)).statusCode, q).toBe(422);
  });

  it("defaults to the last 7 days", async () => {
    const d = await dashboard("m1", "");
    expect(Date.parse(d.period.to) - Date.parse(d.period.from)).toBe(7 * DAY);
    expect(Math.abs(Date.parse(d.period.to) - Date.now())).toBeLessThan(60_000);
  });
});

async function listAll(key: Key, path: string): Promise<Record<string, unknown>[] | null> {
  const items: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const res = await get(key, `${path}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (res.statusCode === 403) return null;
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as { items: Record<string, unknown>[]; nextCursor: string | null };
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

const DEAD = new Set(["cancelled", "rescheduled", "no_invite"]);
const inPeriod = (v: unknown) => typeof v === "string" && v >= P_FROM && v < P_TO;

describe("differential: dashboard counts equal what the user can list", () => {
  const keys = [...(Object.keys(U) as Key[]), "bu" as const];

  it.each(keys)("%s", async (key) => {
    const res = await get(key, `/api/v1/dashboard?${PERIOD}`);
    if (res.statusCode === 403) return; // no report:read: covered above
    const d = res.json() as Dashboard;
    const fromLists: Record<string, number> = {};

    const subs = await listAll(key, `/api/v1/submissions?${PERIOD}`);
    if (subs) fromLists.submissions = subs.length;
    const ints = await listAll(key, "/api/v1/interviews");
    if (ints) {
      fromLists.interviewsScheduled = ints.filter((i) => inPeriod(i.startsAt) && !DEAD.has(i.callStatus as string)).length;
      fromLists.interviewsCleared = ints.filter((i) => i.cleared === true && inPeriod(i.clearedAt)).length;
    }
    const created = await listAll(key, `/api/v1/placements?${PERIOD}`);
    const placements = await listAll(key, "/api/v1/placements");
    if (created && placements) {
      fromLists.placementsCreated = created.length;
      fromLists.placementsJoined = placements.filter((p) => joinedInP.includes(p.id as string)).length;
    }
    const cands = await listAll(key, "/api/v1/candidates");
    if (cands) {
      // Narrowed to report:read ownership (a recruiter's own candidates; no Open-to-all-teams rows).
      const access = key === "bu" ? { ...toUserAccess("hr"), userId: bu.id, roles: [{ role: "bu_head" as Role }] } : toUserAccess(key);
      const report = resolveScope(access, "report:read")!;
      fromLists.candidatesAdded = cands.filter((c) => candidatesInP.includes(c.id as string) && ownsCandidate(report, {
        recruiterId: (c.recruiter as { id: string } | null)?.id ?? null, teamId: (c.team as { id: string }).id,
        locationId: (c.location as { id: string }).id, visibility: "team", marketingStatus: "",
      })).length;
    }
    expect(d.totals).toEqual(fromLists);
  });
});

describe("RLS alone yields the same counts (no definer bypass)", () => {
  const sql: Record<string, string> = {
    submissions: `SELECT count(*)::int AS n FROM eureka.submission WHERE submitted_at >= $1 AND submitted_at < $2`,
    interviewsScheduled: `SELECT count(*)::int AS n FROM eureka.interview WHERE starts_at >= $1 AND starts_at < $2
      AND call_status NOT IN ('cancelled','rescheduled','no_invite')`,
    interviewsCleared: `SELECT count(*)::int AS n FROM eureka.interview WHERE cleared AND cleared_at >= $1 AND cleared_at < $2`,
    placementsCreated: `SELECT count(*)::int AS n FROM eureka.placement WHERE created_at >= $1 AND created_at < $2`,
    placementsJoined: `SELECT count(*)::int AS n FROM eureka.placement WHERE joined_at >= $1 AND joined_at < $2`,
  };
  // For these roles report:read covers at least the read scope, so the report narrowing changes nothing.
  it.each(["r1a", "l1", "l3", "m1", "m2", "ad", "ceo", "locD", "locA", "hr"] as const)("%s", async (key) => {
    const d = await dashboard(key);
    for (const m of d.metrics.filter((x) => x in sql)) {
      const n = await asUser(db.app, U[key], async (c) => (await c.query<{ n: number }>(sql[m]!, [P_FROM, P_TO])).rows[0]!.n);
      expect(n, `${key} ${m}`).toBe(d.totals[m]);
    }
  });
});

describe("needs attention", () => {
  const sections = async (key: Key) => Object.fromEntries((await dashboard(key)).needsAttention.sections.map((s) => [s.kind, s]));

  it("lists stale submissions, interviews without staff feedback and stalled placements, oldest first", async () => {
    const s = await sections("r1a");
    expect(Object.keys(s)).toEqual(["submissionStale", "interviewFeedbackMissing", "placementStalled"]);
    expect(s.submissionStale!.total).toBe(1);
    expect(s.submissionStale!.items.map((i) => i.id)).toEqual([attention.stale]);
    expect(s.submissionStale!.items[0]).toMatchObject({ status: "submitted", ageDays: 10, detail: { client: "Northwind Financial", jobTitle: "Java Developer" } });
    expect(s.submissionStale!.items[0]!.candidate.name).toMatch(/^PlCand\d+ Placed$/);
    expect(s.interviewFeedbackMissing!.total).toBe(2);
    expect(s.interviewFeedbackMissing!.items.map((i) => i.id)).toEqual(attention.feedback);
    expect(s.placementStalled!.total).toBe(2);
    expect(s.placementStalled!.items.map((i) => [i.id, i.detail.reason])).toEqual([
      [attention.placements[0], "no_progress"], [attention.placements[1], "start_date_passed"],
    ]);
  });

  it("returns the thresholds in use", async () => {
    expect((await dashboard("m1")).needsAttention.thresholds).toEqual(DASHBOARD_THRESHOLDS);
    expect(NEEDS_ATTENTION_LIMIT).toBeGreaterThan(0);
  });

  it.each([
    ["l1", [1, 2, 2]], ["m1", [1, 2, 2]], ["ceo", [1, 2, 2]], ["locD", [1, 2, 2]],
    ["r1b", [0, 0, 0]], ["m2", [0, 0, 0]], ["locA", [0, 0, 0]],
  ] as const)("%s sees only its scope", async (key, [sub, int, pl]) => {
    const s = await sections(key);
    expect([s.submissionStale!.total, s.interviewFeedbackMissing!.total, s.placementStalled!.total]).toEqual([sub, int, pl]);
    if (sub === 0) expect(s.submissionStale!.items).toEqual([]);
  });

  it("omits lists the role cannot read", async () => {
    for (const key of ["hr", "bu"] as const) {
      const s = await sections(key);
      expect(Object.keys(s), key).toEqual(["placementStalled"]);
      expect(s.placementStalled!.total).toBe(2);
    }
  });

  it("the report permission holders are exactly the roles with a dashboard", () => {
    for (const key of Object.keys(U) as (keyof typeof U)[]) {
      expect(can(toUserAccess(key), "report:read"), key).toBe(key in EXPECTED);
    }
  });
});

describe("expensive-query guards", () => {
  it("maps a statement timeout to 503 with advice to narrow the period", async () => {
    // Hold a lock the count query needs, so the 5 s statement timeout of a non-org caller fires (57014).
    const locker = await db.admin.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE eureka.submission IN ACCESS EXCLUSIVE MODE");
      const res = await get("m2", `/api/v1/dashboard?${PERIOD}`);
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toMatchObject({ status: 503, detail: "The report took too long; narrow the period and try again" });
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    expect((await get("m2", `/api/v1/dashboard?${PERIOD}`)).statusCode).toBe(200);
  }, 30_000);

  it("limits dashboard requests per user", async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= DASHBOARD_REQUESTS_PER_MINUTE; i++) {
      statuses.push((await get("l2", `/api/v1/dashboard?${PERIOD}`)).statusCode);
      if (statuses.at(-1) === 429) break;
    }
    // l2 already used some of its window in earlier tests; every call before the limit succeeded.
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((s) => s === 200)).toBe(true);
    const res = await get("l2", `/api/v1/dashboard?${PERIOD}`);
    expect(res.statusCode).toBe(429);
    expect(res.json().detail).toMatch(/Too many dashboard requests/);
    // Other users are unaffected.
    expect((await get("l3", `/api/v1/dashboard?${PERIOD}`)).statusCode).toBe(200);
  });
});
