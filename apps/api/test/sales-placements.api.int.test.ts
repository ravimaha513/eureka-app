import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, TECH_ID, U, seedFixtures } from "./fixtures.js";
import { createPlacement, extraUser, newCandidate, selectedSubmission, transitionPlacementRow } from "./placement-seed.js";

/**
 * Sales / placements gaps (migration 0160, docs/placements-api.md and
 * docs/dashboards-api.md): placement status joining_issue, the re-confirmed
 * flag, the technology snapshot, placements report filters and audited CSV
 * export, sales reports grouped by manager and by candidate (the location
 * sales view) with CSV export, and BGC history as 3/5/7/10 year choices.
 */
let db: TestDb;
let app: NestFastifyApplication;
let bu: { id: string };
const SECRET = "test-secret-test-secret-test-secret-123";

const TECH2 = "00000000-0000-0000-0000-000000000502";
const CLIENT2 = "00000000-0000-0000-0000-000000000602";
const V1 = "00000000-0000-0000-0000-000000000701";
const V2 = "00000000-0000-0000-0000-000000000702";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO eureka.technology (id, name) VALUES ($1, 'Python')`, [TECH2]);
  await db.admin.query(`INSERT INTO eureka.client (id, name) VALUES ($1, 'Fabrikam Health')`, [CLIENT2]);
  await db.admin.query(`INSERT INTO eureka.vendor (id, name) VALUES ($1, 'Contoso Staffing'), ($2, 'Tailspin Partners')`, [V1, V2]);
  bu = await extraUser(db, "bu", "bu_head");
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U | "bu";
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
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers },
  });
}

/** Superuser write with triggers off (test setup only). */
async function force(sql: string, params: unknown[] = []) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

let keyNo = 0;
const createBody = (submissionId: string, extra: Record<string, unknown> = {}) => ({
  submissionId, placementType: "w2", rate: 61, workMode: "remote", tentativeStart: "2031-03-02", ...extra,
});
const postPlacement = (key: Key, b: unknown) =>
  call(key, "POST", "/api/v1/placements", b, { "idempotency-key": `sp-${++keyNo}-${Date.now()}` });

/** A placement by `actor` for a fresh candidate, with the submission's client and vendor set before the snapshot. */
async function placed(actor: string, cand: { teamId: string; recruiterId: string | null; locationId: string; technologyId?: string },
  sub: { clientId?: string; vendorId?: string | null } = {}) {
  const c = await newCandidate(db, cand);
  if (cand.technologyId) await force(`UPDATE eureka.candidate SET technology_id = $2 WHERE id = $1`, [c.id, cand.technologyId]);
  const s = await selectedSubmission(db, actor, c.id);
  await force(`UPDATE eureka.submission SET client_id = $2, vendor_id = $3 WHERE id = $1`, [s, sub.clientId ?? CLIENT_ID, sub.vendorId ?? null]);
  const p = await createPlacement(db, actor, s);
  return { id: p.id, candidateId: c.id, submissionId: s };
}

const audits = async (action: string) =>
  (await db.admin.query<{ changes: Record<string, unknown>; entity_id: string | null }>(
    `SELECT changes, entity_id FROM eureka.audit_event WHERE action = $1 ORDER BY seq`, [action])).rows;

describe("placement entry: re-confirmed flag and technology snapshot", () => {
  it("stores the flag the user entered, independent of first placement, and audits it without the rate", async () => {
    const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const s = await selectedSubmission(db, U.r1a, c.id);
    const res = await postPlacement("r1a", createBody(s, { reconfirmed: true }));
    expect(res.statusCode).toBe(201);
    expect(res.json().isFirstPlacement).toBe(true); // the database still decides first placement
    const got = (await call("r1a", "GET", `/api/v1/placements/${res.json().id}`)).json();
    expect(got).toMatchObject({ reconfirmed: true, technology: { id: TECH_ID, name: "Java" }, joinedAt: null });
    const a = (await audits("placement.created")).find((r) => r.entity_id === res.json().id)!;
    expect(a.changes).toMatchObject({ reconfirmed: true });
    expect(a.changes).not.toHaveProperty("rate");

    const c2 = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const s2 = await selectedSubmission(db, U.r1a, c2.id);
    const res2 = await postPlacement("r1a", createBody(s2));
    expect((await call("r1a", "GET", `/api/v1/placements/${res2.json().id}`)).json().reconfirmed).toBe(false);
  });

  it("refuses a non-boolean flag and keeps the flag and technology fixed after creation", async () => {
    const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const s = await selectedSubmission(db, U.r1a, c.id);
    expect((await postPlacement("r1a", createBody(s, { reconfirmed: "yes" }))).statusCode).toBe(422);
    expect((await postPlacement("r1a", createBody(s, { technologyId: TECH2 }))).statusCode).toBe(422);
    const p = await createPlacement(db, U.r1a, s);
    // The candidate's technology changes later; the placement keeps its snapshot.
    await force(`UPDATE eureka.candidate SET technology_id = $2 WHERE id = $1`, [c.id, TECH2]);
    expect((await call("r1a", "GET", `/api/v1/placements/${p.id}`)).json().technology).toEqual({ id: TECH_ID, name: "Java" });
    // Even the definer path cannot rewrite them (0022 write guard).
    await expect(asUser(db.app, U.r1a, (c2) => c2.query(`UPDATE eureka.placement SET reconfirmed = true WHERE id = $1`, [p.id])))
      .rejects.toThrow(/permission denied/);
    const own = await db.admin.connect();
    try {
      await own.query("BEGIN");
      await own.query("SET LOCAL ROLE authz_definer");
      await expect(own.query(`UPDATE eureka.placement SET reconfirmed = true WHERE id = $1`, [p.id])).rejects.toThrow(/permission denied|immutable/);
    } finally {
      await own.query("ROLLBACK");
      own.release();
    }
  });
});

describe("placement status joining_issue", () => {
  it("closes an open placement with a reason, returns the candidate to active and frees the submission", async () => {
    const p = await placed(U.r1a, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const listed = (await call("r1a", "GET", `/api/v1/placements/${p.id}`)).json();
    expect(listed.allowedTransitions).toEqual(["paperwork", "backout", "joining_issue"]);
    expect((await call("r1a", "PATCH", `/api/v1/placements/${p.id}/status`, { to: "joining_issue" })).json().detail).toBe("reason_required");
    const ok = await call("r1a", "PATCH", `/api/v1/placements/${p.id}/status`, { to: "joining_issue", reason: "Client delayed onboarding" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: p.id, status: "joining_issue" });
    const cand = (await db.admin.query(`SELECT marketing_status FROM eureka.candidate WHERE id = $1`, [p.candidateId])).rows[0];
    expect(cand.marketing_status).toBe("active");
    const ev = (await db.admin.query(`SELECT payload FROM eureka.outbox_event WHERE aggregate_id = $1 AND type = 'placement.state_changed'`, [p.id])).rows;
    expect(ev.map((r) => r.payload.to)).toEqual(["joining_issue"]);
    expect(JSON.stringify(ev)).not.toContain("Client delayed");
    const audit = (await audits("placement.status")).filter((r) => r.entity_id === p.id);
    expect(audit.map((r) => r.changes)).toEqual([{ from: "confirmed", to: "joining_issue", reasonGiven: true }]);
    expect(audit.map((r) => JSON.stringify(r.changes)).join()).not.toContain("Client delayed");
    // Closed like a backout: no contract can be added (0086 create_contract, rebuilt in 0160).
    expect((await call("r1a", "GET", `/api/v1/placements/${p.id}/contracts`)).json().canAdd).toBe(false);
    const k = await call("r1a", "POST", `/api/v1/placements/${p.id}/contracts`, { kind: "sow", title: "SOW" });
    expect(k.statusCode).toBe(422);
    expect(k.json().detail).toBe("placement_closed");
    // Final: nothing further; and the submission can be placed again, as a first placement.
    expect((await call("r1a", "GET", `/api/v1/placements/${p.id}`)).json().allowedTransitions).toEqual([]);
    const again = await postPlacement("r1a", createBody(p.submissionId));
    expect(again.statusCode).toBe(201);
    expect(again.json().isFirstPlacement).toBe(true);
  });

  it("is not allowed after joining, and the database enforces the same rules", async () => {
    const p = await placed(U.r1a, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    for (const to of ["paperwork", "bgc", "ready", "joined"]) await transitionPlacementRow(db, U.r1a, p.id, to);
    const res = await call("m1", "PATCH", `/api/v1/placements/${p.id}/status`, { to: "joining_issue", reason: "Late" });
    expect(res.json().detail).toBe("invalid_transition");
    await expect(transitionPlacementRow(db, U.m1, p.id, "joining_issue", "Late")).rejects.toThrow(/invalid_transition/);
    const p2 = await placed(U.r1a, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    await expect(transitionPlacementRow(db, U.r1a, p2.id, "joining_issue", "  ")).rejects.toThrow(/reason_required/);
    await expect(transitionPlacementRow(db, U.r1a, p2.id, "joining_issue", null)).rejects.toThrow(/reason_required/);
    // Read-before-write: not visible -> 404, visible but not allowed (HR reads placements) -> 403.
    expect((await call("r2a", "PATCH", `/api/v1/placements/${p2.id}/status`, { to: "joining_issue", reason: "x" })).statusCode).toBe(404);
    expect((await call("hr", "PATCH", `/api/v1/placements/${p2.id}/status`, { to: "joining_issue", reason: "x" })).statusCode).toBe(403);
    expect((await transitionPlacementRow(db, U.r1a, p2.id, "joining_issue", "Visa stamping pending")).candidate_to).toBe("active");
    await expect(force(`UPDATE eureka.placement SET status_reason = NULL WHERE id = $1`, [p2.id])).rejects.toThrow(/placement_reason/);
  });
});

describe("placements report: filters and export", () => {
  let ids: Record<string, string>;
  beforeAll(async () => {
    ids = {
      a: (await placed(U.r1a, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas }, { vendorId: V1 })).id,
      b: (await placed(U.r1a, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.austin, technologyId: TECH2 }, { clientId: CLIENT2, vendorId: V2 })).id,
      c: (await placed(U.r3a, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas, technologyId: TECH2 }, { vendorId: V1 })).id,
    };
  });
  const list = async (key: Key, q: string) =>
    ((await call(key, "GET", `/api/v1/placements?limit=200&${q}`)).json().items as { id: string }[]).map((p) => p.id);
  const mine = (got: string[]) => Object.entries(ids).filter(([, id]) => got.includes(id)).map(([k]) => k).sort();

  it("filters by vendor, end client, technology and location within the caller's scope", async () => {
    expect(mine(await list("ceo", `vendorId=${V1}`))).toEqual(["a", "c"]);
    expect(mine(await list("ceo", `clientId=${CLIENT2}`))).toEqual(["b"]);
    expect(mine(await list("ceo", `technologyId=${TECH2}`))).toEqual(["b", "c"]);
    expect(mine(await list("ceo", `locationId=${LOC.austin}`))).toEqual(["b"]);
    expect(mine(await list("ceo", `vendorId=${V1}&locationId=${LOC.dallas}&technologyId=${TECH2}`))).toEqual(["c"]);
    expect(mine(await list("r1a", `vendorId=${V1}`))).toEqual(["a"]); // r3a's placement is outside r1a's scope
    // BU Head reads placements but not candidates: the technology snapshot still filters.
    expect(mine(await list("bu", `technologyId=${TECH2}`))).toEqual(["b", "c"]);
    expect((await call("ceo", "GET", `/api/v1/placements?vendorId=nope`)).statusCode).toBe(422);
  });

  it("exports the filtered list as CSV without rates or contacts, capped and audited by filter names", async () => {
    const res = await call("l1", "POST", "/api/v1/placements/export", { technologyId: TECH2 });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["x-export-rows"]).toBe("1"); // b only: c belongs to team t3
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Candidate,Technology,Status,Type,Work mode,End client,Vendor,Implementation partner,Recruiter,Team,Location,Tentative start,Joined on,First placement,Re-confirmed,Created on");
    expect(lines[1]).toContain("Python,confirmed,w2,onsite,Fabrikam Health,Tailspin Partners,");
    expect(res.body).not.toMatch(/\b60(\.00)?\b/); // the seed's rate
    const a = (await audits("placement.export")).at(-1)!;
    expect(a.changes).toEqual({ rows: 1, truncated: false, cap: 5000, filters: ["technologyId"] });
    expect(JSON.stringify(a.changes)).not.toContain(TECH2);
  });

  it("needs report:export and placement:read; strict body", async () => {
    expect((await call("r1a", "POST", "/api/v1/placements/export", {})).statusCode).toBe(403); // no report:export
    expect((await call("locD", "POST", "/api/v1/placements/export", {})).statusCode).toBe(403);
    expect((await call("hr", "POST", "/api/v1/placements/export", {})).statusCode).toBe(403);
    expect((await call("ceo", "POST", "/api/v1/placements/export", { cursor: "x" })).statusCode).toBe(422);
    expect((await call("ceo", "POST", "/api/v1/placements/export", { limit: 100000 })).statusCode).toBe(422);
  });
});

// ---------- sales reports (dashboard) ----------

const P_FROM = "2032-05-01T00:00:00.000Z";
const P_TO = "2032-05-08T00:00:00.000Z";
const inP = (day: number) => `2032-05-0${day}T10:00:00Z`;
const PERIOD = `from=${encodeURIComponent(P_FROM)}&to=${encodeURIComponent(P_TO)}`;

describe("sales reports by manager and by candidate", () => {
  const cands: Record<string, string> = {};
  let orphanRecruiter: string;
  let noManagerTeam: string;
  beforeAll(async () => {
    const sub = async (actor: string, candidateId: string, day: number) => {
      const id = await asUser(db.app, actor, async (c) => (await c.query<{ id: string }>(
        `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'Data Engineer',$2) RETURNING id`,
        [candidateId, CLIENT_ID])).rows[0]!.id, true);
      await force(`UPDATE eureka.submission SET submitted_at = $2 WHERE id = $1`, [id, inP(day)]);
      return id;
    };
    const interview = async (submissionId: string, day: number, cleared: boolean) => {
      await force(`INSERT INTO eureka.interview (submission_id, candidate_id, recruiter_id, team_id, location_id, round, starts_at, ends_at,
                     call_status, cleared, cleared_at)
                   SELECT s.id, s.candidate_id, s.recruiter_id, s.team_id, s.location_id, 'L1', $2::timestamptz, $2::timestamptz + interval '1 hour',
                          'completed', $3, CASE WHEN $3 THEN $2::timestamptz + interval '2 hours' END
                   FROM eureka.submission s WHERE s.id = $1`, [submissionId, inP(day), cleared]);
    };
    const cand = async (key: string, teamId: string, recruiterId: string | null, locationId: string) => {
      const c = await newCandidate(db, { teamId, recruiterId, locationId });
      await force(`UPDATE eureka.candidate SET created_at = '2020-01-01' WHERE id = $1`, [c.id]);
      cands[key] = c.id;
      return c.id;
    };
    // t1 (lead l1 -> m1): two submissions, one cleared interview. t2 (l2 -> m1): one. t3 (l3 -> m2): one, interview not cleared.
    const s1 = await sub(U.r1a, await cand("c1", T.t1, U.r1a, LOC.dallas), 1);
    await sub(U.r1a, cands.c1!, 2);
    await interview(s1, 3, true);
    await sub(U.r2a, await cand("c2", T.t2, U.r2a, LOC.austin), 2);
    const s3 = await sub(U.r3a, await cand("c3", T.t3, U.r3a, LOC.dallas), 4);
    await interview(s3, 5, false);
    // A recruiter without a team, reporting to l3 (-> m2), and a team whose lead reports to nobody.
    orphanRecruiter = (await extraUser(db, "solo", "recruiter")).id;
    await db.admin.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ($1, $2)`, [orphanRecruiter, U.l3]);
    const lead = (await extraUser(db, "lonelead", "lead")).id;
    noManagerTeam = (await db.admin.query<{ id: string }>(`INSERT INTO eureka.team (name, lead_id) VALUES ('Team Solo', $1) RETURNING id`, [lead])).rows[0]!.id;
    const c4 = await cand("c4", T.t3, U.r3a, LOC.dallas);
    await force(`INSERT INTO eureka.submission (candidate_id, recruiter_id, team_id, location_id, submitted_at, job_title, client_id)
                 VALUES ($1, $2, NULL, $3, $4, 'QA', $5), ($1, $6, $7, $3, $4, 'QA', $5)`,
      [c4, orphanRecruiter, LOC.dallas, inP(6), CLIENT_ID, lead, noManagerTeam]);
  });

  const dash = async (key: Key, q: string) => (await call(key, "GET", `/api/v1/dashboard?${PERIOD}&${q}`)).json();
  const byName = (d: { groups: { id: string | null; name: string | null; counts: Record<string, number> }[] }, metric: string) =>
    Object.fromEntries(d.groups.map((g) => [g.name ?? "(none)", g.counts[metric]]));

  it("groups activity by the manager over the team's lead (or the recruiter without a team)", async () => {
    const d = await dash("ceo", "groupBy=manager");
    expect(d.groupBy).toBe("manager");
    expect(byName(d, "submissions")).toEqual({ m1: 3, m2: 2, "(none)": 1 });
    expect(byName(d, "interviewsCleared")).toEqual({ m1: 1, m2: 0, "(none)": 0 });
    expect(d.groups.find((g: { name: string | null }) => g.name === "m1").id).toBe(U.m1);
    expect(d.groupsTruncated).toBe(false);
    // A manager sees only their own hierarchy.
    expect(byName(await dash("m1", "groupBy=manager"), "submissions")).toEqual({ m1: 3 });
  });

  it("gives location roles one row per candidate by default (location sales view)", async () => {
    const d = await dash("locD", "");
    expect(d.groupBy).toBe("candidate");
    const rows = Object.fromEntries(d.groups.map((g: { id: string; name: string; counts: Record<string, number> }) => [g.id, g]));
    expect(rows[cands.c1!]).toMatchObject({ counts: { submissions: 2, interviewsScheduled: 1, interviewsCleared: 1 } });
    expect(rows[cands.c1!].name).toMatch(/Placed$/);
    expect(rows[cands.c3!]).toMatchObject({ counts: { submissions: 1, interviewsScheduled: 1, interviewsCleared: 0 } });
    expect(rows[cands.c4!]).toMatchObject({ counts: { submissions: 2 } });
    expect(rows[cands.c2!]).toBeUndefined(); // Austin
    // Austin's incharge sees only c2.
    const a = await dash("locA", "");
    expect(a.groups.map((g: { id: string }) => g.id)).toEqual([cands.c2]);
  });

  it("exports the grouped counts with a total row for report:export holders, audited", async () => {
    const res = await call("ceo", "POST", "/api/v1/dashboard/export", { from: P_FROM, to: P_TO, groupBy: "manager" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Manager,Submissions,Interviews,Interviews cleared,Placements,Joined,Candidates added");
    expect(lines.slice(1)).toEqual(["m1,3,1,1,0,0,0", "m2,2,1,0,0,0,0", "No manager,1,0,0,0,0,0", "Total,6,2,1,0,0,0"]);
    expect(res.headers["x-export-rows"]).toBe("3");
    const a = (await audits("dashboard.export")).at(-1)!;
    expect(a.changes).toMatchObject({ groupBy: "manager", from: P_FROM, to: P_TO, rows: 3, truncated: false });

    const m1 = await call("m1", "POST", "/api/v1/dashboard/export", { from: P_FROM, to: P_TO, groupBy: "manager" });
    expect(m1.body.replace(/^﻿/, "").trim().split("\r\n").slice(1)).toEqual(["m1,3,1,1,0,0,0", "Total,3,1,1,0,0,0"]);
  });

  it("export needs report:export; the body is strict", async () => {
    expect((await call("r1a", "POST", "/api/v1/dashboard/export", { from: P_FROM, to: P_TO })).statusCode).toBe(403);
    expect((await call("locD", "POST", "/api/v1/dashboard/export", { from: P_FROM, to: P_TO })).statusCode).toBe(403);
    expect((await call("hr", "POST", "/api/v1/dashboard/export", { from: P_FROM, to: P_TO })).statusCode).toBe(403);
    expect((await call("ceo", "POST", "/api/v1/dashboard/export", { from: P_FROM, to: P_TO, groupBy: "vendor" })).statusCode).toBe(422);
    expect((await call("ceo", "POST", "/api/v1/dashboard/export", { from: P_FROM, to: P_TO, limit: 5 })).statusCode).toBe(422);
  });
});

