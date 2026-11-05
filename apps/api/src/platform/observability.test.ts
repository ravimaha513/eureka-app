import { createServer, type Server, type Socket } from "node:net";
import { ForbiddenException, Logger, NotFoundException, UnauthorizedException, type ArgumentsHost } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { DbService, STATEMENT_TIMEOUT_MS } from "./db.service.js";
import { ProblemFilter, RETRY_SAFE_CONFLICT, RetryableUnavailable, toProblem } from "./errors.js";
import { JsonLoggerService, apiLog, setLogWriter } from "./logger.js";
import { emfLine, poolMetricLine, requestMetricLine } from "./metrics.js";
import { OidcFailure, OidcService } from "./oidc.service.js";
import { requestIdFrom } from "./request-context.js";
import { HOST_SESSION_COOKIE, SESSION_COOKIE, SessionService } from "./session.service.js";

const base = {
  NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "session-secret-session-secret-session-secret",
  DATABASE_URL: "postgres://x@127.0.0.1:1/z",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let lines: Record<string, unknown>[] = [];
let prevWriter: (line: string) => void;
beforeAll(() => { prevWriter = setLogWriter((l) => lines.push(JSON.parse(l) as Record<string, unknown>)); });
afterAll(() => { setLogWriter(prevWriter); });
afterEach(() => { lines = []; });

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code });

describe("toProblem: database error mapping (R-02, F-11)", () => {
  it.each([
    ["57014", 503, "query_timeout", 1],
    ["53300", 503, "database_busy", 1],
    ["57P01", 503, "database_busy", 1],
    ["57P03", 503, "database_busy", 1],
  ])("%s → %i (retryable, Retry-After)", (code, status, detail, retryAfter) => {
    expect(toProblem(pgError(code))).toEqual({ status, title: "Service Unavailable", detail, retryAfter });
  });

  it.each(["40001", "40P01", "55P03"])("%s → 409 with a retry-safe detail", (code) => {
    expect(toProblem(pgError(code))).toEqual({ status: 409, title: "Conflict", detail: RETRY_SAFE_CONFLICT });
    expect(RETRY_SAFE_CONFLICT).toMatch(/not applied/);
  });

  it.each(["timeout exceeded when trying to connect", "Connection terminated due to connection timeout"])(
    "pool connect timeout (%s) → 503 database_busy", (message) => {
      expect(toProblem(new Error(message))).toEqual({ status: 503, title: "Service Unavailable", detail: "database_busy", retryAfter: 1 });
    });

  it("RetryableUnavailable → 503 with its Retry-After", () => {
    expect(toProblem(new RetryableUnavailable("report_busy", 7))).toEqual({
      status: 503, title: "Service Unavailable", detail: "report_busy", retryAfter: 7 });
  });

  it("keeps the existing mappings", () => {
    expect(toProblem(pgError("42501")).status).toBe(403);
    expect(toProblem(pgError("P0002")).status).toBe(404);
    expect(toProblem(pgError("23505")).status).toBe(409);
    for (const c of ["23503", "23514", "22P02"]) expect(toProblem(pgError(c)).status).toBe(422);
    expect(toProblem(pgError("XX000"))).toEqual({ status: 500, title: "Internal Server Error" });
    expect(toProblem(new Error("x"))).toEqual({ status: 500, title: "Internal Server Error" });
    expect(toProblem(null).status).toBe(500);
    expect(toProblem(new NotFoundException())).toMatchObject({ status: 404, title: "NotFound" });
  });
});

/** A fake Fastify request/reply pair behind an ArgumentsHost. */
function hostFor(req: Record<string, unknown>) {
  const sent: { status?: number; headers: Record<string, string>; body?: Record<string, unknown> } = { headers: {} };
  const reply = {
    status(s: number) { sent.status = s; return reply; },
    header(k: string, v: string) { sent.headers[k] = v; return reply; },
    send(b: Record<string, unknown>) { sent.body = b; return reply; },
  };
  const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => req }) } as unknown as ArgumentsHost;
  return { host, sent };
}

