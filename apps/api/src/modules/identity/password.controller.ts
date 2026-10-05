import { Body, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, NotFoundException, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AllowPasswordChange, CurrentUser, Public, type AuthedUser } from "../../platform/auth.guard.js";
import { clientInfo } from "../../platform/client-info.js";
import { clientIp, ipKey } from "../../platform/client-ip.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { SESSION_COOKIE, SessionService } from "../../platform/session.service.js";

const PasswordLogin = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) }).strict();
const ChangePassword = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }).strict();

/**
 * Username and password sign-in for staging and local test environments
 * (migration 0083). 404 everywhere unless PASSWORD_LOGIN=on, which the config
 * only allows when EUREKA_ENVIRONMENT is staging or local; the database
 * refuses the same calls unless authz.policy_setting password_login = 'on'.
 * The password is checked in the database (bcrypt, lockout, audit); this
 * controller never sees a hash.
 */
@Controller("api/auth")
export class PasswordController {
  private readonly perIp = new RateLimiter(30, 10 * 60_000);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly db: DbService,
  ) {}

  private enabled(): void {
    if (this.config.PASSWORD_LOGIN !== "on") throw new NotFoundException();
  }

  /** What the sign-in screen offers. */
  @Public()
  @Get("methods")
  methods() {
    return {
      password: this.config.PASSWORD_LOGIN === "on",
      google: this.config.AUTH_MODE === "google",
      dev: this.config.AUTH_MODE === "dev" && this.config.NODE_ENV !== "production",
    };
  }

  @Public()
  @Post("password-login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.enabled();
    if (!this.perIp.take(ipKey(clientIp(req, this.config)))) throw new HttpException("too_many_attempts", HttpStatus.TOO_MANY_REQUESTS);
    const { email, password } = PasswordLogin.parse(body);
    const r = await this.db.system(async (c) => (await c.query<{ user_id: string | null; outcome: string; must_change: boolean }>(
      `SELECT user_id, outcome, must_change FROM authz.password_login($1, $2, $3, $4)`,
      [email, password, this.config.PASSWORD_MAX_FAILURES, this.config.PASSWORD_LOCK_MINUTES])).rows[0]!);
    if (r.outcome === "locked") throw new HttpException("account_locked", HttpStatus.TOO_MANY_REQUESTS);
    if (r.outcome !== "ok" || !r.user_id) throw new UnauthorizedException("Invalid email or password");
    const sid = await this.sessions.create(r.user_id, new Date(), clientInfo(req, this.config));
    void reply.setCookie(SESSION_COOKIE, sid, {
      httpOnly: true, secure: this.config.NODE_ENV === "production", sameSite: "lax", path: "/",
      maxAge: this.config.SESSION_ABSOLUTE_HOURS * 3600,
    });
    return { mustChangePassword: r.must_change };
  }

  /** The signed-in user changes their own password (also the way out of a temporary one). */
  @Post("password/change")
  @AllowPasswordChange()
  @HttpCode(204)
  async change(@CurrentUser() user: AuthedUser, @Body() body: unknown): Promise<void> {
    this.enabled();
    const { currentPassword, newPassword } = ChangePassword.parse(body);
    const outcome = await this.db.withUser(user.id, async (c) => (await c.query<{ o: string }>(
      `SELECT authz.password_change($1, $2, $3, $4, $5) AS o`,
      [user.sessionHash, currentPassword, newPassword, this.config.PASSWORD_MAX_FAILURES, this.config.PASSWORD_LOCK_MINUTES])).rows[0]!.o);
    if (outcome === "ok") return;
    if (outcome === "locked") throw new HttpException("account_locked", HttpStatus.TOO_MANY_REQUESTS);
    if (outcome === "invalid") throw new ForbiddenException("current_password_incorrect");
    throw new HttpException(outcome === "same" ? "password_unchanged" : "password_weak", HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
