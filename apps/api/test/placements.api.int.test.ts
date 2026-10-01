import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PLACEMENT_STATUSES,
  SUBMISSION_STATUSES,
  activityVisible,
  can,
  candidateVisible,
  ownsActivity,
  ownsCandidate,
  resolveScope,
  type ActivityRef,
  type Permission,
} from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { newCandidate, selectedSubmission } from "./placement-seed.js";
import { seedPipeline, type PipelineSeed } from "./pipeline-seed.js";

/** API checks for docs/placements-api.md (placements, lookups, per-record actions). */
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

type Method = "GET" | "POST" | "PATCH" | "PUT";
async function call(key: Key, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers },
  });
}

let keyNo = 0;
const idemKey = () => `test-key-${++keyNo}-${Date.now()}`;
const post = (key: Key, body: unknown, idem: string | null = idemKey()) =>
  call(key, "POST", "/api/v1/placements", body, idem === null ? {} : { "idempotency-key": idem });
const body = (submissionId: string, extra: Record<string, unknown> = {}) => ({
  submissionId, placementType: "w2", rate: 62.5, workMode: "hybrid", projectCity: "Dallas", projectState: "TX",
  tentativeStart: "2031-02-02",
  contacts: [{ kind: "invoicing_poc", name: "Ina Voice", email: "ina@vendor.example", phone: "+14695550199" }],
  ...extra,
});

/** Superuser write with triggers off (test setup and reverting probe writes only). */
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

