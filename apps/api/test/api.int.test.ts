import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, candidateVisible, resolveScope, type Permission } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { OidcService } from "../src/platform/oidc.service.js";
import { AuthController } from "../src/modules/identity/auth.controller.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, TECH_ID, U, USERS, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "dev",
    SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();

async function login(key: keyof typeof U): Promise<Session> {
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

async function call(key: keyof typeof U, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown, csrf = true) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(csrf && method !== "GET" ? { "x-csrf-token": s.csrf } : {}) },
  });
}

const users = Object.keys(U) as (keyof typeof U)[];

describe("authentication and session", () => {
  it("health is public; business endpoints require a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    const r = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(r.statusCode).toBe(401);
    expect(r.headers["content-type"]).toContain("application/problem+json");
  });

  it("dev identity provider cannot be enabled in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "dev", SESSION_SECRET: SECRET, DATABASE_URL: "postgres://x@y/z" }))
      .toThrow(/not allowed in production/);
  });

  it("production requires the CloudFront origin secret", () => {
    expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "google", SESSION_SECRET: SECRET, DATABASE_URL: "postgres://x@y/z",
      GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_HOSTED_DOMAIN: "eureka.example" }))
      .toThrow(/ORIGIN_VERIFY_SECRET is required/);
  });

  it("with an origin secret, only requests carrying it reach the API (health stays open)", async () => {
    const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
    const origin = "cloudfront-origin-secret-cloudfront-origin-secret";
    const guarded = await createApp(loadConfig({
      NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, ORIGIN_VERIFY_SECRET: origin,
      DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
    }));
    try {
      const direct = await guarded.inject({ method: "GET", url: "/api/v1/me" });
      expect(direct.statusCode).toBe(403);
      expect(direct.headers["content-type"]).toContain("application/problem+json");
      const wrong = await guarded.inject({ method: "POST", url: "/api/auth/dev-login", headers: { "x-origin-verify": "nope" },
        payload: { email: "r1a@eureka.example" } });
      expect(wrong.statusCode).toBe(403);
      expect((await guarded.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
      const viaCdn = await guarded.inject({ method: "GET", url: "/api/v1/me", headers: { "x-origin-verify": origin } });
      expect(viaCdn.statusCode).toBe(401); // passes the guard, then needs a session
    } finally {
      await guarded.close();
    }
  });

  it("unknown users cannot sign in", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "nobody@eureka.example" } });
    expect(r.statusCode).toBe(403);
  });

  it("state-changing requests need the session-bound CSRF token", async () => {
    const id = candidates.find((c) => c.recruiterId === U.r1a)!.id;
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${id}`, { priority: "P1" }, false)).statusCode).toBe(403);
    const other = await login("r1b");
    const s = await login("r1a");
    const r = await app.inject({ method: "PATCH", url: `/api/v1/candidates/${id}`, payload: { priority: "P1" },
      headers: { cookie: s.cookie, "x-csrf-token": other.csrf } });
    expect(r.statusCode).toBe(403);
  });

  it("session cookie is httpOnly and SameSite=Lax", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "hr@eureka.example" } });
    const c = String(res.headers["set-cookie"]);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
  });

  it("idle timeout, deactivation and logout end the session", async () => {
    const a = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "acct@eureka.example" } });
    const cookie = String(a.headers["set-cookie"]).split(";")[0]!;
    await db.admin.query(`UPDATE eureka.session SET last_seen_at = now() - interval '2 hours' WHERE user_id = $1`, [U.acct]);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })).statusCode).toBe(401);

    const b = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "imm@eureka.example" } });
    const cookieB = String(b.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: cookieB } });
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: cookieB, "x-csrf-token": me.json().csrfToken } });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: cookieB } })).statusCode).toBe(401);
  });

  it("/me returns roles and capabilities from the catalog", async () => {
    const r = await call("locD", "GET", "/api/v1/me");
    expect(r.json().roles).toEqual([{ key: "location_ops_admin", label: "Location Ops Admin", locationId: LOC.dallas }]);
    expect(r.json().capabilities).toContain("candidate.rating:update");
    expect(r.json().capabilities).not.toContain("candidate:update");
  });
});

describe("authorization matrix (generated from the catalog)", () => {
  const someCandidate = () => candidates[0]!.id;
  const endpoints: { perm: Permission; method: "GET" | "POST" | "PATCH" | "PUT"; url: () => string; body?: unknown }[] = [
    { perm: "hotlist:read", method: "GET", url: () => "/api/v1/hotlist" },
    { perm: "candidate:read", method: "GET", url: () => "/api/v1/candidates" },
    { perm: "submission:read", method: "GET", url: () => "/api/v1/submissions" },
    { perm: "submission:create", method: "POST", url: () => "/api/v1/submissions", body: {} },
    { perm: "candidate:create", method: "POST", url: () => "/api/v1/candidates", body: {} },
    { perm: "candidate:update", method: "PATCH", url: () => `/api/v1/candidates/${someCandidate()}`, body: { bogus: 1 } },
    { perm: "candidate.visibility:update", method: "PUT", url: () => `/api/v1/candidates/${someCandidate()}/visibility`, body: {} },
    { perm: "candidate.rating:update", method: "PUT", url: () => `/api/v1/candidates/${someCandidate()}/technical-rating`, body: {} },
  ];
  const cases = users.flatMap((u) => endpoints.map((e) => [u, e.perm, e] as const));

  it.each(cases)("%s → %s", async (userKey, perm, e) => {
    const res = await call(userKey, e.method, e.url(), e.body);
    if (can(toUserAccess(userKey), perm)) expect(res.statusCode, res.body).not.toBe(403);
    else expect(res.statusCode, res.body).toBe(403);
  });
});

describe("API returns exactly the engine-visible candidates (differential)", () => {
  it.each(users)("%s", async (key) => {
    const access = toUserAccess(key);
    const scope = resolveScope(access, "candidate:read");
    const expected = candidates.filter((c) => candidateVisible(scope, c)).map((c) => c.id).sort();
    const res = await call(key, "GET", "/api/v1/candidates?limit=200");
    if (!scope) { expect(res.statusCode).toBe(403); return; }
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { id: string }) => i.id).sort()).toEqual(expected);
  });
});

describe("candidate endpoints", () => {
  const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active")!;
  const teammate = () => candidates.find((c) => c.recruiterId === U.r1b && c.visibility === "team")!;
  const otherHidden = () => candidates.find((c) => c.teamId === T.t3 && c.visibility === "team")!;
  const otherAllTeams = () => candidates.find((c) => c.teamId === T.t3 && c.visibility === "all_teams" && c.marketingStatus === "active")!;

  it("404 for records outside scope, 403 for visible records the caller may not change", async () => {
    expect((await call("r1a", "GET", `/api/v1/candidates/${otherHidden().id}`)).statusCode).toBe(404);
    expect((await call("r1a", "GET", `/api/v1/candidates/${teammate().id}`)).statusCode).toBe(200);
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${teammate().id}`, { priority: "P1" })).statusCode).toBe(403);
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${otherHidden().id}`, { priority: "P1" })).statusCode).toBe(404);
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${own().id}`, { priority: "P1" })).statusCode).toBe(200);
  });

  it.each([["visibility", "all_teams"], ["teamId", T.t2], ["recruiterId", U.r2a], ["technicalRating", 5], ["status", "stopped"], ["locationId", LOC.austin]])(
    "mass assignment of %s is rejected with 422", async (field, value) => {
      const r = await call("l1", "PATCH", `/api/v1/candidates/${own().id}`, { [field]: value });
      expect(r.statusCode).toBe(422);
    });

  it("phone is shown for own-team candidates and masked for another team's Open-to-all-teams candidate", async () => {
    const mine = (await call("r1a", "GET", `/api/v1/candidates/${teammate().id}`)).json();
    expect(mine.phone).toMatch(/^\+1469555/);
    expect(mine.phoneMasked).toBe(false);
    const theirs = (await call("r1a", "GET", `/api/v1/candidates/${otherAllTeams().id}`)).json();
    expect(theirs.phoneMasked).toBe(true);
    expect(theirs.phone).toMatch(/^•••-•••-\d\d$/);
  });

  it("Hot List is open to everyone (OD-01): other team's candidate listed with masked phone, profile still 404", async () => {
    const other = candidates.find((c) => c.teamId === T.t2 && c.visibility === "team" && c.marketingStatus === "active")!;
    for (const key of ["r1a", "admin"] as const) {
      const items: { id: string; phoneMasked: boolean }[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: typeof items; nextCursor: string | null } = (await call(key, "GET", `/api/v1/hotlist?limit=100${cursor ? `&cursor=${cursor}` : ""}`)).json();
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      const row = items.find((i) => i.id === other.id);
      expect(row, key).toBeDefined();
      expect(row!.phoneMasked).toBe(true);
    }
    expect((await call("r1a", "GET", `/api/v1/candidates/${other.id}`)).statusCode).toBe(404);
  });

  it("lead changes visibility; recruiter cannot", async () => {
    expect((await call("r1a", "PUT", `/api/v1/candidates/${own().id}/visibility`, { visibility: "all_teams" })).statusCode).toBe(403);
    expect((await call("l1", "PUT", `/api/v1/candidates/${teammate().id}/visibility`, { visibility: "all_teams" })).statusCode).toBe(200);
  });

  it("location admin rates candidates in their location only", async () => {
    const dallas = candidates.find((c) => c.locationId === LOC.dallas)!;
    const austin = candidates.find((c) => c.locationId === LOC.austin)!;
    expect((await call("locD", "PUT", `/api/v1/candidates/${dallas.id}/technical-rating`, { rating: 4 })).statusCode).toBe(200);
    expect((await call("locD", "PUT", `/api/v1/candidates/${austin.id}/technical-rating`, { rating: 4 })).statusCode).toBe(404);
  });

  it("status transitions follow the state machine", async () => {
    const r = await call("r1a", "POST", `/api/v1/candidates/${own().id}/transition`, { to: "on_hold" });
    expect(r.json()).toEqual({ id: own().id, status: "on_hold" });
    expect((await call("r1a", "POST", `/api/v1/candidates/${own().id}/transition`, { to: "confirmation" })).statusCode).toBe(422);
    await call("r1a", "POST", `/api/v1/candidates/${own().id}/transition`, { to: "active" });
  });

  it("recruiter creates a candidate in their own team", async () => {
    const r = await call("r1a", "POST", "/api/v1/candidates", { firstName: "New", lastName: "Hire", technologyId: TECH_ID, locationId: LOC.dallas });
    expect(r.statusCode).toBe(201);
    const back = await call("r1b", "GET", `/api/v1/candidates/${r.json().id}`);
    expect(back.json().team.id).toBe(T.t1);
    expect((await call("r1a", "POST", "/api/v1/candidates", { firstName: "X", lastName: "Y", technologyId: TECH_ID, locationId: LOC.dallas, teamId: T.t3 })).statusCode).toBe(403);
  });

  it("writes are audited with sensitive values redacted", async () => {
    const { rows } = await db.admin.query(`SELECT action, changes FROM eureka.audit_event WHERE action = 'candidate.updated' ORDER BY seq DESC LIMIT 1`);
    expect(rows[0].changes).toEqual({ priority: "P1" });
  });
});

