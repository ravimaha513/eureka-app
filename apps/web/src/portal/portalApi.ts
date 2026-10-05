/**
 * Applicant portal client (docs/jobs-portal-api.md "Applicant portal"). Its own
 * CSRF token (the applicant session's), the x-eureka-portal header on every
 * write, and only /api/portal/* routes: the applicant session cookie is scoped
 * to that path and staff routes refuse it.
 */
import { ApiError, type FieldIssue } from "../api";
import type { RichDoc } from "@eureka/shared";

let csrf = "";
export const setPortalCsrf = (t: string) => { csrf = t; };

export async function portalApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-eureka-portal": "1", ...(csrf ? { "x-csrf-token": csrf } : {}) } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string; title?: string; errors?: unknown };
    throw new ApiError(res.status, body.detail ?? body.title ?? res.statusText, body.detail, body.title,
      Array.isArray(body.errors) ? (body.errors as FieldIssue[]) : undefined);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface Applicant { id: string; firstName: string; lastName: string; email: string; phone: string | null; emailVerified: boolean; csrfToken: string }

export interface PortalJob {
  id: string;
  title: string;
  employer: string | null;
  category: string;
  experienceLevel: string;
  employmentType: string;
  workMode: string;
  status: string;
  location: string | null;
  deadline: string | null;
  workHours: number | null;
  pay: { amount: number; frequency: string; currency: string } | null;
  skills: string[];
  excerpt: string;
  requirements: RichDoc | null;
  description: RichDoc | null;
  postedAt: string | null;
  applied: boolean;
  applicationId: string | null;
}

export interface PortalInterview {
  id: string; interviewType: string; round: string; startsAt: string; durationMinutes: number; status: string; meetingLink: string | null;
}

export interface PortalApplication {
  id: string;
  status: string;
  appliedAt: string;
  statusChangedAt: string;
  canWithdraw: boolean;
  job: { id: string; title: string; employer: string | null; workMode: string; employmentType: string; status: string; location: string | null };
  interviews?: PortalInterview[];
}

const json = (b: unknown) => ({ body: JSON.stringify(b) });

export const portal = {
  me: () => portalApi<Applicant>("/api/portal/me"),
  signUp: (b: { firstName: string; lastName: string; email: string; phone: string }) =>
    portalApi<{ message: string }>("/api/portal/auth/sign-up", { method: "POST", ...json(b) }),
  requestLink: (email: string) => portalApi<{ message: string }>("/api/portal/auth/request-link", { method: "POST", ...json({ email }) }),
  verify: (token: string) => portalApi<void>("/api/portal/auth/verify", { method: "POST", ...json({ token }) }),
  signOut: () => portalApi<void>("/api/portal/auth/sign-out", { method: "POST" }),
  jobs: (cursor?: string) => portalApi<{ items: PortalJob[]; nextCursor: string | null }>(`/api/portal/jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  job: (id: string) => portalApi<PortalJob>(`/api/portal/jobs/${id}`),
  apply: (id: string) => portalApi<{ id: string }>(`/api/portal/jobs/${id}/apply`, { method: "POST" }),
  applications: (status?: string) => portalApi<{ items: PortalApplication[] }>(`/api/portal/applications${status ? `?status=${status}` : ""}`),
  application: (id: string) => portalApi<PortalApplication>(`/api/portal/applications/${id}`),
  withdraw: (id: string) => portalApi<{ id: string; status: string }>(`/api/portal/applications/${id}/withdraw`, { method: "POST" }),
};

export function portalError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return "Too many attempts. Wait a few minutes and try again.";
    if (e.detail === "link_invalid") return "This sign-in link has expired or was already used. Ask for a new one.";
    if (e.detail === "already_applied") return "You have already applied for this job.";
    if (e.detail === "job_not_open") return "This job is no longer accepting applications.";
    if (e.detail === "invalid_transition") return "This application can no longer be withdrawn.";
    if (e.status === 401) return "Your session has ended. Sign in again.";
    if (e.status === 422 && e.errors?.length) return e.errors.map((x) => x.message).join(" ");
  }
  return "Something went wrong. Try again.";
}
