import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../App";
import { AccessPage } from "../admin/AccessPage";
import { EmployeesPage } from "../employees/EmployeesPage";
import type { Employee } from "../employees/employeesApi";
import { meFor, mockApi, problem, wrap, type Handler } from "../pipeline/testkit";
import { SettingsPage } from "./SettingsPage";

afterEach(() => vi.restoreAllMocks());

const PROFILE = {
  displayName: "Test User", email: "me@eureka.example", designation: "Senior Recruiter", location: "Dallas",
  phone: null, bio: null, rowVersion: 0, signIn: { provider: "google", domain: "eureka.example" },
};
const PREFS = {
  items: [
    { type: "work_authorization.expiring", label: "Work authorization expiring", description: "Expiry notices.", mandatory: true, inApp: true },
    { type: "employee.benched", label: "Employee on the bench", description: "Bench.", mandatory: false, inApp: true },
  ],
};
const SESSIONS = {
  signIn: { provider: "google", domain: "eureka.example" },
  items: [
    { id: "s-cur", signedInAt: "2026-10-04T20:19:00Z", lastSeenAt: "2026-10-05T10:00:00Z", device: "desktop", browser: "Chrome", ip: "23.127.xx.xx", current: true, status: "active" },
    { id: "s-old", signedInAt: "2026-10-01T18:26:00Z", lastSeenAt: "2026-10-04T09:00:00Z", device: "mobile", browser: "Safari", ip: "23.127.xx.xx", current: false, status: "active" },
    { id: "s-gone", signedInAt: "2026-09-20T18:26:00Z", lastSeenAt: "2026-09-20T19:00:00Z", device: "desktop", browser: "Firefox", ip: null, current: false, status: "signed_out" },
  ],
};
const settingsRoutes = (): Record<string, Handler> => ({
  "GET /api/v1/settings/profile": () => ({ body: PROFILE }),
  "PUT /api/v1/settings/profile": (_u, body) => ({ body: { ...PROFILE, ...(body as object), rowVersion: 1 } }),
  "GET /api/v1/settings/notifications": () => ({ body: PREFS }),
  "PUT /api/v1/settings/notifications/employee.benched": (_u, body) => ({
    body: { items: PREFS.items.map((p) => (p.type === "employee.benched" ? { ...p, inApp: (body as { inApp: boolean }).inApp } : p)) },
  }),
  "GET /api/v1/settings/sessions": () => ({ body: SESSIONS }),
  "POST /api/v1/settings/sessions/s-old/revoke": () => ({ status: 204 }),
  "POST /api/v1/settings/sessions/revoke-others": () => ({ body: { revoked: 1 } }),
});