async function getAll(key: Key, path: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const res = await call(key, "GET", `${path}${sep}limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as { items: Record<string, unknown>[]; nextCursor: string | null };
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

type Made = ActivityRef & { id: string; submissionId: string; candidate: FixtureCandidate };
const made: Made[] = [];

/** Placements created through the API by their actors, across teams (for differential checks). */
async function makePlacements() {
  const plan: { actor: Key; cand: Parameters<typeof newCandidate>[1] }[] = [
    { actor: "r1a", cand: { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas } },
    { actor: "r1b", cand: { teamId: T.t1, recruiterId: U.r1b, locationId: LOC.austin } },
    { actor: "l1", cand: { teamId: T.t1, recruiterId: null, locationId: LOC.austin } },
    { actor: "r2a", cand: { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.dallas } },
    { actor: "r2a", cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin, visibility: "all_teams" } },
    { actor: "r3a", cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas } },
  ];
  for (const { actor, cand } of plan) {
    const c = await newCandidate(db, cand);
    const sub = await selectedSubmission(db, U[actor], c.id);
    const res = await post(actor, body(sub));
    expect(res.statusCode, res.body).toBe(201);
    const s = (await db.admin.query(`SELECT recruiter_id, team_id, location_id FROM eureka.submission WHERE id = $1`, [sub])).rows[0];
    made.push({ id: res.json().id, submissionId: sub, recruiterId: s.recruiter_id, teamId: s.team_id, locationId: s.location_id,
      candidate: { ...c, marketingStatus: "confirmation" } });
  }
}

describe("lookups", () => {
  beforeAll(async () => {
    await db.admin.query(`INSERT INTO eureka.vendor (name) VALUES ('Acme Staffing')`);
    await db.admin.query(`INSERT INTO eureka.implementation_partner (name) VALUES ('Prime IP')`);
    await db.admin.query(`INSERT INTO eureka.technology (name, active) VALUES ('Cobol', false)`);
  });

  it.each(users)("any signed-in user gets the picker lists (%s)", async (key) => {
    const res = await call(key, "GET", "/api/v1/lookups");
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json();
    expect(Object.keys(j).sort()).toEqual(["clients", "coaches", "implementationPartners", "locations", "technologies", "vendors"]);
    for (const list of Object.values(j) as { id: string; name: string }[][]) {
      for (const item of list) expect(Object.keys(item).sort()).toEqual(["id", "name"]);
    }
    expect(j.technologies.map((t: { name: string }) => t.name)).toEqual(["Java"]); // inactive Cobol hidden
    expect(j.locations.map((l: { id: string }) => l.id).sort()).toEqual([LOC.austin, LOC.dallas].sort());
    expect(j.coaches).toEqual([{ id: U.coach, name: "coach" }]);
    expect(j.vendors.map((v: { name: string }) => v.name)).toContain("Acme Staffing");
    expect(j.implementationPartners.map((v: { name: string }) => v.name)).toEqual(["Prime IP"]);
  });

  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/lookups" })).statusCode).toBe(401);
  });
});

describe("per-record actions match what the server allows (candidates)", () => {
  const TARGETS = ["active", "on_hold", "stopped", "full_of_interviews", "confirmation", "terminated"];

  /** One readable candidate per (status, updatable by the user or not). */
  function sample(key: Key): FixtureCandidate[] {
    const access = toUserAccess(key);
    const scope = resolveScope(access, "candidate:read");
    const update = resolveScope(access, "candidate:update");
    const seen = new Set<string>();
    return candidates.filter((c) => {
      if (!candidateVisible(scope, c)) return false;
      const k = `${c.marketingStatus}|${update !== null && ownsCandidate(update, c)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  it.each(users.filter((u) => can(toUserAccess(u), "candidate:read")))("%s", async (key) => {
    let checked = 0;
    for (const cand of sample(key)) {
      const res = await call(key, "GET", `/api/v1/candidates/${cand.id}`);
      expect(res.statusCode, res.body).toBe(200);
      const actions = res.json().actions as { edit: boolean; transition: string[]; visibility: boolean; rating: boolean; logSubmission: boolean };
      expect(Object.keys(actions).sort()).toEqual(["edit", "logSubmission", "rating", "transition", "visibility"]);
      for (const to of TARGETS) {
        const r = await call(key, "POST", `/api/v1/candidates/${cand.id}/transition`, { to });
        const ok = actions.transition.includes(to);
        expect(r.statusCode === 201, `${key} ${cand.marketingStatus}->${to} ${r.body}`).toBe(ok);
        if (ok) {
          await force(`UPDATE eureka.candidate SET marketing_status = $2, bench_since = NULL WHERE id = $1`, [cand.id, cand.marketingStatus]);
          checked++;
        }
      }
      const edit = await call(key, "PATCH", `/api/v1/candidates/${cand.id}`, { priority: "P2" });
      expect(edit.statusCode < 300, `${key} edit ${edit.body}`).toBe(actions.edit);
      const vis = await call(key, "PUT", `/api/v1/candidates/${cand.id}/visibility`, { visibility: cand.visibility });
      expect(vis.statusCode < 300, `${key} visibility ${vis.body}`).toBe(actions.visibility);
      const rating = await call(key, "PUT", `/api/v1/candidates/${cand.id}/technical-rating`, { rating: 3 });
      expect(rating.statusCode < 300, `${key} rating ${rating.body}`).toBe(actions.rating);
      const sub = await call(key, "POST", "/api/v1/submissions", { candidateId: cand.id, jobTitle: "Probe", clientId: CLIENT_ID });
      expect(sub.statusCode < 300, `${key} logSubmission ${sub.body}`).toBe(actions.logSubmission);
      if (sub.statusCode < 300) await force(`DELETE FROM eureka.submission WHERE id = $1`, [sub.json().id]);
    }
    if (can(toUserAccess(key), "candidate:update")) expect(checked).toBeGreaterThan(0);
  });
});

describe("per-record actions match what the server allows (submissions)", () => {
  let hour = 9000;
  const at = (h: number) => new Date(Date.parse("2032-01-05T10:00:00Z") + h * 3_600_000).toISOString();

  it.each(users.filter((u) => can(toUserAccess(u), "submission:read")))("%s", async (key) => {
    const items = (await getAll(key, "/api/v1/submissions")).filter((i) => seed.submissions.some((s) => s.id === i.id)).slice(0, 6);
    let allowed = 0;
    for (const item of items) {
      const id = item.id as string;
      const actions = item.actions as { transition: string[]; createInterview: boolean; createPlacement: boolean };
      expect(Object.keys(actions).sort()).toEqual(["createInterview", "createPlacement", "transition"]);
      for (const to of SUBMISSION_STATUSES) {
        const r = await call(key, "PATCH", `/api/v1/submissions/${id}/status`, { to, ...(to === "rejected" ? { rejectionReason: "Probe" } : {}) });
        const ok = actions.transition.includes(to);
        expect(r.statusCode === 200, `${key} ${item.status}->${to} ${r.body}`).toBe(ok);
        if (ok) {
          allowed++;
          await force(`UPDATE eureka.submission SET status = $2, rejection_reason = NULL, status_changed_at = NULL, status_changed_by = NULL WHERE id = $1`,
            [id, item.status]);
        }
      }
      hour += 2;
      const iv = await call(key, "POST", "/api/v1/interviews", { submissionId: id, round: "Probe", startsAt: at(hour), endsAt: at(hour + 1) });
      expect(iv.statusCode < 300, `${key} createInterview ${iv.body}`).toBe(actions.createInterview);
      if (iv.statusCode < 300) await force(`DELETE FROM eureka.interview WHERE id = $1`, [iv.json().id]);
      expect(actions.createPlacement).toBe(false); // seeded submissions are not selected
    }
    if (can(toUserAccess(key), "submission:update")) expect(allowed).toBeGreaterThan(0);
  });

  it("createPlacement is true exactly when POST /placements succeeds", async () => {
    // Selected submissions across the matrix: own, lead-made for unassigned, Open-to-all-teams, other team.
    const subs: string[] = [];
    for (const [actor, cand] of [
      [U.r1a, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas }],
      [U.l1, { teamId: T.t1, recruiterId: null, locationId: LOC.dallas }],
      [U.r2a, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas, visibility: "all_teams" as const }],
      [U.r3a, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin, marketingStatus: "full_of_interviews" }],
    ] as const) {
      const c = await newCandidate(db, cand);
      subs.push(await selectedSubmission(db, actor, c.id));
    }
    // And one whose candidate is no longer available.
    const held = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.austin });
    const heldSub = await selectedSubmission(db, U.r1a, held.id);
    await force(`UPDATE eureka.candidate SET marketing_status = 'on_hold' WHERE id = $1`, [held.id]);
    subs.push(heldSub);

    let successes = 0;
    for (const key of users) {
      if (!can(toUserAccess(key), "submission:read")) continue;
      for (const id of subs) {
        const res = await call(key, "GET", `/api/v1/submissions/${id}`);
        if (res.statusCode === 404) continue;
        const flag = res.json().actions.createPlacement as boolean;
        const p = await post(key, body(id));
        expect(p.statusCode === 201, `${key} ${id} ${p.body}`).toBe(flag);
        if (p.statusCode === 201) {
          successes++;
          const pid = p.json().id as string;
          const cand = (await db.admin.query(`SELECT candidate_id FROM eureka.submission WHERE id = $1`, [id])).rows[0].candidate_id;
          const prior = id === subs[3] ? "full_of_interviews" : "active";
          await force(`DELETE FROM eureka.placement_contact WHERE placement_id = $1`, [pid]);
          await force(`DELETE FROM eureka.outbox_event WHERE aggregate_id = $1`, [pid]);
          await force(`DELETE FROM eureka.placement WHERE id = $1`, [pid]);
          await force(`UPDATE eureka.candidate SET marketing_status = $2 WHERE id = $1`, [cand, prior]);
        }
      }
    }
    expect(successes).toBeGreaterThan(5);
  });
});

