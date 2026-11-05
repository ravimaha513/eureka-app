import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { SharedRateLimiter, type RateSystemDb } from "../src/platform/rate-limit.js";
import { createTestDb, type TestDb } from "./db-harness.js";

/**
 * Shared-store rate limiter (migration 0486, R-24; audit F-06, B-09): the count
 * lives in Postgres, so it holds across API tasks and deploys.
 */
let db: TestDb;
let sys: RateSystemDb;

beforeAll(async () => {
  db = await createTestDb();
  sys = { system: async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
    const c = await db.app.connect();
    try { return await fn(c); } finally { c.release(); }
  } };
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const take = (key: string, limit: number, windowSeconds: number) =>
  db.app.query<{ ok: boolean }>(`SELECT authz.rate_take($1, $2, $3) AS ok`, [key, limit, windowSeconds]).then((r) => r.rows[0]!.ok);

describe("SharedRateLimiter", () => {
  it("one limit across two API tasks (two limiter instances, each with its own memory)", async () => {
    const taskA = new SharedRateLimiter("test.two-tasks", 3, 600_000);
    const taskB = new SharedRateLimiter("test.two-tasks", 3, 600_000);
    expect(await taskA.take("user-1", sys)).toBe(true);
    expect(await taskB.take("user-1", sys)).toBe(true);
    expect(await taskA.take("user-1", sys)).toBe(true);
    expect(await taskB.take("user-1", sys)).toBe(false);
    expect(await taskA.take("user-1", sys)).toBe(false);
    // Other keys and other limiters have their own windows.
    expect(await taskB.take("user-2", sys)).toBe(true);
    expect(await new SharedRateLimiter("test.other", 3, 600_000).take("user-1", sys)).toBe(true);
  });

  it("survives a restart (a new instance keeps counting)", async () => {
    const before = new SharedRateLimiter("test.restart", 2, 600_000);
    expect(await before.take("k", sys)).toBe(true);
    expect(await before.take("k", sys)).toBe(true);
    expect(await new SharedRateLimiter("test.restart", 2, 600_000).take("k", sys)).toBe(false);
  });

  it("the in-memory first gate refuses without a database call", async () => {
    const rl = new SharedRateLimiter("test.gate", 1, 600_000);
    expect(await rl.take("k", sys)).toBe(true);
    let calls = 0;
    const counting: RateSystemDb = { system: async (fn) => { calls++; return sys.system(fn); } };
    expect(await rl.take("k", counting)).toBe(false);
    expect(calls).toBe(0);
  });

  it("inside a transaction that rolls back, the unit is given back", async () => {
    const rl = new SharedRateLimiter("test.tx", 5, 600_000);
    const c = await db.app.connect();
    try {
      await c.query("BEGIN");
      expect(await rl.take("k", c)).toBe(true);
      await c.query("ROLLBACK");
      await c.query("BEGIN");
      expect(await rl.take("k", c)).toBe(true);
      await c.query("COMMIT");
    } finally { c.release(); }
    const n = (await db.admin.query<{ n: number }>(`SELECT sum(n)::int AS n FROM authz.rate_window`)).rows[0]!.n;
    expect(n).toBeGreaterThan(0);
  });

  it("refuses an invalid name", () => {
    expect(() => new SharedRateLimiter("Bad Name!", 1, 1000)).toThrow();
  });
});

describe("authz.rate_take / authz.rate_purge", () => {
  it("never stores the key itself (raw IPs or emails), only a 32-byte digest", async () => {
    await take("ip:203.0.113.7", 10, 60);
    await take("email:jane@example.test", 10, 60);
    const rows = (await db.admin.query<{ k: Buffer }>(`SELECT key_hash AS k FROM authz.rate_window`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.k).toHaveLength(32);
      expect(r.k.toString("latin1")).not.toMatch(/203\.0\.113|jane|example/);
    }
  });

  it("a new window starts when the old one ends", async () => {
    const key = `window-${Date.now()}`;
    // Start right after a second boundary so the two takes land in the same 1 s window.
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 20));
    expect(await take(key, 1, 1)).toBe(true);
    expect(await take(key, 1, 1)).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await take(key, 1, 1)).toBe(true);
  });

  it("refuses NULL and out-of-range inputs (422)", async () => {
    for (const [k, l, w] of [[null, 1, 60], ["", 1, 60], ["x".repeat(201), 1, 60], ["k", 0, 60], ["k", null, 60], ["k", 1, 0], ["k", 1, null], ["k", 1, 604801]]) {
      await expect(db.app.query(`SELECT authz.rate_take($1, $2, $3)`, [k, l, w])).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("the app cannot read or write the table; only the worker may purge", async () => {
    await expect(db.app.query(`SELECT * FROM authz.rate_window`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.query(`DELETE FROM authz.rate_window`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.query(`SELECT authz.rate_purge()`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.worker.query(`SELECT authz.rate_take('k', 1, 60)`)).rejects.toMatchObject({ code: "42501" });
  });

  it("rate_purge deletes expired windows only", async () => {
    await take("purge-live", 5, 3600);
    await db.admin.query(`INSERT INTO authz.rate_window (key_hash, window_start, expires_at, n)
                          VALUES (sha256('purge-old'::bytea), now() - interval '2 hours', now() - interval '1 hour', 3)`);
    const live = (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM authz.rate_window WHERE expires_at > now()`)).rows[0]!.n;
    const purged = (await db.worker.query<{ n: number }>(`SELECT authz.rate_purge() AS n`)).rows[0]!.n;
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM authz.rate_window WHERE expires_at <= now()`)).rows[0]!.n).toBe(0);
    expect((await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM authz.rate_window`)).rows[0]!.n).toBe(live);
  });
});
