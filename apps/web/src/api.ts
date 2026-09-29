export interface Me {
  id: string;
  email: string;
  displayName: string;
  roles: { key: string; label: string; locationId: string | null }[];
  capabilities: string[];
  csrfToken: string;
}

export interface Candidate {
  id: string;
  name: string;
  technology: string;
  status: string;
  visibility: "team" | "all_teams";
  priority: "P1" | "P2" | "P3";
  team: { id: string; name: string };
  recruiter: { id: string; name: string } | null;
  location: { id: string; name: string };
  daysInMarket: number | null;
  technicalRating: number | null;
  phone: string | null;
  phoneMasked: boolean;
}

export class ApiError extends Error {
  /** RFC 9457 `detail` (the machine-readable error code in this API) and `title`, when the server sent them. */
  constructor(public status: number, message: string, public detail?: string, public title?: string) {
    super(message);
  }
}

let csrfToken = "";
export const setCsrf = (t: string) => { csrfToken = t; };

/** Same-origin fetch with the session cookie; CSRF header on writes (design A6.1). */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    const body = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
    throw new ApiError(res.status, body.detail ?? body.title ?? res.statusText, body.detail, body.title);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
