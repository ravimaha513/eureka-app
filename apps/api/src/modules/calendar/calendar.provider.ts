import { randomUUID } from "node:crypto";

/**
 * The support calendar port (interview-alerts package, docs/alerts-calendar-birthdays.md CA-1..CA-6).
 *
 *   google: Google Calendar through OAuth 2.0 (offline access, scope
 *           calendar.events + openid email) and the Calendar v3 REST API, with
 *           Node's fetch. The refresh token is the only credential kept (encrypted
 *           by the service); access tokens live in memory for one call.
 *   dev:    an in-memory calendar for development and tests: "connecting" needs
 *           no Google account and events are kept in a map (the API's dev-only
 *           inspection route lists them).
 *
 * Provider error messages never carry response bodies (they can name the account).
 */
export interface CalendarEventInput { summary: string; description: string; startsAt: Date; endsAt: Date }
export interface CalendarProvider {
  readonly kind: "google" | "dev";
  /** Where the browser goes to authorise; the callback returns to `redirectUri` with `code` and `state`. */
  authUrl(redirectUri: string, state: string): string;
  /** Exchanges the authorisation code for the refresh token and the authorising account's email. */
  exchange(code: string, redirectUri: string): Promise<{ refreshToken: string; email: string }>;
  /** Creates a busy event on `calendarId`; returns the provider's event id. */
  createEvent(refreshToken: string, calendarId: string, ev: CalendarEventInput): Promise<string>;
  /** Removes the event; an event already gone counts as removed. */
  deleteEvent(refreshToken: string, calendarId: string, eventId: string): Promise<void>;
}
export const CALENDAR_PROVIDER = Symbol("CALENDAR_PROVIDER");

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR = "https://www.googleapis.com/calendar/v3";
const SCOPE = "openid email https://www.googleapis.com/auth/calendar.events";

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
    try { email = payload ? String((JSON.parse(Buffer.from(payload, "base64url").toString()) as { email?: unknown }).email ?? "") : ""; } catch { email = ""; }
    if (!email) throw new Error("calendar authorisation returned no account email");
    return { refreshToken, email: email.toLowerCase() };
  }

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
}

export interface DevCalendarEvent extends CalendarEventInput { id: string; calendarId: string }

/** Development and tests: no Google; events live in memory for the life of the process. */
export class DevCalendarProvider implements CalendarProvider {
  readonly kind = "dev" as const;
  readonly events = new Map<string, DevCalendarEvent>();
  /** When set, the next createEvent fails (tests). */
  failNext: Error | null = null;

  authUrl(redirectUri: string, state: string): string {
    const u = new URL(redirectUri);
    u.searchParams.set("code", "dev");
    u.searchParams.set("state", state);
    return u.toString();
  }
  async exchange(code: string) {
    if (code !== "dev") throw new Error("calendar token request failed (400)");
    return { refreshToken: `dev-refresh-${randomUUID()}`, email: "support@eureka.example" };
  }
  async createEvent(_token: string, calendarId: string, ev: CalendarEventInput): Promise<string> {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    const id = `dev-${randomUUID()}`;
    this.events.set(id, { id, calendarId, ...ev });
    return id;
  }
  async deleteEvent(_token: string, _calendarId: string, eventId: string): Promise<void> {
    this.events.delete(eventId);
  }
}
