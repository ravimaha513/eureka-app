import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilities, ROLES, type Role } from "@eureka/shared";
import App, { HotList, Shell } from "./App";
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
    // Payments (gap L1): Sales read their placements' invoices by hierarchy.
    ["recruiter", ["Hot List", "Submissions", "Interviews", "Placements", "Payments"], ["Users & Access", "Employees"]],
    ["location_ops_admin", ["Hot List", "Interviews"], ["Performance", "Payments", "Users & Access"]],
    // Hot List is team-scoped (Eureka App 4): roles without hotlist:read do not get it.
    ["hr", ["Employees", "Paperwork & BGC"], ["Payments", "Users & Access", "Hot List"]],
    ["accounts", ["Payments", "Employees"], ["Users & Access", "Hot List"]],
    ["org_admin", ["Users & Access"], ["Candidates", "Employees", "Payments", "Hot List"]],
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
    expect(within(nav).queryByRole("button", { name: "Hot List" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "Payments" })).not.toBeInTheDocument();
  });
});

describe("URL routing", () => {
  const items = () => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
  const nav = () => screen.getByRole("complementary", { name: "Main navigation" });
  const goBackTo = (path: string) => act(() => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  it("lands on the Hot List at / and keeps the current screen in the address bar", async () => {
    items();
    wrap(<Shell me={meFor("recruiter")} onSignOut={() => undefined} />);
    await waitFor(() => expect(window.location.pathname).toBe("/hotlist"));
    expect(within(nav()).getByRole("button", { name: "Hot List" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(nav()).getByRole("button", { name: "Submissions" }));
    expect(window.location.pathname).toBe("/submissions");
    expect(await screen.findByRole("heading", { level: 1, name: "Submissions" })).toBeInTheDocument();
    goBackTo("/hotlist");
    expect(within(nav()).getByRole("button", { name: "Hot List" })).toHaveAttribute("aria-current", "page");
  });

  it("opens the screen named in the URL", async () => {
    items();
    window.history.replaceState(null, "", "/submissions");
    wrap(<Shell me={meFor("recruiter")} onSignOut={() => undefined} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Submissions" })).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: "Submissions" })).toHaveAttribute("aria-current", "page");
  });

  it("sends a screen the role does not have to the default screen", async () => {
    items();
    window.history.replaceState(null, "", "/access");
    wrap(<Shell me={meFor("recruiter")} onSignOut={() => undefined} />);
    await waitFor(() => expect(window.location.pathname).toBe("/hotlist"));
    expect(within(nav()).getByRole("button", { name: "Hot List" })).toHaveAttribute("aria-current", "page");
  });
});

describe("mobile menu", () => {
  it("toggles the sidebar drawer, closes on navigation and on Escape with focus back on the button", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    wrap(<Shell me={meFor("org_admin")} onSignOut={() => undefined} />);
    const menu = screen.getByRole("button", { name: "Menu" });
    const nav = screen.getByRole("complementary", { name: "Main navigation" });
    expect(menu).toHaveAttribute("aria-controls", nav.id);
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(nav).toHaveClass("open");
    fireEvent.click(within(nav).getByRole("button", { name: "Users & Access" }));
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveFocus();
  });
});

describe("theme and account menu", () => {
  it("switches to dark and back, and remembers the choice", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    wrap(<Shell me={meFor("org_admin")} onSignOut={() => undefined} />);
    const theme = screen.getByRole("group", { name: "Theme" });
    fireEvent.click(within(theme).getByRole("button", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("eureka-theme")).toBe("dark");
    fireEvent.click(within(theme).getByRole("button", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("signs out from the account menu in the top bar", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const onSignOut = vi.fn();
    wrap(<Shell me={meFor("org_admin")} onSignOut={onSignOut} />);
    const account = screen.getByRole("button", { name: "Account: Test User" });
    expect(account).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(account);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalled();
  });
});

describe("sign out", () => {
  it("returns to the sign-in screen after logout", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v1/me") return new Response(JSON.stringify(meFor("recruiter")), { status: 200 });
      if (url === "/api/auth/logout") return new Response(null, { status: 204 });
      if (url.startsWith("/api/v1/notifications/unread-count")) return new Response(JSON.stringify({ unread: 0, capped: false }), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    wrap(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account: Test User" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Hi, welcome back!" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
  });
});

describe("notification bell in the shell", () => {
  it("every role gets the bell in the top bar, outside the sidebar", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).startsWith("/api/v1/notifications/unread-count") ? { unread: 4, capped: false } : { items: [] }), { status: 200 }));
    wrap(<Shell me={meFor("recruiter")} onSignOut={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Notifications, 4 unread" })).toBeInTheDocument();
    const nav = screen.getByRole("complementary", { name: "Main navigation" });
    expect(within(nav).queryByRole("button", { name: /Notifications/ })).not.toBeInTheDocument();
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
