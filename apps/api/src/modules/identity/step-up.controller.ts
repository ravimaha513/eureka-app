import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  Body, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, Logger, NotFoundException, Post, Query, Req, Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CurrentUser, type AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { OidcService } from "../../platform/oidc.service.js";

const STEP_UP_COOKIE = "eureka_stepup";
const COOKIE_PATH = "/api/auth/step-up";

/** A same-origin path to come back to (no scheme, no host, no backslash); mirrors the step_up_challenge CHECK. */
export const ReturnPath = z.string().max(201).regex(/^\/[A-Za-z0-9/_.?=&%-]{0,200}$/).refine((p) => !p.startsWith("//"), "same-origin path only");
export const StartStepUp = z.object({ returnTo: ReturnPath }).strict();

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/**
 * Step-up re-authentication (design A6.1) before restricted actions (opening
 * I-9, driving license and work-authorization files).
 *
 * Google: POST start (CSRF) stores the hashed state and nonce against this
 * session (authz.step_up_begin) and returns Google's URL with max_age=0 and
 * prompt=login; the PKCE verifier and nonce ride in a signed, httpOnly cookie
 * bound to the session. GET callback (session required) verifies the ID token
 * (signature, issuer, audience, nonce, hd, email, auth_time present) and
 * authz.step_up_complete consumes the challenge once and grants step-up only
 * for the Google account linked to this user and a sign-in after the
 * challenge started, no older than STEP_UP_MAX_AGE_SECONDS. The grant lives
 * STEP_UP_TTL_MINUTES (database cap 15) and only for this session.
 *
 * Development: POST dev grants step-up without an identity provider; refused
 * unless AUTH_MODE=dev outside production, and by the database unless
 * authz.policy_setting dev_step_up = 'on'.
 *
 * WebAuthn (the design's fallback if Google cannot prove a fresh sign-in) is
 * not built: follow-up after the Phase 0 spike.
 */
