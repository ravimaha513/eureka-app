import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityVisible,
  can,
  ownsActivity,
  resolveScope,
  resolveScopeFor,
  type ActivityRef,
  type Permission,
  type UserAccess,
} from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { at, seedPipeline, type PipelineSeed } from "./pipeline-seed.js";

let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
let seed: PipelineSeed;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  seed = await seedPipeline(db, candidates);
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

type Key = keyof typeof U;
const users = Object.keys(U) as Key[];
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

async function call(key: Key, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) },
  });
}

async function getAll(key: Key, path: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const res = await call(key, "GET", `${path}${sep}limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as { items: Record<string, unknown>[]; nextCursor: string | null };
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

// Independent oracles from the catalog (the service has its own copies).
const salesUpdate = (a: UserAccess, r: ActivityRef) =>
  ownsActivity(resolveScopeFor(a, "interview:update", ["own", "team", "hierarchy", "org"]), r);
const locationUpdate = (a: UserAccess, r: ActivityRef) =>
  r.locationId !== null && (resolveScopeFor(a, "interview:update", ["location"])?.locationIds.has(r.locationId) ?? false);
const kinds = (a: UserAccess, r: ActivityRef) => ([
  ["coach", ["coached"]], ["location", ["location"]], ["client", ["own", "team", "hierarchy", "org"]],
] as const).filter(([, s]) => activityVisible(resolveScopeFor(a, "interview.feedback:create", s), r)).map(([k]) => k);

const sample = () => seed.interviews.find((i) => i.recruiterId === U.r1a)!;

describe("authorization matrix (generated from the catalog)", () => {
  const endpoints: { perm: Permission; method: "GET" | "POST" | "PATCH"; url: () => string; body?: unknown }[] = [
    { perm: "submission:read", method: "GET", url: () => "/api/v1/submissions" },
    { perm: "submission:read", method: "GET", url: () => `/api/v1/submissions/${sample().submissionId}` },
    { perm: "submission:update", method: "PATCH", url: () => `/api/v1/submissions/${sample().submissionId}/status`, body: { to: "bogus" } },
    { perm: "interview:read", method: "GET", url: () => "/api/v1/interviews" },
    { perm: "interview:read", method: "GET", url: () => `/api/v1/interviews/${sample().id}` },
    { perm: "interview:read", method: "GET", url: () => `/api/v1/interviews/${sample().id}/feedback` },
    { perm: "interview:create", method: "POST", url: () => "/api/v1/interviews", body: {} },
    { perm: "interview:create", method: "GET", url: () => "/api/v1/interviews/coaches" },
    { perm: "interview:update", method: "PATCH", url: () => `/api/v1/interviews/${sample().id}`, body: { bogus: 1 } },
    { perm: "interview.feedback:create", method: "POST", url: () => `/api/v1/interviews/${sample().id}/feedback`, body: {} },
  ];
  const cases = users.flatMap((u) => endpoints.map((e, i) => [u, `${e.method} #${i} ${e.perm}`, e] as const));
  it.each(cases)("%s → %s", async (key, _name, e) => {
    const res = await call(key, e.method, e.url(), e.body);
    if (can(toUserAccess(key), e.perm)) expect(res.statusCode, res.body).not.toBe(403);
    else expect(res.statusCode, res.body).toBe(403);
  });
});

describe("interview coach picker", () => {
  it("filters client history without widening the caller's scope", async () => {
    const all = await call("r1a", "GET", "/api/v1/interviews");
    const filtered = await call("r1a", "GET", `/api/v1/interviews?clientId=${CLIENT_ID}`);
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items.map((i: { id: string }) => i.id)).toEqual(
      all.json().items.filter((i: { client: { id: string } | null }) => i.client?.id === CLIENT_ID).map((i: { id: string }) => i.id),
    );
    const absent = await call("r1a", "GET", "/api/v1/interviews?clientId=00000000-0000-4000-8000-000000000001");
    expect(absent.statusCode).toBe(200);
    expect(absent.json().items).toEqual([]);
  });
  it("returns only active coaches and minimal display fields", async () => {
    const res = await call("r1a", "GET", "/api/v1/interviews/coaches");
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: string; name: string }[];
    expect(items.map((i) => i.id)).toContain(U.coach);
    expect(items.map((i) => i.id)).not.toContain(U.r1a);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(["id", "name"]);
  });
});

