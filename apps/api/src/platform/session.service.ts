import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { UserAccess } from "@eureka/shared";
import { accessFromFacts, type AccessFacts } from "./access.service.js";
import type { ClientInfo } from "./client-info.js";
import { CONFIG, type AppConfig } from "./config.js";
import { DbService } from "./db.service.js";

/**
 * Staff session cookie names (audit F-14). Over HTTPS the cookie is
 * `__Host-eureka_sid`: the browser then requires Secure, Path=/ and no Domain,
 * so a sibling subdomain cannot plant or overwrite it. Plain-HTTP development
 * and tests keep `eureka_sid` (a `__Host-` cookie cannot be set without Secure).
 */
export const SESSION_COOKIE = "eureka_sid";
export const HOST_SESSION_COOKIE = "__Host-eureka_sid";

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge?: number;
}

export interface SessionInfo {
  userId: string;
  idHash: Buffer;
  authTime: Date;
}

/** A valid session with the facts the AuthGuard needs (authz.request_context). */
export interface RequestAuth extends SessionInfo {
  access: UserAccess;
  /** The temporary-password flag; false unless asked for (PASSWORD_LOGIN=on). */
  mustChangePassword: boolean;
}

/**
 * Server-side sessions (design A6.1). The cookie carries a 256-bit random id;
 * only its SHA-256 hash is stored. Tokens from the identity provider never
 * reach the browser.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Secure cookies whenever the app is served over HTTPS (or runs in production). */
  get secureCookies(): boolean {
    return this.config.NODE_ENV === "production" || new URL(this.config.PUBLIC_BASE_URL).protocol === "https:";
  }

  /** The cookie name new sessions are issued under. */
  get cookieName(): string {
    return this.secureCookies ? HOST_SESSION_COOKIE : SESSION_COOKIE;
  }

  /** The one definition of the staff session cookie's attributes (auth and password sign-in, logout). */
  sessionCookieOptions(): SessionCookieOptions {
    return { httpOnly: true, secure: this.secureCookies, sameSite: "lax", path: "/", maxAge: this.config.SESSION_ABSOLUTE_HOURS * 3600 };
  }

  /**
   * The session id from the request cookies. Transition (remove one release
   * after the `__Host-` rename shipped): over HTTPS the old `eureka_sid` cookie is
   * still read when the new one is absent, so sessions issued before the deploy
   * survive; every new sign-in gets the `__Host-` cookie.
   */
  readSessionId(cookies: Record<string, string | undefined> | undefined): string | undefined {
    return cookies?.[this.cookieName] ?? (this.secureCookies ? cookies?.[SESSION_COOKIE] : undefined);
  }

  setSessionCookie(reply: FastifyReply, sid: string): void {
    void reply.setCookie(this.cookieName, sid, this.sessionCookieOptions());
  }

  /** Logout: clear the current cookie and, during the transition, the old name too. */
  clearSessionCookie(reply: FastifyReply): void {
    const { maxAge: _, ...attrs } = this.sessionCookieOptions();
    void reply.clearCookie(this.cookieName, attrs);
    if (this.cookieName !== SESSION_COOKIE) void reply.clearCookie(SESSION_COOKIE, attrs);
  }

  static hash(sid: string): Buffer {
    return createHash("sha256").update(sid).digest();
  }

  /** `client`: device class, browser family and masked IP for Login activity (never the raw user agent or IP). */
  async create(userId: string, authTime: Date, client?: ClientInfo): Promise<string> {
    const sid = randomBytes(32).toString("base64url");
    await this.db.system((c) =>
      c.query(
        `INSERT INTO eureka.session (id_hash, user_id, expires_at, auth_time, access_version, device_class, browser, ip_masked)
         SELECT $1, u.id, now() + make_interval(hours => $3), $4, u.access_version, $5, $6, $7
         FROM eureka.app_user u WHERE u.id = $2 AND u.status = 'active'`,
        [SessionService.hash(sid), userId, this.config.SESSION_ABSOLUTE_HOURS, authTime,
          client?.deviceClass ?? null, client?.browser ?? null, client?.ipMasked ?? null],
      ),
    );
    return sid;
  }

  /**
   * The request's authentication in one statement on one connection (audit F-03):
   * authz.request_context validates the session (absolute and idle timeouts, user
   * status; last_seen_at is written at most once a minute, so the idle timeout is
   * exact to a minute), loads the access facts from current rows (no cache) and,
   * when `checkPassword`, the temporary-password flag. Null = no valid session.
   */
  async authenticate(sid: string | undefined, checkPassword: boolean): Promise<RequestAuth | null> {
    if (!sid || sid.length > 100) return null;
    const idHash = SessionService.hash(sid);
    const { rows } = await this.db.system((c) =>
      c.query<{ user_id: string; auth_time: Date; access: AccessFacts; must_change: boolean }>(
        `SELECT user_id, auth_time, access, must_change FROM authz.request_context($1, $2, $3)`,
        [idHash, this.config.SESSION_IDLE_MINUTES, checkPassword],
      ),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      userId: row.user_id, idHash, authTime: row.auth_time,
      access: accessFromFacts(row.user_id, row.access), mustChangePassword: row.must_change,
    };
  }

  async revoke(idHash: Buffer): Promise<void> {
    await this.db.system((c) =>
      c.query(`UPDATE eureka.session SET revoked_at = now() WHERE id_hash = $1`, [idHash]),
    );
  }

  /** CSRF token bound to the session: HMAC(secret, session id hash). */
  csrfToken(idHash: Buffer): string {
    return createHmac("sha256", this.config.SESSION_SECRET).update(idHash).digest("base64url");
  }

  verifyCsrf(idHash: Buffer, token: string | undefined): boolean {
    if (!token) return false;
    const expected = Buffer.from(this.csrfToken(idHash));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