describe("submissions", () => {
  it("recruiter submits an Open-to-all-teams candidate; second submission to the same client warns", async () => {
    const cand = candidates.find((c) => c.teamId === T.t3 && c.visibility === "all_teams" && c.marketingStatus === "active")!;
    const first = await call("r1a", "POST", "/api/v1/submissions", { candidateId: cand.id, jobTitle: "Java Developer", clientId: CLIENT_ID });
    expect(first.statusCode).toBe(201);
    expect(first.json().duplicateWarning).toBe(false);
    const second = await call("r1b", "POST", "/api/v1/submissions", { candidateId: cand.id, jobTitle: "Java Developer", clientId: CLIENT_ID });
    expect(second.json().duplicateWarning).toBe(true);
  });

  it("submitting a candidate outside scope returns 404", async () => {
    const hidden = candidates.find((c) => c.teamId === T.t3 && c.visibility === "team")!;
    expect((await call("r1a", "POST", "/api/v1/submissions", { candidateId: hidden.id, jobTitle: "x", clientId: CLIENT_ID })).statusCode).toBe(404);
  });

  it("client cannot set snapshot fields", async () => {
    const cand = candidates.find((c) => c.recruiterId === U.r1a)!;
    expect((await call("r1a", "POST", "/api/v1/submissions", { candidateId: cand.id, jobTitle: "x", clientId: CLIENT_ID, teamId: T.t3 })).statusCode).toBe(422);
  });

  it("owning team sees another team's submission of its candidate; the submitter's teammates do not", async () => {
    const cand = candidates.find((c) => c.teamId === T.t3 && c.visibility === "all_teams" && c.marketingStatus === "active")!;
    const leadOwner = (await call("l3", "GET", "/api/v1/submissions")).json().items.map((i: { candidateId: string }) => i.candidateId);
    expect(leadOwner).toContain(cand.id);
    const r2a = (await call("r2a", "GET", "/api/v1/submissions")).json().items.map((i: { candidateId: string }) => i.candidateId);
    expect(r2a).not.toContain(cand.id);
  });
});