describe("row-level outcomes per user (404 / 403 / allowed)", () => {
  it.each(users)("submission status change probe for %s", async (key) => {
    const access = toUserAccess(key);
    if (!can(access, "submission:update")) return;
    for (const s of seed.submissions) {
      // submitted -> selected is never valid, so an authorized caller gets 422 and nothing changes.
      const res = await call(key, "PATCH", `/api/v1/submissions/${s.id}/status`, { to: "selected" });
      const expected = !activityVisible(resolveScope(access, "submission:read"), s) ? 404
        : !ownsActivity(resolveScope(access, "submission:update"), s) ? 403 : 422;
      expect(res.statusCode, `${key} ${s.id}`).toBe(expected);
    }
  });

  it.each(users)("interview no-op update for %s", async (key) => {
    const access = toUserAccess(key);
    if (!can(access, "interview:update")) return;
    for (const i of seed.interviews) {
      const res = await call(key, "PATCH", `/api/v1/interviews/${i.id}`, { callStatus: "scheduled" });
      const expected = !activityVisible(resolveScope(access, "interview:read"), i) ? 404
        : !(salesUpdate(access, i) || locationUpdate(access, i)) ? 403 : 200;
      expect(res.statusCode, `${key} ${i.id} ${res.body}`).toBe(expected);
    }
  });

  it.each(users)("feedback for %s", async (key) => {
    const access = toUserAccess(key);
    if (!can(access, "interview.feedback:create")) return;
    for (const i of seed.interviews) {
      const res = await call(key, "POST", `/api/v1/interviews/${i.id}/feedback`, { rating: 3, ...(kinds(access, i).length > 1 ? { kind: kinds(access, i)[0] } : {}) });
      const expected = !activityVisible(resolveScope(access, "interview:read"), i) ? 404 : kinds(access, i).length === 0 ? 403 : 201;
      expect(res.statusCode, `${key} ${i.id} ${res.body}`).toBe(expected);
      if (expected === 201) expect(res.json().kind).toBe(kinds(access, i)[0]);
    }
  });
});

describe("lists return exactly the engine-visible rows (differential)", () => {
  it.each(users)("submissions for %s", async (key) => {
    const access = toUserAccess(key);
    const scope = resolveScope(access, "submission:read");
    if (!scope) { expect((await call(key, "GET", "/api/v1/submissions")).statusCode).toBe(403); return; }
    const items = await getAll(key, "/api/v1/submissions");
    const seeded = new Set(seed.submissions.map((s) => s.id));
    const got = items.map((i) => i.id as string).filter((id) => seeded.has(id)).sort();
    expect(got).toEqual(seed.submissions.filter((s) => activityVisible(scope, s)).map((s) => s.id).sort());
    // Field policy: rate only where rate:read covers the actor snapshot (the team that negotiated it).
    const rateScope = resolveScope(access, "rate:read");
    for (const item of items.filter((i) => seeded.has(i.id as string))) {
      const s = seed.submissions.find((x) => x.id === item.id)!;
      expect("rate" in item, `${key} rate ${s.id}`).toBe(ownsActivity(rateScope, s));
      if ("rate" in item) expect(item.rate).toBe(55);
    }
  });

  it.each(users)("interview board for %s", async (key) => {
    const access = toUserAccess(key);
    const scope = resolveScope(access, "interview:read");
    if (!scope) { expect((await call(key, "GET", "/api/v1/interviews")).statusCode).toBe(403); return; }
    const items = await getAll(key, `/api/v1/interviews?from=${encodeURIComponent(at(0))}`);
    const seeded = new Set(seed.interviews.map((s) => s.id));
    const got = items.map((i) => i.id as string).filter((id) => seeded.has(id)).sort();
    expect(got).toEqual(seed.interviews.filter((i) => activityVisible(scope, i)).map((i) => i.id).sort());
  });

  it("coach sees coached team's interviews only; location admin sees their location only", async () => {
    const coach = await getAll("coach", "/api/v1/interviews");
    expect(coach.length).toBeGreaterThan(0);
    for (const i of coach) expect((i.team as { id: string }).id).toBe(T.t2);
    const locD = await getAll("locD", "/api/v1/interviews");
    expect(locD.length).toBeGreaterThan(0);
    for (const i of locD) expect((i.location as { id: string }).id).toBe(LOC.dallas);
  });
});

