import "reflect-metadata";
import { Controller, Get, Module, Post, RequestMethod, type Type } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "@eureka/shared";
import { AppModule } from "../src/app.module.js";
import { AccessService } from "../src/platform/access.service.js";
import {
  AuthGuard, PORTAL_ROUTE, PUBLIC_ROUTE, Public, REQUIRED_PERMISSION, RequirePermission, SELF_SERVICE_ROUTE, SelfService,
} from "../src/platform/auth.guard.js";
import { CONFIG, loadConfig } from "../src/platform/config.js";
import { DbService } from "../src/platform/db.service.js";
import { setLogWriter } from "../src/platform/logger.js";
import { PortalSessionService } from "../src/platform/portal-session.service.js";
import { SessionService } from "../src/platform/session.service.js";
import type { DocumentStorage } from "../src/platform/storage/document-storage.js";
import { U, toUserAccess } from "./fixtures.js";

/**
 * Route authorization posture (audit R-09, F-08/D-12/B-12). Staff routes are
 * default-deny: every route declares exactly one of RequirePermission, Public,
 * PortalRoute or SelfService, and the guard refuses (403) a staff route that
 * declares none. SelfService ("any signed-in staff user; data scope from RLS or
 * the service") and Public routes are listed below: adding one, or an
 * undecorated route, fails here until the list is reviewed and updated.
 */

/** Reviewed: any signed-in staff user may call these; scope comes from RLS or a check in the service. */
const SELF_SERVICE: readonly string[] = [
  // calendar: calendar:block or interview:create, checked in the handler (RequirePermission takes one)
  "GET /api/v1/calendar/support/busy",
  // identity: own session, profile, preferences and step-up state
  "POST /api/auth/logout",
  "POST /api/auth/password/change",
  "GET /api/v1/me",
  "GET /api/auth/step-up",
  "POST /api/auth/step-up/start",
  "GET /api/auth/step-up/callback",
  "POST /api/auth/step-up/password",
  "POST /api/auth/step-up/dev",
  "GET /api/v1/settings/profile",
  "PUT /api/v1/settings/profile",
  "GET /api/v1/settings/notifications",
  "PUT /api/v1/settings/notifications/:type",
  "GET /api/v1/settings/sessions",
  "POST /api/v1/settings/sessions/:id/revoke",
  "POST /api/v1/settings/sessions/revoke-others",
  // own inbox (RLS: recipient = caller)
  "GET /api/v1/notifications",
  "GET /api/v1/notifications/unread-count",
  "POST /api/v1/notifications/:id/read",
  "POST /api/v1/notifications/:id/unread",
  "POST /api/v1/notifications/read-all",
  // pickers: per-key permission checks in LookupsService
  "GET /api/v1/lookups",
  // service: audit:read, or document.restricted:read with access to that document
  "GET /api/v1/document-access",
  // RLS: job readers, the hiring manager, interviewers
  "GET /api/v1/jobs/:id",
  // RLS + definer re-checks: HR, the job's hiring manager, the application's interviewers
  "GET /api/v1/applications",
  "GET /api/v1/applications/:id",
  "POST /api/v1/applications/:id/status",
  "POST /api/v1/applications/:id/interviews",
  "POST /api/v1/application-interviews/:id/status",
  "PUT /api/v1/application-interviews/:id/people",
  "PUT /api/v1/application-interviews/:id/scorecard",
  // service: vendor.preferred:read or vendor.preferred:create
  "GET /api/v1/preferred-vendors",
  "GET /api/v1/preferred-vendors/:id",
];

/** Reviewed: reachable without a staff session. */
const PUBLIC: readonly string[] = [
  "GET /api/public/feedback/:token",
  "POST /api/public/feedback/:token",
  "GET /api/health/live",
  "GET /api/health/ready",
  "GET /api/health",
  "GET /api/auth/login",
  "GET /api/auth/callback",
  "POST /api/auth/dev-login",
  "GET /api/auth/methods",
  "POST /api/auth/password-login",
  "POST /api/auth/password/setup",
];

