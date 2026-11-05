import { randomUUID } from "node:crypto";

/**
 * The support calendar port (interview-alerts package, docs/alerts-calendar-birthdays.md CA-1..CA-7).
 *
 *   google: Google Calendar through OAuth 2.0 (offline access, scopes
 *           calendar.events + calendar.freebusy + openid email) and the Calendar
 *           v3 REST API, with Node's fetch. The refresh token is the only
 *           credential kept (encrypted by the service); access tokens live in
 *           memory for one call.
 *   dev:    an in-memory calendar for development and tests: "connecting" needs
 *           no Google account and events are kept in a map (the API's dev-only
 *           inspection route lists them).
 *
 * Provider error messages never carry response bodies (they can name the account).
 */
export interface CalendarEventInput { summary: string; description: string; startsAt: Date; endsAt: Date }
/** A busy period: the interval only (CA-7). Titles and attendees never leave the provider. */
export interface BusyInterval { startsAt: Date; endsAt: Date }
/**
 * An event on a coach's own calendar (CC-6). `title` is null for an event the coach marked private
 * or confidential. Location, description, attendees and links are never requested from Google.
 */
export type CoachEvent =
  | { allDay: false; startsAt: Date; endsAt: Date; title: string | null }
  /** `endDate` is exclusive, as Google gives it. */
  | { allDay: true; startDate: string; endDate: string; title: string | null };
export interface CalendarProvider {
  readonly kind: "google" | "dev";
  /** The consent page for a coach's own calendar (read-only); `loginHint` preselects their account. */
  coachAuthUrl(redirectUri: string, state: string, loginHint: string): string;
  /** Whether these granted scopes can read events (the consent screen lets people untick a scope). */
  coachEventsGranted(scopes: string): boolean;
  /** The coach's primary calendar between `from` and `to`, without declined or cancelled events. */
  coachEvents(refreshToken: string, from: Date, to: Date): Promise<CoachEvent[]>;
  /** Ends the access at the provider; an already dead token counts as revoked. */
  revoke(refreshToken: string): Promise<void>;
  /** Where the browser goes to authorise; the callback returns to `redirectUri` with `code` and `state`. */
  authUrl(redirectUri: string, state: string): string;
  /** Exchanges the authorisation code for the refresh token, the authorising account's email and the scopes granted. */
  exchange(code: string, redirectUri: string): Promise<{ refreshToken: string; email: string; emailVerified: boolean; scopes: string }>;
  /** Whether a connection made with these granted scopes can answer freeBusy (older connections need a reconnect). */
  freeBusyGranted(scopes: string): boolean;
  /** Creates a busy event on `calendarId`; returns the provider's event id. */
  createEvent(refreshToken: string, calendarId: string, ev: CalendarEventInput): Promise<string>;
  /** Removes the event; an event already gone counts as removed. */
  deleteEvent(refreshToken: string, calendarId: string, eventId: string): Promise<void>;
  /** The busy periods of `calendarId` between `from` and `to` (read-only; intervals only). */
  freeBusy(refreshToken: string, calendarId: string, from: Date, to: Date): Promise<BusyInterval[]>;
}
export const CALENDAR_PROVIDER = Symbol("CALENDAR_PROVIDER");

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR = "https://www.googleapis.com/calendar/v3";
/**
 * calendar.events writes the blocks; it does NOT cover freebusy.query (Google
 * accepts calendar, calendar.readonly, calendar.freebusy or
 * calendar.events.freebusy there), so calendar.freebusy is added: it reads
 * busy periods only, never titles or attendees, which keeps rule 5 at the
 * provider boundary. A connection granted before this scope existed has none
 * of the four and must be reconnected (CA-7).
 */
const FREEBUSY_SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar",
];
export const SCOPE = "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";

const grantedFreeBusy = (scopes: string) => scopes.split(/\s+/).some((s) => FREEBUSY_SCOPES.includes(s));

