import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import { INTERVIEW_TYPE_LABELS, activityVisible, resolveScope } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { decryptToken, encryptToken } from "../../worker/feedback-mail.js";
import { CALENDAR_PROVIDER, type CalendarProvider } from "./calendar.provider.js";

export const CALENDAR_STATE_COOKIE = "eureka_calendar";
const KEY = "support";

interface ConnectionRow { provider: string; calendar_id: string; account_email: string; token_enc: string; connected_at: Date; connected_by: string; connected_by_name: string | null }
interface InterviewRow {
  id: string; round: string; starts_at: Date; ends_at: Date; call_status: string; interview_type: string | null; meeting_url: string | null;
  recruiter_id: string; team_id: string | null; location_id: string | null; c_recruiter: string | null; c_team: string | null; c_location: string | null;
  candidate_name: string | null; client_name: string | null; job_title: string | null; recruiter_name: string | null;
}
interface BlockRow { id: string; calendar_id: string; external_id: string; starts_at: Date; ends_at: Date; created_at: Date; created_by: string; created_by_name: string | null }

/**
 * The support team's shared calendar (interview-alerts package, migration 0088;
 * docs/alerts-calendar-birthdays.md CA-1..CA-6). One connection for the
 * organisation, made by a calendar:block holder who signs in with the Google
 * account that owns (or may write to) the support calendar. Sales leads and
 * coordinators then block the calendar for an interview's slot and release it
 * again. The refresh token is stored AES-256-GCM encrypted under
 * CALENDAR_TOKEN_KEY (dev mode: a key derived from the session secret).
 */
@Injectable()
export class CalendarService {
  private readonly tokenKey: string;
  constructor(
    private readonly db: DbService, private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig, @Inject(CALENDAR_PROVIDER) private readonly provider: CalendarProvider,
  ) {
    this.tokenKey = config.CALENDAR_TOKEN_KEY ?? createHash("sha256").update(`calendar:${config.SESSION_SECRET}`).digest("hex");
  }

  get mode() { return this.config.CALENDAR_MODE; }

  redirectUri(): string {
    return new URL("/api/v1/calendar/support/callback", this.config.PUBLIC_BASE_URL).toString();
  }

