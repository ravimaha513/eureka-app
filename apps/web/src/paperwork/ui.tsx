import { ApiError } from "../api";
import { PAPERWORK_ERRORS, paperworkLabel } from "./paperworkApi";

/** Friendly text for a paperwork API failure (detail codes first, then the HTTP status). */
export function paperworkError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && PAPERWORK_ERRORS[e.detail]) return PAPERWORK_ERRORS[e.detail]!;
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return "You don't have permission to do that for this record.";
    case 404: return "This placement's paperwork doesn't exist or is outside your scope.";
    case 409: return PAPERWORK_ERRORS.version_mismatch!;
    case 422: return e.errors?.length ? "Some fields need attention. Check the values and try again." : "The server rejected this change.";
    default: return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
  }
}

export const BgcBadge = ({ status }: { status: string }) => <span className={`badge bgc-${status}`}>{paperworkLabel(status)}</span>;
