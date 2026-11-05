import { ForbiddenException, HttpException, Inject, Injectable, Logger, UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { decryptToken, encryptToken } from "../../worker/feedback-mail.js";
import { CALENDAR_PROVIDER, type CalendarProvider, type CoachEvent } from "./calendar.provider.js";
import { CalendarService } from "./calendar.service.js";
import { CoachCalendarQuery } from "./coach-calendar.schemas.js";

/** Binds the signed OAuth state to this flow, so a support calendar round trip cannot finish here. */
export const COACH_GOOGLE_PURPOSE = "coach-google";
const CONCURRENT_READS = 6;
/** A hung Google must not hold a request: coaches still pending by then show as unavailable. */
const READ_DEADLINE_MS = 20_000;
/** Each call costs about two Google requests per connected coach, and nothing is cached. */
const READS_PER_MINUTE = 60;

type CoachStatus = "connected" | "not_connected" | "reconnect" | "unavailable";
interface ConnectionRow { coach_id: string; detail: "full" | "busy"; provider: string; token_enc: string; scopes: string }
interface MeRow { can_connect: boolean; connected: boolean; account_email: string | null; login_email: string }

/** A refused token means the coach must reconnect; anything else may pass by itself. Never forwards the provider's message. */
const needsReconnect = (e: unknown) =>
  /token request failed \((400|401)\)|events read failed \((401|403 insufficientPermissions)/.test(String((e as { message?: unknown })?.message ?? ""));

/**
 * Coaches' own Google Calendars on the coach grid (docs/coach-calendar-api.md CC-6..CC-8, migration
 * 0550). A coach connects themself; who may then see them is the existing CEO-managed grant.
 * Events are read live and kept nowhere. Busy-only viewers get times, never titles.
 */
@Injectable()
export class CoachGoogleService {
  private readonly log = new Logger("CoachGoogle");
  private readonly readLimiter = new RateLimiter(READS_PER_MINUTE, 60_000);
  constructor(
    private readonly db: DbService, private readonly audit: AuditService, private readonly calendar: CalendarService,
    @Inject(CONFIG) private readonly config: AppConfig, @Inject(CALENDAR_PROVIDER) private readonly provider: CalendarProvider,
  ) {}

  redirectUri(): string {
    return new URL("/api/v1/coach-calendar/google/callback", this.config.PUBLIC_BASE_URL).toString();
  }

  private async me(user: AuthedUser): Promise<MeRow | null> {
    return this.db.withUser(user.id, async (c) => (await c.query<MeRow>(`SELECT * FROM authz.coach_google_me()`)).rows[0] ?? null);
  }

  /** CC-7: the signed state and the consent page. Only coaches connect. */
  async start(user: AuthedUser): Promise<{ cookie: string; url: string }> {
    const me = await this.me(user);
    if (!me?.can_connect) throw new ForbiddenException("Not permitted");
    const { cookie, state } = this.calendar.signState(COACH_GOOGLE_PURPOSE, user.id);
    return { cookie, url: this.provider.coachAuthUrl(this.redirectUri(), state, me.login_email) };
  }

  /** CC-7: finishes the round trip. Throws a 422 with the reason the screen explains. */
  async complete(user: AuthedUser, code: string): Promise<void> {
    const { refreshToken, email, emailVerified, scopes } = await this.provider.exchange(code, this.redirectUri());
    // A refused token is dropped, not revoked: Google revokes per account and OAuth client, which
    // could end the shared support calendar or another coach's connection on a shared browser.
    if (!emailVerified) throw new UnprocessableEntityException("wrong_account");
    if (!this.provider.coachEventsGranted(scopes)) throw new UnprocessableEntityException("scope_missing");
    const tokenEnc = encryptToken(refreshToken, this.calendar.tokenKey);
    await this.db.withUser(user.id, async (c) => {
      await c.query(`SELECT authz.coach_google_connect($1, $2, $3, $4)`, [this.provider.kind, email, tokenEnc, scopes])
        .catch((e: unknown) => {
          if ((e as { message?: string }).message === "wrong_account") throw new UnprocessableEntityException("wrong_account");
          throw e;
        });
      await this.audit.record(c, {
        actorId: user.id, action: "coach_calendar.google_connected", entityType: "coach_google_connection", entityId: user.id,
        changes: { provider: this.provider.kind },
      });
    });
  }

  /** CC-8: a coach ends their own connection. Revoking at Google is best effort; the token is gone from here either way. */
  async disconnect(user: AuthedUser): Promise<void> {
    const removed = await this.db.withUser(user.id, async (c) => {
      const row = (await c.query<{ provider: string; token_enc: string; revocable: boolean }>(`SELECT * FROM authz.coach_google_disconnect()`)).rows[0];
      if (row) {
        await this.audit.record(c, {
          actorId: user.id, action: "coach_calendar.google_disconnected", entityType: "coach_google_connection", entityId: user.id,
          changes: { provider: row.provider },
        });
      }
      return row ?? null;
    });
    if (!removed?.revocable || removed.provider !== this.provider.kind) return;
    try {
      await this.provider.revoke(decryptToken(removed.token_enc, this.calendar.tokenKey));
    } catch { /* The local row is what grants access. */ }
  }

  /** CC-6: what the screen layers over the interviews. One coach's failure never fails the others. */
  async events(user: AuthedUser, query: unknown) {
    const { me, coaches, connections, window } = await this.db.withUser(user.id, async (c) => {
      const ok = (await c.query<{ ok: boolean }>(`SELECT authz.coach_calendar_can_view() AS ok`)).rows[0]?.ok;
      if (!ok) throw new ForbiddenException("Not permitted");
      const parsed = CoachCalendarQuery.parse(query);
      if (!this.readLimiter.take(user.id)) throw new HttpException("rate_limited", 429);
      return {
        window: parsed,
        me: (await c.query<MeRow>(`SELECT * FROM authz.coach_google_me()`)).rows[0] ?? null,
        coaches: (await c.query<{ coach_id: string }>(`SELECT coach_id FROM authz.coach_calendar_visible()`)).rows,
        connections: (await c.query<ConnectionRow>(`SELECT * FROM authz.coach_google_connections()`)).rows,
      };
    });
    const enabled = this.config.CALENDAR_MODE !== "disabled";
    const status = new Map<string, CoachStatus>(coaches.map((c) => [c.coach_id, "not_connected"]));
    const events: { coachId: string; startsAt: string; endsAt: string; title: string | null }[] = [];
    const allDay: { coachId: string; startDate: string; endDate: string; title: string | null }[] = [];

    const read = async (k: ConnectionRow) => {
      if (k.provider !== this.provider.kind || !this.provider.coachEventsGranted(k.scopes)) { status.set(k.coach_id, "reconnect"); return; }
      let token: string;
      // A token that no longer decrypts (rotated key) can only be fixed by connecting again.
      try { token = decryptToken(k.token_enc, this.calendar.tokenKey); } catch { status.set(k.coach_id, "reconnect"); return; }
      let items: CoachEvent[];
      try {
        items = await this.provider.coachEvents(token, window.from, window.to);
      } catch (e) {
        status.set(k.coach_id, needsReconnect(e) ? "reconnect" : "unavailable");
        // Status and Google's reason word only, never the response body.
        this.log.warn(`events read failed: ${(e as Error)?.name ?? "Error"} ${/\(([^)]*)\)/.exec(String((e as Error)?.message))?.[1] ?? ""}`.trim());
        return;
      }
      status.set(k.coach_id, "connected");
      for (const ev of items) {
        const title = k.detail === "full" ? ev.title : null;
        if (ev.allDay) allDay.push({ coachId: k.coach_id, startDate: ev.startDate, endDate: ev.endDate, title });
        else events.push({ coachId: k.coach_id, startsAt: ev.startsAt.toISOString(), endsAt: ev.endsAt.toISOString(), title });
      }
    };
    if (enabled) {
      // Stays so for any coach still pending when the deadline passes.
      for (const k of connections) status.set(k.coach_id, "unavailable");
      const queue = [...connections];
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(CONCURRENT_READS, queue.length) }, async () => {
          for (let k = queue.shift(); k; k = queue.shift()) await read(k);
        })),
        new Promise((resolve) => { timer = setTimeout(resolve, READ_DEADLINE_MS); }),
      ]);
      clearTimeout(timer);
      queue.length = 0; // Nothing further starts after the deadline.
    }
    return {
      enabled,
      me: { canConnect: enabled && me?.can_connect === true, connected: me?.connected === true, accountEmail: me?.account_email ?? null },
      coaches: enabled ? [...status].map(([coachId, s]) => ({ coachId, status: s })) : [],
      // Copies: a read still finishing after the deadline must not change this answer.
      events: [...events], allDay: [...allDay],
    };
  }
}
