import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORK_AUTH_NUMBER_MASK, can, candidateVisible, resolveScope, workAuthAccess } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";
import { FieldCipher, sealWith } from "../src/platform/crypto/field-crypto.js";
import { LocalKeyProvider } from "../src/platform/crypto/key-provider.js";

/**
 * Work authorization API (FR-VIS-01, 02; docs/work-authorization-api.md):
 * authorization matrix against the engine, masking, the audited reveal with
 * step-up, and that the number never reaches audit_event, outbox_event or a
 * response other than the reveal.
 */
let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];
const NUMBER = "EAC2190054321";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();
async function login(key: keyof typeof U, fresh = false): Promise<Session> {
  const cached = sessions.get(key);
  if (cached && !fresh) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}
async function call(key: keyof typeof U, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}
const patch = (key: keyof typeof U, url: string, version: number | null, body: unknown) =>
  call(key, "PATCH", url, body, version === null ? {} : { "if-match": `"${version}"` });
const base = (candidateId: string) => `/api/v1/candidates/${candidateId}/work-authorizations`;
const fresh = () => newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
const auditText = async () => (await db.admin.query<{ t: string }>(`SELECT coalesce(string_agg(changes::text || action, ' '), '') AS t FROM eureka.audit_event`)).rows[0]!.t;
const outboxText = async () => (await db.admin.query<{ t: string }>(`SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM eureka.outbox_event`)).rows[0]!.t;

async function created(candidateId: string, body: Record<string, unknown> = { type: "h1b", number: NUMBER, validFrom: "2025-10-01", validTo: "2028-09-30", status: "valid" }) {
  const r = await call("imm", "POST", base(candidateId), body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; rowVersion: number };
}

describe("authorization matrix (engine = API)", () => {
  it.each(users)("%s: list, create", async (key) => {
    const access = toUserAccess(key);
    const cand = candidates.find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active")!;
    const visible = candidateVisible(resolveScope(access, "candidate:read"), cand);
    const wa = workAuthAccess(access, cand);
    const list = await call(key, "GET", base(cand.id));
    expect(list.statusCode).toBe(!can(access, "visa:read") ? 403 : !visible || !wa.read ? 404 : 200);
    if (list.statusCode === 200) expect(list.json().canEdit).toBe(wa.update);
    const create = await call(key, "POST", base(cand.id), { type: "h1b", status: "pending" });
    expect(create.statusCode, create.body).toBe(!can(access, "visa:update") ? 403 : !wa.read ? 404 : !wa.update ? 403 : 201);
  });

  it("an unknown candidate is 404 for Immigration", async () => {
    expect((await call("imm", "GET", base("00000000-0000-4000-8000-000000000999"))).statusCode).toBe(404);
  });
});

