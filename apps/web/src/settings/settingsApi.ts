/** Typed client for Settings & Preferences (docs/interviews-settings-api.md ST-1..ST-9). */
import { ApiError, api } from "../api";

export interface SignIn { provider: "google" | "dev"; domain: string | null }
export interface Profile {
  displayName: string; email: string; designation: string | null; location: string | null;
  phone: string | null; bio: string | null; rowVersion: number; signIn: SignIn;
}
export interface Preference { type: string; label: string; description: string; mandatory: boolean; inApp: boolean }
export interface SessionRow {
  id: string; signedInAt: string; lastSeenAt: string; device: "desktop" | "mobile" | "tablet" | "unknown";
  browser: string; ip: string | null; current: boolean; status: "active" | "signed_out" | "expired";
}

const json = (b: unknown) => ({ body: JSON.stringify(b) });

export const settingsApi = {
  profile: () => api<Profile>("/api/v1/settings/profile"),
  saveProfile: (rowVersion: number, b: { phone: string | null; bio: string | null }) =>
    api<Profile>("/api/v1/settings/profile", { method: "PUT", headers: { "if-match": `"${rowVersion}"` }, ...json(b) }),
  preferences: () => api<{ items: Preference[] }>("/api/v1/settings/notifications"),
  setPreference: (type: string, inApp: boolean) =>
    api<{ items: Preference[] }>(`/api/v1/settings/notifications/${encodeURIComponent(type)}`, { method: "PUT", ...json({ inApp }) }),
  sessions: () => api<{ signIn: SignIn; items: SessionRow[] }>("/api/v1/settings/sessions"),
  revoke: (id: string) => api<void>(`/api/v1/settings/sessions/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  revokeOthers: () => api<{ revoked: number }>("/api/v1/settings/sessions/revoke-others", { method: "POST" }),
};

export const settingsKeys = {
  profile: ["settings", "profile"] as const,
  preferences: ["settings", "notifications"] as const,
  sessions: ["settings", "sessions"] as const,
};

const ERRORS: Record<string, string> = {
  stale: "Your profile changed in another tab or window. Reload to see the latest version, then save again.",
  if_match_required: "Reload the page and try again.",
  notification_type_mandatory: "This notification is required for your role and can't be turned off.",
  current_session: "That's this session. Use Sign out in the account menu instead.",
};

export function settingsError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && ERRORS[e.detail]) return ERRORS[e.detail]!;
  if (e.status === 422 && e.errors?.length) return e.errors.map((x) => x.message).join(" ");
  if (e.status === 404) return "That session has already ended. Refresh the list.";
  return e.detail ?? e.title ?? e.message;
}

export const DEVICE_LABELS: Record<SessionRow["device"], string> = { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet", unknown: "Unknown device" };