// ---------- BGC history years ----------

describe("BGC employment and address history as 3 / 5 / 7 / 10 years", () => {
  it("accepts only the four choices (API and database)", async () => {
    const p = await placed(U.r1a, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const url = `/api/v1/paperwork/placements/${p.id}/bgc`;
    expect((await call("hr", "PATCH", url, { employmentYears: 4 })).statusCode).toBe(422);
    expect((await call("hr", "PATCH", url, { addressYears: 0 })).statusCode).toBe(422);
    const ok = await call("hr", "PATCH", url, { employmentYears: 10, addressYears: 5 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ employmentYears: 10, addressYears: 5 });
    await expect(asUser(db.app, U.hr, (c) => c.query(`SELECT * FROM authz.update_bgc($1, '{"employmentYears": 6}'::jsonb, NULL)`, [p.id])))
      .rejects.toThrow(/invalid_change/);
    expect((await call("hr", "PATCH", url, { employmentYears: null })).json().employmentYears).toBeNull();
  });

  it("the migration rounds earlier free values up to the next choice, through the definer with history", async () => {
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0160_sales_placements.sql"), "utf8");
    const update = /UPDATE eureka\.bgc SET[\s\S]*?;\n/.exec(sql)![0];
    const values = [0, 1, 3, 4, 5, 6, 7, 8, 10, 25, 50];
    const p = await placed(U.r1a, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    expect((await call("hr", "PATCH", `/api/v1/paperwork/placements/${p.id}/bgc`, { status: "initiated" })).statusCode).toBe(200);
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(`ALTER TABLE eureka.bgc DROP CONSTRAINT bgc_employment_years_check, DROP CONSTRAINT bgc_address_years_check`);
      const out: [number, number | null][] = [];
      for (const v of values) {
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(`UPDATE eureka.bgc SET employment_years = $2, address_years = $2 WHERE placement_id = $1`, [p.id, v]);
        await c.query("SET LOCAL session_replication_role = origin");
        const before = (await c.query(`SELECT version FROM eureka.bgc WHERE placement_id = $1`, [p.id])).rows[0].version;
        await c.query("SET LOCAL ROLE authz_definer");
        await c.query(update);
        await c.query("RESET ROLE");
        const b = (await c.query(`SELECT employment_years, address_years, version FROM eureka.bgc WHERE placement_id = $1`, [p.id])).rows[0];
        expect(b.address_years).toBe(b.employment_years);
        expect(b.version).toBe([3, 5, 7, 10].includes(v) ? before : before + 1);
        out.push([v, b.employment_years]);
      }
      expect(out).toEqual([[0, null], [1, 3], [3, 3], [4, 5], [5, 5], [6, 7], [7, 7], [8, 10], [10, 10], [25, 10], [50, 10]]);
      const hist = (await c.query(`SELECT actor_id, changed FROM eureka.bgc_event WHERE placement_id = $1 AND NOT ('status' = ANY (changed))`, [p.id])).rows;
      expect(hist.length).toBeGreaterThan(0);
      expect(hist.every((h) => h.actor_id === null && h.changed.includes("employment_years"))).toBe(true);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
