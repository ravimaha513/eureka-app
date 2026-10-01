import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilities, ROLES, type Role } from "@eureka/shared";
import { HotList, Shell } from "./App";
import type { Me } from "./api";
import { visibleNav } from "./nav";

const meFor = (role: Role): Me => ({
  id: "u1", email: "u@eureka.example", displayName: "Test User", csrfToken: "t",
  roles: [{ key: role, label: role, locationId: null }],
  capabilities: capabilities({ userId: "u1", roles: [{ role, locationId: "loc" }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [] }),
});

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

afterEach(() => vi.restoreAllMocks());

describe("role-aware navigation", () => {
  it.each([
    ["recruiter", ["Hot List", "Submissions", "Interviews", "Placements"], ["Users & Access", "Payments", "Employees"]],
    ["location_ops_admin", ["Hot List", "Interviews"], ["Performance", "Payments", "Users & Access"]],
    // Hot List is open to every signed-in user (OD-01).
    ["hr", ["Employees", "Paperwork & BGC", "Hot List"], ["Payments", "Users & Access"]],
    ["accounts", ["Payments", "Employees", "Hot List"], ["Users & Access"]],
    ["org_admin", ["Users & Access", "Hot List"], ["Candidates", "Employees", "Payments"]],
  ] as const)("%s sees only its screens", (role, shown, hidden) => {
    const labels = visibleNav(meFor(role).capabilities).map((n) => n.label);
    for (const s of shown) expect(labels).toContain(s);
    for (const h of hidden) expect(labels).not.toContain(h);
  });

  it("every role gets at least one screen", () => {
    for (const role of ROLES) expect(visibleNav(meFor(role).capabilities).length, role).toBeGreaterThan(0);
  });

  it("renders the sidebar from capabilities", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    wrap(<Shell me={meFor("org_admin")} onSignOut={() => undefined} />);
    const nav = screen.getByRole("complementary", { name: "Main navigation" });
    expect(within(nav).getByRole("button", { name: "Users & Access" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Hot List" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "Payments" })).not.toBeInTheDocument();
  });
});

describe("Hot List", () => {
  it("shows masked phones as masked and labels Open-to-all-teams candidates", async () => {
    // A fresh response per call: the page also loads the user's saved views.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(JSON.stringify({
      items: String(input).startsWith("/api/v1/hotlist/views") ? [] : [{
        id: "c1", name: "Divya Menon", technology: "Data Engineer", status: "active", visibility: "all_teams", priority: "P1",
        team: { id: "t2", name: "Team Anjali" }, recruiter: null, location: { id: "l", name: "Dallas" },
        daysInMarket: 21, technicalRating: null, phone: "•••-•••-42", phoneMasked: true,
      }],
    }), { status: 200 }));
    wrap(<HotList />);
    const cell = await screen.findByText("•••-•••-42");
    expect(cell).toHaveClass("masked");
    expect(screen.getByText("Open to all teams", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });
});
