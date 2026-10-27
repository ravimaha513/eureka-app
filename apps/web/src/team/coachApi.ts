/** Typed client for interview coach assignments (docs/admin-api.md AD-11). */
import { ApiError, api } from "../api";

export interface Ref { id: string; displayName: string }
export interface Coach extends Ref { email: string; role: "interview_coach" | "interview_lead" }
export interface CoachedTeam { id: string; name: string; lead: Ref; coaches: Ref[] }
/** "admin": Users & Access (access:manage, any coach); "lead": an Interview Lead's own coaches (coach:assign). */
export type CoachVia = "admin" | "lead";

const enc = encodeURIComponent;
const base = (via: CoachVia, teamId: string) =>
  `${via === "admin" ? "/api/v1/admin/teams" : "/api/v1/teams"}/${enc(teamId)}/coaches`;

export const coachApi = {
  mine: () => api<{ items: CoachedTeam[]; coaches: Coach[] }>("/api/v1/coach-assignments"),
  assign: (via: CoachVia, teamId: string, userId: string) =>
    api<void>(base(via, teamId), { method: "POST", body: JSON.stringify({ userId }) }),
  unassign: (via: CoachVia, teamId: string, userId: string) =>
    api<void>(`${base(via, teamId)}/${enc(userId)}`, { method: "DELETE" }),
};
export const coachKeys = { mine: ["coach-assignments"] as const };

export function coachError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail === "already_assigned") return "That coach already supports this team.";
  if (e.detail === "not_assigned") return "That coach no longer supports this team. Refresh and try again.";
  if (e.detail === "not_a_coach") return "Only people with the Interview Coach or Interview Lead role can coach a team.";
  if (e.detail === "user_inactive") return "That person is no longer active.";
  if (e.detail === "self_change") return "You can't change your own coaching assignments. Ask an admin.";
  if (e.status === 403) return "You can only assign coaches who report to you.";
  if (e.status === 404) return "That team no longer exists.";
  return e.detail ?? e.title ?? e.message;
}
