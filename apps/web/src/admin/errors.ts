import { ApiError } from "../api";

/** Friendly text for the RFC 9457 `detail` codes in docs/admin-api.md. */
export const ERROR_MESSAGES: Record<string, string> = {
  self_change: "You can't change your own roles, status or reporting line. Ask another admin.",
  second_approver_required: "A second admin has to approve this. The requester and the person receiving the role can't approve it.",
  restricted_role: "This role is restricted and needs a second approver.",
  location_required: "Pick a location. This role is tied to a location.",
  location_not_allowed: "This role isn't tied to a location. Clear the location and try again.",
  already_member: "This person is already in a team. Use “Move to team…” instead.",
  not_in_scope: "That's outside your scope. You need the permission for both teams or people involved.",
  invalid_reassign_target: "Candidates can only go to an active member or the lead of the old team.",
  cycle: "That would create a reporting loop (someone would end up managing themselves).",
  lead_of_team: "This person leads a team. Give the team a new lead first, then deactivate them.",
  last_admin: "At least one active admin must remain.",
  has_reports: "This person still manages people. Move their direct reports to another manager first.",
  separation_of_duties: "Admins can't hold business roles, and people with business roles can't be admins. Use a separate account.",
  requester_not_admin: "The person who asked for this role is no longer an admin, so it can't be approved. Ask for it again.",
  email_exists: "A user with this email already exists.",
  email_domain: "That email isn't allowed. Use an address in the company's Google domain (or a listed test address).",
  role_already_held: "This person already has that role.",
  request_pending: "A request for this role is already waiting for approval.",
  request_not_pending: "This request has already been decided.",
  request_expired: "This request expired. Ask for the role again.",
  user_inactive: "This person is deactivated. Reactivate them first.",
  invalid_manager: "Pick an active manager.",
  invalid_lead: "Pick an active person as the lead.",
  not_a_member: "This person isn't in that team any more. Refresh and try again.",
  same_team: "Pick a different team.",
  restricted_target: "This user holds a restricted role. Their password is set by whoever manages the database (set-password), not here.",
  password_weak: "Use 10 to 72 characters with at least one letter and one number.",
  password_login_disabled: "Password sign-in is not enabled in this environment.",
  unknown_role: "That role doesn't exist. Refresh and try again.",
};

/** What each operation's plain HTTP failures mean when the server sends no known code. */
export type ErrorContext = "createUser" | "addMember" | "generic";

export function friendlyError(e: unknown, ctx: ErrorContext = "generic"): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && ERROR_MESSAGES[e.detail]) return ERROR_MESSAGES[e.detail]!;
  if (ctx === "createUser" && e.status === 409) return "A user with this email already exists.";
  if (ctx === "createUser" && e.status === 422) return "That email isn't allowed. Use an address in the company's Google domain (or a listed test address).";
  if (ctx === "addMember" && e.status === 409) return ERROR_MESSAGES.already_member!;
  if (e.status === 403) return "You don't have permission to do that.";
  if (e.status === 404) return "That record no longer exists. Refresh and try again.";
  return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
}
