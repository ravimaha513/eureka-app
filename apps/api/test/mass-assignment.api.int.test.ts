import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { RequestMethod, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule, createApp } from "../src/app.module.js";
import { loadConfig, type AppConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, TECH_ID, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Mass-assignment tests for every write endpoint (implementation plan, Phase 2;
 * HANDOFF rule 4). For each POST/PUT/PATCH route the request carries, one at a
 * time, server-managed or foreign fields (ids, status, owner/recruiter/team/location
 * snapshots, timestamps, row_version, audit and scope fields) on top of an
 * otherwise valid body, and must be refused with 422 by the strict schema
 * (the only issue reported is that unknown key) while the database is unchanged
 * (the rows the endpoint writes, and the audit log). Endpoints that take no body
 * ignore it: the effect is checked to come from the URL and the session only.
 *
 * The route list is read from the controllers registered in AppModule, so a new
 * write endpoint without a case here fails the coverage test.
 */

let db: TestDb;
let app: NestFastifyApplication;
let config: AppConfig;
let candidates: FixtureCandidate[];

type Key = keyof typeof U;
type Method = "POST" | "PUT" | "PATCH";

const FOREIGN_ID = "00000000-0000-4000-8000-0000000000ff";
const PAST = "2020-01-01T00:00:00Z";
/** Server-managed on every table: never accepted from a client. */
const SERVER_MANAGED: Record<string, unknown> = {
  id: FOREIGN_ID, createdAt: PAST, updatedAt: PAST, rowVersion: 99, createdBy: U.admin, updatedBy: U.admin, accessVersion: 99,
};

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  config = loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  });
  app = await createApp(config);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---- helpers ------------------------------------------------------------------------------------

type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();
async function login(key: Key, fresh = false): Promise<Session> {
  const cached = sessions.get(key);
  if (cached && !fresh) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  if (!fresh) sessions.set(key, s);
  return s;
}
async function call(key: Key | null, method: "GET" | Method, url: string, payload?: unknown, headers: Record<string, string> = {}, session?: Session) {
  const s = session ?? (key ? await login(key) : null);
  return app.inject({
    method, url, payload: payload as never,
    headers: { ...(s ? { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } : {}), ...headers },
  });
}
async function ok(key: Key, method: Method, url: string, payload: unknown, status = 201) {
  const r = await call(key, method, url, payload);
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(status);
  return r.body ? r.json() : undefined;
}
const rows = async (sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows;
/** The audit log must not move on a refused request. */
const auditHead = async () => (await rows(`SELECT coalesce(max(seq), 0)::text AS seq FROM eureka.audit_event`))[0]!.seq as string;

const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.marketingStatus === "active" && c.visibility === "team" && c.locationId === LOC.dallas)!;

let n = 0;
/** A fresh candidate owned by r1a (as superuser), so writes on it never collide with other cases. */
const freshOwn = () => newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });

/** A staged import batch with one sales row (as the import CLI would open it with an admin's ticket). */
async function importBatch(): Promise<string> {
  const ticket = (await ok("admin", "POST", "/api/v1/imports/tickets", {})).ticket as string;
  const id = (await rows(`SELECT authz.import_open_batch($1, md5(random()::text) || md5(random()::text), '{}', false) AS id`, [ticket]))[0]!.id as string;
  await rows(`INSERT INTO eureka.import_row (batch_id, sheet, row_no, row_key, raw, norm, state, reasons)
              VALUES ($1, 'sales', 2, md5(random()::text) || md5(random()::text), '{}', '{}', 'review', '{missing:name}')`, [id]);
  return id;
}