/** A coach's connection is read-only: it can never change their calendar. */
const COACH_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const COACH_SCOPE = `openid email ${COACH_EVENTS_SCOPE}`;
const COACH_EVENT_READ_SCOPES = [COACH_EVENTS_SCOPE, "https://www.googleapis.com/auth/calendar.readonly"];
const grantedCoachEvents = (scopes: string) => scopes.split(/\s+/).some((s) => COACH_EVENT_READ_SCOPES.includes(s));
/** Only what the grid shows, plus what decides whether to hide or mask an event. */
const COACH_EVENT_FIELDS = "nextPageToken,items(summary,start,end,status,visibility,attendees(self,responseStatus))";
const COACH_EVENT_PAGES = 4;

interface GoogleEventItem {
  summary?: unknown; status?: unknown; visibility?: unknown;
  start?: { dateTime?: unknown; date?: unknown }; end?: { dateTime?: unknown; date?: unknown };
  attendees?: { self?: unknown; responseStatus?: unknown }[];
}

/** One Google event as the grid sees it, or null when it should not show. Exported for its unit test. */
export function toCoachEvent(ev: GoogleEventItem): CoachEvent | null {
  if (ev.status === "cancelled") return null;
  if (ev.attendees?.some((a) => a.self === true && a.responseStatus === "declined")) return null;
  // The owner's own token returns private titles too, so masking them is on us.
  const hidden = ev.visibility === "private" || ev.visibility === "confidential";
  const summary = !hidden && typeof ev.summary === "string" ? ev.summary.trim().slice(0, 200) : "";
  const title = summary || null;
  if (typeof ev.start?.date === "string" && typeof ev.end?.date === "string") {
    return { allDay: true, startDate: ev.start.date, endDate: ev.end.date, title };
  }
  if (typeof ev.start?.dateTime !== "string" || typeof ev.end?.dateTime !== "string") return null;
  const startsAt = new Date(ev.start.dateTime);
  const endsAt = new Date(ev.end.dateTime);
  if (Number.isNaN(+startsAt) || Number.isNaN(+endsAt) || endsAt <= startsAt) return null;
  return { allDay: false, startsAt, endsAt, title };
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly kind = "google" as const;
  fetchImpl: typeof fetch = fetch;
  constructor(private readonly clientId: string, private readonly clientSecret: string) {}

  authUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, state,
      access_type: "offline", prompt: "consent", include_granted_scopes: "false",
    });
    return `${GOOGLE_AUTH}?${params}`;
  }

  coachAuthUrl(redirectUri: string, state: string, loginHint: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId, redirect_uri: redirectUri, response_type: "code", scope: COACH_SCOPE, state,
      access_type: "offline", prompt: "consent", include_granted_scopes: "false", login_hint: loginHint,
    });
    return `${GOOGLE_AUTH}?${params}`;
  }

  coachEventsGranted(scopes: string): boolean { return grantedCoachEvents(scopes); }

  async coachEvents(refreshToken: string, from: Date, to: Date): Promise<CoachEvent[]> {
    const access = await this.accessToken(refreshToken);
    const out: CoachEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < COACH_EVENT_PAGES; page++) {
      const params = new URLSearchParams({
        timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime",
        maxResults: "250", maxAttendees: "1", fields: COACH_EVENT_FIELDS,
      });
      // Working-location and birthday entries are not meetings.
      for (const t of ["default", "focusTime", "outOfOffice"]) params.append("eventTypes", t);
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.fetchImpl(`${GOOGLE_CALENDAR}/calendars/primary/events?${params}`, {
        headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`calendar events read failed (${res.status})`);
      const body = (await res.json()) as { items?: GoogleEventItem[]; nextPageToken?: unknown };
      for (const item of body.items ?? []) {
        const ev = toCoachEvent(item);
        if (ev) out.push(ev);
      }
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return out;
  }

  async revoke(refreshToken: string): Promise<void> {
    const res = await this.fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }), signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 400) throw new Error(`calendar revoke failed (${res.status})`);
  }

  private async token(body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(GOOGLE_TOKEN, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`calendar token request failed (${res.status})`);
    return (await res.json()) as Record<string, unknown>;
  }

  async exchange(code: string, redirectUri: string) {
    const t = await this.token({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
    const refreshToken = t.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken) throw new Error("calendar authorisation returned no refresh token");
    // The ID token comes straight from Google's token endpoint over TLS: its email claim is read without a second signature check.
    const idToken = typeof t.id_token === "string" ? t.id_token : "";
    const payload = idToken.split(".")[1];
    let email = "";
    let emailVerified = false;
    try {
      const claims = payload ? JSON.parse(Buffer.from(payload, "base64url").toString()) as { email?: unknown; email_verified?: unknown } : {};
      email = String(claims.email ?? "");
      emailVerified = claims.email_verified === true || claims.email_verified === "true";
    } catch { email = ""; }
    if (!email) throw new Error("calendar authorisation returned no account email");
    // The scopes the user actually granted (the consent screen lets them untick some).
    const scopes = typeof t.scope === "string" ? t.scope.trim() : "";
    return { refreshToken, email: email.toLowerCase(), emailVerified, scopes };
  }

  freeBusyGranted(scopes: string): boolean { return grantedFreeBusy(scopes); }

  private async accessToken(refreshToken: string): Promise<string> {
    const t = await this.token({ refresh_token: refreshToken, grant_type: "refresh_token" });
    if (typeof t.access_token !== "string") throw new Error("calendar refresh returned no access token");
    return t.access_token;
  }

  async createEvent(refreshToken: string, calendarId: string, ev: CalendarEventInput): Promise<string> {
    const access = await this.accessToken(refreshToken);
    const res = await this.fetchImpl(`${GOOGLE_CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: ev.summary, description: ev.description, transparency: "opaque",
        start: { dateTime: ev.startsAt.toISOString() }, end: { dateTime: ev.endsAt.toISOString() },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`calendar event creation failed (${res.status})`);
    const body = (await res.json()) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) throw new Error("calendar event creation returned no id");
    return body.id;
  }

  async deleteEvent(refreshToken: string, calendarId: string, eventId: string): Promise<void> {
    const access = await this.accessToken(refreshToken);
    const res = await this.fetchImpl(`${GOOGLE_CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE", headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`calendar event removal failed (${res.status})`);
  }

  /** POST /freeBusy: the merged busy periods of one calendar; no event fields are requested or returned. */
  async freeBusy(refreshToken: string, calendarId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    const access = await this.accessToken(refreshToken);
    const res = await this.fetchImpl(`${GOOGLE_CALENDAR}/freeBusy`, {
      method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`calendar free/busy query failed (${res.status})`);
    const body = (await res.json()) as { calendars?: Record<string, { busy?: { start?: unknown; end?: unknown }[]; errors?: unknown[] }> };
    const cal = body.calendars?.[calendarId] ?? Object.values(body.calendars ?? {})[0];
    if (!cal) throw new Error("calendar free/busy query returned no calendar");
    if (cal.errors?.length) throw new Error("calendar free/busy query refused for the calendar");
    const out: BusyInterval[] = [];
    for (const b of cal.busy ?? []) {
      const startsAt = typeof b.start === "string" ? new Date(b.start) : null;
      const endsAt = typeof b.end === "string" ? new Date(b.end) : null;
      if (!startsAt || !endsAt || Number.isNaN(+startsAt) || Number.isNaN(+endsAt) || endsAt <= startsAt) continue;
      out.push({ startsAt, endsAt });
    }
    return out.sort((a, b) => +a.startsAt - +b.startsAt);
  }
}

export interface DevCalendarEvent extends CalendarEventInput { id: string; calendarId: string }

/** Development and tests: no Google; events live in memory for the life of the process. */
export class DevCalendarProvider implements CalendarProvider {
  readonly kind = "dev" as const;
  readonly events = new Map<string, DevCalendarEvent>();
  /** When set, the next createEvent fails (tests). */
  failNext: Error | null = null;
  /** When set, the next deleteEvent fails (tests). */
  failNextDelete: Error | null = null;
  /** When set, runs once inside the next createEvent, before it returns (tests: changes made while the provider is called). */
  duringCreate: (() => Promise<void>) | null = null;
  /** Tests: what the next coach consent returns instead of the hinted account and full scopes. */
  nextCoachExchange: { refreshToken?: string; email?: string; emailVerified?: boolean; scopes?: string } | null = null;
  /** Tests: the events of a refresh token. A token with no entry gets sample events, for trying the screen locally. */
  readonly coachCalendars = new Map<string, CoachEvent[] | Error>();
  readonly revoked: string[] = [];

  authUrl(redirectUri: string, state: string): string {
    const u = new URL(redirectUri);
    u.searchParams.set("code", "dev");
    u.searchParams.set("state", state);
    return u.toString();
  }
  coachAuthUrl(redirectUri: string, state: string, loginHint: string): string {
    const u = new URL(redirectUri);
    u.searchParams.set("code", `dev:${loginHint}`);
    u.searchParams.set("state", state);
    return u.toString();
  }
  async exchange(code: string) {
    if (code.startsWith("dev:")) {
      const next = this.nextCoachExchange;
      this.nextCoachExchange = null;
      return {
        refreshToken: next?.refreshToken ?? `dev-refresh-${randomUUID()}`,
        email: next?.email ?? code.slice(4).toLowerCase(), emailVerified: next?.emailVerified ?? true, scopes: next?.scopes ?? COACH_SCOPE,
      };
    }
    if (code !== "dev") throw new Error("calendar token request failed (400)");
    return { refreshToken: `dev-refresh-${randomUUID()}`, email: "support@eureka.example", emailVerified: true, scopes: SCOPE };
  }
  coachEventsGranted(scopes: string): boolean { return grantedCoachEvents(scopes); }
  async coachEvents(refreshToken: string, from: Date, to: Date): Promise<CoachEvent[]> {
    const set = this.coachCalendars.get(refreshToken);
    if (set instanceof Error) throw set;
    if (set) {
      return set.filter((e) => e.allDay
        ? e.startDate < to.toISOString().slice(0, 10) && e.endDate > from.toISOString().slice(0, 10)
        : e.startsAt < to && e.endsAt > from);
    }
    const out: CoachEvent[] = [];
    for (let day = new Date(from); day < to; day = new Date(+day + 86_400_000)) {
      const at = (h: number, m = 0) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
      out.push({ allDay: false, startsAt: at(15), endsAt: at(15, 45), title: "Team sync" });
      out.push({ allDay: false, startsAt: at(18), endsAt: at(18, 30), title: null });
    }
    return out;
  }
  async revoke(refreshToken: string): Promise<void> { this.revoked.push(refreshToken); }
  freeBusyGranted(scopes: string): boolean { return grantedFreeBusy(scopes); }
  async createEvent(_token: string, calendarId: string, ev: CalendarEventInput): Promise<string> {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    const id = `dev-${randomUUID()}`;
    this.events.set(id, { id, calendarId, ...ev });
    const hook = this.duringCreate;
    this.duringCreate = null;
    if (hook) await hook();
    return id;
  }
  async deleteEvent(_token: string, _calendarId: string, eventId: string): Promise<void> {
    if (this.failNextDelete) { const e = this.failNextDelete; this.failNextDelete = null; throw e; }
    this.events.delete(eventId);
  }
  /** The fake calendar's events that overlap the window, as intervals (never the summary or description). */
  async freeBusy(_token: string, calendarId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    return [...this.events.values()]
      .filter((e) => e.calendarId === calendarId && e.startsAt < to && e.endsAt > from)
      .map((e) => ({ startsAt: e.startsAt, endsAt: e.endsAt }))
      .sort((a, b) => +a.startsAt - +b.startsAt);
  }
}
