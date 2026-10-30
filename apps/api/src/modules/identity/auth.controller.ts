import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuditService } from "../../platform/audit.service.js";
import { clientInfo } from "../../platform/client-info.js";
import { AllowPasswordChange, CurrentUser, Public, type AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { OidcService } from "../../platform/oidc.service.js";
import { openCookie, sealCookie } from "../../platform/sealed-cookie.js";
import { SESSION_COOKIE, SessionService } from "../../platform/session.service.js";

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

  private setSessionCookie(reply: FastifyReply, sid: string): void {
    void reply.setCookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      secure: this.config.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: this.config.SESSION_ABSOLUTE_HOURS * 3600,
    });
  }

  @Public()
  @Get("login")
  login(@Res() reply: FastifyReply): void {
    if (this.config.AUTH_MODE !== "google") throw new NotFoundException();
    const s = this.oidc.start(this.redirectUri());
    void reply
      .setCookie(OIDC_COOKIE, sealCookie(this.config.SESSION_SECRET, { state: s.state, nonce: s.nonce, verifier: s.verifier }), {
        httpOnly: true, secure: this.config.NODE_ENV === "production", sameSite: "lax", path: "/api/auth", maxAge: 600,
      })
      .redirect(s.url, 302);
  }

  @Public()
  @Get("callback")
  async callback(@Query("code") code: string, @Query("state") state: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    if (this.config.AUTH_MODE !== "google") throw new NotFoundException();
    const saved = openCookie<{ state: string; nonce: string; verifier: string }>(this.config.SESSION_SECRET, req.cookies?.[OIDC_COOKIE]);
    if (!saved) throw new ForbiddenException("Sign-in expired, please try again");
    if (!state || state !== saved.state || !code) throw new ForbiddenException("Sign-in state mismatch");

    const idToken = await this.oidc.exchange(code, saved.verifier, this.redirectUri());
    const identity = await this.oidc.verify(idToken, saved.nonce);
    const userId = await this.linkUser(identity.sub, identity.email);
    const sid = await this.sessions.create(userId, identity.authTime, clientInfo(req, this.config));
    this.setSessionCookie(reply, sid);
    void reply.clearCookie(OIDC_COOKIE, { path: "/api/auth" }).redirect(this.config.PUBLIC_BASE_URL, 302);
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
    this.setSessionCookie(reply, await this.sessions.create(rows[0].id, new Date(), clientInfo(req, this.config)));
  }

  @Post("logout")
  @AllowPasswordChange()
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthedUser, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.sessions.revoke(user.sessionHash);
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }
}
