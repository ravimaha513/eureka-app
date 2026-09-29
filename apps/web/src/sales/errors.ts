import { ApiError } from "../api";

export type SalesErrorContext = "profile" | "submission" | "create" | "transition" | "generic";

/** Plain-language text for a failed candidate or submission call (RFC 9457 problem). */
export function salesError(e: unknown, ctx: SalesErrorContext = "generic"): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return ctx === "create"
      ? "You can't create candidates in that team."
      : "You don't have permission to change this candidate. It belongs to a team outside your scope.";
    case 404: return ctx === "submission"
      ? "This candidate isn't available for submission from your account."
      : "This candidate doesn't exist or belongs to another team.";
    case 409: return ctx === "submission"
      ? "A conflicting submission already exists for this candidate and client."
      : "A conflicting record exists. Refresh and try again.";
    case 422:
      if (e.errors?.length) return "Some fields need attention. Check the highlighted fields.";
      if (ctx === "transition") return "That status change isn't allowed from the candidate's current status.";
      return "The server rejected this change. Check the values and try again.";
    case 429: return e.detail ?? "Too many requests. Try again in a minute.";
    default: return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
  }
}

/**
 * Maps a 422 problem's `errors` array to form fields by top-level path.
 * Issues without a matching field are returned under `_form`.
 */
export function fieldErrors(e: unknown, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(e instanceof ApiError) || e.status !== 422 || !e.errors) return out;
  for (const issue of e.errors) {
    const key = issue.path.split(".")[0] ?? "";
    const target = fields.includes(key) ? key : "_form";
    if (target === "_form" && issue.path) out._form = [out._form, `${issue.path}: ${issue.message}`].filter(Boolean).join("; ");
    else if (target === "_form") out._form = [out._form, issue.message].filter(Boolean).join("; ");
    else out[target] ??= issue.message;
  }
  return out;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