describe("number: encrypted, masked, revealed only through the audited call", () => {
  it("create and list never return the number; HR and Immigration see the mask", async () => {
    const cand = await fresh();
    const { id } = await created(cand.id);
    const stored = (await db.admin.query(`SELECT number_enc FROM eureka.work_authorization WHERE id = $1`, [id])).rows[0].number_enc as Buffer;
    expect(stored.includes(Buffer.from(NUMBER))).toBe(false);
    for (const key of ["imm", "hr"] as const) {
      const r = await call(key, "GET", base(cand.id));
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(NUMBER);
      expect(r.json().items).toEqual([expect.objectContaining({
        id, type: "h1b", numberMasked: WORK_AUTH_NUMBER_MASK, hasNumber: true, validFrom: "2025-10-01", validTo: "2028-09-30",
        status: "valid", expired: false, rowVersion: 1, updatedBy: { id: U.imm, name: "imm" },
      })]);
      expect(r.json().canEdit).toBe(key === "imm");
    }
  });

  it("reveal: HR and Immigration get the number; audited without it; nothing in audit or outbox holds it", async () => {
    const cand = await fresh();
    const { id } = await created(cand.id);
    for (const key of ["imm", "hr"] as const) {
      const before = (await db.admin.query(`SELECT coalesce(max(seq), 0) AS s FROM eureka.audit_event`)).rows[0].s;
      const r = await call(key, "POST", `${base(cand.id)}/${id}/reveal`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ id, number: NUMBER });
      expect(r.headers["cache-control"]).toBe("no-store");
      const audit = (await db.admin.query(`SELECT actor_id, action, entity_type, entity_id, changes FROM eureka.audit_event WHERE seq > $1`, [before])).rows;
      expect(audit).toEqual([{ actor_id: U[key], action: "work_authorization.number_revealed", entity_type: "work_authorization", entity_id: id, changes: { candidateId: cand.id } }]);
    }
    expect(await auditText()).not.toContain(NUMBER);
    expect(await outboxText()).not.toContain(NUMBER);
    // Sales, CEO, Accounts, Documents Team: no visa:read.
    for (const key of ["r1a", "l1", "m1", "ceo", "acct", "admin"] as const) {
      expect((await call(key, "POST", `${base(cand.id)}/${id}/reveal`)).statusCode).toBe(403);
    }
    // A record of another candidate is not found through this candidate.
    const other = await fresh();
    expect((await call("imm", "POST", `${base(other.id)}/${id}/reveal`)).statusCode).toBe(404);
  });

  it("reveal needs a sign-in within 15 minutes (step-up); a stale session gets 403 step_up_required and no audit row", async () => {
    const cand = await fresh();
    const { id } = await created(cand.id);
    const s = await login("hr", true);
    await db.admin.query(`UPDATE eureka.session SET auth_time = now() - interval '16 minutes' WHERE user_id = $1`, [U.hr]);
    const before = (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'work_authorization.number_revealed'`)).rows[0].n;
    const r = await app.inject({ method: "POST", url: `${base(cand.id)}/${id}/reveal`, headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
    expect(r.statusCode).toBe(403);
    expect(r.json().detail).toBe("step_up_required");
    expect(r.body).not.toContain(NUMBER);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'work_authorization.number_revealed'`)).rows[0].n).toBe(before);
    sessions.delete("hr");
    const again = await login("hr", true);
    const ok = await app.inject({ method: "POST", url: `${base(cand.id)}/${id}/reveal`, headers: { cookie: again.cookie, "x-csrf-token": again.csrf } });
    expect(ok.statusCode).toBe(200);
  });

  it("a number replaced through a forged rotation fails its integrity check: no number, audited, alert (review R1)", async () => {
    const cand = await fresh();
    const { id } = await created(cand.id);
    // A worker (no blind index key) mints this month's key and "rotates" the row to its own value.
    const worker = new FieldCipher(new LocalKeyProvider());
    const month = new Date().toISOString().slice(0, 7);
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE eureka.field_key SET rotation_key = NULL WHERE rotation_key = $1`, [month]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const key = (await worker.rotationKey(db.worker, "work_auth_number", month))!;
    const old = (await db.admin.query(`SELECT number_enc FROM eureka.work_authorization WHERE id = $1`, [id])).rows[0].number_enc;
    const forged = sealWith(key, { cls: "work_auth_number", rowId: id }, "ATTACKER-1");
    expect((await db.worker.query(`SELECT authz.field_rotation_apply('work_auth_number', $1, $2, $3, $4) AS ok`, [id, old, forged, key.id])).rows[0].ok).toBe(true);
    const r = await call("imm", "POST", `${base(cand.id)}/${id}/reveal`);
    expect(r.statusCode).toBe(500);
    expect(r.json().detail).toBe("integrity_check_failed");
    expect(r.body).not.toContain("ATTACKER");
    expect(r.body).not.toContain(NUMBER);
    const audit = (await db.admin.query(`SELECT action, changes FROM eureka.audit_event WHERE entity_id = $1 AND action LIKE 'work_authorization.%' ORDER BY seq`, [id])).rows;
    expect(audit.slice(-2)).toEqual([
      { action: "work_authorization.number_revealed", changes: { candidateId: cand.id } },
      { action: "work_authorization.integrity_failed", changes: { candidateId: cand.id } },
    ]);
    // Re-entering the number through the API restores a verifiable value.
    const cur = (await call("imm", "GET", base(cand.id))).json().items[0];
    expect((await patch("imm", `${base(cand.id)}/${id}`, cur.rowVersion, { number: NUMBER })).statusCode).toBe(200);
    expect((await call("imm", "POST", `${base(cand.id)}/${id}/reveal`)).json().number).toBe(NUMBER);
  });

  it("reveals are limited per user across API tasks: 20 a minute, 200 a day (from the audit log), 429", async () => {
    const cand = await fresh();
    const { id } = await created(cand.id);
    const revealed = async () => (await db.admin.query(
      `SELECT count(*)::int AS n FROM eureka.audit_event WHERE actor_id = $1 AND action = 'work_authorization.number_revealed'`, [U.imm])).rows[0].n;
    // Earlier reveals by this user in the last minute count, whichever task served them.
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`DELETE FROM eureka.audit_event WHERE actor_id = $1 AND action = 'work_authorization.number_revealed'`, [U.imm]);
      await c.query(`INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes, at)
                     SELECT $1, 'work_authorization.number_revealed', 'work_authorization', $2, '{}', now() FROM generate_series(1, 19)`, [U.imm, id]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect((await call("imm", "POST", `${base(cand.id)}/${id}/reveal`)).statusCode).toBe(200);
    const before = await revealed();
    const limited = await call("imm", "POST", `${base(cand.id)}/${id}/reveal`);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().detail).toBe("too_many_reveals");
    expect(limited.body).not.toContain(NUMBER);
    expect(await revealed()).toBe(before);
    // Older than a minute: the per-minute window frees up, the daily cap still applies.
    const c2 = await db.admin.connect();
    try {
      await c2.query("BEGIN");
      await c2.query("SET LOCAL session_replication_role = replica");
      await c2.query(`UPDATE eureka.audit_event SET at = now() - interval '2 hours' WHERE actor_id = $1 AND action = 'work_authorization.number_revealed'`, [U.imm]);
      await c2.query("COMMIT");
    } finally {
      c2.release();
    }
    expect((await call("imm", "POST", `${base(cand.id)}/${id}/reveal`)).statusCode).toBe(200);
    const c3 = await db.admin.connect();
    try {
      await c3.query("BEGIN");
      await c3.query("SET LOCAL session_replication_role = replica");
      await c3.query(`INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes, at)
                      SELECT $1, 'work_authorization.number_revealed', 'work_authorization', $2, '{}', now() - interval '3 hours' FROM generate_series(1, 200)`, [U.imm, id]);
      await c3.query("COMMIT");
    } finally {
      c3.release();
    }
    expect((await call("imm", "POST", `${base(cand.id)}/${id}/reveal`)).statusCode).toBe(429);
    // Another user is not affected.
    expect((await call("hr", "POST", `${base(cand.id)}/${id}/reveal`)).statusCode).toBe(200);
    // Clean up so later tests can reveal as Immigration.
    const c4 = await db.admin.connect();
    try {
      await c4.query("BEGIN");
      await c4.query("SET LOCAL session_replication_role = replica");
      await c4.query(`DELETE FROM eureka.audit_event WHERE actor_id = $1 AND action = 'work_authorization.number_revealed'`, [U.imm]);
      await c4.query("COMMIT");
    } finally {
      c4.release();
    }
  });

  it("a record without a number cannot be revealed (409)", async () => {
    const cand = await fresh();
    const { id } = await created(cand.id, { type: "green_card", status: "valid" });
    expect((await call("imm", "POST", `${base(cand.id)}/${id}/reveal`)).statusCode).toBe(409);
  });

  it("an invalid number is refused with 422 without echoing it; creation is audited without it", async () => {
    const cand = await fresh();
    const bad = await call("imm", "POST", base(cand.id), { type: "h1b", status: "valid", number: "EAC<script>SECRET99" });
    expect(bad.statusCode).toBe(422);
    expect(bad.body).not.toContain("SECRET99");
    const ok = await call("imm", "POST", base(cand.id), { type: "h1b", status: "valid", number: " eac 219 0011111 " });
    expect(ok.statusCode).toBe(201);
    const id = ok.json().id as string;
    expect((await call("imm", "POST", `${base(cand.id)}/${id}/reveal`)).json().number).toBe("EAC2190011111");
    const audit = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'work_authorization.created' AND entity_id = $1`, [id])).rows;
    expect(audit).toEqual([{ changes: { candidateId: cand.id, type: "h1b", status: "valid", validFrom: null, validTo: null, numberSet: true } }]);
    expect(await auditText()).not.toContain("EAC2190011111");
    const dates = await call("imm", "POST", base(cand.id), { type: "h1b", status: "valid", validFrom: "2027-01-01", validTo: "2026-01-01" });
    expect(dates.statusCode).toBe(422);
  });
});

