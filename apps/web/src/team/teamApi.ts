/** Typed client for a lead's own teams (docs/admin-api.md AD-10). */
import { ApiError, api } from "../api";

export interface Ref { id: string; displayName: string }
export interface MyTeam { id: string; name: string; lead: Ref; members: Ref[] }
export interface Addable extends Ref { email: string }

const enc = encodeURIComponent;
export const teamApi = {
  mine: () => api<{ items: MyTeam[]; addable: Addable[] }>("/api/v1/teams/mine"),
  addMember: (teamId: string, userId: string) =>
    api<void>(`/api/v1/teams/${enc(teamId)}/members`, { method: "POST", body: JSON.stringify({ userId }) }),
  /** AD-14: their candidates on the team go to its lead. */
  removeMember: (teamId: string, userId: string) =>
    api<{ movedCandidates: number }>(`/api/v1/teams/${enc(teamId)}/members/${enc(userId)}`, { method: "DELETE" }),
};
export const teamKeys = { mine: ["teams", "mine"] as const };

export function teamError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail === "already_member") return "That person joined a team in the meantime. Ask an admin or manager to move them.";
  if (e.detail === "not_a_recruiter") return "Only people with the Recruiter role can be added here.";
  if (e.detail === "user_inactive") return "That person is no longer active.";
  if (e.detail === "not_a_member") return "That person is no longer in this team.";
  if (e.detail === "invalid_reassign_target") return "The team's lead is inactive, so their candidates have nowhere to go. Ask an admin to change the lead first.";
  if (e.status === 403) return "You can only change a team you lead or one led in your hierarchy.";
  if (e.status === 404) return "That team no longer exists.";
  return e.detail ?? e.title ?? e.message;
}