describe("submission filters and pagination", () => {
  it("filters by candidate, recruiter, status and date range", async () => {
    const s = seed.submissions.find((x) => x.recruiterId === U.r2a && x.teamId === T.t2)!;
    const byCand = (await call("m1", "GET", `/api/v1/submissions?candidateId=${s.candidate.id}`)).json().items;
    expect(byCand.every((i: { candidateId: string }) => i.candidateId === s.candidate.id)).toBe(true);
    expect(byCand.map((i: { id: string }) => i.id)).toContain(s.id);
    const byRec = (await call("m1", "GET", `/api/v1/submissions?recruiterId=${U.r1b}`)).json().items;
    expect(byRec.length).toBeGreaterThan(0);
    expect(byRec.every((i: { recruiterId: string }) => i.recruiterId === U.r1b)).toBe(true);
    expect((await call("m1", "GET", "/api/v1/submissions?status=selected")).json().items).toEqual([]);
    expect((await call("m1", "GET", "/api/v1/submissions?from=2000-01-01&to=2000-01-02")).json().items).toEqual([]);
    expect((await call("m1", "GET", "/api/v1/submissions?status=nope")).statusCode).toBe(422);
    expect((await call("m1", "GET", "/api/v1/submissions?cursor=abc")).statusCode).toBe(422);
  });

  it("small pages walk the same set as one large page", async () => {
    const all = (await call("ad", "GET", "/api/v1/submissions?limit=200")).json().items.map((i: { id: string }) => i.id);
    const paged = (await getAll("ad", "/api/v1/submissions")).map((i) => i.id);
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(paged.length);
  });
});