describe("Google OIDC validation", () => {
  let oidc: OidcService;
  let key: CryptoKey;
  const cfg = loadConfig({ NODE_ENV: "test", AUTH_MODE: "google", SESSION_SECRET: SECRET, DATABASE_URL: "postgres://x@y/z",
    GOOGLE_CLIENT_ID: "client-123", GOOGLE_CLIENT_SECRET: "s", GOOGLE_HOSTED_DOMAIN: "eureka.example" });

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    key = pair.privateKey as CryptoKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
    oidc = new OidcService(cfg);
    oidc.useKeySet(createLocalJWKSet({ keys: [jwk] }));
  });

  const token = (claims: Record<string, unknown>) => new SignJWT({ email_verified: true, email: "l1@eureka.example", hd: "eureka.example", nonce: "n1", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://accounts.google.com").setAudience("client-123")
    .setSubject("google-sub-l1").setIssuedAt().setExpirationTime("5m").sign(key);

  it("accepts a valid token", async () => {
    const id = await oidc.verify(await token({}), "n1");
    expect(id).toMatchObject({ sub: "google-sub-l1", email: "l1@eureka.example" });
  });

  it.each([
    ["wrong hosted domain", { hd: "gmail.com" }, "n1", /company domain/],
    ["missing hd (personal account)", { hd: undefined }, "n1", /company domain/],
    ["nonce mismatch", {}, "other", /nonce/],
    ["unverified email", { email_verified: false }, "n1", /not verified/],
  ])("rejects %s", async (_n, claims, nonce, err) => {
    await expect(oidc.verify(await token(claims), nonce)).rejects.toThrow(err);
  });

  it("links by sub, links by email only once, and rejects unknown accounts", async () => {
    const ctrl = app.get(AuthController);
    const first = await ctrl.linkUser("google-sub-l1", "l1@eureka.example");
    expect(first).toBe(U.l1);
    expect(await ctrl.linkUser("google-sub-l1", "renamed@eureka.example")).toBe(U.l1);
    // A different Google account claiming the same email cannot take over the user.
    await expect(ctrl.linkUser("attacker-sub", "l1@eureka.example")).rejects.toThrow(/No active Eureka account/);
    await expect(ctrl.linkUser("x", "stranger@eureka.example")).rejects.toThrow(/No active Eureka account/);
  });
});

void USERS;