/** An interview on r1a's fresh candidate through the API; `hoursAgo` places it in the past. */
async function interviewOf(hoursAgo = -24) {
  const cand = await freshOwn();
  const sub = await ok("r1a", "POST", "/api/v1/submissions", { candidateId: cand.id, clientId: CLIENT_ID, jobTitle: `MA ${++n}` });
  const startsAt = new Date(Date.now() - hoursAgo * 3_600_000);
  const endsAt = new Date(startsAt.getTime() + 3_600_000);
  const int = await ok("r1a", "POST", "/api/v1/interviews", { submissionId: sub.id, round: "L1", startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
  return { candidateId: cand.id, submissionId: sub.id as string, interviewId: int.id as string };
}

// ---- cases --------------------------------------------------------------------------------------

interface Prepared {
  url: string;
  /** A body the endpoint accepts (by schema) when sent alone. */
  body: Record<string, unknown>;
  /** The rows the endpoint writes; must be identical before and after a refused request. */
  state: () => Promise<unknown>;
  headers?: Record<string, string>;
}
interface RejectCase {
  /** "METHOD /path" exactly as the controllers declare it. */
  route: string;
  actor: Key | null;
  prepare: () => Promise<Prepared>;
  /** Foreign and server-managed fields for this endpoint (SERVER_MANAGED is always added). */
  forbidden: Record<string, unknown>;
  /** Fields the schema knows but this caller may not set: refused by the service with 422 `detail`. */
  notPermitted?: { fields: Record<string, unknown>; detail: RegExp };
}

const CASES: RejectCase[] = [
  // identity
  {
    route: "POST /api/auth/dev-login", actor: null,
    prepare: async () => ({
      url: "/api/auth/dev-login", body: { email: "r1a@eureka.example" },
      state: () => rows(`SELECT count(*)::int AS n FROM eureka.session`),
    }),
    forbidden: { userId: U.admin, roles: ["org_admin"], sessionId: "x", expiresAt: "2099-01-01T00:00:00Z", authTime: PAST },
  },
  // admin (docs/admin-api.md)
  {
    route: "POST /api/v1/admin/users", actor: "admin",
    prepare: async () => ({
      url: "/api/v1/admin/users", body: { email: "ma-new@eureka.example", displayName: "MA New" },
      state: () => rows(`SELECT count(*)::int AS n FROM eureka.app_user`),
    }),
    forbidden: { status: "inactive", googleSub: "sub-1", roles: ["org_admin"], managerId: U.m1, teamId: T.t1 },
  },
  {
    route: "PUT /api/v1/admin/users/:id/manager", actor: "admin",
    prepare: async () => ({
      url: `/api/v1/admin/users/${U.r1b}/manager`, body: { managerId: U.l2 },
      state: () => rows(`SELECT * FROM eureka.reporting_line ORDER BY user_id`),
    }),
    forbidden: { userId: U.r2a, valid: false },
  },
  {
    route: "POST /api/v1/admin/role-requests", actor: "admin",
    prepare: async () => ({
      url: "/api/v1/admin/role-requests", body: { userId: U.r2a, role: "hr" },
      state: () => rows(`SELECT (SELECT count(*) FROM eureka.role_request)::int AS requests, (SELECT count(*) FROM eureka.user_role)::int AS roles`),
    }),
    forbidden: { status: "approved", requestedBy: U.admin2, decidedBy: U.admin2, decidedAt: PAST, approvedBy: U.admin2, expiresAt: "2099-01-01T00:00:00Z" },
  },
  {
    route: "POST /api/v1/admin/teams", actor: "admin",
    prepare: async () => ({
      url: "/api/v1/admin/teams", body: { name: "MA Team", leadId: U.l3 },
      state: () => rows(`SELECT (SELECT count(*) FROM eureka.team)::int AS teams, (SELECT count(*) FROM eureka.team_member)::int AS members`),
    }),
    forbidden: { members: [U.r1a], status: "active" },
  },
  {
    route: "PUT /api/v1/admin/teams/:id/lead", actor: "admin",
    prepare: async () => ({
      url: `/api/v1/admin/teams/${T.t2}/lead`, body: { leadId: U.l1 },
      state: () => rows(`SELECT * FROM eureka.team ORDER BY id`),
    }),
    forbidden: { teamId: T.t3, name: "Renamed", locationId: LOC.austin, members: [U.r1a] },
  },
  {
    route: "POST /api/v1/admin/teams/:id/members", actor: "admin",
    prepare: async () => ({
      url: `/api/v1/admin/teams/${T.t2}/members`, body: { userId: U.r3a },
      state: () => rows(`SELECT * FROM eureka.team_member ORDER BY team_id, user_id`),
    }),
    forbidden: { teamId: T.t3, valid: false, role: "lead" },
  },
  {
    route: "POST /api/v1/teams/:id/move-member", actor: "m1",
    prepare: async () => ({
      url: `/api/v1/teams/${T.t1}/move-member`, body: { userId: U.r1b, toTeamId: T.t2 },
      state: () => rows(`SELECT (SELECT json_agg(m ORDER BY team_id, user_id) FROM eureka.team_member m) AS members,
                                (SELECT json_agg(json_build_object('id', id, 'team', team_id, 'recruiter', recruiter_id) ORDER BY id) FROM eureka.candidate) AS cands`),
    }),
    forbidden: { fromTeamId: T.t3, movedCandidates: 0, teamId: T.t3 },
  },
  // Hot List extras
  {
    route: "POST /api/v1/hotlist/views", actor: "r1a",
    prepare: async () => ({
      url: "/api/v1/hotlist/views", body: { name: "MA view", filters: { status: "active" } },
      state: () => rows(`SELECT count(*)::int AS n FROM eureka.hotlist_view`),
    }),
    forbidden: { ownerId: U.r1b, userId: U.r1b, owner: U.r1b },
  },
  {
    route: "PATCH /api/v1/hotlist/views/:id", actor: "r1a",
    prepare: async () => {
      const v = await ok("r1a", "POST", "/api/v1/hotlist/views", { name: `MA view ${++n}`, filters: {} });
      return {
        url: `/api/v1/hotlist/views/${v.id}`, body: { name: `MA renamed ${n}` },
        state: () => rows(`SELECT * FROM eureka.hotlist_view WHERE id = $1`, [v.id]),
      };
    },
    forbidden: { ownerId: U.r1b, userId: U.r1b },
  },
  {
    route: "POST /api/v1/hotlist/bulk/visibility", actor: "l1",
    prepare: async () => ({
      url: "/api/v1/hotlist/bulk/visibility", body: { ids: [own().id], visibility: "all_teams" },
      state: () => rows(`SELECT * FROM eureka.candidate WHERE id = $1`, [own().id]),
    }),
    forbidden: { teamId: T.t2, recruiterId: U.r2a, status: "stopped", locationId: LOC.austin },
  },
  {
    route: "POST /api/v1/hotlist/bulk/status", actor: "l1",
    prepare: async () => ({
      url: "/api/v1/hotlist/bulk/status", body: { ids: [own().id], to: "on_hold" },
      state: () => rows(`SELECT * FROM eureka.candidate WHERE id = $1`, [own().id]),
    }),
    forbidden: { teamId: T.t2, recruiterId: U.r2a, visibility: "all_teams", marketingStatus: "stopped", force: true },
  },
  {
    route: "POST /api/v1/hotlist/export", actor: "l1",
    prepare: async () => ({ url: "/api/v1/hotlist/export", body: { status: "active" }, state: async () => null }),
    forbidden: { teamId: T.t2, recruiterId: U.r2a, scope: "org", limit: 1_000_000, unmasked: true, includePhones: true },
  },
  // submissions
  {
    route: "POST /api/v1/submissions", actor: "r1a",
    prepare: async () => ({
      url: "/api/v1/submissions", body: { candidateId: own().id, clientId: CLIENT_ID, jobTitle: "MA submission" },
      state: () => rows(`SELECT count(*)::int AS n FROM eureka.submission`),
    }),
    forbidden: {
      recruiterId: U.r1b, teamId: T.t2, locationId: LOC.austin, status: "selected", submittedAt: PAST,
      statusChangedAt: PAST, statusChangedBy: U.l1, rejectionReason: "x",
    },
  },
  {
    route: "PATCH /api/v1/submissions/:id/status", actor: "r1a",
    prepare: async () => {
      const { submissionId } = await interviewOf();
      return {
        url: `/api/v1/submissions/${submissionId}/status`, body: { to: "under_review" },
        state: () => rows(`SELECT * FROM eureka.submission WHERE id = $1`, [submissionId]),
      };
    },
    forbidden: { status: "selected", recruiterId: U.r1b, teamId: T.t2, candidateId: FOREIGN_ID, statusChangedAt: PAST, statusChangedBy: U.l1, from: "selected" },
  },
  // candidate feedback (public, token-authenticated)
  {
    route: "POST /api/public/feedback/:token", actor: null,
    prepare: async () => {
      const { interviewId } = await interviewOf(3);
      const token = randomBytes(32).toString("base64url");
      const hash = createHash("sha256").update(token).digest("hex");
      const id = (await rows(`SELECT eureka.feedback_prepare($1, $2, '') AS id`, [interviewId, hash]))[0]!.id as string;
      expect(id).toBeTruthy();
      await rows(`SELECT eureka.feedback_sent($1)`, [id]);
      return {
        url: `/api/public/feedback/${token}`, body: { rating: 4 },
        state: () => rows(`SELECT d.used_at, (SELECT count(*) FROM eureka.interview_feedback f WHERE f.interview_id = d.interview_id)::int AS n
                           FROM eureka.feedback_delivery d WHERE d.id = $1`, [id]),
      };
    },
    forbidden: { interviewId: FOREIGN_ID, kind: "coach", authorId: U.coach, candidateId: FOREIGN_ID, usedAt: PAST },
  },
  // candidates
  {
    route: "POST /api/v1/candidates", actor: "r1a",
    prepare: async () => ({
      url: "/api/v1/candidates", body: { firstName: "Mass", lastName: "Assign", technologyId: TECH_ID, locationId: LOC.dallas },
      state: () => rows(`SELECT (SELECT count(*) FROM eureka.candidate)::int AS c, (SELECT count(*) FROM eureka.person)::int AS p`),
    }),
    forbidden: {
      status: "active", marketingStatus: "active", visibility: "all_teams", technicalRating: 5, priority: "P1", personId: FOREIGN_ID,
      ghLocationId: LOC.austin, benchSince: "2020-01-01", marketingStartDate: "2020-01-01", dobYear: 1990,
    },
  },
  {
    route: "POST /api/v1/candidates/duplicate-check", actor: "r1a",
    prepare: async () => ({ url: "/api/v1/candidates/duplicate-check", body: { firstName: "A", lastName: "B", phone: "+14695550001" }, state: async () => null }),
    forbidden: { teamId: T.t3, candidateId: FOREIGN_ID, scope: "org", includeHidden: true },
  },
  {
    route: "PATCH /api/v1/candidates/:id", actor: "r1a",
    prepare: async () => ({
      url: `/api/v1/candidates/${own().id}`, body: { priority: "P1" },
      state: () => rows(`SELECT * FROM eureka.candidate WHERE id = $1`, [own().id]),
    }),
    forbidden: {
      teamId: T.t2, recruiterId: U.r2a, visibility: "all_teams", technicalRating: 5, status: "stopped", marketingStatus: "stopped",
      locationId: LOC.austin, personId: FOREIGN_ID, firstName: "X", phone: "+14695559999", benchSince: "2020-01-01",
    },
  },
  {
    route: "PUT /api/v1/candidates/:id/visibility", actor: "l1",
    prepare: async () => ({
      url: `/api/v1/candidates/${own().id}/visibility`, body: { visibility: "all_teams" },
      state: () => rows(`SELECT * FROM eureka.candidate WHERE id = $1`, [own().id]),
    }),
    forbidden: { teamId: T.t2, recruiterId: U.r2a, candidateId: FOREIGN_ID, status: "stopped" },
  },
  {
    route: "PUT /api/v1/candidates/:id/technical-rating", actor: "locD",
    prepare: async () => ({
      url: `/api/v1/candidates/${own().id}/technical-rating`, body: { rating: 4 },
      state: () => rows(`SELECT * FROM eureka.candidate WHERE id = $1`, [own().id]),
    }),
    forbidden: { candidateId: FOREIGN_ID, ratedBy: U.coach, locationId: LOC.austin, priority: "P1" },
  },
  {
    route: "POST /api/v1/candidates/:id/transition", actor: "r1a",
    prepare: async () => ({
      url: `/api/v1/candidates/${own().id}/transition`, body: { to: "on_hold" },
      state: () => rows(`SELECT * FROM eureka.candidate WHERE id = $1`, [own().id]),
    }),
    forbidden: { from: "terminated", force: true, status: "terminated", teamId: T.t2, benchSince: "2020-01-01" },
  },
  {
    route: "POST /api/v1/batches", actor: "l1",
    prepare: async () => ({
      url: "/api/v1/batches", body: { locationId: LOC.dallas, technologyId: TECH_ID, startMonth: "2031-05" },
      state: () => rows(`SELECT count(*)::int AS n FROM eureka.batch`),
    }),
    forbidden: { status: "in_training", label: "X" },
  },
  {
    route: "PUT /api/v1/batches/:id/status", actor: "l1",
    prepare: async () => {
      const b = await ok("l1", "POST", "/api/v1/batches", { locationId: LOC.dallas, technologyId: TECH_ID, startMonth: `2032-${String(1 + (++n % 12)).padStart(2, "0")}` });
      return {
        url: `/api/v1/batches/${b.id}/status`, body: { to: "in_training" },
        state: () => rows(`SELECT * FROM eureka.batch WHERE id = $1`, [b.id]),
      };
    },
    forbidden: { status: "completed", startMonth: "2040-01", locationId: LOC.austin, technologyId: FOREIGN_ID, sizePlanned: 500 },
  },
  // placements (docs/placements-api.md)
  {
    route: "POST /api/v1/placements", actor: "r1a",
    prepare: async () => {
      const cand = await freshOwn();
      const sub = await selectedSubmission(db, U.r1a, cand.id);
      return {
        url: "/api/v1/placements", headers: { "idempotency-key": `ma-${++n}` },
        body: { submissionId: sub, placementType: "w2", workMode: "onsite", tentativeStart: "2031-01-05" },
        state: () => rows(`SELECT (SELECT count(*) FROM eureka.placement)::int AS placements, (SELECT count(*) FROM eureka.idempotency_key)::int AS keys,
                                  (SELECT count(*) FROM eureka.outbox_event)::int AS outbox`),
      };
    },
    forbidden: {
      status: "joined", isFirstPlacement: false, recruiterId: U.r1b, teamId: T.t2, candidateId: FOREIGN_ID, personId: FOREIGN_ID,
      locationId: LOC.austin, clientId: FOREIGN_ID, vendorId: FOREIGN_ID, statusChangedAt: PAST, joinedAt: PAST, statusReason: "x",
    },
  },
  {
    route: "PATCH /api/v1/placements/:id/status", actor: "r1a",
    prepare: async () => {
      const cand = await freshOwn();
      const sub = await selectedSubmission(db, U.r1a, cand.id);
      const p = await createPlacement(db, U.r1a, sub);
      return {
        url: `/api/v1/placements/${p.id}/status`, body: { to: "paperwork" },
        state: () => rows(`SELECT * FROM eureka.placement WHERE id = $1`, [p.id]),
      };
    },
    forbidden: { status: "joined", statusChangedAt: PAST, statusChangedBy: U.l1, joinedAt: PAST, isFirstPlacement: false, candidateId: FOREIGN_ID, rate: 999 },
  },
  // interviews
  {
    route: "POST /api/v1/interviews", actor: "r1a",
    prepare: async () => {
      const cand = await freshOwn();
      const sub = await ok("r1a", "POST", "/api/v1/submissions", { candidateId: cand.id, clientId: CLIENT_ID, jobTitle: `MA ${++n}` });
      return {
        url: "/api/v1/interviews",
        body: { submissionId: sub.id, round: "L1", startsAt: "2031-02-03T15:00:00Z", endsAt: "2031-02-03T16:00:00Z" },
        state: () => rows(`SELECT count(*)::int AS n FROM eureka.interview`),
      };
    },
    forbidden: {
      candidateId: FOREIGN_ID, recruiterId: U.r1b, teamId: T.t2, locationId: LOC.austin, clientId: FOREIGN_ID, callStatus: "completed",
      cleared: true, consentCaptured: true, clearedBy: U.locD, clearedAt: PAST, feedbackEmailSentAt: PAST, otterUrl: "https://otter.example/x",
    },
  },
  {
    route: "PATCH /api/v1/interviews/:id", actor: "r1a",
    prepare: async () => {
      const { interviewId } = await interviewOf();
      return {
        url: `/api/v1/interviews/${interviewId}`, body: { round: "L2" },
        state: () => rows(`SELECT * FROM eureka.interview WHERE id = $1`, [interviewId]),
      };
    },
    forbidden: {
      submissionId: FOREIGN_ID, candidateId: FOREIGN_ID, recruiterId: U.r1b, teamId: T.t2, locationId: LOC.austin, clientId: FOREIGN_ID,
      clearedBy: U.locD, clearedAt: PAST, feedbackEmailSentAt: PAST,
    },
    // Location fields: a recruiter's grant covers only the sales fields (design B4.7).
    notPermitted: { fields: { cleared: true, consentCaptured: true, systemName: "Zoom" }, detail: /^field_not_permitted: / },
  },
  {
    route: "POST /api/v1/interviews/:id/feedback", actor: "r1a",
    prepare: async () => {
      const { interviewId } = await interviewOf();
      return {
        url: `/api/v1/interviews/${interviewId}/feedback`, body: { notes: "Good answers." },
        state: () => rows(`SELECT count(*)::int AS n FROM eureka.interview_feedback WHERE interview_id = $1`, [interviewId]),
      };
    },
    forbidden: { authorId: U.coach, interviewId: FOREIGN_ID, format: "Video", topics: ["Java"] },
    // A recruiter writes client feedback only; coach and location feedback need those grants.
    notPermitted: { fields: { kind: "coach" }, detail: /^kind_not_permitted$/ },
  },
  // sheet import (docs/import.md): a staged batch with one row, opened as the migration task would
  {
    route: "POST /api/v1/imports/:id/decisions", actor: "admin",
    prepare: async () => {
      const id = await importBatch();
      return {
        url: `/api/v1/imports/${id}/decisions`, body: { sheet: "sales", rowNo: 2, action: "reject" },
        state: () => rows(`SELECT count(*)::int AS n FROM eureka.import_decision`),
      };
    },
    forbidden: { decidedBy: U.admin2, decidedAt: PAST, rowKey: "a".repeat(64), approvedReasons: ["missing:name"], batchId: FOREIGN_ID },
  },
  {
    route: "POST /api/v1/imports/:id/approve", actor: "admin2",
    prepare: async () => {
      const id = await importBatch();
      return {
        url: `/api/v1/imports/${id}/approve`, body: { digest: "0".repeat(64) },
        state: () => rows(`SELECT status, approved_by, approved_digest FROM eureka.import_batch WHERE id = $1`, [id]),
      };
    },
    forbidden: { approvedBy: U.admin, status: "approved", operatorId: U.admin2, placementsCommit: true, approvedAt: PAST },
  },
];

/** Endpoints that read no body: what they change comes from the URL and the session only. */
interface IgnoreCase { route: string; run: () => Promise<void> }
const IGNORED: IgnoreCase[] = [
  {
    route: "POST /api/v1/imports/tickets",
    run: async () => {
      const r = await call("admin", "POST", "/api/v1/imports/tickets", { ...SERVER_MANAGED, createdBy: U.admin2, expiresAt: "2099-01-01T00:00:00Z" });
      expect(r.statusCode, r.body).toBe(201);
      const t = await rows(`SELECT created_by, expires_at < now() + interval '25 hours' AS soon FROM eureka.import_ticket ORDER BY created_at DESC LIMIT 1`);
      expect(t).toEqual([{ created_by: U.admin, soon: true }]);
    },
  },
  {
    route: "POST /api/auth/logout",
    run: async () => {
      const victim = await login("r1a");
      const mine = await login("r2a", true);
      const r = await call(null, "POST", "/api/auth/logout", { userId: U.r1a, sessionId: victim.cookie, all: true }, {}, mine);
      expect(r.statusCode).toBe(204);
      expect((await call(null, "GET", "/api/v1/me", undefined, {}, mine)).statusCode).toBe(401);
      expect((await call(null, "GET", "/api/v1/me", undefined, {}, victim)).statusCode).toBe(200);
    },
  },
  {
    route: "POST /api/v1/admin/users/:id/deactivate",
    run: async () => {
      const u = await ok("admin", "POST", "/api/v1/admin/users", { email: "ma-deact@eureka.example", displayName: "MA Deact" });
      const before = await rows(`SELECT email, display_name, designation, primary_location_id FROM eureka.app_user WHERE id = $1`, [u.id]);
      const r = await call("admin", "POST", `/api/v1/admin/users/${u.id}/deactivate`,
        { ...SERVER_MANAGED, status: "active", displayName: "Hijacked", email: "x@evil.example", userId: U.r2a });
      expect(r.statusCode, r.body).toBe(204);
      expect((await rows(`SELECT status FROM eureka.app_user WHERE id = $1`, [u.id]))[0]!.status).toBe("inactive");
      expect(await rows(`SELECT email, display_name, designation, primary_location_id FROM eureka.app_user WHERE id = $1`, [u.id])).toEqual(before);
      expect((await rows(`SELECT status FROM eureka.app_user WHERE id = $1`, [U.r2a]))[0]!.status).toBe("active");
    },
  },
  {
    route: "POST /api/v1/admin/users/:id/reactivate",
    run: async () => {
      const u = await ok("admin", "POST", "/api/v1/admin/users", { email: "ma-react@eureka.example", displayName: "MA React" });
      await ok("admin", "POST", `/api/v1/admin/users/${u.id}/deactivate`, undefined, 204);
      const r = await call("admin", "POST", `/api/v1/admin/users/${u.id}/reactivate`,
        { ...SERVER_MANAGED, status: "inactive", displayName: "Hijacked", userId: U.r3a });
      expect(r.statusCode, r.body).toBe(204);
      expect(await rows(`SELECT status, display_name FROM eureka.app_user WHERE id = $1`, [u.id])).toEqual([{ status: "active", display_name: "MA React" }]);
      expect((await rows(`SELECT status FROM eureka.app_user WHERE id = $1`, [U.r3a]))[0]!.status).toBe("active");
    },
  },
  {
    route: "POST /api/v1/admin/role-requests/:id/approve",
    run: async () => {
      // hr is restricted: the request waits for a second approver.
      const req = await ok("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r3a, role: "hr" });
      const r = await call("admin2", "POST", `/api/v1/admin/role-requests/${req.id}/approve`,
        { ...SERVER_MANAGED, status: "rejected", role: "org_admin", userId: U.r2a, decidedBy: U.admin, locationId: LOC.austin });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ status: "approved" });
      expect(await rows(`SELECT user_id, role_key, location_id, status, decided_by FROM eureka.role_request WHERE id = $1`, [req.id]))
        .toEqual([{ user_id: U.r3a, role_key: "hr", location_id: null, status: "approved", decided_by: U.admin2 }]);
      expect(await rows(`SELECT role_key FROM eureka.user_role WHERE user_id = ANY($1) AND valid @> now() ORDER BY 1`, [[U.r3a, U.r2a]]))
        .toEqual([{ role_key: "hr" }, { role_key: "recruiter" }, { role_key: "recruiter" }]);
    },
  },
  {
    route: "POST /api/v1/admin/role-requests/:id/reject",
    run: async () => {
      const req = await ok("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r1b, role: "accounts" });
      const r = await call("admin2", "POST", `/api/v1/admin/role-requests/${req.id}/reject`,
        { ...SERVER_MANAGED, status: "approved", role: "org_admin", userId: U.r2a });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ status: "rejected" });
      expect(await rows(`SELECT user_id, role_key, status, decided_by FROM eureka.role_request WHERE id = $1`, [req.id]))
        .toEqual([{ user_id: U.r1b, role_key: "accounts", status: "rejected", decided_by: U.admin2 }]);
      expect(await rows(`SELECT role_key FROM eureka.user_role WHERE user_id = ANY($1) AND valid @> now() ORDER BY 1`, [[U.r1b, U.r2a]]))
        .toEqual([{ role_key: "recruiter" }, { role_key: "recruiter" }]);
    },
  },
];

