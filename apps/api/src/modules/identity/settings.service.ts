import { HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { MANDATORY_NOTIFICATION_TYPES, NOTIFICATION_PREFERENCE_TYPES } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import type { ProfileUpdate } from "./settings.schemas.js";

/** Sessions listed in Login activity: the newest of the last 30 days. */
export const LOGIN_ACTIVITY_DAYS = 30;
export const LOGIN_ACTIVITY_MAX = 20;

/**
 * Settings & Preferences for the signed-in staff member
 * (docs/interviews-settings-api.md ST-1..ST-9). Every query names the caller;
 * RLS on staff_profile and notification_preference enforces the same. The
 * session table has no RLS (it is read before a user is known), so every
 * session query here is explicitly limited to the caller's user id.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, @Inject(CONFIG) private readonly config: AppConfig) {}

  async profile(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => {
      const { rows } = await c.query<{ email: string; display_name: string; designation: string | null;
        phone_e164: string | null; bio: string | null; row_version: number | null; location: string | null }>(
        `SELECT u.email::text, u.display_name, u.designation, p.phone_e164, p.bio, p.row_version, l.name AS location
         FROM eureka.app_user u
         LEFT JOIN eureka.staff_profile p ON p.user_id = u.id
         LEFT JOIN eureka.location l ON l.id = u.primary_location_id
         WHERE u.id = $1`, [user.id]);
      const r = rows[0]!;
      return {
        displayName: r.display_name, email: r.email, designation: r.designation, location: r.location,
        phone: r.phone_e164, bio: r.bio,
        /** 0 until the first save; send it back in If-Match. */
        rowVersion: r.row_version ?? 0,
        signIn: this.signIn(),
      };
    });
  }

  /** ST-8: Google SSO (no password); the hosted domain the account belongs to. */
  private signIn() {
    return { provider: this.config.AUTH_MODE === "google" ? "google" : "dev", domain: this.config.GOOGLE_HOSTED_DOMAIN ?? null };
  }

  /** ST-2: phone and bio only, optimistic concurrency on rowVersion (428 without If-Match, 412 when stale). */
  async updateProfile(user: AuthedUser, expected: number | null, body: ProfileUpdate) {
    if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
    await this.db.withUser(user.id, async (c) => {
      const cur = (await c.query<{ row_version: number }>(
        `SELECT row_version FROM eureka.staff_profile WHERE user_id = $1 FOR UPDATE`, [user.id])).rows[0];
      if ((cur?.row_version ?? 0) !== expected) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      if (cur) {
        await c.query(`UPDATE eureka.staff_profile SET phone_e164 = $2, bio = $3 WHERE user_id = $1`, [user.id, body.phone, body.bio]);
      } else {
        try {
          await c.query(`INSERT INTO eureka.staff_profile (user_id, phone_e164, bio) VALUES ($1,$2,$3)`, [user.id, body.phone, body.bio]);
        } catch (err) {
          // A concurrent first save won the race.
          if ((err as { code?: string }).code === "23505") throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
          throw err;
        }
      }
      // ST-9: which fields are filled in, never their values.
      await this.audit.record(c, {
        actorId: user.id, action: "staff_profile.updated", entityType: "app_user", entityId: user.id,
        changes: { phoneSet: body.phone !== null, bioSet: body.bio !== null },
      });
    });
    return this.profile(user);
  }

  async preferences(user: AuthedUser) {
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ type: string; in_app: boolean }>(
      `SELECT type, in_app FROM eureka.notification_preference WHERE user_id = $1`, [user.id])).rows);
    const off = new Set(rows.filter((r) => !r.in_app).map((r) => r.type));
    return {
      items: NOTIFICATION_PREFERENCE_TYPES.map((t) => ({
        type: t.type, label: t.label, description: t.description, mandatory: t.mandatory,
        inApp: t.mandatory || !off.has(t.type),
      })),
    };
  }

  /** ST-4: on is the default (the row is removed); mandatory types cannot be switched off (the database refuses too). */
  async setPreference(user: AuthedUser, type: string, inApp: boolean) {
    if (!inApp && MANDATORY_NOTIFICATION_TYPES.includes(type)) throw new UnprocessableEntityException("notification_type_mandatory");
    await this.db.withUser(user.id, async (c) => {
      if (inApp) {
        await c.query(`DELETE FROM eureka.notification_preference WHERE user_id = $1 AND type = $2`, [user.id, type]);
      } else {
        await c.query(
          `INSERT INTO eureka.notification_preference (user_id, type, in_app) VALUES ($1,$2,false)
           ON CONFLICT (user_id, type) DO UPDATE SET in_app = false`, [user.id, type]);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "notification_preference.updated", entityType: "app_user", entityId: user.id,
        changes: { type, inApp },
      });
    });
    return this.preferences(user);
  }

  /** ST-5/ST-6: the caller's sessions of the last 30 days, newest first; the current one is marked. */
  async sessions(user: AuthedUser) {
    const { rows } = await this.db.withUser(user.id, (c) => c.query<{
      public_id: string; created_at: Date; last_seen_at: Date; expires_at: Date; revoked_at: Date | null;
      device_class: string | null; browser: string | null; ip_masked: string | null; current: boolean; live: boolean }>(
      `SELECT public_id, created_at, last_seen_at, expires_at, revoked_at, device_class, browser, ip_masked,
              id_hash = $2 AS current,
              (revoked_at IS NULL AND expires_at > now() AND last_seen_at > now() - make_interval(mins => $3)) AS live
       FROM eureka.session
       WHERE user_id = $1 AND created_at > now() - make_interval(days => $4)
       ORDER BY (id_hash = $2) DESC, created_at DESC LIMIT $5`,
      [user.id, user.sessionHash, this.config.SESSION_IDLE_MINUTES, LOGIN_ACTIVITY_DAYS, LOGIN_ACTIVITY_MAX]));
    return {
      signIn: this.signIn(),
      items: rows.map((r) => ({
        id: r.public_id,
        signedInAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        device: r.device_class ?? "unknown",
        browser: r.browser ?? "Other",
        ip: r.ip_masked,
        current: r.current,
        status: r.current || r.live ? "active" : r.revoked_at ? "signed_out" : "expired",
      })),
    };
  }

  /** ST-7: signs out one of the caller's other live sessions (404 when it is not theirs or already ended). */
  async revoke(user: AuthedUser, publicId: string) {
    await this.db.withUser(user.id, async (c) => {
      const r = await c.query(
        `UPDATE eureka.session SET revoked_at = now()
         WHERE public_id = $1 AND user_id = $2 AND id_hash <> $3 AND revoked_at IS NULL AND expires_at > now()`,
        [publicId, user.id, user.sessionHash]);
      if (r.rowCount !== 1) {
        const mine = await c.query(`SELECT 1 FROM eureka.session WHERE public_id = $1 AND id_hash = $2`, [publicId, user.sessionHash]);
        if (mine.rowCount) throw new UnprocessableEntityException("current_session");
        throw new NotFoundException();
      }
      await this.audit.record(c, {
        actorId: user.id, action: "session.revoked", entityType: "session", entityId: publicId, changes: { count: 1 },
      });
    });
  }

  /** ST-7: signs out every other session of the caller; the current one stays. */
  async revokeOthers(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => {
      const r = await c.query(
        `UPDATE eureka.session SET revoked_at = now()
         WHERE user_id = $1 AND id_hash <> $2 AND revoked_at IS NULL AND expires_at > now()`, [user.id, user.sessionHash]);
      const n = r.rowCount ?? 0;
      await this.audit.record(c, {
        actorId: user.id, action: "session.revoked_others", entityType: "app_user", entityId: user.id, changes: { count: n },
      });
      return { revoked: n };
    });
  }
}
