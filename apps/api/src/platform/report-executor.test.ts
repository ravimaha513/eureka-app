import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { DbService } from "./db.service.js";
import { RetryableUnavailable, toProblem } from "./errors.js";
import {
  REPORT_BUSY_DETAIL, REPORT_BUSY_RETRY_AFTER, REPORT_TIMEOUT_DETAIL, REPORT_TIMEOUT_MS, REPORT_TIMEOUT_RETRY_AFTER,
  ReportExecutor, Semaphore, TtlCache, normalizeParams,
} from "./report-executor.js";

/** A DbService stand-in: withUser hands `fn` a client that records its queries. */
function fakeDb() {
  const queries: string[][] = [];
  let users = 0;
  const db = {
    async withUser<T>(_userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const mine: string[] = [];
      queries.push(mine);
      users++;
      return fn({ query: async (sql: string) => { mine.push(sql); return { rows: [] }; } } as unknown as pg.PoolClient);
    },
  };
  return { db: db as unknown as DbService, queries, calls: () => users };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("Semaphore", () => {
  it("hands out at most max slots, never waits, and releases each slot once", () => {
    const s = new Semaphore(2);
    const a = s.tryAcquire();
    const b = s.tryAcquire();
    expect(a && b).toBeTruthy();
    expect(s.tryAcquire()).toBeNull();
    a!();
    a!(); // double release is a no-op
    expect(s.inUse).toBe(1);
    expect(s.tryAcquire()).not.toBeNull();
    expect(s.tryAcquire()).toBeNull();
  });
});

describe("ReportExecutor.run", () => {
  it("sets the raised timeout (25 s, below the gateway's 29 s) only for heavy runs", async () => {
    const { db, queries } = fakeDb();
    const ex = new ReportExecutor(db, { REPORT_MAX_CONCURRENT: 2 });
    await ex.run("u", {}, async (c) => { await c.query("SELECT 1"); });
    await ex.run("u", { heavy: false }, async (c) => { await c.query("SELECT 2"); });
    expect(REPORT_TIMEOUT_MS).toBeLessThanOrEqual(25_000);
    expect(queries).toEqual([[`SET LOCAL statement_timeout = '${REPORT_TIMEOUT_MS}ms'`, "SELECT 1"], ["SELECT 2"]]);
  });

  it("refuses a heavy run beyond the limit with 503 + Retry-After, without taking a connection", async () => {
    const { db, calls } = fakeDb();
    const ex = new ReportExecutor(db, { REPORT_MAX_CONCURRENT: 2 });
    const gate = deferred();
    const running = [ex.run("a", {}, () => gate.promise), ex.run("b", {}, () => gate.promise)];
    await Promise.resolve();
    const err = await ex.run("c", {}, async () => "never").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableUnavailable);
    expect((err as RetryableUnavailable).retryAfterSeconds).toBe(REPORT_BUSY_RETRY_AFTER);
    expect(toProblem(err)).toMatchObject({ status: 503, detail: REPORT_BUSY_DETAIL });
    expect(calls()).toBe(2);
    // Light runs are not limited.
    await expect(ex.run("d", { heavy: false }, async () => "light")).resolves.toBe("light");
    gate.resolve();
    await Promise.all(running);
    expect(ex.slots.inUse).toBe(0);
    await expect(ex.run("c", {}, async () => "ok")).resolves.toBe("ok");
  });

  it("frees the slot when the report fails", async () => {
    const { db } = fakeDb();
    const ex = new ReportExecutor(db, { REPORT_MAX_CONCURRENT: 1 });
    await expect(ex.run("a", {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(ex.slots.inUse).toBe(0);
  });

  it("maps a statement timeout (57014) to 503 + Retry-After with the module's hint; other errors pass through", async () => {
    const { db } = fakeDb();
    const ex = new ReportExecutor(db, { REPORT_MAX_CONCURRENT: 2 });
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    for (const [opts, detail] of [[{}, REPORT_TIMEOUT_DETAIL], [{ heavy: false, timeoutDetail: "Narrow it" }, "Narrow it"]] as const) {
      const err = await ex.run("u", opts, async () => { throw timeout; }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetryableUnavailable);
      expect((err as RetryableUnavailable).retryAfterSeconds).toBe(REPORT_TIMEOUT_RETRY_AFTER);
      expect(toProblem(err)).toMatchObject({ status: 503, detail });
    }
    const other = Object.assign(new Error("dup"), { code: "23505" });
    await expect(ex.run("u", {}, async () => { throw other; })).rejects.toBe(other);
    expect(ex.slots.inUse).toBe(0);
  });
});

describe("ReportExecutor.cached", () => {
  it("serves a copy within the TTL per user and normalized parameters, reloading after it", async () => {
    let t = 0;
    const { db } = fakeDb();
    const ex = new ReportExecutor(db, { REPORT_MAX_CONCURRENT: 2 }, { ttlMs: 60_000, now: () => t });
    let loads = 0;
    const load = async () => ({ n: ++loads });
    expect(await ex.cached("r", "u1", { a: 1, b: undefined, s: new Set(["x", "y"]) }, load)).toEqual({ n: 1 });
    const hit = await ex.cached("r", "u1", { s: new Set(["y", "x"]), a: 1 }, load);
    expect(hit).toEqual({ n: 1 });
    hit.n = 99; // callers cannot corrupt the cached value
    expect(await ex.cached("r", "u1", { a: 1, s: new Set(["x", "y"]) }, load)).toEqual({ n: 1 });
    expect(await ex.cached("r", "u2", { a: 1, s: new Set(["x", "y"]) }, load)).toEqual({ n: 2 }); // other user
    expect(await ex.cached("r", "u1", { a: 2, s: new Set(["x", "y"]) }, load)).toEqual({ n: 3 }); // other params
    expect(await ex.cached("other", "u1", { a: 1, s: new Set(["x", "y"]) }, load)).toEqual({ n: 4 }); // other report
    t = 60_000;
    expect(await ex.cached("r", "u1", { a: 1, s: new Set(["x", "y"]) }, load)).toEqual({ n: 5 });
  });

  it("does not cache failures", async () => {
    const { db } = fakeDb();
    const ex = new ReportExecutor(db, { REPORT_MAX_CONCURRENT: 2 });
    await expect(ex.cached("r", "u", {}, async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(ex.cached("r", "u", {}, async () => 7)).resolves.toBe(7);
  });
});

describe("TtlCache", () => {
  it("stays within its size bound, evicting expired entries first, then the oldest", () => {
    let t = 0;
    const c = new TtlCache<number>(100, 3, () => t);
    c.set("a", 1);
    t = 50;
    c.set("b", 2);
    c.set("c", 3);
    t = 120; // "a" has expired
    c.set("d", 4);
    expect(c.size).toBe(3);
    expect([c.get("a"), c.get("b"), c.get("c"), c.get("d")]).toEqual([undefined, 2, 3, 4]);
    c.set("e", 5); // nothing expired: the oldest ("b") goes
    expect(c.size).toBe(3);
    expect([c.get("b"), c.get("c"), c.get("d"), c.get("e")]).toEqual([undefined, 3, 4, 5]);
  });
});

describe("normalizeParams", () => {
  it("ignores key order and undefined, and keeps Set contents", () => {
    expect(normalizeParams({ b: 1, a: [new Set([2, 1])], c: undefined })).toBe(normalizeParams({ a: [new Set([1, 2])], b: 1 }));
    expect(normalizeParams({ s: new Set(["a"]) })).not.toBe(normalizeParams({ s: new Set(["b"]) }));
  });
});