describe("placements", () => {
  beforeAll(async () => {
    await makePlacements();
  }, 60_000);

  const sample = () => made[0]!;

  describe("authorization matrix (generated from the catalog)", () => {
    const endpoints: { perm: Permission; method: Method; url: () => string; body?: unknown; idem?: boolean }[] = [
      { perm: "placement:read", method: "GET", url: () => "/api/v1/placements" },
      { perm: "placement:read", method: "GET", url: () => `/api/v1/placements/${sample().id}` },
      { perm: "placement:create", method: "POST", url: () => "/api/v1/placements", body: {}, idem: true },
      { perm: "placement:update", method: "PATCH", url: () => `/api/v1/placements/${sample().id}/status`, body: { to: "bogus" } },
    ];
    const cases = users.flatMap((u) => endpoints.map((e, i) => [u, `${e.method} #${i} ${e.perm}`, e] as const));
    it.each(cases)("%s → %s", async (key, _name, e) => {
      const res = await call(key, e.method, e.url(), e.body, e.idem ? { "idempotency-key": idemKey() } : {});
      if (can(toUserAccess(key), e.perm)) expect(res.statusCode, res.body).not.toBe(403);
      else expect(res.statusCode, res.body).toBe(403);
    });
  });

  describe("lists and details (differential with the engine)", () => {
    it.each(users)("%s", async (key) => {
      const access = toUserAccess(key);
      const scope = resolveScope(access, "placement:read");
      if (!scope) { expect((await call(key, "GET", "/api/v1/placements")).statusCode).toBe(403); return; }
      const ids = new Set(made.map((m) => m.id));
      const items = (await getAll(key, "/api/v1/placements")).filter((i) => ids.has(i.id as string));
      expect(items.map((i) => i.id).sort()).toEqual(made.filter((m) => activityVisible(scope, m)).map((m) => m.id).sort());
      const rateScope = resolveScope(access, "rate:read");
      for (const item of items) {
        const m = made.find((x) => x.id === item.id)!;
        // PL-6: rate only where rate:read covers the actor snapshot.
        expect("rate" in item, `${key} rate`).toBe(ownsActivity(rateScope, m));
        if ("rate" in item) expect(item.rate).toBe(62.5);
        // allowedTransitions oracle from the catalog (independent of the service).
        const upd = ownsActivity(resolveScope(access, "placement:update"), m);
        const bgc = ownsActivity(resolveScope(access, "placement.bgc_status:update"), m);
        const expected = !upd ? [] : ["paperwork", "backout", ...(bgc ? ["bgc_failed"] : [])];
        expect([...(item.allowedTransitions as string[])].sort(), `${key} transitions`).toEqual(expected.sort());
      }
      for (const m of made) {
        const res = await call(key, "GET", `/api/v1/placements/${m.id}`);
        expect(res.statusCode, `${key} ${m.id}`).toBe(activityVisible(scope, m) ? 200 : 404);
      }
    });

    it("detail carries the documented shape, contacts and (after joining) the assignment", async () => {
      const m = made.find((x) => x.recruiterId === U.r1a)!;
      const res = await call("m1", "GET", `/api/v1/placements/${m.id}`);
      expect(res.statusCode).toBe(200);
      const p = res.json();
      expect(Object.keys(p).sort()).toEqual([
        "allowedTransitions", "assignment", "candidate", "client", "contacts", "createdAt", "id", "implementationPartner",
        "isFirstPlacement", "location", "placementType", "projectCity", "projectState", "rate", "recruiter", "status",
        "statusChangedAt", "submissionId", "team", "tentativeStart", "vendor", "workMode",
      ]);
      expect(p).toMatchObject({
        id: m.id, status: "confirmed", placementType: "w2", workMode: "hybrid", projectCity: "Dallas", projectState: "TX",
        tentativeStart: "2031-02-02", isFirstPlacement: true, rate: 62.5, submissionId: m.submissionId,
        recruiter: { id: U.r1a, name: "r1a" }, team: { id: T.t1, name: "Team Rohit" }, location: { id: LOC.dallas, name: "Dallas" },
        vendor: null, implementationPartner: null, assignment: null, statusChangedAt: null,
      });
      expect(p.candidate.id).toBe(m.candidate.id);
      expect(p.candidate.name).toMatch(/^PlCand\d+ Placed$/);
      expect(p.contacts).toEqual([{ id: expect.any(String), kind: "invoicing_poc", name: "Ina Voice", email: "ina@vendor.example", phone: "+14695550199" }]);
    });
  });

  describe("row-level outcomes per user (404 / 403 / 422)", () => {
    it.each(users)("%s", async (key) => {
      const access = toUserAccess(key);
      if (!can(access, "placement:update")) return;
      for (const m of made) {
        // confirmed -> joined is never valid, so an authorized caller gets 422 and nothing changes.
        const res = await call(key, "PATCH", `/api/v1/placements/${m.id}/status`, { to: "joined" });
        const expected = !activityVisible(resolveScope(access, "placement:read"), m) ? 404
          : !ownsActivity(resolveScope(access, "placement:update"), m) ? 403 : 422;
        expect(res.statusCode, `${key} ${m.id} ${res.body}`).toBe(expected);
        if (expected === 422) expect(res.json().detail).toBe("invalid_transition");
      }
    });

    it.each(users.filter((u) => can(toUserAccess(u), "placement:update")))("allowedTransitions are honored by the server for %s", async (key) => {
      for (const m of made) {
        const res = await call(key, "GET", `/api/v1/placements/${m.id}`);
        if (res.statusCode !== 200) continue;
        const allowed = res.json().allowedTransitions as string[];
        for (const to of PLACEMENT_STATUSES) {
          const r = await call(key, "PATCH", `/api/v1/placements/${m.id}/status`, { to, reason: "Probe reason" });
          expect(r.statusCode === 200, `${key} confirmed->${to} ${r.body}`).toBe(allowed.includes(to));
          if (r.statusCode === 200) {
            await force(`UPDATE eureka.placement SET status = 'confirmed', status_reason = NULL, status_changed_at = NULL, status_changed_by = NULL WHERE id = $1`, [m.id]);
            await force(`UPDATE eureka.candidate SET marketing_status = 'confirmation' WHERE id = $1`, [m.candidate.id]);
          }
        }
      }
    });
  });

  describe("create", () => {
    const fresh = async (actor: Key = "r1a", upTo = "selected") => {
      const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
      return { cand: c, sub: await selectedSubmission(db, U[actor], c.id, upTo) };
    };

    it("returns 201 { id, isFirstPlacement } and moves the candidate to confirmation", async () => {
      const { cand, sub } = await fresh();
      const res = await post("r1a", body(sub));
      expect(res.statusCode, res.body).toBe(201);
      expect(Object.keys(res.json()).sort()).toEqual(["id", "isFirstPlacement"]);
      expect(res.json().isFirstPlacement).toBe(true);
      const c = await call("r1a", "GET", `/api/v1/candidates/${cand.id}`);
      expect(c.json().status).toBe("confirmation");
      // The placement drives the candidate now: no manual transitions offered or allowed.
      expect(c.json().actions.transition).toEqual([]);
      const t = await call("r1a", "POST", `/api/v1/candidates/${cand.id}/transition`, { to: "active" });
      expect([t.statusCode, t.json().detail]).toEqual([422, "placement_open"]);
    });

    it("Idempotency-Key: required, replayed for the same body, refused for a different body", async () => {
      const { sub } = await fresh();
      const missing = await post("r1a", body(sub), null);
      expect([missing.statusCode, missing.json().detail]).toEqual([400, "idempotency_key_required"]);
      const bad = await post("r1a", body(sub), "has spaces in it");
      expect([bad.statusCode, bad.json().detail]).toEqual([400, "idempotency_key_required"]);

      const key = idemKey();
      const first = await post("r1a", body(sub), key);
      expect(first.statusCode).toBe(201);
      // Same body with keys in another order: same response, no second placement.
      const reordered = Object.fromEntries(Object.entries(body(sub)).reverse());
      const again = await post("r1a", reordered, key);
      expect([again.statusCode, again.json()]).toEqual([201, first.json()]);
      const n = await db.admin.query(`SELECT count(*)::int AS n FROM eureka.placement WHERE submission_id = $1`, [sub]);
      expect(n.rows[0].n).toBe(1);
      const other = await post("r1a", body(sub, { rate: 70 }), key);
      expect([other.statusCode, other.json().detail]).toEqual([409, "idempotency_key_reused"]);
      // Keys are per user: the lead reusing it is a new request (and the placement exists).
      const lead = await post("l1", body(sub), key);
      expect([lead.statusCode, lead.json().detail]).toEqual([409, "placement_exists"]);
      // A new key on the same submission is a new request.
      const dup = await post("r1a", body(sub));
      expect([dup.statusCode, dup.json().detail]).toEqual([409, "placement_exists"]);
    });

    it("a failed request does not consume its key", async () => {
      const { sub } = await fresh("r1a", "interview_completed");
      const key = idemKey();
      const r = await post("r1a", body(sub), key);
      expect([r.statusCode, r.json().detail]).toEqual([422, "submission_not_selected"]);
      await force(`UPDATE eureka.submission SET status = 'selected' WHERE id = $1`, [sub]);
      expect((await post("r1a", body(sub), key)).statusCode).toBe(201);
    });

    it.each([
      ["status", { status: "joined" }],
      ["isFirstPlacement", { isFirstPlacement: false }],
      ["recruiterId", { recruiterId: U.r1b }],
      ["teamId", { teamId: T.t2 }],
      ["candidateId", { candidateId: "00000000-0000-4000-8000-000000000001" }],
      ["locationId", { locationId: LOC.austin }],
      ["createdAt", { createdAt: "2020-01-01T00:00:00Z" }],
    ])("mass assignment of %s is refused with 422", async (_n, extra) => {
      const { sub } = await fresh();
      const res = await post("r1a", body(sub, extra));
      expect(res.statusCode, res.body).toBe(422);
      expect((await db.admin.query(`SELECT 1 FROM eureka.placement WHERE submission_id = $1`, [sub])).rowCount).toBe(0);
    });

    it.each([
      ["a bad type", { placementType: "fte" }],
      ["a zero rate", { rate: 0 }],
      ["an absurd rate", { rate: 100000 }],
      ["a bad date", { tentativeStart: "2031-13-01" }],
      ["a bad work mode", { workMode: "moon" }],
      ["a bad contact email", { contacts: [{ kind: "vendor_poc", name: "A", email: "nope" }] }],
      ["a bad contact phone", { contacts: [{ kind: "vendor_poc", name: "A", phone: "12" }] }],
      ["an unknown contact field", { contacts: [{ kind: "vendor_poc", name: "A", ssn: "x" }] }],
      ["too many contacts", { contacts: Array(11).fill({ kind: "vendor_poc", name: "A" }) }],
      ["an unknown implementation partner", { implementationPartnerId: "00000000-0000-4000-8000-000000000009" }],
    ])("validation: %s → 422", async (_n, extra) => {
      const { sub } = await fresh();
      expect((await post("r1a", body(sub, extra))).statusCode).toBe(422);
    });

    it("error codes: 404 invisible, 403 not placeable, 422 not selected / candidate unavailable", async () => {
      const { sub } = await fresh();
      expect((await post("r1b", body(sub))).statusCode).toBe(404); // own scope only
      expect((await post("r3a", body(sub))).statusCode).toBe(404);
      const loc = await post("locD", body(sub));
      expect(loc.statusCode).toBe(403); // RequirePermission: no placement:create
      const { sub: early } = await fresh("r1a", "interview_completed");
      const r = await post("r1a", body(early));
      expect([r.statusCode, r.json().detail]).toEqual([422, "submission_not_selected"]);
      const { cand, sub: held } = await fresh();
      await force(`UPDATE eureka.candidate SET marketing_status = 'on_hold' WHERE id = $1`, [cand.id]);
      const h = await post("r1a", body(held));
      expect([h.statusCode, h.json().detail]).toEqual([422, "candidate_not_available"]);
    });

    it("audit never contains rates or contact details (PL-6, PL-9)", async () => {
      const { sub } = await fresh();
      const res = await post("r1a", body(sub));
      const id = res.json().id as string;
      await call("r1a", "PATCH", `/api/v1/placements/${id}/status`, { to: "paperwork" });
      await call("r1a", "PATCH", `/api/v1/placements/${id}/status`, { to: "backout", reason: "Took another offer at 99/hr" });
      const { rows } = await db.admin.query(`SELECT action, changes FROM eureka.audit_event WHERE entity_id = $1 ORDER BY seq`, [id]);
      expect(rows.map((r) => r.action)).toEqual(["placement.created", "placement.status", "placement.status"]);
      const text = JSON.stringify(rows);
      expect(text).not.toMatch(/62\.5|ina@|4695550199|Ina Voice|99\/hr/);
      expect(rows[2].changes).toEqual({ from: "paperwork", to: "backout", reasonGiven: true });
    });
  });

  describe("status changes", () => {
    const placed = async () => {
      const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
      const sub = await selectedSubmission(db, U.r1a, c.id);
      const res = await post("r1a", body(sub));
      return { cand: c, id: res.json().id as string };
    };
    const move = (key: Key, id: string, to: string, reason?: string) =>
      call(key, "PATCH", `/api/v1/placements/${id}/status`, { to, ...(reason !== undefined ? { reason } : {}) });

    it("walks to joined; the assignment and candidate follow; bgc_failed after joining benches", async () => {
      const { cand, id } = await placed();
      for (const to of ["paperwork", "bgc", "ready", "joined"]) {
        const r = await move("r1a", id, to);
        expect([r.statusCode, r.json()]).toEqual([200, { id, status: to }]);
      }
      const p = (await call("r1a", "GET", `/api/v1/placements/${id}`)).json();
      expect(p.assignment).toMatchObject({ assignmentNo: 1, endDate: null, endReason: null });
      expect(p.assignment.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.allowedTransitions).toEqual([]); // r1a lacks placement.bgc_status:update
      expect((await call("m1", "GET", `/api/v1/placements/${id}`)).json().allowedTransitions).toEqual(["bgc_failed"]);
      expect((await call("r1a", "GET", `/api/v1/candidates/${cand.id}`)).json().status).toBe("placed");
      const denied = await move("r1a", id, "bgc_failed", "x");
      expect(denied.statusCode).toBe(403);
      const noReason = await move("m1", id, "bgc_failed");
      expect([noReason.statusCode, noReason.json().detail]).toEqual([422, "reason_required"]);
      expect((await move("m1", id, "bgc_failed", "Adverse report")).statusCode).toBe(200);
      const after = (await call("m1", "GET", `/api/v1/placements/${id}`)).json();
      expect(after.assignment).toMatchObject({ assignmentNo: 1, endReason: "bgc_failed" });
      expect((await call("m1", "GET", `/api/v1/candidates/${cand.id}`)).json().status).toBe("bench");
      const ev = await db.admin.query(`SELECT type FROM eureka.outbox_event WHERE aggregate_id = $1`, [id]);
      expect(ev.rows.map((r) => r.type).sort()).toEqual(["placement.created", ...Array(5).fill("placement.state_changed")]);
    });

    it("skips, NULLs and unknown targets are refused", async () => {
      const { id } = await placed();
      expect((await move("r1a", id, "bgc")).json().detail).toBe("invalid_transition");
      expect((await move("r1a", id, "joined")).json().detail).toBe("invalid_transition");
      expect((await call("r1a", "PATCH", `/api/v1/placements/${id}/status`, { to: null })).statusCode).toBe(422);
      expect((await call("r1a", "PATCH", `/api/v1/placements/${id}/status`, {})).statusCode).toBe(422);
      expect((await move("r1a", id, "hired")).statusCode).toBe(422);
      expect((await call("r1a", "PATCH", `/api/v1/placements/${id}/status`, { to: "paperwork", by: U.ceo })).statusCode).toBe(422);
      const blank = await move("r1a", id, "backout", "   ");
      expect([blank.statusCode, blank.json().detail]).toEqual([422, "reason_required"]);
      expect((await move("r1a", id, "backout", "Declined")).statusCode).toBe(200);
      expect((await move("r1a", id, "paperwork")).json().detail).toBe("invalid_transition");
    });

    it("filters by status, candidate and recruiter; pagination is stable", async () => {
      const byStatus = await getAll("ad", "/api/v1/placements?status=confirmed");
      expect(byStatus.length).toBeGreaterThan(0);
      expect(byStatus.every((p) => p.status === "confirmed")).toBe(true);
      const m = made[3]!;
      const byCand = (await call("ad", "GET", `/api/v1/placements?candidateId=${m.candidate.id}`)).json().items;
      expect(byCand.map((p: { id: string }) => p.id)).toEqual([m.id]);
      const byRec = await getAll("ad", `/api/v1/placements?recruiterId=${U.r1b}`);
      expect(byRec.every((p) => (p.recruiter as { id: string }).id === U.r1b)).toBe(true);
      expect((await call("ad", "GET", "/api/v1/placements?from=2000-01-01&to=2000-01-02")).json().items).toEqual([]);
      expect((await call("ad", "GET", "/api/v1/placements?status=nope")).statusCode).toBe(422);
      const all = (await call("ad", "GET", "/api/v1/placements?limit=200")).json().items.map((i: { id: string }) => i.id);
      expect((await getAll("ad", "/api/v1/placements")).map((i) => i.id)).toEqual(all);
    });
  });
});
