/** Typed client for the support calendar (docs/alerts-calendar-birthdays.md CA-1..CA-7). */
import { ApiError, api } from "../api";

export interface CalendarStatus {
  mode: "disabled" | "dev" | "google";
  connected: boolean;
  /** False for a connection made before the free/busy scope (CA-7): reconnect to enable the check. */
  freeBusy: boolean;
  calendarId: string | null;
  accountEmail: string | null;
  connectedAt: string | null;
  connectedBy: { id: string; name: string | null } | null;
}
export interface CalendarBlock {
  id: string; calendarId: string; startsAt: string; endsAt: string; createdAt: string; createdBy: { id: string; name: string | null };
}
export interface BlockStatus { block: CalendarBlock | null; canBlock: boolean; connected: boolean }
/** CA-7: intervals only; `available` is false until the connection can answer free/busy. */
export interface BusyInterval { startsAt: string; endsAt: string }
export interface BusyStatus { connected: boolean; available: boolean; busy: BusyInterval[] }

const enc = encodeURIComponent;
export const calendarApi = {
  status: () => api<CalendarStatus>("/api/v1/calendar/support"),
  /** Top-level navigation: the OAuth round trip needs the session cookie and ends back in the app. */
  connectUrl: (calendarId: string) => `/api/v1/calendar/support/connect?calendarId=${enc(calendarId)}`,
  disconnect: () => api<CalendarStatus>("/api/v1/calendar/support/disconnect", { method: "POST" }),
  busy: (from: string, to: string) => api<BusyStatus>(`/api/v1/calendar/support/busy?from=${enc(from)}&to=${enc(to)}`),
  blockStatus: (interviewId: string) => api<BlockStatus>(`/api/v1/interviews/${enc(interviewId)}/calendar-block`),
  block: (interviewId: string) => api<BlockStatus>(`/api/v1/interviews/${enc(interviewId)}/calendar-block`, { method: "POST" }),
  release: (interviewId: string) => api<BlockStatus>(`/api/v1/interviews/${enc(interviewId)}/calendar-block/release`, { method: "POST" }),
};
export const calendarKeys = {
  status: ["calendar", "support"] as const,
  busy: (from: string, to: string) => ["calendar", "busy", from, to] as const,
  block: (interviewId: string) => ["calendar", "block", interviewId] as const,
};

const ERRORS: Record<string, string> = {
  calendar_not_connected: "The support calendar is not connected. Connect it from the Interviews page first.",
  interview_not_scheduled: "Only a scheduled interview can be blocked on the support calendar.",
  already_blocked: "This interview is already blocked on the support calendar.",
  no_active_block: "This interview is not blocked on the support calendar.",
  calendar_state_expired: "The calendar authorisation expired. Start again.",
  calendar_state_mismatch: "The calendar authorisation did not match this sign-in. Start again.",
  calendar_unavailable: "The calendar provider did not answer. Try again in a moment.",
};
export function calendarError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && ERRORS[e.detail]) return ERRORS[e.detail]!;
  if (e.status === 403) return "You are not allowed to change the support calendar for this interview.";
  if (e.status === 404) return "The interview is no longer available.";
  if (e.status >= 500) return "The calendar provider did not accept the request. Try again in a moment.";
  return e.detail ?? e.title ?? e.message;
}