  /** Signed, short-lived state for the OAuth round trip (the same pattern as the sign-in cookie). */
  signState(calendarId: string, userId: string): { cookie: string; state: string } {
    const state = randomBytes(16).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ state, calendarId, userId })).toString("base64url");
    return { cookie: `${payload}.${this.sign(payload)}`, state };
  }
  readState(raw: string | undefined, state: string, userId: string): { calendarId: string } {
    const [payload, sig] = (raw ?? "").split(".");
    const expected = payload ? Buffer.from(this.sign(payload)) : Buffer.alloc(0);
    if (!payload || !sig || expected.length !== sig.length || !timingSafeEqual(expected, Buffer.from(sig))) {
      throw new ForbiddenException("calendar_state_expired");
    }
    const saved = JSON.parse(Buffer.from(payload, "base64url").toString()) as { state: string; calendarId: string; userId: string };
    if (saved.state !== state || saved.userId !== userId) throw new ForbiddenException("calendar_state_mismatch");
    return { calendarId: saved.calendarId };
  }
  private sign(value: string): string {
    return createHmac("sha256", this.config.SESSION_SECRET).update(`calendar:${value}`).digest("base64url");
  }

  private async connection(c: pg.PoolClient): Promise<ConnectionRow | null> {
    const { rows } = await c.query<ConnectionRow>(
      `SELECT k.provider, k.calendar_id, k.account_email::text AS account_email, k.token_enc, k.connected_at, k.connected_by, u.display_name AS connected_by_name
         FROM eureka.calendar_connection k LEFT JOIN eureka.app_user u ON u.id = k.connected_by WHERE k.key = $1`, [KEY]);
    return rows[0] ?? null;
  }
  private presentConnection(k: ConnectionRow | null) {
    return {
      mode: this.mode,
      connected: k !== null,
      calendarId: k?.calendar_id ?? null,
      accountEmail: k?.account_email ?? null,
      connectedAt: k?.connected_at ?? null,
      connectedBy: k ? { id: k.connected_by, name: k.connected_by_name } : null,
    };
  }

  async status(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => this.presentConnection(await this.connection(c)));
  }

  authUrl(state: string): string {
    return this.provider.authUrl(this.redirectUri(), state);
  }

  async complete(user: AuthedUser, code: string, calendarId: string) {
    const { refreshToken, email } = await this.provider.exchange(code, this.redirectUri());
    const tokenEnc = encryptToken(refreshToken, this.tokenKey);
    return this.db.withUser(user.id, async (c) => {
      await c.query(
        `INSERT INTO eureka.calendar_connection (key, provider, calendar_id, account_email, token_enc) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO UPDATE SET provider = EXCLUDED.provider, calendar_id = EXCLUDED.calendar_id,
           account_email = EXCLUDED.account_email, token_enc = EXCLUDED.token_enc`,
        [KEY, this.provider.kind, calendarId, email, tokenEnc]);
      // The account and calendar addresses are redacted by the audit service; the fact of a connection is kept.
      await this.audit.record(c, { actorId: user.id, action: "calendar.connected", entityType: "calendar_connection", changes: { provider: this.provider.kind } });
      return this.presentConnection(await this.connection(c));
    });
  }

  async disconnect(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => {
      const n = (await c.query(`DELETE FROM eureka.calendar_connection WHERE key = $1`, [KEY])).rowCount ?? 0;
      if (n) await this.audit.record(c, { actorId: user.id, action: "calendar.disconnected", entityType: "calendar_connection", changes: {} });
      return this.presentConnection(null);
    });
  }

  /** The interview under the caller's RLS (404), then the calendar:block scope over its actor snapshot (403). */
  private async interview(c: pg.PoolClient, user: AuthedUser, id: string): Promise<InterviewRow> {
    const { rows } = await c.query<InterviewRow>(
      `SELECT i.id, i.round, i.starts_at, i.ends_at, i.call_status, i.interview_type, i.meeting_url, i.recruiter_id, i.team_id, i.location_id,
              c.recruiter_id AS c_recruiter, c.team_id AS c_team, c.location_id AS c_location,
              CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
              cl.name AS client_name, s.job_title, ru.display_name AS recruiter_name
         FROM eureka.interview i
         LEFT JOIN eureka.candidate c ON c.id = i.candidate_id
         LEFT JOIN eureka.person p ON p.id = c.person_id
         LEFT JOIN eureka.client cl ON cl.id = i.client_id
         LEFT JOIN eureka.submission s ON s.id = i.submission_id
         LEFT JOIN eureka.app_user ru ON ru.id = i.recruiter_id
        WHERE i.id = $1`, [id]);
    const r = rows[0];
    if (!r) throw new NotFoundException();
    const scope = resolveScope(user.access, "calendar:block");
    const visible = activityVisible(scope, {
      recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id,
      candidate: { recruiterId: r.c_recruiter, teamId: r.c_team, locationId: r.c_location, visibility: "team", marketingStatus: "" },
    });
    if (!visible) throw new ForbiddenException("Not permitted");
    return r;
  }

  private async activeBlock(c: pg.PoolClient, interviewId: string): Promise<BlockRow | null> {
    const { rows } = await c.query<BlockRow>(
      `SELECT b.id, b.calendar_id, b.external_id, b.starts_at, b.ends_at, b.created_at, b.created_by, u.display_name AS created_by_name
         FROM eureka.calendar_block b LEFT JOIN eureka.app_user u ON u.id = b.created_by
        WHERE b.interview_id = $1 AND b.status = 'active'`, [interviewId]);
    return rows[0] ?? null;
  }
  private presentBlock(b: BlockRow | null) {
    return b ? { id: b.id, calendarId: b.calendar_id, startsAt: b.starts_at, endsAt: b.ends_at, createdAt: b.created_at, createdBy: { id: b.created_by, name: b.created_by_name } } : null;
  }

  /** The interview's block (readers of the interview) and whether the caller may block it. */
  async blockStatus(user: AuthedUser, interviewId: string) {
    return this.db.withUser(user.id, async (c) => {
      const exists = await c.query(`SELECT 1 FROM eureka.interview WHERE id = $1`, [interviewId]);
      if (!exists.rowCount) throw new NotFoundException();
      let canBlock = false;
      try { await this.interview(c, user, interviewId); canBlock = true; } catch { canBlock = false; }
      const connected = canBlock ? (await this.connection(c)) !== null : false;
      return { block: this.presentBlock(await this.activeBlock(c, interviewId)), canBlock, connected };
    });
  }

  async block(user: AuthedUser, interviewId: string) {
    return this.db.withUser(user.id, async (c) => {
      const i = await this.interview(c, user, interviewId);
      if (i.call_status !== "scheduled") throw new UnprocessableEntityException("interview_not_scheduled");
      if (await this.activeBlock(c, interviewId)) throw new ConflictException("already_blocked");
      const k = await this.connection(c);
      if (!k) throw new UnprocessableEntityException("calendar_not_connected");
      const token = decryptToken(k.token_enc, this.tokenKey);
      const type = i.interview_type ? INTERVIEW_TYPE_LABELS[i.interview_type as keyof typeof INTERVIEW_TYPE_LABELS] ?? i.interview_type : null;
      const description = [
        `Candidate: ${i.candidate_name ?? "—"}`, `Client: ${i.client_name ?? "—"}`, `Position: ${i.job_title ?? "—"}`,
        `Round: ${i.round}`, `Type: ${type ?? "—"}`, `Meeting link: ${i.meeting_url ?? "—"}`, `Recruiter: ${i.recruiter_name ?? "—"}`,
        `Blocked from Eureka by ${user.id}`,
      ].join("\n");
      const externalId = await this.provider.createEvent(token, k.calendar_id, {
        summary: `Interview: ${i.round} – ${i.candidate_name ?? "candidate"}`, description, startsAt: i.starts_at, endsAt: i.ends_at,
      });
      try {
        await c.query(
          `INSERT INTO eureka.calendar_block (interview_id, calendar_id, external_id, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5)`,
          [interviewId, k.calendar_id, externalId, i.starts_at, i.ends_at]);
      } catch (err) {
        // The row did not land (concurrent block, policy): take the event back so the calendar matches the database.
        await this.provider.deleteEvent(token, k.calendar_id, externalId).catch(() => undefined);
        if ((err as { code?: string }).code === "23505") throw new ConflictException("already_blocked");
        throw err;
      }
      await this.audit.record(c, { actorId: user.id, action: "calendar.blocked", entityType: "interview", entityId: interviewId, changes: { provider: k.provider } });
      return { block: this.presentBlock(await this.activeBlock(c, interviewId)), canBlock: true, connected: true };
    });
  }

  async release(user: AuthedUser, interviewId: string) {
    return this.db.withUser(user.id, async (c) => {
      await this.interview(c, user, interviewId);
      const b = await this.activeBlock(c, interviewId);
      if (!b) throw new NotFoundException("no_active_block");
      const k = await this.connection(c);
      // A connection replaced or removed since the block: the event cannot be reached; the record is still released.
      if (k && k.calendar_id === b.calendar_id) await this.provider.deleteEvent(decryptToken(k.token_enc, this.tokenKey), k.calendar_id, b.external_id);
      await c.query(`UPDATE eureka.calendar_block SET status = 'released' WHERE id = $1 AND status = 'active'`, [b.id]);
      await this.audit.record(c, { actorId: user.id, action: "calendar.released", entityType: "interview", entityId: interviewId, changes: { reachable: k !== null && k.calendar_id === b.calendar_id } });
      return { block: null, canBlock: true, connected: k !== null };
    });
  }
}