describe("submission state machine", () => {
  const fresh = async (key: Key = "r1a") => {
    const cand = candidates.find((c) => c.recruiterId === U.r1a && c.marketingStatus === "active")!;
    const r = await call(key, "POST", "/api/v1/submissions", { candidateId: cand.id, jobTitle: "Dev", clientId: CLIENT_ID });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  const move = (id: string, to: string, extra: Record<string, unknown> = {}, key: Key = "r1a") =>
    call(key, "PATCH", `/api/v1/submissions/${id}/status`, { to, ...extra });

  it("walks the happy path to selected, then stays terminal", async () => {
    const id = await fresh();
    for (const to of ["under_review", "interview_requested", "interview_scheduled", "interview_completed", "selected"]) {
      const r = await move(id, to);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ id, status: to, rejectionReason: null });
    }
    for (const to of ["rejected", "withdrawn", "submitted"]) {
      const r = await move(id, to, to === "rejected" ? { rejectionReason: "x" } : {});
      expect(r.statusCode).toBe(422);
      expect(r.json().detail).toBe("invalid_transition");
    }
    const got = (await call("r1a", "GET", `/api/v1/submissions/${id}`)).json();
    expect(got.status).toBe("selected");
    expect(got.statusChangedAt).not.toBeNull();
  });

  it("refuses skipped and backward steps", async () => {
    const id = await fresh();
    expect((await move(id, "interview_scheduled")).json().detail).toBe("invalid_transition");
    expect((await move(id, "submitted")).statusCode).toBe(422);
    await move(id, "under_review");
    expect((await move(id, "submitted")).statusCode).toBe(422);
  });

  it("rejection needs a reason; other statuses take none; withdrawn from any open state", async () => {
    const id = await fresh();
    expect((await move(id, "rejected")).statusCode).toBe(422);
    expect((await move(id, "rejected", { rejectionReason: "   " })).statusCode).toBe(422);
    expect((await move(id, "under_review", { rejectionReason: "why" })).statusCode).toBe(422);
    const ok = await move(id, "rejected", { rejectionReason: "Client chose another vendor" });
    expect(ok.json()).toEqual({ id, status: "rejected", rejectionReason: "Client chose another vendor" });
    const w = await fresh();
    await move(w, "under_review");
    await move(w, "interview_requested");
    expect((await move(w, "withdrawn")).json().status).toBe("withdrawn");
  });

  it("teammates may not move each other's submissions; the lead may; others get 404", async () => {
    const id = await fresh();
    expect((await move(id, "under_review", {}, "r1b")).statusCode).toBe(404);
    expect((await move(id, "under_review", {}, "r3a")).statusCode).toBe(404);
    expect((await move(id, "under_review", {}, "l1")).statusCode).toBe(200);
    expect((await move(id, "interview_requested", {}, "m1")).statusCode).toBe(200);
    expect((await move(id, "interview_scheduled", {}, "l3")).statusCode).toBe(404);
    expect((await move(id, "interview_scheduled", {}, "locD")).statusCode).toBe(403); // guard: no submission:update
  });

  it("transitions are audited with from/to and never the rate", async () => {
    const id = await fresh();
    await move(id, "under_review");
    const { rows } = await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'submission.status' AND entity_id = $1`, [id]);
    expect(rows[0].changes).toEqual({ from: "submitted", to: "under_review" });
    const created = await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'submission.created' AND entity_id = $1`, [id]);
    expect(JSON.stringify(created.rows[0].changes)).not.toMatch(/rate/);
  });

  it("D-01 stays: a lead cannot submit a candidate seen only on the open Hot List", async () => {
    const hotOnly = candidates.find((c) => c.teamId === T.t2 && c.visibility === "team" && c.marketingStatus === "active")!;
    const r = await call("l1", "POST", "/api/v1/submissions", { candidateId: hotOnly.id, jobTitle: "Dev", clientId: CLIENT_ID });
    expect([403, 404]).toContain(r.statusCode);
  });
});