const REQ = { id: "req-1", method: "PATCH", url: "/api/v1/candidates/abc?q=jane@x.example", routeOptions: { url: "/api/v1/candidates/:id" }, user: { id: "user-uuid" } };

describe("ProblemFilter (R-11, F-04)", () => {
  const filter = new ProblemFilter();

  it("adds instance = request id to problem bodies (additive)", () => {
    const { host, sent } = hostFor(REQ);
    filter.catch(new NotFoundException(), host);
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ type: "about:blank", title: "NotFound", status: 404, detail: "Not Found", instance: "req-1" });
  });

  it("sets Retry-After for retryable database errors", () => {
    const { host, sent } = hostFor(REQ);
    filter.catch(pgError("57014"), host);
    expect(sent.status).toBe(503);
    expect(sent.headers["retry-after"]).toBe("1");
    expect(sent.body).toMatchObject({ detail: "query_timeout", instance: "req-1" });
  });

  it("logs a 5xx with reqId, method, route template, userId and pgCode (no raw URL)", () => {
    const { host } = hostFor(REQ);
    filter.catch(pgError("XX000", "internal"), host);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error", msg: "request failed", service: "api", reqId: "req-1", method: "PATCH",
      route: "/api/v1/candidates/:id", userId: "user-uuid", pgCode: "XX000", status: 500, err: "internal",
    });
    expect(JSON.stringify(lines[0])).not.toContain("jane@x.example");
  });

  it("logs 401 and 403 at warn with the fixed reason only", () => {
    filter.catch(new UnauthorizedException("Sign in required"), hostFor({ ...REQ, user: undefined }).host);
    filter.catch(new ForbiddenException("Invalid CSRF token"), hostFor(REQ).host);
    expect(lines.map((l) => [l.level, l.status, l.reason, l.reqId])).toEqual([
      ["warn", 401, "Sign in required", "req-1"], ["warn", 403, "Invalid CSRF token", "req-1"],
    ]);
    expect(lines[0]).not.toHaveProperty("userId");
  });

  it("does not log 4xx other than 401/403", () => {
    filter.catch(new NotFoundException(), hostFor(REQ).host);
    filter.catch(pgError("23505"), hostFor(REQ).host);
    expect(lines).toEqual([]);
  });

  it("unmatched routes log the placeholder route", () => {
    filter.catch(new Error("x"), hostFor({ id: "r2", method: "GET", url: "/nope" }).host);
    expect(lines[0]).toMatchObject({ route: "unmatched", reqId: "r2" });
  });
});

describe("structured logger (R-11)", () => {
  it("drops fields that are not on the allow-list (no PII)", () => {
    apiLog.warn("x", { reqId: "r", email: "a@b.example", phone: "+1555", body: { name: "Jane" }, userId: "u" });
    expect(lines[0]).toEqual({ ts: expect.any(String), level: "warn", msg: "x", service: "api", reqId: "r", userId: "u" });
  });

  it("serves as a Nest LoggerService", () => {
    const svc = new JsonLoggerService();
    svc.log("started", "NestApplication");
    svc.error("failed", "Error: failed\n    at foo (bar.js:1:1)", "Ctx");
    svc.warn(new Error("bad"), "Ctx");
    svc.log({ msg: "obj", email: "a@b.example", status: 200 });
    svc.debug();
    expect(lines).toEqual([
      expect.objectContaining({ level: "info", msg: "started", context: "NestApplication" }),
      expect.objectContaining({ level: "error", msg: "failed", context: "Ctx", stack: expect.stringContaining("at foo") }),
      expect.objectContaining({ level: "warn", msg: "bad", context: "Ctx", errName: "Error" }),
      { ts: expect.any(String), level: "info", msg: "log", service: "api", status: 200 },
    ]);
  });

  it("Nest Logger instances route through it once installed", () => {
    Logger.overrideLogger(new JsonLoggerService());
    try {
      new Logger("StepUp").warn("step-up token refused");
      expect(lines[0]).toMatchObject({ level: "warn", msg: "step-up token refused", context: "StepUp" });
    } finally {
      Logger.overrideLogger(false);
    }
  });
});

