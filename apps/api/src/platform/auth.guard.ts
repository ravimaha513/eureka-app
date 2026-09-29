import {
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
import { DbService } from "./db.service.js";
import { SESSION_COOKIE, SessionService } from "./session.service.js";

export interface AuthedUser {
  id: string;
  access: UserAccess;
  sessionHash: Buffer;
  authTime: Date;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

export const PUBLIC_ROUTE = "eureka:public";
export const REQUIRED_PERMISSION = "eureka:permission";

/** Marks a route as reachable without a session (login, health, public feedback). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
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
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
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

    const needed = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, targets);
    if (needed && !can(access, needed)) throw new ForbiddenException("Not permitted");
    return true;
  }
}