describe("interviews", () => {
  let hour = 1000;
  const slot = () => { hour += 3; return { startsAt: at(hour), endsAt: at(hour + 1) }; };
  const newSubmission = async (key: Key = "r1a", pick = (c: FixtureCandidate) => c.recruiterId === U.r1a && c.marketingStatus === "active" && c.locationId === LOC.dallas) => {
    const cand = candidates.find(pick)!;
    const r = await call(key, "POST", "/api/v1/submissions", { candidateId: cand.id, jobTitle: "Dev", clientId: CLIENT_ID });
    return r.json().id as string;
  };
  const create = (submissionId: string, times = slot(), key: Key = "r1a") =>
    call(key, "POST", "/api/v1/interviews", { submissionId, round: "Client L1", ...times });

  it("recruiter schedules an interview; snapshots and client come from the submission", async () => {
    const sub = await newSubmission();
    const r = await create(sub);
    expect(r.statusCode, r.body).toBe(201);
    const got = (await call("r1a", "GET", `/api/v1/interviews/${r.json().id}`)).json();
    expect(got).toMatchObject({
      submissionId: sub, recruiter: { id: U.r1a }, team: { id: T.t1 }, location: { id: LOC.dallas },
      client: { id: CLIENT_ID, name: "Northwind Financial" }, callStatus: "scheduled", cleared: false, consentCaptured: false,
    });
    expect(got.editableFields).toEqual(["callStatus", "coachId", "durationMin", "endsAt", "interviewType", "inviteReceived", "leadId",
      "meetingUrl", "otterUrl", "panelIds", "recordingUrl", "round", "startsAt"]);
  });

  it("creation is authorized against the parent submission", async () => {
    const sub = await newSubmission();
    expect((await create(sub, slot(), "r1b")).statusCode).toBe(404);
    expect((await create(sub, slot(), "l1")).statusCode).toBe(201);
    expect((await create(sub, slot(), "l3")).statusCode).toBe(404);
    expect((await create(sub, slot(), "locD")).statusCode).toBe(403);
    expect((await call("r1a", "POST", "/api/v1/interviews", { submissionId: sub, round: "x", ...slot(), teamId: T.t3 })).statusCode).toBe(422);
    const bad = slot();
    expect((await call("r1a", "POST", "/api/v1/interviews", { submissionId: sub, round: "x", startsAt: bad.endsAt, endsAt: bad.startsAt })).statusCode).toBe(422);
  });

  it("no interviews on a closed submission", async () => {
    const sub = await newSubmission();
    await call("r1a", "PATCH", `/api/v1/submissions/${sub}/status`, { to: "withdrawn" });
    const r = await create(sub);
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toBe("submission_closed");
  });

  it("conflict check: overlapping live interviews for one candidate are refused (409)", async () => {
    const sub = await newSubmission();
    const other = await newSubmission("l1"); // same candidate, another submission
    const t = slot();
    const first = await create(sub, t);
    expect(first.statusCode).toBe(201);
    const clash = await create(other, { startsAt: at(hour) .replace(":00:00", ":30:00"), endsAt: at(hour + 2) }, "l1");
    expect(clash.statusCode).toBe(409);
    expect(clash.json().detail).toBe("interview_conflict");
    expect(clash.body).not.toMatch(/Key|candidate_id|tstzrange/);
    // Back-to-back is fine.
    expect((await create(other, { startsAt: t.endsAt, endsAt: at(hour + 2) }, "l1")).statusCode).toBe(201);
    // Moving an interview onto a busy slot is refused too.
    const later = await create(sub);
    const move = await call("r1a", "PATCH", `/api/v1/interviews/${later.json().id}`, t);
    expect(move.statusCode).toBe(409);
    // A cancelled interview frees its slot.
    expect((await call("r1a", "PATCH", `/api/v1/interviews/${first.json().id}`, { callStatus: "cancelled" })).statusCode).toBe(200);
    expect((await call("r1a", "PATCH", `/api/v1/interviews/${later.json().id}`, t)).statusCode).toBe(200);
  });

  it("recording links only with consent (AS-12)", async () => {
    const id = (await create(await newSubmission())).json().id;
    const link = { otterUrl: "https://otter.ai/u/abc" };
    const noConsent = await call("r1a", "PATCH", `/api/v1/interviews/${id}`, link);
    expect(noConsent.statusCode).toBe(422);
    expect(noConsent.json().detail).toBe("consent_required");
    expect((await call("locD", "PATCH", `/api/v1/interviews/${id}`, { consentCaptured: true })).statusCode).toBe(200);
    expect((await call("r1a", "PATCH", `/api/v1/interviews/${id}`, link)).statusCode).toBe(200);
    expect((await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { recordingUrl: "javascript:alert(1)" })).statusCode).toBe(422);
    const revoke = await call("locD", "PATCH", `/api/v1/interviews/${id}`, { consentCaptured: false });
    expect(revoke.json().detail).toBe("consent_required");
    // Clearing the links first, then consent can be withdrawn.
    expect((await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { otterUrl: null })).statusCode).toBe(200);
    expect((await call("locD", "PATCH", `/api/v1/interviews/${id}`, { consentCaptured: false })).statusCode).toBe(200);
  });

  it("column allowlist per role: forbidden fields are 422, unknown fields 422", async () => {
    const id = (await create(await newSubmission())).json().id;
    for (const f of [{ cleared: true }, { consentCaptured: true }, { systemName: "PC-4" }]) {
      const r = await call("r1a", "PATCH", `/api/v1/interviews/${id}`, f);
      expect(r.statusCode, JSON.stringify(f)).toBe(422);
      expect(r.json().detail).toMatch(/^field_not_permitted/);
    }
    for (const f of [{ startsAt: at(9000) }, { round: "L2" }, { otterUrl: null }, { coachId: U.coach }]) {
      expect((await call("locD", "PATCH", `/api/v1/interviews/${id}`, f)).statusCode, JSON.stringify(f)).toBe(422);
    }
    for (const f of [{ teamId: T.t3 }, { recruiterId: U.r3a }, { locationId: LOC.austin }, { feedbackEmailSentAt: at(1) }, { clearedBy: U.r1a }, {}]) {
      expect((await call("l1", "PATCH", `/api/v1/interviews/${id}`, f)).statusCode, JSON.stringify(f)).toBe(422);
    }
    expect((await call("locA", "PATCH", `/api/v1/interviews/${id}`, { cleared: true })).statusCode).toBe(404);
  });

  it("location admin toggles cleared; the server records who and when; writes are audited", async () => {
    const id = (await create(await newSubmission())).json().id;
    const r = await call("locD", "PATCH", `/api/v1/interviews/${id}`, { cleared: true, systemName: "PC-4", callStatus: "completed" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ cleared: true, systemName: "PC-4", callStatus: "completed" });
    expect(r.json().clearedAt).not.toBeNull();
    const row = (await db.admin.query(`SELECT cleared_by FROM eureka.interview WHERE id = $1`, [id])).rows[0];
    expect(row.cleared_by).toBe(U.locD);
    const off = await call("locD", "PATCH", `/api/v1/interviews/${id}`, { cleared: false });
    expect(off.json().clearedAt).toBeNull();
    const audit = await db.admin.query(`SELECT actor_id, changes FROM eureka.audit_event WHERE action = 'interview.updated' AND entity_id = $1 ORDER BY seq`, [id]);
    expect(audit.rows.map((a) => a.changes)).toEqual([{ cleared: true, systemName: "PC-4", callStatus: "completed" }, { cleared: false }]);
  });

  it("coach reads coached interviews and adds coach feedback; cannot edit", async () => {
    const t2 = seed.interviews.find((i) => i.teamId === T.t2)!;
    const t1 = seed.interviews.find((i) => i.teamId === T.t1 && i.candidate.teamId === T.t1)!;
    expect((await call("coach", "GET", `/api/v1/interviews/${t2.id}`)).json().feedbackKinds).toEqual(["coach"]);
    expect((await call("coach", "PATCH", `/api/v1/interviews/${t2.id}`, { cleared: true })).statusCode).toBe(403);
    const fb = await call("coach", "POST", `/api/v1/interviews/${t2.id}/feedback`, { notes: "Needs work on system design" });
    expect(fb.statusCode).toBe(201);
    expect(fb.json().kind).toBe("coach");
    expect((await call("coach", "POST", `/api/v1/interviews/${t1.id}/feedback`, { rating: 4 })).statusCode).toBe(404);
    expect((await call("coach", "POST", `/api/v1/interviews/${t2.id}/feedback`, { rating: 4, kind: "location" })).json().detail).toBe("kind_not_permitted");
    expect((await call("coach", "POST", `/api/v1/interviews/${t2.id}/feedback`, { kind: "coach" })).statusCode).toBe(422);
    expect((await call("coach", "POST", `/api/v1/interviews/${t2.id}/feedback`, { rating: 9 })).statusCode).toBe(422);
    expect((await call("coach", "POST", `/api/v1/interviews/${t2.id}/feedback`, { rating: 2, kind: "candidate" })).statusCode).toBe(422);
    const list = (await call("r2a", "GET", `/api/v1/interviews/${t2.id}/feedback`)).json().items;
    expect(list.some((f: { kind: string; author: { id: string } }) => f.kind === "coach" && f.author.id === U.coach)).toBe(true);
    const audit = await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'interview.feedback.created' AND entity_id = $1`, [fb.json().id]);
    expect(audit.rows[0].changes).toEqual({ interviewId: t2.id, kind: "coach", rating: null });
  });

  it("recruiters record client feedback, location admins location feedback", async () => {
    const i = seed.interviews.find((x) => x.recruiterId === U.r1a && x.locationId === LOC.dallas)!;
    expect((await call("r1a", "POST", `/api/v1/interviews/${i.id}/feedback`, { rating: 5 })).json().kind).toBe("client");
    expect((await call("locD", "POST", `/api/v1/interviews/${i.id}/feedback`, { rating: 4, notes: "Good" })).json().kind).toBe("location");
  });
});