describe("request id (R-11)", () => {
  it("uses the X-Ray root of x-amzn-trace-id", () => {
    expect(requestIdFrom("Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1"))
      .toBe("1-5759e988-bd862e3fe1be46a994272793");
    expect(requestIdFrom(["Self=1-abc;Root=1-5759E988-BD862E3FE1BE46A994272793"])).toBe("1-5759e988-bd862e3fe1be46a994272793");
  });

  it.each([undefined, "", "Root=evil\nline", "Root=1-xyz-123", `Root=1-5759e988-${"a".repeat(24)}x`, "a".repeat(600)])(
    "falls back to a random UUID for %j", (h) => {
      expect(requestIdFrom(h)).toMatch(UUID);
    });
});

describe("EMF metrics (R-11)", () => {
  it("formats CloudWatch embedded metric lines", () => {
    expect(JSON.parse(emfLine({ A: "x" }, [{ name: "M", unit: "Count", value: 2 }], { p: 1 }, 1000))).toEqual({
      _aws: { Timestamp: 1000, CloudWatchMetrics: [{ Namespace: "Eureka/API", Dimensions: [["A"]], Metrics: [{ Name: "M", Unit: "Count" }] }] },
      p: 1, A: "x", M: 2,
    });
  });

  it("request lines carry route latency and a 5xx count; pool lines the waiting count", () => {
    const ok = JSON.parse(requestMetricLine({ method: "GET", route: "/api/v1/x/:id", status: 200, durationMs: 12.345, reqId: "r" }));
    expect(ok).toMatchObject({ Route: "/api/v1/x/:id", Method: "GET", Latency: 12.3, Errors5xx: 0, status: 200, reqId: "r" });
    expect(ok._aws.CloudWatchMetrics[0].Dimensions).toEqual([["Route", "Method"]]);
    expect(JSON.parse(requestMetricLine({ method: "GET", route: "/r", status: 503, durationMs: 1, reqId: "r" })).Errors5xx).toBe(1);
    expect(JSON.parse(poolMetricLine({ totalCount: 5, idleCount: 1, waitingCount: 3 }))).toMatchObject({ PoolWaiting: 3, PoolTotal: 5, PoolIdle: 1 });
  });
});

describe("DbService pool resilience (R-02, F-01)", () => {
  it("defaults DB_CONNECT_TIMEOUT_MS to 3000 and validates it", () => {
    expect(loadConfig(base).DB_CONNECT_TIMEOUT_MS).toBe(3000);
    expect(loadConfig({ ...base, DB_CONNECT_TIMEOUT_MS: "500" }).DB_CONNECT_TIMEOUT_MS).toBe(500);
    for (const v of ["0", "99", "30001", "x"]) expect(() => loadConfig({ ...base, DB_CONNECT_TIMEOUT_MS: v })).toThrow(/Invalid configuration/);
  });

  it("sets statement_timeout and connectionTimeoutMillis in the pool config and listens for pool errors", async () => {
    const db = new DbService(loadConfig({ ...base, DB_CONNECT_TIMEOUT_MS: "1234" }));
    try {
      const opts = (db.pool as unknown as { options: Record<string, unknown> }).options;
      expect(opts.statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
      expect(STATEMENT_TIMEOUT_MS).toBe(5000);
      expect(opts.connectionTimeoutMillis).toBe(1234);
      expect(db.pool.listenerCount("error")).toBe(1);
      expect(db.pool.listenerCount("connect")).toBe(1);
      // An idle-client error is logged, not thrown.
      db.pool.emit("error", pgError("57P01", "terminating connection due to administrator command"));
      expect(lines[0]).toMatchObject({ level: "error", msg: "idle database client error", pgCode: "57P01" });
    } finally {
      await db.onModuleDestroy();
    }
  });

  describe("connect timeout", () => {
    let server: Server;
    let port = 0;
    const sockets: Socket[] = [];
    beforeAll(async () => {
      // Accepts TCP connections and never answers: pg's connect times out.
      server = createServer((s) => { sockets.push(s); });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as { port: number }).port;
    });
    afterAll(async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    });

    it("becomes a RetryableUnavailable (503, Retry-After) instead of hanging", async () => {
      const db = new DbService(loadConfig({ ...base, DATABASE_URL: `postgres://x:y@127.0.0.1:${port}/z`, DB_CONNECT_TIMEOUT_MS: "150" }));
      try {
        const err = await db.system(async () => 1).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RetryableUnavailable);
        expect(toProblem(err)).toEqual({ status: 503, title: "Service Unavailable", detail: "database_busy", retryAfter: 1 });
      } finally {
        await db.onModuleDestroy();
      }
    });
  });
});

