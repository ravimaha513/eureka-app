import { BadRequestException, ConflictException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonical, idempotent, parseIdempotencyKey, requestHash } from "../src/platform/idempotency.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

// platform/idempotency.ts (R-14): the one Idempotency-Key implementation, run as eureka_app
// inside the caller's transaction, against the eureka.idempotency_key table (0022).
let db: TestDb;
beforeAll(async () => { db = await createTestDb(); await seedFixtures(db.admin); }, 120_000);
afterAll(async () => { await db?.drop(); });

const E = "POST /test/idempotency";
let n = 0;
const key = () => `idem-${Date.now()}-${++n}`;
/** One committed request: claims, runs fn, stores the answer. */
const run = <T>(k: string | undefined, body: unknown, fn: () => Promise<T>, opts = { required: false }, user = U.r1a) =>
  asUser(db.app, user, (c) => idempotent(c, { id: user }, E, k, body, opts, fn), true);

describe("parseIdempotencyKey: one error vocabulary", () => {
  const msg = (f: () => unknown) => { try { f(); return null; } catch (e) { return [(e as BadRequestException).getStatus(), (e as Error).message]; } };
  it("optional: absent is null, malformed is invalid_idempotency_key", () => {
    expect(parseIdempotencyKey(undefined, { required: false })).toBeNull();
    expect(parseIdempotencyKey("abc-1", { required: false })).toBe("abc-1");
    expect(msg(() => parseIdempotencyKey("has spaces", { required: false }))).toEqual([400, "invalid_idempotency_key"]);
    expect(msg(() => parseIdempotencyKey("", { required: false }))).toEqual([400, "invalid_idempotency_key"]);
    expect(msg(() => parseIdempotencyKey("x".repeat(201), { required: false }))).toEqual([400, "invalid_idempotency_key"]);
  });
  it("required: absent or malformed is idempotency_key_required", () => {
    expect(msg(() => parseIdempotencyKey(undefined, { required: true }))).toEqual([400, "idempotency_key_required"]);
    expect(msg(() => parseIdempotencyKey("has spaces", { required: true }))).toEqual([400, "idempotency_key_required"]);
    expect(parseIdempotencyKey("ok", { required: true })).toBe("ok");
  });
  it("hashes the canonical body: key order and undefined members do not matter", () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }], u: undefined })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});

describe("idempotent()", () => {
  it("no key on an optional endpoint: runs every time and stores nothing", async () => {
    let calls = 0;
    await run(undefined, { a: 1 }, async () => ++calls);
    await run(undefined, { a: 1 }, async () => ++calls);
    expect(calls).toBe(2);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.idempotency_key WHERE endpoint = $1`, [E])).rows[0].n).toBe(0);
  });

  it("no key on a required endpoint: 400 before fn runs", async () => {
    let calls = 0;
    await expect(run(undefined, {}, async () => ++calls, { required: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toBe(0);
  });

  it("same key and body: the stored answer, fn runs once; stored as {status, body}", async () => {
    const k = key();
    let calls = 0;
    const first = await run(k, { a: 1, b: [1, 2] }, async () => ({ id: `id-${++calls}` }));
    const again = await run(k, { b: [1, 2], a: 1 }, async () => ({ id: `id-${++calls}` }));
    expect(first).toEqual({ id: "id-1" });
    expect(again).toEqual(first);
    expect(calls).toBe(1);
    const row = (await db.admin.query(`SELECT response FROM eureka.idempotency_key WHERE key = $1`, [k])).rows[0];
    expect(row.response).toEqual({ status: 201, body: { id: "id-1" } });
  });

  it("same key, another body: 409 idempotency_key_reused, fn not run", async () => {
    const k = key();
    await run(k, { a: 1 }, async () => ({ id: "x" }));
    let ran = false;
    const err = await run(k, { a: 2 }, async () => { ran = true; return {}; }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe("idempotency_key_reused");
    expect(ran).toBe(false);
  });

  it("keys are per user and per endpoint", async () => {
    const k = key();
    await run(k, { a: 1 }, async () => ({ who: "r1a" }));
    expect(await run(k, { a: 1 }, async () => ({ who: "r1b" }), { required: false }, U.r1b)).toEqual({ who: "r1b" });
    expect(await asUser(db.app, U.r1a, (c) => idempotent(c, { id: U.r1a }, `${E}/other`, k, { a: 1 }, { required: false },
      async () => ({ who: "other endpoint" })), true)).toEqual({ who: "other endpoint" });
  });

  it("a failed request rolls the claim back with the write: the key stays usable", async () => {
    const k = key();
    await expect(run(k, { a: 1 }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.idempotency_key WHERE key = $1`, [k])).rows[0].n).toBe(0);
    expect(await run(k, { a: 1 }, async () => ({ ok: true }))).toEqual({ ok: true });
  });

  it("replays rows stored before the helper (bare body)", async () => {
    const k = key();
    const hash = requestHash({ a: 1 });
    await asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ($1,$2,$3,$4)`, [k, U.r1a, E, hash]), true);
    await asUser(db.app, U.r1a, (c) => c.query(
      `UPDATE eureka.idempotency_key SET response = $1 WHERE key = $2`, [JSON.stringify({ id: "legacy", rowVersion: 1 }), k]), true);
    expect(await run(k, { a: 1 }, async () => ({ id: "new" }))).toEqual({ id: "legacy", rowVersion: 1 });
  });

  it("a concurrent repeat waits for the first and then replays it", async () => {
    const k = key();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = run(k, { a: 1 }, async () => { await gate; return { id: `c-${++calls}` }; });
    // The second request blocks on the first's uncommitted claim.
    await new Promise((r) => setTimeout(r, 200));
    const second = run(k, { a: 1 }, async () => ({ id: `c-${++calls}` }));
    await new Promise((r) => setTimeout(r, 200));
    release();
    expect(await Promise.all([first, second])).toEqual([{ id: "c-1" }, { id: "c-1" }]);
    expect(calls).toBe(1);
  });
});
