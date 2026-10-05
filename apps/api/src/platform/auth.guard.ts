import {
  Inject,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { can, type Permission, type UserAccess } from "@eureka/shared";
import { AccessService } from "./access.service.js";
import { CONFIG, type AppConfig } from "./config.js";
import { DbService } from "./db.service.js";
import { SESSION_COOKIE, SessionService } from "./session.service.js";
import { PORTAL_HEADER, PortalSessionService } from "./portal-session.service.js";

export interface AuthedUser {
  id: string;
  access: UserAccess;
  sessionHash: Buffer;
  authTime: Date;
}

/** jobs-portal: the signed-in applicant of a portal request. */
export interface AuthedApplicant {
  id: string;
  sessionHash: Buffer;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
    applicant?: AuthedApplicant;
  }
}

export const PUBLIC_ROUTE = "eureka:public";
export const REQUIRED_PERMISSION = "eureka:permission";

/** Marks a route as reachable without a session (login, health, public feedback). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/**
 * jobs-portal: applicant routes (/api/portal/*). They authenticate ONLY with an
 * applicant session (own cookie, own table) and refuse staff sessions; staff
 * routes never accept an applicant session. "public" portal routes (sign-up,
 * sign-in) need no session but every write must carry the x-eureka-portal header.
 */
export const PORTAL_ROUTE = "eureka:portal";
export const PortalRoute = (mode: "session" | "public" = "session") => SetMetadata(PORTAL_ROUTE, mode);

export const CurrentApplicant = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthedApplicant => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.applicant) throw new UnauthorizedException();
  return req.applicant;
});
/** Routes a user with a temporary password may still call (me, logout, change password). */
export const ALLOW_PASSWORD_CHANGE = "eureka:allow-password-change";
export const AllowPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE, true);

/** Coarse RBAC check before the handler; data scope is applied in queries and RLS. */
export const RequirePermission = (p: Permission) => SetMetadata(REQUIRED_PERMISSION, p);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthedUser => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.user) throw new UnauthorizedException();
  return req.user;
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly db: DbService,
    private readonly accessService: AccessService,
    private readonly portalSessions: PortalSessionService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const portal = this.reflector.getAllAndOverride<"session" | "public" | undefined>(PORTAL_ROUTE, targets);
    if (portal) return this.portal(req, portal);
    // Defence in depth: nothing under /api/portal is served by a staff route.
    if (/^\/api\/portal(\/|\?|$)/.test(req.url)) throw new UnauthorizedException("Applicant sign-in required");
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;

    const session = await this.sessions.resolve(req.cookies?.[SESSION_COOKIE]);
    if (!session) throw new UnauthorizedException("Sign in required");

    if (!SAFE_METHODS.has(req.method)) {
      const token = req.headers["x-csrf-token"];
      if (!this.sessions.verifyCsrf(session.idHash, Array.isArray(token) ? token[0] : token)) {
        throw new ForbiddenException("Invalid CSRF token");
      }
    }

    // Access facts are loaded per request from current rows (no time-based cache).
    const access = await this.db.withUser(session.userId, (c) => this.accessService.load(c, session.userId));
    req.user = { id: session.userId, access, sessionHash: session.idHash, authTime: session.authTime };

    // A temporary (admin-set) password must be changed before anything else (migration 0083).
    if (this.config.PASSWORD_LOGIN === "on" && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE, targets)) {
      const must = await this.db.withUser(session.userId, async (c) =>
        (await c.query<{ m: boolean }>(`SELECT authz.password_must_change() AS m`)).rows[0]!.m);
      if (must) throw new ForbiddenException("password_change_required");
    }

    const needed = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, targets);
    if (needed && !can(access, needed)) throw new ForbiddenException("Not permitted");
    return true;
  }

  /** Applicant routes: the portal cookie only (a staff cookie is never read here). */
  private async portal(req: FastifyRequest, mode: "session" | "public"): Promise<boolean> {
    if (!/^\/api\/portal(\/|\?|$)/.test(req.url)) throw new ForbiddenException("Not permitted");
    const write = !SAFE_METHODS.has(req.method);
    if (mode === "public") {
      if (write && req.headers[PORTAL_HEADER] !== "1") throw new ForbiddenException("Invalid request");
      return true;
    }
    const session = await this.portalSessions.resolve(req.cookies?.[this.portalSessions.cookieName]);
    if (!session) throw new UnauthorizedException("Applicant sign-in required");
    if (write) {
      const token = req.headers["x-csrf-token"];
      if (!this.portalSessions.verifyCsrf(session.idHash, Array.isArray(token) ? token[0] : token)) {
        throw new ForbiddenException("Invalid CSRF token");
      }
    }
    req.applicant = { id: session.applicantId, sessionHash: session.idHash };
    return true;
  }
}
