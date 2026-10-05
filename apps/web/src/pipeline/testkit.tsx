/** Test helpers: a mocked-fetch router and fixtures shaped like the API (submissions service, docs/placements-api.md). */
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { capabilities, type Role } from "@eureka/shared";
import { setCsrf, type Me } from "../api";
import type { Placement, Submission } from "./pipelineApi";

export type Reply = { status?: number; body?: unknown } | "network";
export type Handler = (url: URL, body: unknown, headers: Record<string, string>) => Reply;
export interface Call { method: string; path: string; url: URL; body: unknown; headers: Record<string, string> }

export function mockApi(initial: Record<string, Handler>) {
  setCsrf("tok");
  const routes: Record<string, Handler> = { ...initial };
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    // Uploads to storage send a multipart form; everything else is JSON.
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: url.pathname, url, body, headers });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 599 });
    const r = h(url, body, headers);
    if (r === "network") throw new TypeError("Failed to fetch");
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { "content-type": "application/problem+json" } });
  });
  return {
    routes, calls,
    writes: () => calls.filter((c) => c.method !== "GET"),
    gets: (path: string) => calls.filter((c) => c.method === "GET" && c.path === path),
  };
}

export const problem = (status: number, extra: Record<string, unknown> = {}): Reply =>
  ({ status, body: { type: "about:blank", title: "Error", status, ...extra } });

export const wrap = (ui: React.ReactNode): RenderResult =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

export const meFor = (role: Role): Me => ({
  id: "u-me", email: "me@eureka.example", displayName: "Test User", csrfToken: "tok",
  roles: [{ key: role, label: role, locationId: null }],
  capabilities: capabilities({ userId: "u-me", roles: [{ role, locationId: "loc" }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [] }),
});

export const COACH = "77777777-7777-4777-8777-777777777777";
export const VENDOR = "66666666-6666-4666-8666-666666666666";
export const LOOKUPS = {
  technologies: [], clients: [{ id: "cl1", name: "Northwind Financial" }], vendors: [{ id: VENDOR, name: "Contoso Staffing" }],
  locations: [], coaches: [{ id: COACH, name: "Coach One" }],
};

export const sub = (id: string, extra: Partial<Submission> = {}): Submission => ({
  id, candidateId: `c-${id}`, candidateName: "Asha Iyer", recruiterId: "u-me", recruiterName: "Test User",
  teamId: "t1", locationId: "loc", jobTitle: "Senior Java Developer", clientId: "cl1", client: "Northwind Financial",
  vendorId: null, status: "submitted", rejectionReason: null, submittedAt: "2026-09-20T15:00:00Z", statusChangedAt: null,
  actions: { transition: ["under_review", "rejected", "withdrawn"], createInterview: true, createPlacement: false },
  ...extra,
});

export const plc = (id: string, extra: Partial<Placement> = {}): Placement => ({
  id, status: "confirmed", placementType: "c2c", workMode: "hybrid", projectCity: "Dallas", projectState: "TX",
  tentativeStart: "2026-10-15", isFirstPlacement: false,
  candidate: { id: "c1", name: "Asha Iyer" }, recruiter: { id: "u-me", name: "Test User" }, team: { id: "t1", name: "Team Rohit" },
  location: { id: "loc", name: "Dallas" }, client: { id: "cl1", name: "Northwind Financial" }, vendor: { id: VENDOR, name: "Contoso Staffing" },
  submissionId: "s1", createdAt: "2026-09-25T15:00:00Z", statusChangedAt: null, allowedTransitions: ["paperwork", "backout", "bgc_failed"],
  ...extra,
});

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
