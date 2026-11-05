import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { DbService } from "../src/platform/db.service.js";
import { RetryableUnavailable } from "../src/platform/errors.js";
import { setLogWriter } from "../src/platform/logger.js";
import { OidcService } from "../src/platform/oidc.service.js";
import { HOST_SESSION_COOKIE, SESSION_COOKIE, SessionService } from "../src/platform/session.service.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/**
 * Audit R-02 (pool resilience), R-11 (request id, structured logs, OIDC
 * failure redirects) and F-14 (__Host- staff session cookie). The app runs
 * with an https PUBLIC_BASE_URL so the secure cookie path is exercised.
 */
let db: TestDb;
let app: NestFastifyApplication;
let appUrl: string;
const SECRET = "test-secret-test-secret-test-secret-123";
const BASE = "https://eureka.example";
const DOMAIN = "eureka.example";

let lines: Record<string, unknown>[] = [];
const logLines = (msg: string) => lines.filter((l) => l.msg === msg);

let key: CryptoKey;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  appUrl = `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`;
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "google", SESSION_SECRET: SECRET, DATABASE_URL: appUrl, PUBLIC_BASE_URL: BASE,
    GOOGLE_CLIENT_ID: "client-123", GOOGLE_CLIENT_SECRET: "s", GOOGLE_HOSTED_DOMAIN: DOMAIN,
  }));
  setLogWriter((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey as CryptoKey;
  app.get(OidcService).useKeySet(createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

afterEach(() => { lines = []; });

const sessionFor = async (userId: string) => app.get(SessionService).create(userId, new Date());

describe("request id (R-11)", () => {
  it("echoes a fresh UUID as x-request-id and as instance in problem bodies", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(r.statusCode).toBe(401);
    const id = r.headers["x-request-id"];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.json()).toMatchObject({ status: 401, instance: id });
    // The denial is logged at warn, correlated, without the cookie or other request data.
    expect(logLines("request denied")).toEqual([expect.objectContaining({
      level: "warn", status: 401, reqId: id, method: "GET", route: "/api/v1/me", reason: "Sign in required" })]);
  });

  it("reuses the X-Ray root of x-amzn-trace-id; ignores a client request-id header", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health", headers: {
      "x-amzn-trace-id": "Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1", "request-id": "spoofed" } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-request-id"]).toBe("1-5759e988-bd862e3fe1be46a994272793");
    const spoof = await app.inject({ method: "GET", url: "/api/health", headers: { "request-id": "spoofed" } });
    expect(spoof.headers["x-request-id"]).not.toBe("spoofed");
  });

  it("writes one EMF latency line per response with the route template", async () => {
    const sid = await sessionFor(U.hr);
    const r = await app.inject({ method: "GET", url: `/api/v1/candidates/${U.hr}`, headers: { cookie: `${HOST_SESSION_COOKIE}=${sid}` } });
    const m = lines.filter((l) => l.metric === "request");
    expect(m).toEqual([expect.objectContaining({
      Route: "/api/v1/candidates/:id", Method: "GET", status: r.statusCode, reqId: r.headers["x-request-id"], Errors5xx: 0 })]);
    expect(typeof m[0]!.Latency).toBe("number");
    expect(JSON.stringify(m[0])).not.toContain(U.hr);
  });
});

