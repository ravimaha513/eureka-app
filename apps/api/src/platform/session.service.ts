import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { ClientInfo } from "./client-info.js";
import { CONFIG, type AppConfig } from "./config.js";
import { DbService } from "./db.service.js";

export const SESSION_COOKIE = "eureka_sid";

export interface SessionInfo {
  userId: string;
  idHash: Buffer;
  authTime: Date;
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

  /** Returns the session if valid; enforces absolute and idle timeouts and user status. */
  async resolve(sid: string | undefined): Promise<SessionInfo | null> {
    if (!sid || sid.length > 100) return null;
    const idHash = SessionService.hash(sid);
    const { rows } = await this.db.system((c) =>
      c.query<{ user_id: string; auth_time: Date }>(
        `UPDATE eureka.session s SET last_seen_at = now()
         FROM eureka.app_user u
         WHERE s.id_hash = $1 AND u.id = s.user_id AND u.status = 'active'
           AND s.revoked_at IS NULL AND s.expires_at > now()
           AND s.last_seen_at > now() - make_interval(mins => $2)
         RETURNING s.user_id, s.auth_time`,
        [idHash, this.config.SESSION_IDLE_MINUTES],
      ),
    );
    const row = rows[0];
    return row ? { userId: row.user_id, idHash, authTime: row.auth_time } : null;
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
