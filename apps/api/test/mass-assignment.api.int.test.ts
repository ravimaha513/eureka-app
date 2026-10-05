import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestMethod, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule, createApp } from "../src/app.module.js";
import { loadConfig, type AppConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, TECH_ID, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";
import { deliverInbox, emitEvent, newId } from "./notification-seed.js";
import { backdate, joinedEmployee } from "./employee-seed.js";
import { LOCAL_UPLOAD_PATH } from "../src/platform/storage/document-storage.js";
import { LocalDocumentStore } from "../src/worker/document-store.js";
import { DEFAULT_RESUME_SCAN_OPTIONS, resumeScanJob } from "../src/worker/jobs/resume-scan.js";
import { documentScanJob } from "../src/worker/jobs/document-scan.js";
import { DEFAULT_SCAN_OPTIONS } from "../src/worker/jobs/scan-pipeline.js";
import { StartStepUp } from "../src/modules/identity/step-up.controller.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";

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
/** Local document driver root (the API stands in for the bucket, as in development). */
let docs: string;

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
  docs = await mkdtemp(join(tmpdir(), "eureka-ma-docs-"));
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  config = loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`, LOCAL_STORAGE_DIR: docs,
  });
  app = await createApp(config);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  if (docs) await rm(docs, { recursive: true, force: true });
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

const PDF = "application/pdf";
const pdf = (text: string) => Buffer.from(`%PDF-1.7\n% fictional resume ${text}\n%%EOF\n`);

/** A browser-style multipart POST of the presigned fields plus the file (last). */
function form(fields: Record<string, string>, file: Buffer) {
  const b = "----eurekaMassAssignment";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="cv.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}

/** Requests a resume upload as r1a on a fresh own candidate; optionally uploads `file` and runs the scan. */
async function resumeOf(file?: Buffer) {
  const cand = await freshOwn();
  const r = await ok("r1a", "POST", `/api/v1/candidates/${cand.id}/resumes`, { contentType: PDF, size: file?.length ?? 100 });
  const ticket = r.upload as { url: string; fields: Record<string, string> };
  if (file) {
    const up = await app.inject({ method: "POST", url: ticket.url, ...form(ticket.fields, file) });
    expect(up.statusCode, up.body).toBe(204);
    await new JobRunner(db.worker, [resumeScanJob(new LocalDocumentStore(docs), DEFAULT_RESUME_SCAN_OPTIONS)], silentLogger).tick();
  }
  return { candidateId: cand.id, resumeId: r.id as string, ticket };
}

/** A fresh r1a placement with one paperwork item (fictional sample template, added once as superuser). */
async function paperworkPlacement() {
  await rows(`INSERT INTO authz.checklist_template (kind, placement_type, items)
              SELECT 'paperwork', 'w2', '[{"doc_type":"sample_ma_doc","owner_role":"hr"}]'
              WHERE NOT EXISTS (SELECT 1 FROM authz.checklist_template WHERE kind = 'paperwork' AND placement_type = 'w2')`);
  const cand = await freshOwn();
  const sub = await selectedSubmission(db, U.r1a, cand.id);
  const p = await createPlacement(db, U.r1a, sub, { type: "w2" });
  const itemId = (await rows(`SELECT id FROM eureka.checklist_item WHERE placement_id = $1`, [p.id]))[0]!.id as string;
  return { placementId: p.id, itemId };
}

/** A staged import batch operated by `operator` (as superuser; staging itself runs as eureka_import). */
async function stagedImport(operator: string) {
  const digest = randomBytes(32).toString("hex");
  // Only the CLI (import_open_batch) may write a batch; bypass the guard trigger for this fixture row.
  const c = await db.admin.connect();
  try {
    await c.query("SET session_replication_role = replica");
    return (await c.query<{ id: string }>(`INSERT INTO eureka.import_batch (source_digest, files, operator_id) VALUES ($1, '{}', $2) RETURNING id`,
      [digest, operator])).rows[0]!.id;
  } finally {
    await c.query("RESET session_replication_role");
    c.release();
  }
}

/** An in-app notification for HR and Accounts (as the worker delivers it); returns hr's and acct's row ids. */
async function inboxRows() {
  const [a, p, c] = [await newId(db), await newId(db), await newId(db)];
  const ev = await emitEvent(db, "assignment.ending_soon", "assignment", a,
    { assignmentId: a, placementId: p, personId: a, candidateId: c, plannedEndDate: "2026-11-01", daysLeft: 30, notify: ["hr", "accounts"] });
  await deliverInbox(db, ev);
  const r = await rows(`SELECT recipient_id, id FROM eureka.notification WHERE event_id = $1`, [ev]);
  const of = (u: string) => r.find((x) => x.recipient_id === u)!.id as string;
  return { hr: of(U.hr), acct: of(U.acct) };
}
const notificationState = (ids: string[]) =>
  rows(`SELECT id, recipient_id, title, body, read_at FROM eureka.notification WHERE id = ANY ($1) ORDER BY id`, [ids]);
const dbToday = async () => (await rows(`SELECT CURRENT_DATE::text AS d`))[0]!.d as string;
const daysAgo = async (n: number) => (await rows(`SELECT (CURRENT_DATE - $1::int)::text AS d`, [n]))[0]!.d as string;
/** A fresh r1a candidate placed and joined, the assignment started 60 days ago. */
async function employeeOnAssignment() {
  const j = await joinedEmployee(db);
  await backdate(db, j, await daysAgo(60));
  return j;
}
/** As above, then the assignment ended by HR (employee on the bench). */
async function benchedEmployee() {
  const j = await employeeOnAssignment();
  await asUser(db.app, U.hr, (c) => c.query(`SELECT authz.end_assignment($1, CURRENT_DATE - 1, 'completed')`, [j.assignmentId]), true);
  return j;
}
/** Every row the employment endpoints write for this person (and the outbox). */
const employmentState = async (personId: string) => ({
  employee: await rows(`SELECT * FROM eureka.employee WHERE person_id = $1`, [personId]),
  assignments: await rows(`SELECT a.*, pp.planned_end_date, pp.ending_notice_for FROM eureka.assignment a
                           LEFT JOIN eureka.assignment_plan pp ON pp.assignment_id = a.id WHERE a.person_id = $1`, [personId]),
  candidates: await rows(`SELECT c.marketing_status, c.team_id, c.recruiter_id FROM eureka.candidate c WHERE c.person_id = $1`, [personId]),
  events: await rows(`SELECT count(*)::int AS n FROM eureka.employment_event WHERE person_id = $1`, [personId]),
  outbox: await rows(`SELECT count(*)::int AS n FROM eureka.outbox_event`),
});

/** A fresh Dallas company or facility (as locD, the Dallas Location Ops Admin). */
async function ownerOf(plural: "companies" | "facilities"): Promise<string> {
  return (await ok("locD", "POST", `/api/v1/${plural}`, { locationId: LOC.dallas, name: `MA owner ${++n}` })).id as string;
}
async function utilityOf(plural: "companies" | "facilities") {
  const owner = await ownerOf(plural);
  const utility = (await ok("locD", "POST", `/api/v1/${plural}/${owner}/utilities`, { utilityType: "water", serviceProvider: "MA", password: "ma-pw" })).id as string;
  return { owner, utility };
}
async function billOf(): Promise<string> {
  const { owner, utility } = await utilityOf("companies");
  return (await ok("locD", "POST", `/api/v1/companies/${owner}/bills`,
    { utilityId: utility, paymentMethod: "card", amount: "9.99", billingStart: "2025-01-01", billingEnd: "2025-01-31", dueDate: "2025-02-10" })).id as string;
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
  /** Where the 422 names the key: `errors` (ZodError via the problem filter, default) or `detail`. */
  reports?: "errors" | "detail";
}

/** Fields a document upload never takes from the client (FR-PPR-01, migration 0043). */
const DOCUMENT_FORBIDDEN: Record<string, unknown> = {
  classification: "internal", status: "clean", scanResult: "NO_THREATS_FOUND", sha256: "a".repeat(64), sha256Hex: "a".repeat(64),
  candidateId: FOREIGN_ID, placementId: FOREIGN_ID, fileId: FOREIGN_ID, documentId: FOREIGN_ID, uploadedBy: U.r1b,
  key: `restricted/documents/${FOREIGN_ID}`, storageKey: `clean/documents/${FOREIGN_ID}`, kmsKeyAlias: "alias/other",
  fileName: "../../etc/passwd", scannedAt: PAST, uploadExpiresAt: "2099-01-01T00:00:00Z", verifiedBy: U.hr, expiresOn: "2099-01-01",
};

/** Fields a DataHub folder write never takes from the client (migration 0075). */
const DATAHUB_FOLDER_FORBIDDEN: Record<string, unknown> = {
  deletedAt: PAST, deletedBy: U.hr, row_version: 9, fileCount: 9, memberCount: 9, isMember: true, actions: { manage: true },
  ownerId: U.r1b, classification: "restricted", folderId: FOREIGN_ID,
};

// ---- chat (migration 0070) ----------------------------------------------------------------------

/** A fresh group owned by r1a with r1b. */
async function chatGroup() {
  const g = await ok("r1a", "POST", "/api/v1/chat/conversations/group", { name: `MA chat ${++n}`, memberIds: [U.r1b] });
  return g.id as string;
}
async function chatMessage(conv: string) {
  const r = await ok("r1a", "POST", `/api/v1/chat/conversations/${conv}/messages`, { clientId: randomUUID(), body: "MA hello" });
  return r.message.id as string;
}
/** Every chat row (the definer functions also audit; the audit head is checked separately). */
const chatState = () => rows(`SELECT
  (SELECT count(*)::int FROM eureka.chat_conversation) AS conversations,
  (SELECT coalesce(json_agg(json_build_object('c', c.id, 'n', c.name, 'v', c.row_version, 'r', c.last_rev) ORDER BY c.id), '[]') FROM eureka.chat_conversation c) AS convs,
  (SELECT coalesce(json_agg(json_build_object('c', m.conversation_id, 'u', m.user_id, 'r', m.role, 'l', m.left_at) ORDER BY m.conversation_id, m.user_id), '[]') FROM eureka.chat_member m) AS members,
  (SELECT coalesce(json_agg(s ORDER BY s.conversation_id, s.user_id), '[]') FROM eureka.chat_member_state s) AS states,
  (SELECT coalesce(json_agg(json_build_object('id', m.id, 'b', m.body, 'r', m.rev) ORDER BY m.id), '[]') FROM eureka.chat_message m) AS messages,
  (SELECT count(*)::int FROM eureka.chat_attachment) AS attachments,
  (SELECT count(*)::int FROM eureka.file_object) AS files`);
const CHAT_FORBIDDEN: Record<string, unknown> = {
  conversationId: FOREIGN_ID, userId: U.admin, senderId: U.r1b, kind: "group", directKey: `${U.r1a}:${U.r1b}`,
  deletedAt: PAST, leftAt: PAST, joinedAt: PAST, seq: 1, rev: 1, lastReadSeq: 0, visibleAfterSeq: 0, notifiedAt: PAST,
};

function chatCases(): RejectCase[] {
  return [
    {
      route: "POST /api/v1/chat/conversations/direct", actor: "r1a",
      prepare: async () => ({ url: "/api/v1/chat/conversations/direct", body: { userId: U.l2 }, state: chatState }),
      // userId is this endpoint's own field (the other person).
      forbidden: { ...Object.fromEntries(Object.entries(CHAT_FORBIDDEN).filter(([k]) => k !== "userId")), role: "owner", memberIds: [U.admin], otherId: U.admin },
    },
    {
      route: "POST /api/v1/chat/conversations/group", actor: "r1a",
      prepare: async () => ({ url: "/api/v1/chat/conversations/group", body: { name: "MA group", memberIds: [U.r1b] }, state: chatState }),
      forbidden: { ...CHAT_FORBIDDEN, role: "member", owners: [U.admin], createdBy: U.admin },
    },
    {
      route: "PATCH /api/v1/chat/conversations/:id", actor: "r1a",
      prepare: async () => {
        const g = await chatGroup();
        return { url: `/api/v1/chat/conversations/${g}`, body: { name: "MA renamed" }, state: chatState, headers: { "if-match": '"1"' } };
      },
      forbidden: { ...CHAT_FORBIDDEN, role: "member" },
    },
    {
      route: "PATCH /api/v1/chat/conversations/:id/preferences", actor: "r1a",
      prepare: async () => {
        const g = await chatGroup();
        return { url: `/api/v1/chat/conversations/${g}/preferences`, body: { favorite: true }, state: chatState };
      },
      forbidden: { ...CHAT_FORBIDDEN, role: "member", hidden: false, lastReadMessageId: FOREIGN_ID, lastViewedAt: PAST },
    },
    {
      route: "POST /api/v1/chat/conversations/:id/members", actor: "r1a",
      prepare: async () => {
        const g = await chatGroup();
        return { url: `/api/v1/chat/conversations/${g}/members`, body: { userIds: [U.l1] }, state: chatState };
      },
      forbidden: { ...CHAT_FORBIDDEN, role: "owner" },
    },
    {
      route: "PATCH /api/v1/chat/conversations/:id/members/:userId", actor: "r1a",
      prepare: async () => {
        const g = await chatGroup();
        return { url: `/api/v1/chat/conversations/${g}/members/${U.r1b}`, body: { role: "owner" }, state: chatState };
      },
      forbidden: CHAT_FORBIDDEN,
    },
    {
      route: "POST /api/v1/chat/conversations/:id/messages", actor: "r1a",
      prepare: async () => {
        const g = await chatGroup();
        return { url: `/api/v1/chat/conversations/${g}/messages`, body: { clientId: randomUUID(), body: "MA" }, state: chatState };
      },
      forbidden: { ...CHAT_FORBIDDEN, role: "owner", createdAt: PAST, editedAt: PAST, deleted: false, mine: true, sender: { id: U.r1b } },
    },
    {
      route: "POST /api/v1/chat/conversations/:id/read", actor: "r1b",
      prepare: async () => {
        const g = await chatGroup();
        await chatMessage(g);
        return { url: `/api/v1/chat/conversations/${g}/read`, body: {}, state: chatState };
      },
      forbidden: { ...CHAT_FORBIDDEN, role: "owner", lastViewedAt: PAST, lastReadMessageId: FOREIGN_ID },
    },
    {
      route: "PATCH /api/v1/chat/messages/:messageId", actor: "r1a",
      prepare: async () => {
        const g = await chatGroup();
        const m = await chatMessage(g);
        return { url: `/api/v1/chat/messages/${m}`, body: { body: "MA edited" }, state: chatState };
      },
      forbidden: { ...CHAT_FORBIDDEN, role: "owner", editedAt: PAST, deleted: true, attachments: [] },
    },
  ];
}


const CASES: RejectCase[] = [
  // interviews-settings (migration 0081): the owner, version and times of a staff profile are the server's;
  // name, email and designation are not editable in Settings
  {
    route: "PUT /api/v1/settings/profile", actor: "r1a",
    prepare: async () => {
      const v = (await rows(`SELECT row_version FROM eureka.staff_profile WHERE user_id = $1`, [U.r1a]))[0]?.row_version ?? 0;
      return {
        url: "/api/v1/settings/profile", body: { phone: null, bio: null }, headers: { "if-match": `"${v}"` },
        state: () => rows(`SELECT * FROM eureka.staff_profile ORDER BY user_id`),
      };
    },
    forbidden: { userId: U.r1b, displayName: "Boss", email: "boss@eureka.example", designation: "CEO", phoneE164: "+14695550199", status: "inactive" },
  },
  {
    route: "PUT /api/v1/settings/notifications/:type", actor: "hr",
    prepare: async () => ({
      url: "/api/v1/settings/notifications/employee.exited", body: { inApp: false },
      state: () => rows(`SELECT * FROM eureka.notification_preference ORDER BY user_id, type`),
    }),
    forbidden: { userId: U.acct, type: "work_authorization.expiring", mandatory: false, email: false, recipientId: U.acct },
  },
  // employees export (EM-X1): only the list filters
  {
    route: "POST /api/v1/employees/export", actor: "ceo",
    prepare: async () => ({
      url: "/api/v1/employees/export", body: {},
      state: () => rows(`SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'employee.export'`),
    }),
    forbidden: { cursor: "2026-01-01.00000000-0000-4000-8000-0000000000ff", limit: 100000, cap: 1_000_000, contact: true, unmasked: true, userId: U.hr },
  },
  // resumes (FR-CAN-07, migration 0036): status, scan result, version, digest, uploader and key are the server's
  {
    route: "POST /api/v1/candidates/:id/resumes", actor: "r1a",
    prepare: async () => {
      const cand = await freshOwn();
      return {
        url: `/api/v1/candidates/${cand.id}/resumes`, body: { contentType: PDF, size: 1234 },
        state: () => rows(`SELECT count(*)::int AS n FROM eureka.resume`),
      };
    },
    forbidden: {
      status: "clean", scanResult: "NO_THREATS_FOUND", version: 1, isCurrent: true, sha256: "a".repeat(64), sha256Hex: "a".repeat(64),
      uploadedBy: U.r1b, candidateId: FOREIGN_ID, key: `clean/resume/${FOREIGN_ID}`, storageKey: `clean/resume/${FOREIGN_ID}`,
      fileName: "../../etc/passwd", scannedAt: PAST, uploadExpiresAt: "2099-01-01T00:00:00Z",
    },
  },
  // in-app inbox (migration 0046): the recipient comes from the session, the read time from the server
  {
    route: "POST /api/v1/notifications/read-all", actor: "hr",
    prepare: async () => {
      const r = await inboxRows();
      return {
        url: "/api/v1/notifications/read-all", body: {},
        state: () => notificationState([r.hr, r.acct]),
      };
    },
    forbidden: {
      recipientId: U.acct, userId: U.acct, readAt: PAST, read: false, ids: [FOREIGN_ID], eventId: FOREIGN_ID,
      type: "employee.exited", title: "Hijacked", entity: { type: "candidate", id: FOREIGN_ID },
    },
  },
  // paperwork documents (FR-PPR-01, migration 0043): classification, owner, status, file and key are the server's
  {
    route: "POST /api/v1/candidates/:id/documents", actor: "hr",
    prepare: async () => {
      const cand = await freshOwn();
      return {
        url: `/api/v1/candidates/${cand.id}/documents`, body: { docType: "offer_letter", contentType: PDF, size: 1234 },
        state: () => rows(`SELECT (SELECT count(*)::int FROM eureka.document) AS d, (SELECT count(*)::int FROM eureka.file_object) AS f`),
      };
    },
    forbidden: DOCUMENT_FORBIDDEN,
  },
  {
    route: "POST /api/v1/placements/:id/documents", actor: "hr",
    prepare: async () => {
      const cand = await freshOwn();
      const placement = (await createPlacement(db, U.r1a, await selectedSubmission(db, U.r1a, cand.id))).id;
      return {
        url: `/api/v1/placements/${placement}/documents`, body: { docType: "i9", contentType: PDF, size: 1234 },
        state: () => rows(`SELECT (SELECT count(*)::int FROM eureka.document) AS d, (SELECT count(*)::int FROM eureka.file_object) AS f`),
      };
    },
    forbidden: DOCUMENT_FORBIDDEN,
  },
  // work authorization (FR-VIS-01, migration 0042): person, ciphertext, key, audit columns and row version are the server's
  {
    route: "POST /api/v1/candidates/:id/work-authorizations", actor: "imm",
    prepare: async () => {
      const cand = await freshOwn();
      return {
        url: `/api/v1/candidates/${cand.id}/work-authorizations`, body: { type: "h1b", number: "EAC2190012345", status: "valid", validTo: "2028-01-31" },
        state: () => rows(`SELECT count(*)::int AS n, (SELECT count(*)::int FROM eureka.field_key) AS keys FROM eureka.work_authorization`),
      };
    },
    forbidden: {
      personId: FOREIGN_ID, candidateId: FOREIGN_ID, numberEnc: "AQ==", number_enc: "AQ==", numberKeyId: FOREIGN_ID, keyId: FOREIGN_ID,
      numberMasked: "x", hasNumber: false, expired: true, daysToExpiry: 1, updatedBy: U.hr, authType: "o1", row_version: 9,
    },
  },
  {
    route: "PATCH /api/v1/candidates/:id/work-authorizations/:waId", actor: "imm",
    prepare: async () => {
      const cand = await freshOwn();
      const wa = await ok("imm", "POST", `/api/v1/candidates/${cand.id}/work-authorizations`, { type: "h1b", number: "EAC2190012345", status: "valid" });
      return {
        url: `/api/v1/candidates/${cand.id}/work-authorizations/${wa.id}`, body: { status: "revoked", number: "WAC1" },
        headers: { "if-match": "1" },
        state: () => rows(`SELECT * FROM eureka.work_authorization WHERE id = $1`, [wa.id]),
      };
    },
    forbidden: {
      personId: FOREIGN_ID, candidateId: FOREIGN_ID, numberEnc: "AQ==", numberKeyId: FOREIGN_ID, keyId: FOREIGN_ID,
      numberMasked: "x", hasNumber: false, expired: true, updatedBy: U.hr, row_version: 9,
    },
  },
  // sheet import sign-off (docs/import.md, migration 0033)
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
  // paperwork and BGC (docs/paperwork-api.md, migration 0044): placement, snapshots, version and who/when are the server's
  {
    route: "PATCH /api/v1/paperwork/items/:id", actor: "hr",
    prepare: async () => {
      const { itemId } = await paperworkPlacement();
      return {
        url: `/api/v1/paperwork/items/${itemId}`, body: { status: "received" },
        state: () => rows(`SELECT (SELECT row_to_json(i) FROM eureka.checklist_item i WHERE i.id = $1) AS item,
                                  (SELECT count(*) FROM eureka.checklist_item_event WHERE item_id = $1)::int AS events`, [itemId]),
      };
    },
    forbidden: {
      placementId: FOREIGN_ID, candidateId: FOREIGN_ID, recruiterId: U.r1b, teamId: T.t2, locationId: LOC.austin, kind: "onboarding",
      docType: "other_doc", required: false, position: 9, version: 99, templateVersion: 7, statusChangedAt: PAST, statusChangedBy: U.admin,
    },
  },
  {
    route: "PATCH /api/v1/paperwork/placements/:id/bgc", actor: "hr",
    prepare: async () => {
      const { placementId } = await paperworkPlacement();
      return {
        url: `/api/v1/paperwork/placements/${placementId}/bgc`, body: { status: "initiated" },
        state: () => rows(`SELECT (SELECT row_to_json(b) FROM eureka.bgc b WHERE b.placement_id = $1) AS bgc,
                                  (SELECT status FROM eureka.placement WHERE id = $1) AS placement`, [placementId]),
      };
    },
    forbidden: {
      placementId: FOREIGN_ID, candidateId: FOREIGN_ID, recruiterId: U.r1b, teamId: T.t2, locationId: LOC.austin, version: 99,
      statusChangedAt: PAST, statusChangedBy: U.admin, placementStatus: "bgc_failed",
    },
  },
  {
    route: "POST /api/v1/paperwork/templates", actor: "hr",
    prepare: async () => ({
      url: "/api/v1/paperwork/templates",
      body: { kind: "onboarding", placementType: "1099", items: [{ docType: "sample_ma_doc", ownerRole: "hr" }], expectedVersion: 0 },
      state: () => rows(`SELECT count(*)::int AS n FROM authz.checklist_template`),
    }),
    forbidden: { version: 5, publishedAt: PAST, publishedBy: U.admin, active: true },
  },
  // employees and assignments (docs/employees-api.md): status, dates the server sets, snapshots and history are the server's
  {
    route: "POST /api/v1/assignments/:id/end", actor: "hr",
    prepare: async () => {
      const j = await employeeOnAssignment();
      return {
        url: `/api/v1/assignments/${j.assignmentId}/end`, body: { endDate: await dbToday(), reason: "completed" },
        state: () => employmentState(j.personId),
      };
    },
    forbidden: {
      endReason: "bgc_failed", status: "bench", employeeStatus: "exited", personId: FOREIGN_ID, placementId: FOREIGN_ID,
      candidateId: FOREIGN_ID, assignmentNo: 9, startDate: "2020-01-01", candidateStatus: "terminated", note: "free text",
    },
  },
  {
    route: "PUT /api/v1/assignments/:id/planned-end-date", actor: "hr",
    prepare: async () => {
      const j = await employeeOnAssignment();
      return {
        url: `/api/v1/assignments/${j.assignmentId}/planned-end-date`, body: { plannedEndDate: "2099-01-01" },
        state: () => employmentState(j.personId),
      };
    },
    forbidden: { endingNoticeFor: "2099-01-01", endDate: "2099-01-01", startDate: "2020-01-01", assignmentId: FOREIGN_ID, previousPlannedEndDate: "2020-01-01" },
  },
  {
    route: "POST /api/v1/employees/:id/exit", actor: "hr",
    prepare: async () => {
      const j = await benchedEmployee();
      return { url: `/api/v1/employees/${j.personId}/exit`, body: { exitDate: await dbToday(), reason: "resigned" }, state: () => employmentState(j.personId) };
    },
    forbidden: { status: "on_assignment", exitedOn: "2020-01-01", statusSince: PAST, employeeSince: "2020-01-01", candidateId: FOREIGN_ID, personId: FOREIGN_ID },
  },
  {
    route: "POST /api/v1/employees/:id/return-to-market", actor: "hr",
    prepare: async () => {
      const j = await benchedEmployee();
      return { url: `/api/v1/employees/${j.personId}/return-to-market`, body: {}, state: () => employmentState(j.personId) };
    },
    forbidden: { candidateStatus: "active", status: "on_assignment", candidateId: FOREIGN_ID, teamId: T.t2, recruiterId: U.r2a },
  },
  {
    route: "POST /api/v1/reports/joinings-exits/export", actor: "l1",
    prepare: async () => ({ url: "/api/v1/reports/joinings-exits/export", body: { from: "2025-01-01", to: "2025-06-30" }, state: async () => null }),
    forbidden: { teamId: T.t2, recruiterId: U.r2a, scope: "org", limit: 1_000_000, includePhones: true, cap: 1 },
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
  // companies, facilities, utilities and bills (migration 0054): location, status at creation, row version,
  // ciphertext, owner, void and invoice columns are the server's
  ...(["companies", "facilities"] as const).flatMap((plural): RejectCase[] => [
    {
      route: `POST /api/v1/${plural}`, actor: "locD",
      prepare: async () => ({
        url: `/api/v1/${plural}`, body: { locationId: LOC.dallas, name: `MA ${plural} ${++n}`, city: "Dallas" },
        state: () => rows(`SELECT (SELECT count(*) FROM eureka.company)::int AS c, (SELECT count(*) FROM eureka.facility)::int AS f`),
      }),
      forbidden: {
        status: "inactive", incharges: [U.locD], employeeCount: 3, location: { id: LOC.austin }, actions: { manage: true },
        companyId: FOREIGN_ID, row_version: 9, created_by: U.hr,
      },
    },
    {
      route: `PATCH /api/v1/${plural}/:id`, actor: "locD",
      prepare: async () => {
        const o = await ownerOf(plural);
        return {
          url: `/api/v1/${plural}/${o}`, body: { city: "Plano", status: "inactive" }, headers: { "if-match": "1" },
          state: () => rows(`SELECT * FROM eureka.${plural === "companies" ? "company" : "facility"} WHERE id = $1`, [o]),
        };
      },
      forbidden: { incharges: [U.locD], employeeCount: 3, location: { id: LOC.austin }, actions: { manage: true }, row_version: 9 },
    },
    {
      route: `POST /api/v1/${plural}/:id/incharges`, actor: "locD",
      prepare: async () => {
        const o = await ownerOf(plural);
        return {
          url: `/api/v1/${plural}/${o}/incharges`, body: { userId: U.locD },
          state: () => rows(`SELECT (SELECT count(*) FROM eureka.company_incharge)::int AS c, (SELECT count(*) FROM eureka.facility_incharge)::int AS f`),
        };
      },
      forbidden: { assignedBy: U.hr, assignedAt: PAST, companyId: FOREIGN_ID, facilityId: FOREIGN_ID, name: "Hijacked" },
    },
    {
      route: `POST /api/v1/${plural}/:id/utilities`, actor: "locD",
      prepare: async () => {
        const o = await ownerOf(plural);
        return {
          url: `/api/v1/${plural}/${o}/utilities`, body: { utilityType: "water", serviceProvider: "MA Water", password: "ma-secret" },
          state: () => rows(`SELECT (SELECT count(*) FROM eureka.utility)::int AS u, (SELECT count(*) FROM eureka.field_key)::int AS k`),
        };
      },
      forbidden: {
        passwordEnc: "AQ==", password_enc: "AQ==", passwordMac: "AQ==", passwordKeyId: FOREIGN_ID, hasPassword: false, status: "inactive",
        companyId: FOREIGN_ID, facilityId: FOREIGN_ID, locationId: LOC.austin,
      },
    },
    {
      route: `POST /api/v1/${plural}/:id/bills`, actor: "locD",
      prepare: async () => {
        const { owner, utility } = await utilityOf(plural);
        return {
          url: `/api/v1/${plural}/${owner}/bills`,
          body: { utilityId: utility, paymentMethod: "ach", amount: "10.00", billingStart: "2025-01-01", billingEnd: "2025-01-31", dueDate: "2025-02-10" },
          state: () => rows(`SELECT count(*)::int AS n FROM eureka.utility_bill`),
        };
      },
      forbidden: {
        status: "paid", voidedAt: PAST, voidedBy: U.hr, voidReason: "x", invoiceDocumentId: FOREIGN_ID, invoice: { documentId: FOREIGN_ID },
        companyId: FOREIGN_ID, facilityId: FOREIGN_ID, locationId: LOC.austin, utility: { id: FOREIGN_ID },
      },
    },
  ]),
  {
    route: "POST /api/v1/companies/:id/employees", actor: "locD",
    prepare: async () => {
      const o = await ownerOf("companies");
      const e = await joinedEmployee(db);
      return {
        url: `/api/v1/companies/${o}/employees`, body: { employeeId: e.personId, startDate: "2025-01-01" },
        state: () => rows(`SELECT count(*)::int AS n FROM eureka.company_employee`),
      };
    },
    forbidden: { endDate: "2025-12-31", companyId: FOREIGN_ID, status: "exited", endedBy: U.hr, name: "X" },
  },
  {
    route: "POST /api/v1/companies/:id/employees/:employeeId/end", actor: "locD",
    prepare: async () => {
      const o = await ownerOf("companies");
      const e = await joinedEmployee(db);
      await ok("locD", "POST", `/api/v1/companies/${o}/employees`, { employeeId: e.personId, startDate: "2025-01-01" });
      return {
        url: `/api/v1/companies/${o}/employees/${e.personId}/end`, body: { endDate: "2025-06-30" },
        state: () => rows(`SELECT * FROM eureka.company_employee WHERE person_id = $1`, [e.personId]),
      };
    },
    forbidden: { startDate: "2024-01-01", companyId: FOREIGN_ID, endedBy: U.hr, endedAt: PAST, employeeId: FOREIGN_ID },
  },
  {
    route: "PATCH /api/v1/utilities/:id", actor: "locD",
    prepare: async () => {
      const { utility } = await utilityOf("companies");
      return {
        url: `/api/v1/utilities/${utility}`, body: { status: "inactive", password: "ma-new" }, headers: { "if-match": "1" },
        state: () => rows(`SELECT * FROM eureka.utility WHERE id = $1`, [utility]),
      };
    },
    forbidden: {
      passwordEnc: "AQ==", passwordMac: "AQ==", passwordKeyId: FOREIGN_ID, hasPassword: false, companyId: FOREIGN_ID,
      facilityId: FOREIGN_ID, locationId: LOC.austin, row_version: 9,
    },
  },
  {
    route: "PATCH /api/v1/bills/:id", actor: "locD",
    prepare: async () => {
      const b = await billOf();
      return {
        url: `/api/v1/bills/${b}`, body: { amount: "11.00", paidOn: "2025-02-01" }, headers: { "if-match": "1" },
        state: () => rows(`SELECT * FROM eureka.utility_bill WHERE id = $1`, [b]),
      };
    },
    forbidden: { status: "due", voidedAt: PAST, voidReason: "x", invoiceDocumentId: FOREIGN_ID, invoice: null, utility: { id: FOREIGN_ID }, row_version: 9 },
  },
  {
    route: "POST /api/v1/bills/:id/void", actor: "locD",
    prepare: async () => {
      const b = await billOf();
      return {
        url: `/api/v1/bills/${b}/void`, body: { reason: "Entered twice" },
        state: () => rows(`SELECT * FROM eureka.utility_bill WHERE id = $1`, [b]),
      };
    },
    forbidden: { voidedAt: PAST, voidedBy: U.hr, status: "paid", billId: FOREIGN_ID },
  },
  {
    route: "POST /api/v1/bills/:id/invoice", actor: "locD",
    prepare: async () => {
      const b = await billOf();
      return {
        url: `/api/v1/bills/${b}/invoice`, body: { fileName: "invoice.pdf", contentType: PDF, size: 1234 },
        state: () => rows(`SELECT (SELECT count(*) FROM eureka.document)::int AS d, (SELECT count(*) FROM eureka.file_object)::int AS f,
                                  (SELECT row_version FROM eureka.utility_bill WHERE id = $1) AS v`, [b]),
      };
    },
    forbidden: (({ fileName: _f, ...rest }) => ({ ...rest, billId: FOREIGN_ID, docType: "i9" }))(DOCUMENT_FORBIDDEN),
  },
  // datahub (docs/datahub-api.md, migration 0075): owner, location of a subfolder, row version, status, file and key are the server's
  {
    route: "POST /api/v1/datahub/folders", actor: "hr",
    prepare: async () => ({
      url: "/api/v1/datahub/folders", body: { name: `MA folder ${++n}`, level: "internal" },
      state: () => rows(`SELECT count(*)::int AS n FROM eureka.datahub_folder`),
    }),
    forbidden: DATAHUB_FOLDER_FORBIDDEN,
  },
  {
    route: "PATCH /api/v1/datahub/folders/:id", actor: "hr",
    prepare: async () => {
      const f = await ok("hr", "POST", "/api/v1/datahub/folders", { name: `MA patch ${++n}`, level: "internal" });
      return {
        url: `/api/v1/datahub/folders/${f.id}`, body: { description: "Changed" }, headers: { "if-match": "1" },
        state: () => rows(`SELECT * FROM eureka.datahub_folder WHERE id = $1`, [f.id]),
      };
    },
    forbidden: DATAHUB_FOLDER_FORBIDDEN,
  },
  {
    route: "POST /api/v1/datahub/folders/:id/files", actor: "hr",
    prepare: async () => {
      const f = await ok("hr", "POST", "/api/v1/datahub/folders", { name: `MA files ${++n}`, level: "internal" });
      return {
        url: `/api/v1/datahub/folders/${f.id}/files`, body: { name: "Policy.pdf", contentType: PDF, size: 1234 },
        state: () => rows(`SELECT (SELECT count(*)::int FROM eureka.datahub_file_version) AS v, (SELECT count(*)::int FROM eureka.file_object) AS f`),
      };
    },
    forbidden: {
      ...DOCUMENT_FORBIDDEN, folderId: FOREIGN_ID, fileObjectId: FOREIGN_ID, version: 7, versionId: FOREIGN_ID, latestVersion: 7,
      level: "internal", deletedAt: PAST,
    },
  },
  // training (migration 0065, docs/training-api.md): owners, creators, versions, statuses and progress stamps are the server's
  {
    route: "POST /api/v1/training/batches", actor: "locD",
    prepare: async () => ({
      url: "/api/v1/training/batches", body: { locationId: LOC.dallas, technologyId: TECH_ID, startDate: nextTrainingMonth() },
      state: () => rows(`SELECT count(*)::int AS n FROM eureka.batch`),
    }),
    forbidden: { status: "in_training", createdBy: U.l1, startMonth: "2030-01", students: 5, courses: 2, customName: "x", trainer: U.coach },
  },
  {
    route: "PATCH /api/v1/training/batches/:id", actor: "locD",
    prepare: async () => {
      const b = await trainingBatch();
      return { url: `/api/v1/training/batches/${b}`, body: { name: "Renamed" }, headers: { "if-match": '"2"' },
        state: () => rows(`SELECT * FROM eureka.batch WHERE id = $1`, [b]) };
    },
    forbidden: { status: "completed", locationId: LOC.austin, technologyId: FOREIGN_ID, startMonth: "2030-01", createdBy: U.l1 },
  },
  {
    route: "PUT /api/v1/training/batches/:id/status", actor: "locD",
    prepare: async () => {
      const b = await trainingBatch();
      return { url: `/api/v1/training/batches/${b}/status`, body: { to: "in_training" }, state: () => rows(`SELECT * FROM eureka.batch WHERE id = $1`, [b]) };
    },
    forbidden: { status: "completed", from: "planned", batchId: FOREIGN_ID },
  },
  {
    route: "POST /api/v1/training/batches/:id/courses", actor: "locD",
    prepare: async () => {
      const b = await trainingBatch();
      const c = await trainingCourse();
      return { url: `/api/v1/training/batches/${b}/courses`, body: { courseId: c.id },
        state: () => rows(`SELECT * FROM eureka.batch_course WHERE batch_id = $1`, [b]) };
    },
    forbidden: { position: 1, addedBy: U.l1, addedAt: PAST, batchId: FOREIGN_ID },
  },
  {
    route: "PUT /api/v1/training/batches/:id/courses/order", actor: "locD",
    prepare: async () => {
      const b = await trainingBatch();
      const c = await trainingCourse();
      await ok("locD", "POST", `/api/v1/training/batches/${b}/courses`, { courseId: c.id });
      return { url: `/api/v1/training/batches/${b}/courses/order`, body: { courseIds: [c.id] },
        state: () => rows(`SELECT * FROM eureka.batch_course WHERE batch_id = $1`, [b]) };
    },
    forbidden: { positions: [1], batchId: FOREIGN_ID },
  },
  {
    route: "POST /api/v1/training/batches/:id/students", actor: "locD",
    prepare: async () => {
      const b = await trainingBatch();
      const cand = await freshOwn();
      return { url: `/api/v1/training/batches/${b}/students`, body: { candidateId: cand.id },
        state: () => rows(`SELECT batch_id FROM eureka.candidate WHERE id = $1`, [cand.id]) };
    },
    forbidden: { batchId: FOREIGN_ID, locationId: LOC.austin, status: "active", progress: 100 },
  },
  {
    route: "PUT /api/v1/training/batches/:id/students/:candidateId/modules/:moduleId", actor: "locD",
    prepare: async () => {
      const b = await trainingBatch();
      const c = await trainingCourse();
      await ok("locD", "POST", `/api/v1/training/batches/${b}/courses`, { courseId: c.id });
      const cand = await freshOwn();
      await ok("locD", "POST", `/api/v1/training/batches/${b}/students`, { candidateId: cand.id });
      return { url: `/api/v1/training/batches/${b}/students/${cand.id}/modules/${c.moduleId}`, body: { completed: true },
        state: () => rows(`SELECT * FROM eureka.module_progress WHERE batch_id = $1`, [b]) };
    },
    forbidden: { completedAt: PAST, completedBy: U.coach, candidateId: FOREIGN_ID, moduleId: FOREIGN_ID },
  },
  {
    route: "POST /api/v1/training/courses", actor: "locD",
    prepare: async () => ({
      url: "/api/v1/training/courses", body: { title: "MA course" },
      state: () => rows(`SELECT count(*)::int AS n FROM eureka.course`),
    }),
    forbidden: { archived: true, createdBy: U.l1, canEdit: true, totalMinutes: 5, location: { id: LOC.austin } },
  },
  {
    route: "PATCH /api/v1/training/courses/:id", actor: "locD",
    prepare: async () => {
      const c = await trainingCourse();
      return { url: `/api/v1/training/courses/${c.id}`, body: { title: "Renamed" }, headers: { "if-match": '"1"' },
        state: () => rows(`SELECT * FROM eureka.course WHERE id = $1`, [c.id]) };
    },
    forbidden: { locationId: LOC.austin, createdBy: U.l1, modules: [] },
  },
  {
    route: "POST /api/v1/training/courses/:id/modules", actor: "locD",
    prepare: async () => {
      const c = await trainingCourse();
      return { url: `/api/v1/training/courses/${c.id}/modules`, body: { title: "More", durationMinutes: 15 },
        state: () => rows(`SELECT * FROM eureka.course_module WHERE course_id = $1 ORDER BY position`, [c.id]) };
    },
    forbidden: { position: 1, courseId: FOREIGN_ID },
  },
  {
    route: "PUT /api/v1/training/courses/:id/modules/order", actor: "locD",
    prepare: async () => {
      const c = await trainingCourse();
      return { url: `/api/v1/training/courses/${c.id}/modules/order`, body: { moduleIds: [c.moduleId] },
        state: () => rows(`SELECT * FROM eureka.course_module WHERE course_id = $1 ORDER BY position`, [c.id]) };
    },
    forbidden: { positions: [1], courseId: FOREIGN_ID },
  },
  {
    route: "PATCH /api/v1/training/courses/:id/modules/:moduleId", actor: "locD",
    prepare: async () => {
      const c = await trainingCourse();
      return { url: `/api/v1/training/courses/${c.id}/modules/${c.moduleId}`, body: { durationMinutes: 20 }, headers: { "if-match": '"1"' },
        state: () => rows(`SELECT * FROM eureka.course_module WHERE course_id = $1`, [c.id]) };
    },
    forbidden: { position: 3, courseId: FOREIGN_ID },
  },
  // chat (migration 0070, docs/chat-api.md): members, roles, sender, revisions, read marks and keys are the server's
  ...chatCases(),
];


let trainingMonth = 0;
/** A start date in a month no other case uses (one batch per location, technology and month). */
const nextTrainingMonth = () => {
  const m = trainingMonth++;
  return `${2060 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-05`;
};
/** A planned Dallas batch created by the Dallas Location Ops Admin (row version 2 after the details are set). */
const trainingBatch = async () =>
  (await ok("locD", "POST", "/api/v1/training/batches", { locationId: LOC.dallas, technologyId: TECH_ID, startDate: nextTrainingMonth() })).id as string;
/** A Dallas course with one module. */
async function trainingCourse(): Promise<{ id: string; moduleId: string }> {
  const { id } = await ok("locD", "POST", "/api/v1/training/courses", { title: `MA course ${++n}`, modules: [{ title: "M1", durationMinutes: 30 }] });
  const moduleId = (await rows(`SELECT id FROM eureka.course_module WHERE course_id = $1`, [id]))[0]!.id as string;
  return { id, moduleId };
}

/** Endpoints that read no body: what they change comes from the URL and the session only. */
interface IgnoreCase { route: string; run: () => Promise<void> }
const IGNORED: IgnoreCase[] = [
  // interviews-settings (ST-7): the session comes from the URL, its owner from the caller's session
  {
    route: "POST /api/v1/settings/sessions/:id/revoke",
    run: async () => {
      const a = await login("r2a", true);
      const b = await login("r2a", true);
      const other = await login("r3a", true);
      const list = (await call(null, "GET", "/api/v1/settings/sessions", undefined, {}, a)).json().items as { id: string; current: boolean }[];
      const bId = (await rows(`SELECT public_id FROM eureka.session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 OFFSET 0`, [U.r2a]))[0]!.public_id as string;
      expect(list.some((i) => i.id === bId)).toBe(true);
      const otherId = (await rows(`SELECT public_id FROM eureka.session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [U.r3a]))[0]!.public_id as string;
      const res = await call(null, "POST", `/api/v1/settings/sessions/${bId}/revoke`,
        { ...SERVER_MANAGED, id: otherId, userId: U.r3a, sessionId: otherId, all: true, revokedAt: PAST }, {}, a);
      expect(res.statusCode, res.body).toBe(204);
      expect((await call(null, "GET", "/api/v1/me", undefined, {}, b)).statusCode).toBe(401);
      expect((await call(null, "GET", "/api/v1/me", undefined, {}, a)).statusCode).toBe(200);
      expect((await call(null, "GET", "/api/v1/me", undefined, {}, other)).statusCode).toBe(200);
    },
  },
  {
    route: "POST /api/v1/settings/sessions/revoke-others",
    run: async () => {
      const a = await login("r3a", true);
      const b = await login("r3a", true);
      const other = await login("r2a", true);
      const res = await call(null, "POST", "/api/v1/settings/sessions/revoke-others", { userId: U.r2a, keep: [], all: true, ...SERVER_MANAGED }, {}, a);
      expect(res.statusCode, res.body).toBe(200);
      expect((await call(null, "GET", "/api/v1/me", undefined, {}, b)).statusCode).toBe(401);
      expect((await call(null, "GET", "/api/v1/me", undefined, {}, a)).statusCode).toBe(200);
      expect((await call(null, "GET", "/api/v1/me", undefined, {}, other)).statusCode).toBe(200);
    },
  },
  // chat (migration 0070)
  {
    route: "POST /api/v1/chat/conversations/:id/leave",
    run: async () => {
      const g = await chatGroup();
      await ok("r1a", "POST", `/api/v1/chat/conversations/${g}/members`, { userIds: [U.l1] }, 200);
      const r = await call("r1b", "POST", `/api/v1/chat/conversations/${g}/leave`,
        { ...SERVER_MANAGED, userId: U.l1, conversationId: FOREIGN_ID, role: "owner", leftAt: PAST });
      expect(r.statusCode, r.body).toBe(204);
      const left = await rows(`SELECT user_id, role, left_at IS NOT NULL AS gone FROM eureka.chat_member WHERE conversation_id = $1 ORDER BY user_id`, [g]);
      expect(left).toEqual([
        { user_id: U.l1, role: "member", gone: false }, { user_id: U.r1a, role: "owner", gone: false }, { user_id: U.r1b, role: "member", gone: true },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)));
    },
  },
  {
    route: "POST /api/v1/chat/attachments/:attachmentId/download",
    run: async () => {
      const g = await chatGroup();
      const sent = await ok("r1a", "POST", `/api/v1/chat/conversations/${g}/messages`,
        { clientId: randomUUID(), body: "", attachments: [{ fileName: "ma.pdf", contentType: "application/pdf", size: 10 }] });
      const att = sent.message.attachments[0].id as string;
      const before = await auditHead();
      // Still pending: refused whatever the body claims.
      const r = await call("r1b", "POST", `/api/v1/chat/attachments/${att}/download`,
        { ...SERVER_MANAGED, status: "clean", fileId: FOREIGN_ID, key: `clean/documents/${FOREIGN_ID}` });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().detail).toBe("not_available");
      expect(await rows(`SELECT f.status FROM eureka.chat_attachment a JOIN eureka.file_object f ON f.id = a.file_id WHERE a.id = $1`, [att]))
        .toEqual([{ status: "pending" }]);
      expect(await auditHead()).toBe(before);
    },
  },
  {
    route: "POST /api/v1/notifications/:id/read",
    run: async () => {
      const r = await inboxRows();
      const before = Date.now();
      const res = await call("hr", "POST", `/api/v1/notifications/${r.hr}/read`,
        { ...SERVER_MANAGED, readAt: PAST, recipientId: U.acct, userId: U.acct, title: "Hijacked", read: false, id: r.acct });
      expect(res.statusCode, res.body).toBe(204);
      const st = await notificationState([r.hr, r.acct]);
      const hr = st.find((x) => x.id === r.hr)!;
      const acct = st.find((x) => x.id === r.acct)!;
      expect((hr.read_at as Date).getTime()).toBeGreaterThanOrEqual(before - 5_000);   // the server's time, not PAST
      expect(hr.title).toBe("Project assignment ends within 30 days");
      expect(hr.recipient_id).toBe(U.hr);
      expect(acct.read_at).toBeNull();                                                 // the other recipient's row is untouched
    },
  },
  {
    route: "POST /api/v1/notifications/:id/unread",
    run: async () => {
      const r = await inboxRows();
      await ok("hr", "POST", `/api/v1/notifications/${r.hr}/read`, undefined, 204);
      await ok("acct", "POST", `/api/v1/notifications/${r.acct}/read`, undefined, 204);
      const acctBefore = (await notificationState([r.acct]))[0];
      const res = await call("hr", "POST", `/api/v1/notifications/${r.hr}/unread`,
        { ...SERVER_MANAGED, readAt: PAST, recipientId: U.acct, id: r.acct, read: true });
      expect(res.statusCode, res.body).toBe(204);
      expect((await notificationState([r.hr]))[0]!.read_at).toBeNull();
      expect((await notificationState([r.acct]))[0]).toEqual(acctBefore);
    },
  },
  {
    route: "POST /api/v1/documents/:documentId/download",
    run: async () => {
      const cand = await freshOwn();
      const file = pdf("document download");
      const r = await ok("r1a", "POST", `/api/v1/candidates/${cand.id}/documents`, { docType: "offer_letter", contentType: PDF, size: file.length });
      const up = await app.inject({ method: "POST", url: r.upload.url, ...form(r.upload.fields, file) });
      expect(up.statusCode, up.body).toBe(204);
      await new JobRunner(db.worker, [documentScanJob(new LocalDocumentStore(docs), DEFAULT_SCAN_OPTIONS)], silentLogger).tick();
      const before = await rows(`SELECT * FROM eureka.document ORDER BY id`);
      const res = await call("r1a", "POST", `/api/v1/documents/${r.id}/download`, {
        ...SERVER_MANAGED, key: `restricted/documents/${FOREIGN_ID}`, fileId: FOREIGN_ID, classification: "restricted",
        fileName: "payload.html", contentType: "text/html", expiresSeconds: 86_400, stepUpGrantId: FOREIGN_ID,
      });
      expect(res.statusCode, res.body).toBe(200);
      const { url, expiresAt } = res.json() as { url: string; expiresAt: string };
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
      const got = await app.inject({ method: "GET", url });
      expect(got.rawPayload.equals(file)).toBe(true);
      expect(got.headers["content-type"]).toBe(PDF);
      expect(String(got.headers["content-disposition"])).not.toContain("payload.html");
      expect(await rows(`SELECT * FROM eureka.document ORDER BY id`)).toEqual(before);
      const log = await rows(`SELECT user_id, classification, step_up_grant_id FROM eureka.document_access WHERE document_id = $1`, [r.id]);
      expect(log).toEqual([{ user_id: U.r1a, classification: "internal", step_up_grant_id: null }]);
    },
  },
  {
    route: "POST /api/auth/step-up/dev",
    run: async () => {
      await rows(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`);
      try {
        const mine = await login("acct", true);
        const victim = await login("hr", true);
        const res = await call(null, "POST", "/api/auth/step-up/dev",
          { ...SERVER_MANAGED, userId: U.hr, sessionId: victim.cookie, method: "google", ttlMinutes: 600, expiresAt: "2099-01-01T00:00:00Z", authTime: PAST },
          {}, mine);
        expect(res.statusCode, res.body).toBe(200);
        expect(Date.parse(res.json().expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
        const grants = await rows(`SELECT user_id, method FROM eureka.step_up_grant WHERE user_id = ANY($1)`, [[U.acct, U.hr]]);
        expect(grants).toEqual([{ user_id: U.acct, method: "dev" }]);
        expect((await call(null, "GET", "/api/auth/step-up", undefined, {}, victim)).json()).toMatchObject({ active: false });
      } finally {
        await rows(`DELETE FROM authz.policy_setting WHERE key = 'dev_step_up'`);
      }
    },
  },
  {
    // Google mode only (this app runs AUTH_MODE=dev, where it is 404); its strict schema is checked directly.
    route: "POST /api/auth/step-up/start",
    run: async () => {
      expect((await call("hr", "POST", "/api/auth/step-up/start", { returnTo: "/" })).statusCode).toBe(404);
      for (const [field, value] of Object.entries({ ...SERVER_MANAGED, userId: U.r1a, sessionHash: "x", state: "s", nonce: "n",
        redirectUri: "https://evil.example/cb", expiresAt: "2099-01-01T00:00:00Z", maxAge: 99999 })) {
        const r = StartStepUp.safeParse({ returnTo: "/", [field]: value });
        expect(r.success, field).toBe(false);
      }
      expect(StartStepUp.safeParse({ returnTo: "/candidates" }).success).toBe(true);
    },
  },
  {
    // The reveal takes no body: the record comes from the URL, the reader from the session.
    route: "POST /api/v1/candidates/:id/work-authorizations/:waId/reveal",
    run: async () => {
      const cand = await freshOwn();
      const a = await ok("imm", "POST", `/api/v1/candidates/${cand.id}/work-authorizations`, { type: "h1b", number: "AAA111", status: "valid" });
      const b = await ok("imm", "POST", `/api/v1/candidates/${cand.id}/work-authorizations`, { type: "h1b", number: "BBB222", status: "valid" });
      const before = await rows(`SELECT * FROM eureka.work_authorization ORDER BY id`);
      // The reveal needs a step-up of this session (development step-up here).
      await rows(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`);
      const s = await login("imm", true);
      try {
        expect((await call(null, "POST", "/api/auth/step-up/dev", undefined, {}, s)).statusCode).toBe(200);
      } finally {
        await rows(`DELETE FROM authz.policy_setting WHERE key = 'dev_step_up'`);
      }
      const r = await call(null, "POST", `/api/v1/candidates/${cand.id}/work-authorizations/${a.id}/reveal`, {
        ...SERVER_MANAGED, waId: b.id, candidateId: FOREIGN_ID, actorId: U.hr, number: "ZZZ999", stepUpGrantId: FOREIGN_ID,
      }, {}, s);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ id: a.id, number: "AAA111" });
      expect(await rows(`SELECT * FROM eureka.work_authorization ORDER BY id`)).toEqual(before);
      const audit = await rows(`SELECT actor_id, entity_id, changes FROM eureka.audit_event WHERE action = 'work_authorization.number_revealed' ORDER BY seq DESC LIMIT 1`);
      expect(audit).toEqual([{ actor_id: U.imm, entity_id: a.id, changes: { candidateId: cand.id, stepUpGrantId: expect.any(String) } }]);
      expect(audit[0]!.changes.stepUpGrantId).not.toBe(FOREIGN_ID);
    },
  },
  {
    route: "POST /api/v1/candidates/:id/resumes/:resumeId/download",
    run: async () => {
      const file = pdf("download");
      const { candidateId, resumeId } = await resumeOf(file);
      const other = await resumeOf(pdf("other"));
      expect((await rows(`SELECT status, version FROM eureka.resume WHERE id = $1`, [resumeId]))).toEqual([{ status: "clean", version: 1 }]);
      const before = await rows(`SELECT * FROM eureka.resume ORDER BY id`);
      const r = await call("r1a", "POST", `/api/v1/candidates/${candidateId}/resumes/${resumeId}/download`, {
        ...SERVER_MANAGED, key: `clean/resume/${other.resumeId}`, resumeId: other.resumeId, fileName: "payload.html",
        contentType: "text/html", expiresSeconds: 86_400, version: 7, status: "clean",
      });
      expect(r.statusCode, r.body).toBe(200);
      const { url, expiresAt } = r.json() as { url: string; expiresAt: string };
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
      // The link serves this resume, as a PDF attachment named by the server.
      const got = await app.inject({ method: "GET", url });
      expect(got.statusCode).toBe(200);
      expect(got.rawPayload.equals(file)).toBe(true);
      expect(got.headers["content-type"]).toBe(PDF);
      expect(String(got.headers["content-disposition"])).toMatch(/^attachment;/);
      expect(String(got.headers["content-disposition"])).not.toContain("payload.html");
      expect(await rows(`SELECT * FROM eureka.resume ORDER BY id`)).toEqual(before);
    },
  },
  {
    route: "POST /api/v1/imports/tickets",
    run: async () => {
      const r = await call("admin", "POST", "/api/v1/imports/tickets", {
        ...SERVER_MANAGED, createdBy: U.admin2, operatorId: U.admin2, expiresAt: "2099-01-01T00:00:00Z", tokenHash: "a".repeat(64),
        ticket: "chosen-by-client", batchId: FOREIGN_ID, usedAt: PAST,
      });
      expect(r.statusCode, r.body).toBe(201);
      const { ticket, expiresAt } = r.json() as { ticket: string; expiresAt: string };
      expect(ticket).not.toBe("chosen-by-client");
      const hash = createHash("sha256").update(ticket).digest("hex");
      const t = await rows(`SELECT created_by, expires_at, used_at, batch_id FROM eureka.import_ticket WHERE token_hash = $1`, [hash]);
      expect(t).toEqual([{ created_by: U.admin, expires_at: new Date(expiresAt), used_at: null, batch_id: null }]);
      expect(Date.parse(expiresAt)).toBeLessThan(Date.parse("2099-01-01T00:00:00Z"));
      expect(await rows(`SELECT 1 FROM eureka.import_ticket WHERE token_hash = $1`, ["a".repeat(64)])).toEqual([]);
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
  {
    route: "POST /api/v1/utilities/:id/reveal-password",
    run: async () => {
      const o = await ownerOf("companies");
      const a = await ok("locD", "POST", `/api/v1/companies/${o}/utilities`, { utilityType: "gas", serviceProvider: "A", password: "pw-A" });
      const b = await ok("locD", "POST", `/api/v1/companies/${o}/utilities`, { utilityType: "gas", serviceProvider: "B", password: "pw-B" });
      const before = await rows(`SELECT * FROM eureka.utility ORDER BY id`);
      await rows(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`);
      const s = await login("locD", true);
      try {
        expect((await call(null, "POST", "/api/auth/step-up/dev", undefined, {}, s)).statusCode).toBe(200);
      } finally {
        await rows(`DELETE FROM authz.policy_setting WHERE key = 'dev_step_up'`);
      }
      const r = await call(null, "POST", `/api/v1/utilities/${a.id}/reveal-password`, {
        ...SERVER_MANAGED, utilityId: b.id, password: "chosen", actorId: U.hr, stepUpGrantId: FOREIGN_ID,
      }, {}, s);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ password: "pw-A" });
      expect(await rows(`SELECT * FROM eureka.utility ORDER BY id`)).toEqual(before);
      const audit = await rows(`SELECT actor_id, entity_id, changes FROM eureka.audit_event WHERE action = 'utility.password_revealed' ORDER BY seq DESC LIMIT 1`);
      expect(audit).toEqual([{ actor_id: U.locD, entity_id: a.id, changes: { ownerKind: "company", ownerId: o, stepUpGrantId: expect.any(String) } }]);
      expect(audit[0]!.changes.stepUpGrantId).not.toBe(FOREIGN_ID);
    },
  },
  {
    // Membership comes from the URL (folder, user) and the session; nothing in the body counts.
    route: "PUT /api/v1/datahub/folders/:id/members/:userId",
    run: async () => {
      const f = await ok("hr", "POST", "/api/v1/datahub/folders", { name: `MA members ${++n}`, level: "restricted" });
      const res = await call("hr", "PUT", `/api/v1/datahub/folders/${f.id}/members/${U.r1a}`,
        { ...SERVER_MANAGED, userId: U.r2a, folderId: FOREIGN_ID, addedBy: U.admin, addedAt: PAST });
      expect(res.statusCode, res.body).toBe(204);
      const m = await rows(`SELECT folder_id, user_id, added_by FROM eureka.datahub_folder_member WHERE folder_id = $1`, [f.id]);
      expect(m).toEqual([{ folder_id: f.id, user_id: U.r1a, added_by: U.hr }]);
    },
  },
  {
    route: "POST /api/v1/datahub/versions/:id/download",
    run: async () => {
      const f = await ok("hr", "POST", "/api/v1/datahub/folders", { name: `MA download ${++n}`, level: "internal" });
      const file = pdf("datahub download");
      const r = await ok("hr", "POST", `/api/v1/datahub/folders/${f.id}/files`, { name: "Policy.pdf", contentType: PDF, size: file.length });
      const up = await app.inject({ method: "POST", url: r.upload.url, ...form(r.upload.fields, file) });
      expect(up.statusCode, up.body).toBe(204);
      await new JobRunner(db.worker, [documentScanJob(new LocalDocumentStore(docs), DEFAULT_SCAN_OPTIONS)], silentLogger).tick();
      const res = await call("hr", "POST", `/api/v1/datahub/versions/${r.versionId}/download`, {
        ...SERVER_MANAGED, key: `restricted/documents/${FOREIGN_ID}`, fileObjectId: FOREIGN_ID, classification: "restricted",
        fileName: "payload.html", contentType: "text/html", expiresSeconds: 86_400, stepUpGrantId: FOREIGN_ID, level: "restricted",
      });
      expect(res.statusCode, res.body).toBe(200);
      const { url, expiresAt } = res.json() as { url: string; expiresAt: string };
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
      const got = await app.inject({ method: "GET", url });
      expect(got.rawPayload.equals(file)).toBe(true);
      expect(got.headers["content-type"]).toBe(PDF);
      expect(String(got.headers["content-disposition"])).toBe('attachment; filename="Policy-v1.pdf"');
      const log = await rows(`SELECT user_id, level, step_up_grant_id FROM eureka.datahub_access WHERE version_id = $1`, [r.versionId]);
      expect(log).toEqual([{ user_id: U.hr, level: "internal", step_up_grant_id: null }]);
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

  it("the local storage upload route (registered outside Nest with the local driver) is covered below", () => {
    expect(app.getHttpAdapter().getInstance().hasRoute({ method: "POST", url: LOCAL_UPLOAD_PATH })).toBe(true);
  });
});

/**
 * The local driver's upload route stands in for the S3 presigned POST: like the
 * bucket policy, it accepts exactly the signed fields. A client cannot add its
 * own (status, key, metadata) or change the signed ones; nothing is stored.
 */
describe("mass assignment: local storage upload accepts only the signed fields", () => {
  const quarantined = async () => (await readdir(join(docs, "quarantine", "resume")).catch(() => [] as string[])).sort();
  const file = Buffer.alloc(100, 0x41); // the ticket is for 100 bytes

  it.each([
    ["an extra status field", { status: "clean" }],
    ["an extra metadata field", { "x-amz-meta-scan": "NO_THREATS_FOUND" }],
    ["an extra key field", { key2: `clean/resume/${FOREIGN_ID}` }],
  ])("%s → 400, nothing stored, the resume stays pending", async (_n, extra) => {
    const { resumeId, ticket } = await resumeOf();
    const before = await quarantined();
    const res = await app.inject({ method: "POST", url: ticket.url, ...form({ ...ticket.fields, ...extra }, file) });
    expect(res.statusCode, res.body).toBe(400);
    expect(await quarantined()).toEqual(before);
    expect((await rows(`SELECT status FROM eureka.resume WHERE id = $1`, [resumeId]))[0]!.status).toBe("pending");
  });

  it.each([
    ["a different key", { key: `clean/resume/${FOREIGN_ID}` }],
    ["a different Content-Type", { "Content-Type": "text/html" }],
  ])("%s → 403, nothing stored", async (_n, change) => {
    const { ticket } = await resumeOf();
    const before = await quarantined();
    const res = await app.inject({ method: "POST", url: ticket.url, ...form({ ...ticket.fields, ...change }, file) });
    expect(res.statusCode, res.body).toBe(403);
    expect(await quarantined()).toEqual(before);
  });

  it("the unchanged signed fields are accepted (control)", async () => {
    const { ticket } = await resumeOf();
    const res = await app.inject({ method: "POST", url: ticket.url, ...form(ticket.fields, file) });
    expect(res.statusCode, res.body).toBe(204);
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
    const unknownKey = `Unrecognized key(s) in object: '${field}'`;
    if (c.reports === "detail") expect(res.json().detail, res.body).toBe(unknownKey);
    else expect(res.json().errors, res.body).toEqual([{ path: "", message: unknownKey }]);
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