describe("Settings & Preferences", () => {
  it("opens from the avatar menu for any signed-in user", async () => {
    mockApi({ ...settingsRoutes(), "GET /api/v1/notifications/unread-count": () => ({ body: { unread: 0, capped: false } }) });
    wrap(<Shell me={meFor("recruiter")} onSignOut={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Test User" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings & Preferences" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows name and designation read-only and saves phone and bio with If-Match", async () => {
    const api = mockApi(settingsRoutes());
    wrap(<SettingsPage me={{ displayName: "Test User" }} />);
    expect(await screen.findByText(/from your Google account/)).toBeInTheDocument();
    expect(screen.getByText("Senior Recruiter", { exact: false })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Display name/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Work phone"), { target: { value: "+1 469 555 0142" } });
    fireEvent.change(screen.getByLabelText("Short bio"), { target: { value: "Java and cloud hiring." } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    const put = api.writes().find((c) => c.path === "/api/v1/settings/profile")!;
    expect(put.method).toBe("PUT");
    expect(put.headers["if-match"]).toBe('"0"');
    expect(put.body).toEqual({ phone: "+1 469 555 0142", bio: "Java and cloud hiring." });
    expect(screen.getByText(/Education, skills, certifications and resumes are kept on candidate profiles/)).toBeInTheDocument();
  });

  it("explains a stale profile save", async () => {
    mockApi({ ...settingsRoutes(), "PUT /api/v1/settings/profile": () => problem(412, { detail: "stale" }) });
    wrap(<SettingsPage me={{ displayName: "Test User" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another tab");
  });

  it("toggles an optional notification and locks a mandatory one", async () => {
    const api = mockApi(settingsRoutes());
    wrap(<SettingsPage me={{ displayName: "Test User" }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Notifications" }));
    const mandatory = await screen.findByRole("switch", { name: "Work authorization expiring" });
    expect(mandatory).toBeDisabled();
    expect(mandatory).toHaveAttribute("aria-checked", "true");
    const bench = screen.getByRole("switch", { name: "Employee on the bench" });
    fireEvent.click(bench);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Employee on the bench" })).toHaveAttribute("aria-checked", "false"));
    expect(api.writes().at(-1)).toMatchObject({ method: "PUT", path: "/api/v1/settings/notifications/employee.benched", body: { inApp: false } });
  });

  it("lists login activity, marks the current session and signs out another one", async () => {
    const api = mockApi(settingsRoutes());
    wrap(<SettingsPage me={{ displayName: "Test User" }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Security" }));
    expect(await screen.findByText(/Signed in with Google \(eureka\.example\)/)).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Login activity" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Current session")).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows[1]!).getByText("23.127.xx.xx")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Signed out")).toBeInTheDocument();
    expect(within(rows[2]!).queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /Sign out the Mobile Safari session/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.writes().some((c) => c.path === "/api/v1/settings/sessions/s-old/revoke")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Sign out of all other sessions" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out others" }));
    expect(await screen.findByText("Signed out 1 other session.")).toBeInTheDocument();
  });
});

describe("Staff directory", () => {
  const user = (id: string, displayName: string, extra: Record<string, unknown> = {}) => ({
    id, email: `${id}@eureka.example`, displayName, designation: "Recruiter", status: "active", primaryLocation: null,
    manager: null, roles: [], teams: [], ...extra,
  });
  const routes = (contactVisible: boolean): Record<string, Handler> => ({
    "GET /api/v1/admin/meta": () => ({ body: { roles: [], locations: [] } }),
    "GET /api/v1/admin/users": () => ({ body: {
      contactVisible,
      items: [user("u1", "Priya Rao", contactVisible ? { phone: "+14695550142" } : {})], nextCursor: null,
    } }),
    "GET /api/v1/admin/users/summary": () => ({ body: { active: 3, inactive: 0, roles: [
      { key: "location_incharge", label: "Location Incharge", count: 1 }, { key: "recruiter", label: "Recruiter", count: 2 }] } }),
  });

  it("shows KPI cards per role that has users and the phone column when permitted", async () => {
    mockApi(routes(true));
    wrap(<AccessPage me={meFor("org_admin")} />);
    const kpis = await screen.findByRole("list", { name: "Active users per role" });
    expect(within(kpis).getAllByRole("listitem")).toHaveLength(2);
    expect(within(kpis).getByText("Location Incharge")).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Users" });
    expect(within(table).getByRole("columnheader", { name: "Phone" })).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "+14695550142" })).toHaveAttribute("href", "tel:+14695550142");
  });

  it("hides the phone column without staff.contact:read", async () => {
    mockApi(routes(false));
    wrap(<AccessPage me={meFor("org_admin")} />);
    const table = await screen.findByRole("table", { name: "Users" });
    expect(within(table).queryByRole("columnheader", { name: "Phone" })).not.toBeInTheDocument();
  });
});

describe("Employees contacts and export", () => {
  const NONE = { endAssignment: false, setEndDate: false, exit: false, returnToMarket: false };
  const emp = (id: string, name: string, contact: Employee["contact"]): Employee => ({
    id, candidate: { id: `c-${id}`, name }, status: "on_assignment", employeeSince: "2026-06-01", statusSince: "2026-06-01",
    exitedOn: null, exitReason: null, location: null, team: null, assignment: null, actions: NONE, contact,
  });
  const routes = (): Record<string, Handler> => ({
    "GET /api/v1/employees": () => ({ body: { items: [
      emp("e1", "Asha Iyer", { email: "asha@example.com", phone: "+14695550142", masked: false }),
      emp("e2", "Divya Menon", { email: "d•••@example.com", phone: "•••-•••-43", masked: true }),
    ], nextCursor: null } }),
    "GET /api/v1/lookups": () => ({ body: { technologies: [], clients: [], vendors: [], implementationPartners: [], locations: [], coaches: [] } }),
    "POST /api/v1/employees/export": () => ({ body: "csv" }),
  });

  it("links readable contacts with icons and shows masked ones as plain text", async () => {
    mockApi(routes());
    wrap(<EmployeesPage me={meFor("hr")} />);
    const r1 = (await screen.findByText("Asha Iyer", { selector: "b" })).closest("tr")!;
    expect(within(r1).getByRole("link", { name: "asha@example.com" })).toHaveAttribute("href", "mailto:asha@example.com");
    expect(within(r1).getByRole("link", { name: "+14695550142" })).toHaveAttribute("href", "tel:+14695550142");
    const r2 = screen.getByText("Divya Menon", { selector: "b" }).closest("tr")!;
    expect(within(r2).queryByRole("link", { name: /example\.com/ })).not.toBeInTheDocument();
    expect(within(r2).getByText("•••-•••-43")).toBeInTheDocument();
    expect(within(r2).getByText("Contact details hidden")).toBeInTheDocument();
  });

  it("exports with the current filters only for report:export holders", async () => {
    const api = mockApi(routes());
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    wrap(<EmployeesPage me={meFor("ceo")} />);
    await screen.findByText("Asha Iyer", { selector: "b" });
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/ }));
    await waitFor(() => expect(api.writes().some((c) => c.path === "/api/v1/employees/export")).toBe(true));
    expect(api.writes().find((c) => c.path === "/api/v1/employees/export")!.body).toEqual({});
  });

  it("offers no export without report:export", async () => {
    mockApi(routes());
    wrap(<EmployeesPage me={meFor("hr")} />);
    await screen.findByText("Asha Iyer", { selector: "b" });
    expect(screen.queryByRole("button", { name: /Export CSV/ })).not.toBeInTheDocument();
  });
});