// ---- route discovery ------------------------------------------------------------------------------

/** Every POST/PUT/PATCH route of the controllers registered in AppModule (Nest route metadata). */
function writeRoutes(): string[] {
  const controllers = (AppModule.forConfig(config).controllers ?? []) as Type[];
  const out: string[] = [];
  const paths = (v: unknown): string[] => (Array.isArray(v) ? v : [v ?? ""]).map(String);
  for (const ctrl of controllers) {
    for (const base of paths(Reflect.getMetadata("path", ctrl))) {
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        if (name === "constructor" || typeof handler !== "function") continue;
        const method = Reflect.getMetadata("method", handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const verb = RequestMethod[method];
        if (verb !== "POST" && verb !== "PUT" && verb !== "PATCH") continue;
        for (const p of paths(Reflect.getMetadata("path", handler))) {
          out.push(`${verb} ${`/${base}/${p}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1")}`);
        }
      }
    }
  }
  return out.sort();
}

describe("mass assignment: coverage", () => {
  it("every POST/PUT/PATCH route has a case, and every case names a real route", () => {
    const routes = writeRoutes();
    expect(routes.length).toBeGreaterThan(30);
    const covered = [...CASES.map((c) => c.route), ...IGNORED.map((c) => c.route)].sort();
    expect(new Set(covered).size, "duplicate cases").toBe(covered.length);
    expect(routes.filter((r) => !covered.includes(r)), "write routes without a mass-assignment case").toEqual([]);
    expect(covered.filter((r) => !routes.includes(r)), "cases for routes that do not exist").toEqual([]);
  });
});

describe("mass assignment: strict bodies refuse server-managed and foreign fields", () => {
  const each = CASES.flatMap((c) => Object.entries({ ...SERVER_MANAGED, ...c.forbidden }).map(([field, value]) => [c.route, field, value, c] as const));

  it.each(each)("%s with %s → 422, nothing written", async (route, field, value, c) => {
    const p = await c.prepare();
    const method = route.split(" ")[0] as Method;
    const before = [await p.state(), await auditHead()];
    const res = await call(c.actor, method, p.url, { ...p.body, [field]: value }, p.headers);
    expect(res.statusCode, res.body).toBe(422);
    // The unknown key is the only problem: the rest of the body is valid.
    const errors = res.json().errors as { path: string; message: string }[];
    expect(errors, res.body).toEqual([{ path: "", message: `Unrecognized key(s) in object: '${field}'` }]);
    expect([await p.state(), await auditHead()]).toEqual(before);
  });

  const permitted = CASES.filter((c) => c.notPermitted).flatMap((c) =>
    Object.entries(c.notPermitted!.fields).map(([field, value]) => [c.route, field, value, c] as const));

  it.each(permitted)("%s with %s (not this caller's field) → 422, nothing written", async (route, field, value, c) => {
    const p = await c.prepare();
    const method = route.split(" ")[0] as Method;
    const before = [await p.state(), await auditHead()];
    const res = await call(c.actor, method, p.url, { ...p.body, [field]: value }, p.headers);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toMatch(c.notPermitted!.detail);
    expect([await p.state(), await auditHead()]).toEqual(before);
  });
});

describe("mass assignment: body-less endpoints ignore the body", () => {
  it.each(IGNORED.map((c) => [c.route, c] as const))("%s", async (_route, c) => {
    await c.run();
  });
});
