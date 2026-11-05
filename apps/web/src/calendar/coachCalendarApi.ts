/** Typed client for the coach calendar (docs/coach-calendar-api.md CC-1..CC-5). */
import { ApiError, api } from "../api";

export type CoachCalendarDetail = "full" | "busy";
export interface CalendarCoach { id: string; name: string; detail: CoachCalendarDetail }
/** The last four are null when the viewer's grant for this coach is busy only. */
export interface CalendarEvent {
  coachId: string; startsAt: string; endsAt: string;
  interviewId: string | null; candidateName: string | null; round: string | null; callStatus: string | null;
}
export interface CoachCalendar { canManage: boolean; coaches: CalendarCoach[]; events: CalendarEvent[] }
export interface NamedId { id: string; name: string }
export interface CoachGrant {
  id: string;
  grantee: { type: "role"; role: string; name: string } | { type: "user"; id: string; name: string };
  allCoaches: boolean; coaches: NamedId[]; detail: CoachCalendarDetail; updatedAt: string;
}
export interface CoachGrants { items: CoachGrant[]; coaches: NamedId[]; roles: { key: string; label: string }[] }
export interface SetCoachGrant {
  granteeRole?: string; granteeUserId?: string; allCoaches: boolean; coachIds?: string[]; detail: CoachCalendarDetail;
}

const enc = encodeURIComponent;
export const coachCalendarKeys = {
  all: ["coach-calendar"] as const,
  calendar: (from: string, to: string) => ["coach-calendar", "grid", from, to] as const,
  grants: ["coach-calendar", "grants"] as const,
  people: (q: string) => ["coach-calendar", "people", q] as const,
};
export const coachCalendarApi = {
  calendar: (from: string, to: string) => api<CoachCalendar>(`/api/v1/coach-calendar?from=${enc(from)}&to=${enc(to)}`),
  grants: () => api<CoachGrants>("/api/v1/coach-calendar/grants"),
  people: (q: string) => api<{ items: NamedId[] }>(`/api/v1/coach-calendar/people?q=${enc(q)}`),
  setGrant: (b: SetCoachGrant) => api<{ id: string }>("/api/v1/coach-calendar/grants", { method: "POST", body: JSON.stringify(b) }),
  removeGrant: (id: string) => api<void>(`/api/v1/coach-calendar/grants/${enc(id)}`, { method: "DELETE" }),
};

export function coachCalendarError(e: unknown): string {
  const code = e instanceof ApiError ? e.detail : undefined;
  if (code === "invalid_grantee") return "That role or person can't be given access. Pick another.";
  if (code === "invalid_coaches") return "Choose at least one active coach.";
  if (e instanceof ApiError && e.status === 403) return "Only the CEO can change coach calendar access.";
  return "That didn't save. Try again.";
}
