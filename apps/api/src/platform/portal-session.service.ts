import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { CONFIG, type AppConfig } from "./config.js";
import { DbService } from "./db.service.js";

/**
 * Applicant sessions (jobs-portal, migration 0061): a separate session kind
 * with its own table, cookie name and cookie path, so an applicant session can
 * never authenticate a staff route and a staff session never a portal route.
 * Like staff sessions, the cookie carries 256 random bits and only their
 * SHA-256 is stored.
 */
export const PORTAL_COOKIE = "eureka_portal_sid";
export const PORTAL_COOKIE_PATH = "/api/portal";
/** Header every unauthenticated portal write must carry (a cross-site form cannot send it). */
export const PORTAL_HEADER = "x-eureka-portal";

export interface PortalSessionInfo { applicantId: string; idHash: Buffer }

@Injectable()
export class PortalSessionService {
  constructor(private readonly db: DbService, @Inject(CONFIG) private readonly config: AppConfig) {}

  static hash(v: string | Buffer): Buffer {
    return createHash("sha256").update(v).digest();
  }

  /** A fresh session id (cookie value) and its hash (stored). */
  static newSessionId(): { sid: string; hash: Buffer } {
    const sid = randomBytes(32).toString("base64url");
    return { sid, hash: PortalSessionService.hash(sid) };
  }

  async resolve(sid: string | undefined): Promise<PortalSessionInfo | null> {
    if (!sid || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
    const idHash = PortalSessionService.hash(sid);
    const { rows } = await this.db.system((c) => c.query<{ id: string | null }>(
      `SELECT authz.portal_session_resolve($1, $2) AS id`, [idHash, this.config.PORTAL_SESSION_IDLE_MINUTES]));
    const id = rows[0]?.id;
    return id ? { applicantId: id, idHash } : null;
  }

  async revoke(idHash: Buffer): Promise<void> {
    await this.db.system((c) => c.query(`SELECT authz.portal_session_revoke($1)`, [idHash]));
  }

  /** CSRF token bound to the applicant session (domain-separated from staff tokens). */
  csrfToken(idHash: Buffer): string {
    return createHmac("sha256", this.config.SESSION_SECRET).update("eureka-portal-csrf\0").update(idHash).digest("base64url");
  }

  verifyCsrf(idHash: Buffer, token: string | undefined): boolean {
    if (!token) return false;
    const expected = Buffer.from(this.csrfToken(idHash));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  cookieOptions() {
    return {
      httpOnly: true, secure: this.config.NODE_ENV === "production", sameSite: "strict" as const,
      path: PORTAL_COOKIE_PATH, maxAge: this.config.PORTAL_SESSION_HOURS * 3600,
    };
  }
}