@Controller("api/auth/step-up")
export class StepUpController {
  private readonly log = new Logger("StepUp");

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly oidc: OidcService,
    private readonly db: DbService,
  ) {}

  private redirectUri(): string {
    return new URL("/api/auth/step-up/callback", this.config.PUBLIC_BASE_URL).toString();
  }

  /** HMAC over the payload and the session it was issued to. */
  private sign(payload: string, session: Buffer): string {
    return createHmac("sha256", this.config.SESSION_SECRET).update(`step-up|${session.toString("hex")}|${payload}`).digest("base64url");
  }

  /** Whether this session holds a live step-up grant, and which modes the server offers. */
  @Get()
  async status(@CurrentUser() user: AuthedUser) {
    const g = await this.db.withUser(user.id, async (c) => (await c.query<{ method: string; expires_at: Date }>(
      `SELECT method, expires_at FROM authz.step_up_current($1)`, [user.sessionHash])).rows[0]);
    return {
      active: Boolean(g),
      expiresAt: g?.expires_at.toISOString() ?? null,
      method: g?.method ?? null,
      mode: this.config.AUTH_MODE === "dev" && this.config.NODE_ENV !== "production" ? "dev" : "google",
      ttlMinutes: this.config.STEP_UP_TTL_MINUTES,
    };
  }

  @Post("start")
  @HttpCode(200)
  async start(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    if (this.config.AUTH_MODE !== "google") throw new NotFoundException();
    const { returnTo } = StartStepUp.parse(body);
    const email = await this.db.withUser(user.id, async (c) =>
      (await c.query<{ email: string }>(`SELECT email FROM eureka.app_user WHERE id = $1`, [user.id])).rows[0]?.email);
    const s = this.oidc.startStepUp(this.redirectUri(), email);
    await this.db.withUser(user.id, (c) => c.query(`SELECT authz.step_up_begin($1, $2, $3, $4)`,
      [user.sessionHash, sha256(s.state), sha256(s.nonce), returnTo])).catch((err: { message?: string; code?: string }) => {
      if (err.message === "too_many_step_ups") throw new HttpException("too_many_step_ups", HttpStatus.TOO_MANY_REQUESTS);
      throw err;
    });
    const payload = Buffer.from(JSON.stringify({ state: s.state, nonce: s.nonce, verifier: s.verifier })).toString("base64url");
    void reply.setCookie(STEP_UP_COOKIE, `${payload}.${this.sign(payload, user.sessionHash)}`, {
      httpOnly: true, secure: this.config.NODE_ENV === "production", sameSite: "lax", path: COOKIE_PATH, maxAge: 600,
    });
    return { redirectUrl: s.url };
  }

  /** Google redirects here (top-level GET: the Lax session cookie is sent). */
  @Get("callback")
  async callback(
    @CurrentUser() user: AuthedUser, @Query("code") code: string | undefined, @Query("state") state: string | undefined,
    @Req() req: FastifyRequest, @Res() reply: FastifyReply,
  ) {
    if (this.config.AUTH_MODE !== "google") throw new NotFoundException();
    const raw = req.cookies?.[STEP_UP_COOKIE] ?? "";
    const [payload, sig] = raw.split(".");
    const expected = payload ? Buffer.from(this.sign(payload, user.sessionHash)) : Buffer.alloc(0);
    if (!payload || !sig || expected.length !== sig.length || !timingSafeEqual(expected, Buffer.from(sig))) {
      throw new ForbiddenException("Step-up expired, please try again");
    }
    const saved = JSON.parse(Buffer.from(payload, "base64url").toString()) as { state: string; nonce: string; verifier: string };
    if (typeof state !== "string" || state !== saved.state) throw new ForbiddenException("Step-up state mismatch");
    void reply.clearCookie(STEP_UP_COOKIE, { path: COOKIE_PATH });

    // The challenge is consumed on every path from here (single use, also when
    // the user cancelled at Google or the token is refused), each with its reason.
    let r: { outcome: string; return_to: string | null };
    let identity: { sub: string; authTime: Date } | null = null;
    let failure: "cancelled" | "token_refused" | null = null;
    if (typeof code !== "string" || !code) {
      failure = "cancelled"; // error=access_denied or no code
    } else {
      try {
        const idToken = await this.oidc.exchange(code, saved.verifier, this.redirectUri());
        identity = await this.oidc.verifyStepUp(idToken, saved.nonce);
      } catch (err) {
        this.log.warn(`step-up token refused: ${(err as Error).message}`);
        failure = "token_refused";
      }
    }
    if (failure || !identity) {
      r = await this.db.withUser(user.id, async (c) => (await c.query<{ outcome: string; return_to: string | null }>(
        `SELECT outcome, return_to FROM authz.step_up_fail($1, $2, $3)`,
        [user.sessionHash, sha256(saved.state), failure ?? "token_refused"])).rows[0]!);
    } else {
      r = await this.db.withUser(user.id, async (c) => (await c.query<{ outcome: string; return_to: string | null }>(
        `SELECT outcome, return_to FROM authz.step_up_complete($1, $2, $3, $4, $5, $6, $7)`,
        [user.sessionHash, sha256(saved.state), sha256(saved.nonce), identity.sub, identity.authTime,
          this.config.STEP_UP_MAX_AGE_SECONDS, this.config.STEP_UP_TTL_MINUTES])).rows[0]!);
    }
    const back = r.return_to && ReturnPath.safeParse(r.return_to).success ? r.return_to : "/";
    const target = new URL(back, this.config.PUBLIC_BASE_URL);
    if (target.origin !== new URL(this.config.PUBLIC_BASE_URL).origin) throw new ForbiddenException("Step-up return path refused");
    if (r.outcome !== "granted") target.searchParams.set("stepUp", "failed");
    void reply.redirect(target.toString(), 302);
  }

  /** Development identity provider's step-up; unreachable unless AUTH_MODE=dev (never in production). */
  @Post("dev")
  @HttpCode(200)
  async dev(@CurrentUser() user: AuthedUser) {
    if (this.config.AUTH_MODE !== "dev" || this.config.NODE_ENV === "production") throw new NotFoundException();
    const g = await this.db.withUser(user.id, async (c) => (await c.query<{ expires_at: Date }>(
      `SELECT expires_at FROM authz.step_up_dev($1, $2)`, [user.sessionHash, this.config.STEP_UP_TTL_MINUTES])).rows[0]!);
    return { active: true, expiresAt: g.expires_at.toISOString(), method: "dev" };
  }
}