describe("update (PATCH, If-Match optimistic concurrency)", () => {
  it("changes fields, replaces or removes the number, bumps rowVersion; If-Match required (428), stale 412", async () => {
    const cand = await fresh();
    const { id } = await created(cand.id);
    const url = `${base(cand.id)}/${id}`;
    const r1 = await patch("imm", url, 1, { validTo: "2029-09-30" });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toEqual({ id, rowVersion: 2 });
    expect((await patch("imm", url, 1, { status: "revoked" })).statusCode).toBe(412);
    expect((await patch("imm", url, null, { status: "revoked" })).statusCode).toBe(428);
    expect((await call("imm", "PATCH", url, { status: "revoked" }, { "if-match": "*" })).statusCode).toBe(428);
    // Row versions are the server's: never in the body.
    expect((await patch("imm", url, 2, { rowVersion: 2, status: "revoked" })).statusCode).toBe(422);
    const r2 = await patch("imm", url, 2, { number: "WAC9990000001" });
    expect(r2.statusCode).toBe(200);
    expect((await call("imm", "POST", `${url}/reveal`)).json().number).toBe("WAC9990000001");
    const r3 = await patch("imm", url, 3, { number: null, status: "revoked" });
    expect(r3.statusCode).toBe(200);
    const item = (await call("imm", "GET", base(cand.id))).json().items[0];
    expect(item).toMatchObject({ hasNumber: false, numberMasked: null, status: "revoked", validTo: "2029-09-30", rowVersion: 4 });
    const audit = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'work_authorization.updated' AND entity_id = $1 ORDER BY seq`, [id])).rows.map((r) => r.changes);
    expect(audit).toEqual([
      { candidateId: cand.id, validTo: "2029-09-30" },
      { candidateId: cand.id, numberChanged: true, numberSet: true },
      { candidateId: cand.id, status: "revoked", numberChanged: true, numberSet: false },
    ]);
    expect(await auditText()).not.toContain("WAC9990000001");
    // Dates out of order after merging with the stored values.
    expect((await patch("imm", url, 4, { validFrom: "2030-01-01" })).statusCode).toBe(422);
    // HR reads but cannot edit; another candidate's path does not find the record.
    expect((await patch("hr", url, 4, { status: "valid" })).statusCode).toBe(403);
    const other = await fresh();
    expect((await patch("imm", `${base(other.id)}/${id}`, 4, { status: "valid" })).statusCode).toBe(404);
  });

  it("expired is derived from valid_to (New York day), never stored", async () => {
    const cand = await fresh();
    await created(cand.id, { type: "f1_opt", status: "valid", validTo: "2020-05-01" });
    const item = (await call("imm", "GET", base(cand.id))).json().items[0];
    expect(item).toMatchObject({ status: "valid", expired: true });
    expect(item.daysToExpiry).toBeLessThan(0);
  });
});
