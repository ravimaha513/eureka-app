import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { DbService } from "./db.service.js";
import { originGuard } from "./origin-guard.js";

const SECRET = "session-secret-session-secret-session-secret";
const base = { NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, DATABASE_URL: "postgres://x@127.0.0.1:1/z" };
const google = { ...base, AUTH_MODE: "google", GOOGLE_HOSTED_DOMAIN: "eureka.example" };
const S1 = "origin-secret-one-origin-secret-one-000";
const S2 = "origin-secret-two-origin-secret-two-000";

describe("DB pool size (DB_POOL_MAX)", () => {
  it("defaults to 10 and accepts 1..50", () => {
    expect(loadConfig(base).DB_POOL_MAX).toBe(10);
    expect(loadConfig({ ...base, DB_POOL_MAX: "5" }).DB_POOL_MAX).toBe(5);
    expect(loadConfig({ ...base, DB_POOL_MAX: "1" }).DB_POOL_MAX).toBe(1);
    expect(loadConfig({ ...base, DB_POOL_MAX: "50" }).DB_POOL_MAX).toBe(50);
  });

  it.each(["0", "51", "2.5", "abc"])("rejects %s", (v) => {
    expect(() => loadConfig({ ...base, DB_POOL_MAX: v })).toThrow(/Invalid configuration/);
  });

  it("is applied to the pg pool", async () => {
    const db = new DbService(loadConfig({ ...base, DB_POOL_MAX: "5" }));
    try {
      expect((db.pool as unknown as { options: { max: number } }).options.max).toBe(5);
    } finally {
      await db.onModuleDestroy();
    }
  });
});

describe("Google OAuth placeholder", () => {
  it("rejects the Terraform 'set-me' placeholder when AUTH_MODE=google", () => {
    expect(() => loadConfig({ ...google, GOOGLE_CLIENT_ID: "set-me", GOOGLE_CLIENT_SECRET: "real-secret" })).toThrow(/placeholder/);
    expect(() => loadConfig({ ...google, GOOGLE_CLIENT_ID: "client-123", GOOGLE_CLIENT_SECRET: "set-me" })).toThrow(/placeholder/);
  });

  it("accepts real values, and ignores the placeholder in dev mode", () => {
    expect(loadConfig({ ...google, GOOGLE_CLIENT_ID: "client-123", GOOGLE_CLIENT_SECRET: "s" }).GOOGLE_CLIENT_ID).toBe("client-123");
    expect(loadConfig({ ...base, GOOGLE_CLIENT_ID: "set-me", GOOGLE_CLIENT_SECRET: "set-me" }).AUTH_MODE).toBe("dev");
  });
});

describe("ORIGIN_VERIFY_SECRET list", () => {
  it("accepts one secret or a comma-separated list", () => {
    expect(loadConfig({ ...base, ORIGIN_VERIFY_SECRET: S1 }).ORIGIN_VERIFY_SECRET).toBe(S1);
    expect(loadConfig({ ...base, ORIGIN_VERIFY_SECRET: `${S1},${S2}` }).ORIGIN_VERIFY_SECRET).toBe(`${S1},${S2}`);
    expect(loadConfig({ ...base, ORIGIN_VERIFY_SECRET: ` ${S1} , ${S2} ` }).ORIGIN_VERIFY_SECRET).toBeDefined();
  });

  it.each([["short"], [`${S1},short`], [","], [""]])("rejects %j", (v) => {
    expect(() => loadConfig({ ...base, ORIGIN_VERIFY_SECRET: v })).toThrow(/at least 32 characters/);
  });
});

describe("origin guard", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.addHook("onRequest", originGuard(`${S1}, ${S2}`));
    app.get("/api/health", async () => ({ status: "ok" }));
    app.get("/api/healthz", async () => ({ status: "other" }));
    app.get("/api/v1/me", async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (url: string, remoteAddress: string, secret?: string) =>
    app.inject({ method: "GET", url, remoteAddress, headers: secret === undefined ? {} : { "x-origin-verify": secret } });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("lets the container health check through from %s", async (ip) => {
    expect((await get("/api/health", ip)).statusCode).toBe(200);
    expect((await get("/api/health?deep=1", ip)).statusCode).toBe(200);
  });

  it("requires the secret for health from anywhere else (VPC link)", async () => {
    const r = await get("/api/health", "10.40.1.23");
    expect(r.statusCode).toBe(403);
    expect(r.headers["content-type"]).toContain("application/problem+json");
    expect((await get("/api/health", "10.40.1.23", S1)).statusCode).toBe(200);
  });

  it("only exempts the exact health path", async () => {
    expect((await get("/api/healthz", "127.0.0.1")).statusCode).toBe(403);
    expect((await get("/api/health/../v1/me", "127.0.0.1")).statusCode).toBe(403);
    expect((await get("/api/v1/me", "127.0.0.1")).statusCode).toBe(403);
  });

  it("accepts any secret in the list and rejects others", async () => {
    expect((await get("/api/v1/me", "10.40.1.23", S1)).statusCode).toBe(200);
    expect((await get("/api/v1/me", "10.40.1.23", S2)).statusCode).toBe(200);
    expect((await get("/api/v1/me", "10.40.1.23", `${S1},${S2}`)).statusCode).toBe(403);
    expect((await get("/api/v1/me", "10.40.1.23", "nope")).statusCode).toBe(403);
    expect((await get("/api/v1/me", "10.40.1.23", "")).statusCode).toBe(403);
    expect((await get("/api/v1/me", "10.40.1.23")).statusCode).toBe(403);
  });

  it("refuses to build without a secret", () => {
    expect(() => originGuard(" , ")).toThrow();
  });
});
