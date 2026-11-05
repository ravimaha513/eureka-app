import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuditService } from "../../platform/audit.service.js";
import { clientInfo } from "../../platform/client-info.js";
import { AllowPasswordChange, CurrentUser, Public, type AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { apiLog } from "../../platform/logger.js";
import { OidcFailure, OidcService, type SignInError, type VerifiedIdentity } from "../../platform/oidc.service.js";
import { requestLogFields } from "../../platform/request-context.js";
import { openCookie, sealCookie } from "../../platform/sealed-cookie.js";
import { SessionService } from "../../platform/session.service.js";

const OIDC_COOKIE = "eureka_oidc";
const DevLogin = z.object({ email: z.string().email() }).strict();

@Controller("api/auth")
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly oidc: OidcService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private redirectUri(): string {
    return new URL("/api/auth/callback", this.config.PUBLIC_BASE_URL).toString();
  }

  @Public()
  @Get("login")
  login(@Res() reply: FastifyReply): void {
    if (this.config.AUTH_MODE !== "google") throw new NotFoundException();
    const s = this.oidc.start(this.redirectUri());
    void reply
      .setCookie(OIDC_COOKIE, sealCookie(this.config.SESSION_SECRET, { state: s.state, nonce: s.nonce, verifier: s.verifier }), {
        httpOnly: true, secure: this.sessions.secureCookies, sameSite: "lax", path: "/api/auth", maxAge: 600,
      })
      .redirect(s.url, 302);
  }

  /**
   * Google redirects the browser here (top-level navigation). Every expected
   * failure (expired or mismatched state, cancelled at Google, token refused or
   * timed out, outside the company domain, no Eureka account) is a 302 to the
   * sign-in page with `?error=<code>` (SIGN_IN_ERRORS), logged at warn with the
   * code only. Unexpected server errors still surface as problem responses.
   */
  @Public()
  @Get("callback")
  async callback(
    @Query("code") code: string | undefined, @Query("state") state: string | undefined, @Query("error") error: string | undefined,
    @Req() req: FastifyRequest, @Res() reply: FastifyReply,
  ) {
    if (this.config.AUTH_MODE !== "google") throw new NotFoundException();
    const saved = openCookie<{ state: string; nonce: string; verifier: string }>(this.config.SESSION_SECRET, req.cookies?.[OIDC_COOKIE]);
    void reply.clearCookie(OIDC_COOKIE, { path: "/api/auth" }); // single use, on every path
    if (!saved) return this.signInFailed(req, reply, "expired");
    if (typeof state !== "string" || state !== saved.state) return this.signInFailed(req, reply, "signin_failed");
    if (typeof error === "string" && error) return this.signInFailed(req, reply, "cancelled");
    if (typeof code !== "string" || !code) return this.signInFailed(req, reply, "signin_failed");

    let identity: VerifiedIdentity;
    try {
      identity = await this.oidc.verify(await this.oidc.exchange(code, saved.verifier, this.redirectUri()), saved.nonce);
    } catch (err) {
      return this.signInFailed(req, reply, err instanceof OidcFailure ? err.reason : "signin_failed", err);
    }
    let userId: string;
    try {
      userId = await this.linkUser(identity.sub, identity.email);
    } catch (err) {
      // linkUser commits the auth.denied audit row before it throws.
      if (err instanceof ForbiddenException) return this.signInFailed(req, reply, "not_provisioned");
      throw err;
    }
    const sid = await this.sessions.create(userId, identity.authTime, clientInfo(req, this.config));
    this.sessions.setSessionCookie(reply, sid);
    void reply.redirect(this.config.PUBLIC_BASE_URL, 302);
  }

  private signInFailed(req: FastifyRequest, reply: FastifyReply, reason: SignInError, err?: unknown): void {
    const e = err instanceof Error ? { err: err.message, errName: err.name } : {};
    apiLog.warn("sign-in failed", { ...requestLogFields(req), reason, ...e });
    const target = new URL("/login", this.config.PUBLIC_BASE_URL);
    target.searchParams.set("error", reason);
    void reply.redirect(target.toString(), 302);
  }

  /** Link by Google sub; email only once for a pre-provisioned user without a sub (design A6.1). */
  async linkUser(sub: string, email: string): Promise<string> {
    // The link and its audit row share one transaction. The denial is thrown after commit so its audit row is kept.
    const userId = await this.db.withSystemTx(async (c) => {
      const bySub = await c.query<{ id: string }>(
        `SELECT id FROM eureka.app_user WHERE google_sub = $1 AND status = 'active'`, [sub]);
      if (bySub.rows[0]) return bySub.rows[0].id;
      // Defence in depth (OidcService.verify checks it too): never link an email outside the hosted domain.
      const domain = this.config.GOOGLE_HOSTED_DOMAIN?.trim().toLowerCase();
      const inDomain = !domain || email.toLowerCase().endsWith(`@${domain}`);
      const byEmail = inDomain ? await c.query<{ id: string }>(
        `UPDATE eureka.app_user SET google_sub = $1
         WHERE email = $2 AND google_sub IS NULL AND status = 'active' RETURNING id`, [sub, email]) : { rows: [] };
      const linked = byEmail.rows[0];
      await this.audit.record(c, {
        actorId: linked?.id ?? "00000000-0000-0000-0000-000000000000",
        action: linked ? "auth.linked" : "auth.denied",
        entityType: "app_user",
        entityId: linked?.id,
        changes: { email },
      });
      return linked?.id ?? null;
    });
    if (!userId) throw new ForbiddenException("No active Eureka account for this Google account");
    return userId;
  }

  /** Development identity provider; unreachable unless AUTH_MODE=dev (never in production). */
  @Public()
  @Post("dev-login")
  @HttpCode(204)
  async devLogin(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    if (this.config.AUTH_MODE !== "dev" || this.config.NODE_ENV === "production") throw new NotFoundException();
    const { email } = DevLogin.parse(body);
    const { rows } = await this.db.system((c) =>
      c.query<{ id: string }>(`SELECT id FROM eureka.app_user WHERE email = $1 AND status = 'active'`, [email]));
    if (!rows[0]) throw new ForbiddenException("Unknown user");
    this.sessions.setSessionCookie(reply, await this.sessions.create(rows[0].id, new Date(), clientInfo(req, this.config)));
  }

  @Post("logout")
  @AllowPasswordChange()
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthedUser, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.sessions.revoke(user.sessionHash);
    this.sessions.clearSessionCookie(reply);
  }
}
