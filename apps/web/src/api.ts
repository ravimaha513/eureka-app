import type { Permission } from "@eureka/shared";
import { BUSY_MESSAGE, STALE_MESSAGE, limitText, serverSentence } from "./lib/errorText";

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
  /** `id` null: no team yet ("name" says so); the profile offers Assign team. */
  team: { id: string | null; name: string; lead?: string | null };
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
  /** `Retry-After` in seconds (503/429), when the server sent one. */
  retryAfter?: number;
  /** apiFetch already waited out a 503's Retry-After and tried again (React Query must not retry it too). */
  retried?: boolean;
}

/** Window events: BUSY_EVENT (`detail` +1 / -1) while a GET waits out a 503; STALE_EVENT after a 412 `stale`. */
export const BUSY_EVENT = "eureka:busy";
export const STALE_EVENT = "eureka:stale";
/** Longest Retry-After a GET waits for before trying once more; a longer one fails at once. */
const MAX_RETRY_WAIT_S = 10;

/** Optional If-Match for an edit (docs/<area>-api.md); no header when the version is unknown. 0 is a version. */
export const ifMatch = (version: number | null | undefined): Record<string, string> =>
  version == null ? {} : { "if-match": `"${version}"` };

/** Readable text for the API-wide 412 `stale`, 429 and 503 answers (else null: the screen's own mapping applies). */
export const commonProblem = (e: unknown): string | null =>
  e instanceof ApiError && ((e.status === 412 && e.detail === "stale") || e.status === 429 || e.status === 503) ? e.message : null;

function retryAfterSeconds(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

let csrfToken = "";
export const setCsrf = (t: string) => { csrfToken = t; };

/**
 * Same-origin fetch with the session cookie; CSRF header on writes (design A6.1).
 * Resolves with the raw response when it is OK; throws ApiError otherwise.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const send = () => fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-csrf-token": csrfToken } : {}),
      ...init.headers,
    },
  });
  let res = await send();
  let retried = false;
  const wait = retryAfterSeconds(res);
  // A busy server (503 + Retry-After) gets one more try for a read; writes are never repeated.
  if (res.status === 503 && method === "GET" && wait !== undefined && wait <= MAX_RETRY_WAIT_S) {
    window.dispatchEvent(new CustomEvent(BUSY_EVENT, { detail: 1 }));
    try {
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await send();
    } finally {
      window.dispatchEvent(new CustomEvent(BUSY_EVENT, { detail: -1 }));
    }
    retried = true;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string; title?: string; errors?: unknown };
    const errors = Array.isArray(body.errors) ? (body.errors as FieldIssue[]) : undefined;
    const stale = res.status === 412 && body.detail === "stale";
    const message = stale ? STALE_MESSAGE : res.status === 429 ? limitText(body.detail)
      : res.status === 503 ? serverSentence(body.detail, BUSY_MESSAGE) : body.detail ?? body.title ?? res.statusText;
    const err = new ApiError(res.status, message, body.detail, body.title, errors);
    err.retryAfter = retryAfterSeconds(res);
    err.retried = retried;
    if (stale) window.dispatchEvent(new Event(STALE_EVENT));
    throw err;
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