/**
 * Routes in modules another change owns, still undecorated on this branch. Each must gain the
 * posture named here; until then it is accepted as either undecorated or that posture (and the
 * guard refuses it while undecorated). Remove an entry once the decorator lands.
 */
const PENDING: Readonly<Record<string, "self-service">> = {};

type Posture = "permission" | "public" | "portal" | "self-service";
const KEYS: Record<Posture, string> = {
  permission: REQUIRED_PERMISSION, public: PUBLIC_ROUTE, portal: PORTAL_ROUTE, "self-service": SELF_SERVICE_ROUTE,
};

/** Every route of the controllers registered in AppModule, with the postures declared on the handler or its class. */
function inventory(): { route: string; where: string; postures: Posture[] }[] {
  const config = loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    PASSWORD_LOGIN: "on", EUREKA_ENVIRONMENT: "local", DATABASE_URL: "postgres://x@127.0.0.1:1/none",
  });
  const controllers = (AppModule.forConfig(config, {} as DocumentStorage).controllers ?? []) as Type[];
  const paths = (v: unknown): string[] => (Array.isArray(v) ? v : [v ?? ""]).map(String);
  const out: { route: string; where: string; postures: Posture[] }[] = [];
  for (const ctrl of controllers) {
    for (const base of paths(Reflect.getMetadata("path", ctrl))) {
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        if (name === "constructor" || typeof handler !== "function") continue;
        const method = Reflect.getMetadata("method", handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const postures = (Object.keys(KEYS) as Posture[]).filter((k) =>
          Reflect.getMetadata(KEYS[k], handler) !== undefined || Reflect.getMetadata(KEYS[k], ctrl) !== undefined);
        for (const p of paths(Reflect.getMetadata("path", handler))) {
          const route = `${RequestMethod[method]} ${`/${base}/${p}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1")}`;
          out.push({ route, where: `${ctrl.name}.${name}`, postures });
        }
      }
    }
  }
  return out;
}

describe("route inventory: every staff route declares its authorization posture", () => {
  const routes = inventory();
  const withPosture = (p: Posture) => routes.filter((r) => r.postures.includes(p)).map((r) => r.route).sort();

  it("finds the registered routes", () => {
    expect(routes.length).toBeGreaterThan(300);
    expect(new Set(routes.map((r) => r.route)).size, "duplicate routes").toBe(routes.length);
  });

  it("no route declares more than one posture", () => {
    expect(routes.filter((r) => r.postures.length > 1).map((r) => `${r.route} (${r.where}): ${r.postures.join(", ")}`)).toEqual([]);
  });

  it("no route is undecorated (except the pending list)", () => {
    const none = routes.filter((r) => r.postures.length === 0).map((r) => r.route);
    expect(none.filter((r) => !(r in PENDING)), "routes without RequirePermission / Public / PortalRoute / SelfService").toEqual([]);
  });

  it("pending routes exist and are undecorated or carry the posture they are waiting for", () => {
    for (const [route, want] of Object.entries(PENDING)) {
      const r = routes.find((x) => x.route === route);
      expect(r, `${route} is not a route`).toBeDefined();
      expect([[], [want]]).toContainEqual(r!.postures);
    }
  });

  it("SelfService routes match the reviewed list", () => {
    const pendingSelf = Object.keys(PENDING).filter((r) => PENDING[r] === "self-service");
    expect(withPosture("self-service").filter((r) => !pendingSelf.includes(r))).toEqual([...SELF_SERVICE].sort());
  });

  it("Public routes match the reviewed list", () => {
    expect(withPosture("public")).toEqual([...PUBLIC].sort());
  });

  it("portal routes live under /api/portal and staff routes never do", () => {
    const portal = (r: string) => /^\S+ \/api\/portal(\/|$)/.test(r);
    expect(withPosture("portal").filter((r) => !portal(r))).toEqual([]);
    expect(routes.filter((r) => !r.postures.includes("portal") && portal(r.route)).map((r) => r.route)).toEqual([]);
  });
});