describe("staff session cookie (F-14)", () => {
  const svc = (env: Record<string, string>) => new SessionService(null as never, loadConfig({ ...base, ...env }));

  it("plain HTTP keeps eureka_sid without Secure", () => {
    const s = svc({});
    expect(s.cookieName).toBe(SESSION_COOKIE);
    expect(s.sessionCookieOptions()).toEqual({ httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 12 * 3600 });
    expect(s.readSessionId({ [SESSION_COOKIE]: "a" })).toBe("a");
    expect(s.readSessionId({ [HOST_SESSION_COOKIE]: "a" })).toBeUndefined();
  });

  it("HTTPS uses __Host-eureka_sid, Secure, Path=/ and no Domain", () => {
    const s = svc({ PUBLIC_BASE_URL: "https://eureka.example" });
    expect(s.cookieName).toBe("__Host-eureka_sid");
    const o = s.sessionCookieOptions();
    expect(o).toMatchObject({ secure: true, path: "/" });
    expect(o).not.toHaveProperty("domain");
  });

  it("production is Secure even with an http base URL", () => {
    const cfg = { ...loadConfig({ ...base, PUBLIC_BASE_URL: "http://x.example" }), NODE_ENV: "production" as const };
    expect(new SessionService(null as never, cfg).secureCookies).toBe(true);
  });

  it("reads the old cookie name during the transition, preferring the new one", () => {
    const s = svc({ PUBLIC_BASE_URL: "https://eureka.example" });
    expect(s.readSessionId({ [SESSION_COOKIE]: "old" })).toBe("old");
    expect(s.readSessionId({ [SESSION_COOKIE]: "old", [HOST_SESSION_COOKIE]: "new" })).toBe("new");
    expect(s.readSessionId(undefined)).toBeUndefined();
  });
});

describe("OIDC token exchange (F-05)", () => {
  const oidc = () => new OidcService(loadConfig({
    ...base, AUTH_MODE: "google", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_HOSTED_DOMAIN: "eureka.example",
  }));

  it("times out a token endpoint that never answers", async () => {
    const o = oidc();
    o.exchangeTimeoutMs = 50;
    o.fetchImpl = (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
    const started = Date.now();
    await expect(o.exchange("c", "v", "https://x/cb")).rejects.toMatchObject({ reason: "unavailable", message: "token exchange timed out" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("classifies refused and failed exchanges", async () => {
    const o = oidc();
    o.fetchImpl = async () => new Response("{}", { status: 400 });
    await expect(o.exchange("c", "v", "https://x/cb")).rejects.toMatchObject({ reason: "signin_failed" });
    o.fetchImpl = async () => new Response("{}", { status: 503 });
    await expect(o.exchange("c", "v", "https://x/cb")).rejects.toMatchObject({ reason: "unavailable" });
    o.fetchImpl = async () => { throw new TypeError("fetch failed"); };
    await expect(o.exchange("c", "v", "https://x/cb")).rejects.toBeInstanceOf(OidcFailure);
    o.fetchImpl = async () => new Response("{}", { status: 200 });
    await expect(o.exchange("c", "v", "https://x/cb")).rejects.toMatchObject({ reason: "signin_failed" });
    o.fetchImpl = async () => new Response(JSON.stringify({ id_token: "t" }), { status: 200 });
    expect(await o.exchange("c", "v", "https://x/cb")).toBe("t");
  });
});