describe("pool resilience (R-02)", () => {
  it("survives the termination of idle pooled connections and serves the next request", async () => {
    const pool = app.get(DbService).pool;
    // Warm several idle connections.
    await Promise.all([1, 2, 3].map(() => app.inject({ method: "GET", url: "/api/health" })));
    const idle = pool.idleCount;
    expect(idle).toBeGreaterThan(0);
    let errors = 0;
    const onError = () => { errors += 1; };
    pool.on("error", onError);
    const { rows } = await db.admin.query<{ n: number }>(
      `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
       WHERE datname = $1 AND usename = 'eureka_app' AND state = 'idle'`, [db.name]);
    expect(rows[0]!.n).toBe(idle);
    // Each idle client notices its own termination; the pool drops it.
    for (let i = 0; i < 100 && errors < idle; i++) await new Promise((r) => setTimeout(r, 20));
    pool.off("error", onError);
    expect(errors).toBe(idle);
    expect(pool.idleCount).toBe(0);
    expect(logLines("idle database client error")[0]).toMatchObject({ level: "error", pgCode: "57P01" });
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
  });

  it("a connection killed while checked out fails only its own request", async () => {
    const dbs = app.get(DbService);
    const err = await dbs.withUser(U.hr, async (c) => {
      const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await db.admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await new Promise((r) => setTimeout(r, 200));
      await c.query("SELECT 1");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("statement_timeout defaults to 5s per connection and SET LOCAL still overrides it", async () => {
    const dbs = app.get(DbService);
    expect(await dbs.withUser(U.hr, async (c) => (await c.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]!.t)).toBe("5s");
    expect(await dbs.withUser(U.hr, async (c) => {
      await c.query("SET LOCAL statement_timeout = '60s'");
      return (await c.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]!.t;
    })).toBe("1min");
    expect(await dbs.system(async (c) => (await c.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]!.t)).toBe("5s");
  });

  it("an exhausted pool answers RetryableUnavailable after DB_CONNECT_TIMEOUT_MS", async () => {
    const small = new DbService(loadConfig({
      NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, DATABASE_URL: appUrl, DB_POOL_MAX: "1", DB_CONNECT_TIMEOUT_MS: "200" }));
    try {
      let release!: () => void;
      const held = small.system(() => new Promise<void>((r) => { release = r; }));
      await new Promise((r) => setTimeout(r, 100));
      const err = await small.system(async (c) => c.query("SELECT 1")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetryableUnavailable);
      release();
      await held;
      expect((await small.system((c) => c.query<{ n: number }>("SELECT 1 AS n"))).rows[0]!.n).toBe(1);
    } finally {
      await small.onModuleDestroy();
    }
  });
});

describe("staff session cookie over HTTPS (F-14)", () => {
  it("accepts the __Host- cookie and, during the transition, the old eureka_sid", async () => {
    const sid = await sessionFor(U.hr);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: `${HOST_SESSION_COOKIE}=${sid}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: `${SESSION_COOKIE}=${sid}` } })).statusCode).toBe(200);
  });

  it("logout clears both cookie names with Secure", async () => {
    const sid = await sessionFor(U.acct);
    const cookie = `${HOST_SESSION_COOKIE}=${sid}`;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, "x-csrf-token": me.json().csrfToken } });
    expect(out.statusCode).toBe(204);
    const set = ([] as string[]).concat(out.headers["set-cookie"] ?? []);
    expect(set.find((c) => c.startsWith(`${HOST_SESSION_COOKIE}=;`))).toMatch(/Secure/);
    expect(set.find((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBeDefined();
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })).statusCode).toBe(401);
  });
});

describe("Google sign-in callback failures redirect to the login page (F-05)", () => {
  const oidc = () => app.get(OidcService);
  afterEach(() => {
    oidc().fetchImpl = fetch;
    oidc().exchangeTimeoutMs = 10_000;
  });

  /** Starts a sign-in: the sealed state cookie and the state/nonce inside it. */
  async function start() {
    const r = await app.inject({ method: "GET", url: "/api/auth/login" });
    expect(r.statusCode).toBe(302);
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    const payload = cookie.split("=")[1]!.split(".")[0]!;
    const { state, nonce } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { state: string; nonce: string };
    return { cookie, state, nonce };
  }

  const idToken = (sub: string, email: string, nonce: string, hd = DOMAIN) =>
    new SignJWT({ email_verified: true, email, hd, nonce }).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://accounts.google.com").setAudience("client-123").setSubject(sub)
      .setIssuedAt().setExpirationTime("5m").sign(key);

  const tokenEndpoint = (token: string) => { oidc().fetchImpl = async () => new Response(JSON.stringify({ id_token: token }), { status: 200 }); };

  async function callback(cookie: string | null, query: string) {
    const r = await app.inject({ method: "GET", url: `/api/auth/callback?${query}`, headers: cookie ? { cookie } : {} });
    return r;
  }

  const expectLoginError = (r: Awaited<ReturnType<typeof callback>>, code: string) => {
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`${BASE}/login?error=${code}`);
    expect(String(r.headers["set-cookie"] ?? "")).not.toContain(HOST_SESSION_COOKIE);
    const warn = logLines("sign-in failed");
    expect(warn).toEqual([expect.objectContaining({ level: "warn", reason: code, reqId: r.headers["x-request-id"] })]);
    expect(JSON.stringify(warn)).not.toMatch(/@/); // no email in the log line
    expect(logLines("request failed")).toEqual([]);
  };

  it("no or expired state cookie → expired", async () => {
    expectLoginError(await callback(null, "code=c&state=s"), "expired");
  });

  it("state mismatch → signin_failed", async () => {
    const s = await start();
    expectLoginError(await callback(s.cookie, "code=c&state=other"), "signin_failed");
  });

  it("cancelled at Google → cancelled", async () => {
    const s = await start();
    expectLoginError(await callback(s.cookie, `error=access_denied&state=${s.state}`), "cancelled");
  });

  it("token endpoint 400 → signin_failed", async () => {
    const s = await start();
    oidc().fetchImpl = async () => new Response("{}", { status: 400 });
    expectLoginError(await callback(s.cookie, `code=c&state=${s.state}`), "signin_failed");
  });

  it("a token endpoint that never answers times out → unavailable", async () => {
    const s = await start();
    oidc().exchangeTimeoutMs = 100;
    oidc().fetchImpl = (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    expectLoginError(await callback(s.cookie, `code=c&state=${s.state}`), "unavailable");
  });

  it("nonce mismatch → signin_failed", async () => {
    const s = await start();
    tokenEndpoint(await idToken("sub-x", `hr@${DOMAIN}`, "other-nonce"));
    expectLoginError(await callback(s.cookie, `code=c&state=${s.state}`), "signin_failed");
  });

  it("outside the company domain → domain", async () => {
    const s = await start();
    tokenEndpoint(await idToken("sub-y", "someone@gmail.com", s.nonce, "gmail.com"));
    expectLoginError(await callback(s.cookie, `code=c&state=${s.state}`), "domain");
  });

  it("no Eureka account → not_provisioned, and the auth.denied audit row is kept", async () => {
    const s = await start();
    tokenEndpoint(await idToken("sub-z", `nobody@${DOMAIN}`, s.nonce));
    const before = (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'auth.denied'`)).rows[0].n;
    expectLoginError(await callback(s.cookie, `code=c&state=${s.state}`), "not_provisioned");
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'auth.denied'`)).rows[0].n).toBe(before + 1);
    // Rule 5: a reason code and the hosted-domain match, never the email.
    const last = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'auth.denied' ORDER BY seq DESC LIMIT 1`)).rows[0];
    expect(last.changes).toEqual({ reason: "no_matching_account", domainMatch: true });
  });

  it("success sets the __Host- session cookie (Secure, HttpOnly, Lax, Path=/) and redirects home", async () => {
    const s = await start();
    tokenEndpoint(await idToken("sub-hr", `hr@${DOMAIN}`, s.nonce));
    const r = await callback(s.cookie, `code=c&state=${s.state}`);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(BASE);
    const set = ([] as string[]).concat(r.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${HOST_SESSION_COOKIE}=`))!;
    expect(set).toMatch(/; Secure/);
    expect(set).toMatch(/; HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/; Path=\//);
    expect(set).not.toMatch(/Domain=/i);
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: set.split(";")[0]! } });
    expect(me.statusCode).toBe(200);
  });
});