// ---- guard: an undecorated staff route is refused --------------------------------------------------

const HR = toUserAccess("hr");
const GRANTED = "job:read" as const;
const DENIED = "access:manage" as const;

@Controller("api/v1/route-authz-probe")
class ProbeController {
  @Get("undecorated")
  undecorated() { return { ok: true }; }

  @Post("undecorated")
  undecoratedWrite() { return { ok: true }; }

  @Get("self")
  @SelfService()
  self() { return { ok: true }; }

  @Get("granted")
  @RequirePermission(GRANTED)
  granted() { return { ok: true }; }

  @Get("denied")
  @RequirePermission(DENIED)
  denied() { return { ok: true }; }

  @Get("public")
  @Public()
  open() { return { ok: true }; }
}

@SelfService()
@Controller("api/v1/route-authz-probe-class")
class ClassSelfServiceController {
  @Get()
  get() { return { ok: true }; }
}

describe("AuthGuard: fail-closed for staff routes", () => {
  let app: NestFastifyApplication;
  let lines: Record<string, unknown>[] = [];
  let restore: ((line: string) => void) | undefined;
  let signedIn = true;

  beforeAll(async () => {
    @Module({
      controllers: [ProbeController, ClassSelfServiceController],
      providers: [
        { provide: CONFIG, useValue: { PASSWORD_LOGIN: "off" } },
        { provide: SessionService, useValue: {
          readSessionId: () => "sid",
          resolve: async () => (signedIn ? { userId: U.hr, idHash: Buffer.from("h"), authTime: new Date() } : null),
          verifyCsrf: () => true,
        } },
        { provide: DbService, useValue: { withUser: async (_u: string, fn: (c: unknown) => unknown) => fn({}) } },
        { provide: AccessService, useValue: { load: async () => HR } },
        { provide: PortalSessionService, useValue: {} },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    })
    class ProbeModule {}
    app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    restore = setLogWriter((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  });

  afterAll(async () => {
    if (restore) setLogWriter(restore);
    await app?.close();
  });

  const get = (url: string, method: "GET" | "POST" = "GET") => app.inject({ method, url: `/api/v1/${url}` });

  it("preconditions: the probe user holds one permission and lacks the other", () => {
    expect(can(HR, GRANTED)).toBe(true);
    expect(can(HR, DENIED)).toBe(false);
  });

  it("an undecorated route is 403 for a signed-in user, and logs the route template only", async () => {
    lines = [];
    const r = await get("route-authz-probe/undecorated?q=jane@example.test");
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toBe("Not permitted");
    expect((await get("route-authz-probe/undecorated", "POST")).statusCode).toBe(403);
    const warn = lines.filter((l) => l.msg === "route declares no authorization posture");
    expect(warn).toHaveLength(2);
    expect(warn[0]).toMatchObject({ level: "warn", context: "AuthGuard", method: "GET", route: "/api/v1/route-authz-probe/undecorated" });
    expect(JSON.stringify(warn)).not.toContain("jane");
    expect(JSON.stringify(warn)).not.toContain(U.hr);
  });

  it("an undecorated route still asks for sign-in first (401 without a session)", async () => {
    signedIn = false;
    try {
      expect((await get("route-authz-probe/undecorated")).statusCode).toBe(401);
    } finally {
      signedIn = true;
    }
  });

  it("decorated routes behave as before", async () => {
    expect((await get("route-authz-probe/self")).statusCode).toBe(200);
    expect((await get("route-authz-probe-class")).statusCode).toBe(200);
    expect((await get("route-authz-probe/granted")).statusCode).toBe(200);
    expect((await get("route-authz-probe/denied")).statusCode).toBe(403);
    signedIn = false;
    try {
      expect((await get("route-authz-probe/public")).statusCode).toBe(200);
      expect((await get("route-authz-probe/self")).statusCode).toBe(401);
    } finally {
      signedIn = true;
    }
  });
});
