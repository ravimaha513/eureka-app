import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CurrentApplicant, PortalRoute, type AuthedApplicant } from "../../platform/auth.guard.js";
import { clientIp } from "../../platform/client-ip.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { DevMailbox, MAIL_PORT, type MailPort } from "../../platform/mail.js";
import { PortalSessionService } from "../../platform/portal-session.service.js";
import { PortalAuthService } from "./portal-auth.service.js";
import { RequestLink, SignUp, VerifyLink } from "./portal.schemas.js";

export { PortalAuthService };

/** Applicant sign-up and one-time-link sign-in (docs/jobs-portal-api.md JP-10..JP-14). */
@Controller("api/portal/auth")
export class PortalAuthController {
  constructor(
    private readonly svc: PortalAuthService,
    private readonly sessions: PortalSessionService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** 202 with the same message whether or not the email already has an account. */
  @PortalRoute("public")
  @Post("sign-up")
  @HttpCode(202)
  signUp(@Req() req: FastifyRequest, @Body() body: unknown) {
    return this.svc.signUp(SignUp.parse(body), clientIp(req, this.config));
  }

  /** 202 with the same message whether or not the email has an account. */
  @PortalRoute("public")
  @Post("request-link")
  @HttpCode(202)
  requestLink(@Req() req: FastifyRequest, @Body() body: unknown) {
    return this.svc.requestLink(RequestLink.parse(body), clientIp(req, this.config));
  }

  /** The web page posts the token from the link's fragment; the link is burnt and a session cookie set. */
  @PortalRoute("public")
  @Post("verify")
  @HttpCode(204)
  async verify(@Req() req: FastifyRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const { token } = VerifyLink.parse(body);
    const { sid } = await this.svc.verify(token, clientIp(req, this.config));
    void reply.setCookie(this.sessions.cookieName, sid, this.sessions.cookieOptions());
  }

  /** Sign out everywhere: ends every session of the applicant, this one included. */
  @PortalRoute()
  @Post("sign-out-all")
  @HttpCode(204)
  async signOutAll(@CurrentApplicant() a: AuthedApplicant, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.sessions.revokeAll(a.id);
    void reply.clearCookie(this.sessions.cookieName, this.sessions.clearOptions());
  }

  @PortalRoute()
  @Post("sign-out")
  @HttpCode(204)
  async signOut(@CurrentApplicant() a: AuthedApplicant, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.sessions.revoke(a.sessionHash);
    void reply.clearCookie(this.sessions.cookieName, this.sessions.clearOptions());
  }
}

/** The signed-in applicant (read under the portal role: own row only). */
@Controller("api/portal/me")
export class PortalMeController {
  constructor(private readonly db: DbService, private readonly sessions: PortalSessionService) {}

  @PortalRoute()
  @Get()
  async me(@CurrentApplicant() a: AuthedApplicant) {
    const row = await this.db.withApplicant(a.id, async (c) => (await c.query<{
      id: string; first_name: string; last_name: string; email: string; phone_e164: string | null; email_verified_at: Date | null;
    }>(`SELECT id, first_name, last_name, email, phone_e164, email_verified_at FROM eureka.applicant`)).rows[0]);
    if (!row) throw new NotFoundException();
    return {
      id: row.id, firstName: row.first_name, lastName: row.last_name, email: row.email, phone: row.phone_e164,
      emailVerified: row.email_verified_at !== null, csrfToken: this.sessions.csrfToken(a.sessionHash),
    };
  }
}

const MailboxQuery = z.object({ to: z.string().email().max(254) }).strict();

/**
 * Development only: the in-memory mailbox, so sign-in links can be followed
 * without a mail server (local runs, e2e). 404 unless AUTH_MODE=dev outside
 * production with the dev mail port (production refuses both).
 */
@Controller("api/portal/dev/mailbox")
export class PortalDevMailboxController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig, @Inject(MAIL_PORT) private readonly mail: MailPort) {}

  @PortalRoute("public")
  @Get()
  inbox(@Query() q: unknown) {
    if (this.config.NODE_ENV === "production" || this.config.AUTH_MODE !== "dev" || !(this.mail instanceof DevMailbox)) throw new NotFoundException();
    return { items: this.mail.inbox(MailboxQuery.parse(q).to) };
  }
}
