import type { Permission } from "@eureka/shared";

export interface Me {
  id: string;
  email: string;
  displayName: string;
  roles: { key: string; label: string; locationId: string | null }[];
  capabilities: Permission[];
  csrfToken: string;
  /** Staging/local password sign-in: an admin-set password must be changed before anything else. */
  mustChangePassword?: boolean;
}

/**
 * Whether the signed-in user holds a capability (presentation only; the API decides).
 * Typed so a misspelt permission fails the typecheck.
 */
export const can = (me: Pick<Me, "capabilities"> | null | undefined, p: Permission): boolean =>
  me?.capabilities.includes(p) ?? false;

export interface Candidate {
  id: string;
  name: string;
  technology: string;
  status: string;
  visibility: "team" | "all_teams" | "selected_teams";
  priority: "P1" | "P2" | "P3";
  /** `lead`: the team lead's name (the sheet's "Lead"); absent on older servers. */
  team: { id: string; name: string; lead?: string | null };
  recruiter: { id: string; name: string } | null;
  location: { id: string; name: string };
  /** In-person candidate; null when not recorded. */
  inPersonOk?: boolean | null;
  daysInMarket: number | null;
  technicalRating: number | null;
  phone: string | null;
  phoneMasked: boolean;
  /** ISO date the candidate started marketing (list and profile responses). */
  marketingStartDate?: string | null;
  /** Open Hot List only: false when the profile belongs to a team outside the user's scope (it would 404). */
  canOpenProfile?: boolean;
  /** Display label: "Active/Remote", "Active/All Teams", "N/A" (derived by the server). Absent on older servers. */
  statusLabel?: string;
  /** Guest house or remote; null when not recorded. */
  stay?: "guest_house" | "remote" | null;
  ghLocation?: { id?: string; name: string } | null;
  /** The visa the candidate is marketed on (VISA_CATEGORIES key). */
  visaCategory?: string | null;
  /** Documents status summary (DOCUMENTS_STATUSES key). */
  documentsStatus?: string | null;
  /** A current uploaded resume or a resume link is on file. */
  hasResume?: boolean;
  /** When the candidate joined its current team (ISO). */
  teamAssignedAt?: string;
}

/** One entry of an RFC 9457 validation problem's `errors` array (422). */
export interface FieldIssue { path: string; message: string }

export class ApiError extends Error {
  /**
   * RFC 9457 `detail` (the machine-readable error code in this API) and `title`, when the server sent them.
   * `errors` carries the per-field issues of a 422 validation problem.
   */
  constructor(public status: number, message: string, public detail?: string, public title?: string, public errors?: FieldIssue[]) {
    super(message);
  }
}

let csrfToken = "";
export const setCsrf = (t: string) => { csrfToken = t; };

/**
 * Same-origin fetch with the session cookie; CSRF header on writes (design A6.1).
 * Resolves with the raw response when it is OK; throws ApiError otherwise.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-csrf-token": csrfToken } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string; title?: string; errors?: unknown };
    const errors = Array.isArray(body.errors) ? (body.errors as FieldIssue[]) : undefined;
    throw new ApiError(res.status, body.detail ?? body.title ?? res.statusText, body.detail, body.title, errors);
  }
  return res;
}

/** JSON API call (see apiFetch). */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
