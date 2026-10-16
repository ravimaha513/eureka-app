import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setCsrf, type Me } from "../api";
import { Shell } from "../App";
import { AccessPage } from "./AccessPage";
import { ERROR_MESSAGES, friendlyError } from "./errors";

// ---- fixtures (shapes from docs/admin-api.md) -------------------------------------------------

const ME: Me = {
  id: "me", email: "admin@eureka.example", displayName: "Ada Admin", csrfToken: "tok",
  roles: [{ key: "org_admin", label: "Org Admin", locationId: null }], capabilities: ["access:manage", "audit:read"],
};
const META = {
  roles: [
    { key: "recruiter", label: "Recruiter", restricted: false, locationBound: false },
    { key: "location_ops_admin", label: "Location Ops Admin", restricted: false, locationBound: true },
    { key: "hr", label: "HR", restricted: true, locationBound: false },
  ],
  locations: [{ id: "loc-dal", name: "Dallas" }, { id: "loc-hyd", name: "Hyderabad" }],
};
const user = (id: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${id}@eureka.example`, displayName, designation: null, status: "active", primaryLocation: null,
  manager: null, roles: [], teams: [], ...extra,
});
const USERS = [
  user("me", "Ada Admin", { roles: [{ key: "org_admin", label: "Org Admin", locationId: null, locationName: null }] }),
  user("u-priya", "Priya Rao", {
    designation: "Senior Recruiter", manager: { id: "u-lead", displayName: "Rohit Lead" },
    roles: [{ key: "location_ops_admin", label: "Location Ops Admin", locationId: "loc-dal", locationName: "Dallas" }],
    teams: [{ id: "t1", name: "Team Rohit", asLead: false }],
  }),
  user("u-lead", "Rohit Lead", { teams: [{ id: "t1", name: "Team Rohit", asLead: true }] }),
  user("u-old", "Old Timer", { status: "inactive" }),
];
const TEAMS = [
  { id: "t1", name: "Team Rohit", location: { id: "loc-dal", name: "Dallas" }, lead: { id: "u-lead", displayName: "Rohit Lead" },
    members: [{ id: "u-priya", displayName: "Priya Rao" }, { id: "u-sam", displayName: "Sam Member" }] },
  { id: "t2", name: "Team Anjali", location: null, lead: { id: "u-anj", displayName: "Anjali Lead" }, members: [] },
];
const REQUESTS = [
  { id: "rq1", user: { id: "u-priya", displayName: "Priya Rao", email: "p@e" }, role: "hr", roleLabel: "HR", locationId: null,
    requestedBy: { id: "me", displayName: "Ada Admin" }, requestedAt: "2026-09-28T10:00:00Z", status: "pending", decidedBy: null, decidedAt: null },
  { id: "rq2", user: { id: "u-lead", displayName: "Rohit Lead", email: "r@e" }, role: "hr", roleLabel: "HR", locationId: null,
    requestedBy: { id: "u-other", displayName: "Other Admin" }, requestedAt: "2026-09-28T11:00:00Z", status: "pending", decidedBy: null, decidedAt: null },
  { id: "rq3", user: { id: "me", displayName: "Ada Admin", email: "a@e" }, role: "location_ops_admin", roleLabel: "Location Ops Admin", locationId: "loc-hyd",
    requestedBy: { id: "u-other", displayName: "Other Admin" }, requestedAt: "2026-09-28T12:00:00Z", status: "pending", decidedBy: null, decidedAt: null },
];

// ---- fetch router ------------------------------------------------------------------------------

type Reply = { status?: number; body?: unknown };
type Handler = (url: URL, init: RequestInit) => Reply;
interface Call { method: string; path: string; url: URL; body: unknown; headers: Record<string, string> }

let routes: Record<string, Handler>;
let calls: Call[];

const problem = (status: number, detail: string): Reply => ({ status, body: { type: "about:blank", title: "Error", status, detail } });

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    calls.push({ method, path: url.pathname, url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 599 });
    const r = h(url, init);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { "content-type": "application/problem+json" } });
  });
}
const writes = () => calls.filter((c) => c.method !== "GET");
const lastWrite = () => writes().at(-1)!;

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  routes = {
    "GET /api/v1/admin/meta": () => ({ body: META }),
    "GET /api/v1/admin/users": (u) => {
      const s = u.searchParams.get("search")?.toLowerCase();
      const items = s ? USERS.filter((x) => x.displayName.toLowerCase().includes(s)) : USERS;
      return { body: { items, nextCursor: u.searchParams.get("cursor") ? null : "c2" } };
    },
    "GET /api/v1/admin/role-requests": () => ({ body: { items: REQUESTS } }),
    "GET /api/v1/admin/teams": () => ({ body: { items: TEAMS } }),
  };
  mockFetch();
});
afterEach(() => vi.restoreAllMocks());

const renderPage = (tab?: "users" | "approvals" | "teams", me: Me = ME) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AccessPage me={me} initialTab={tab} />
    </QueryClientProvider>,
  );

const status = () => screen.getByRole("status");
const row = async (name: string) => (await screen.findByText(name, { selector: "b" })).closest("tr")!;

// ---- navigation --------------------------------------------------------------------------------

describe("Users & Access navigation", () => {
  it("opens from the sidebar entry for an access:manage holder", async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Shell me={ME} onSignOut={() => undefined} />
    </QueryClientProvider>);
    fireEvent.click(within(screen.getByRole("complementary", { name: "Main navigation" })).getByRole("button", { name: "Users & Access" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Users & Access" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("table", { name: "Users" })).toBeInTheDocument();
  });

  it("switches tabs with the arrow keys", async () => {
    renderPage();
    const users = screen.getByRole("tab", { name: "Users" });
    users.focus();
    fireEvent.keyDown(users, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Approvals" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Approvals" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Approvals" }), { key: "ArrowLeft" });
    expect(users).toHaveAttribute("aria-selected", "true");
  });
});

// ---- users ---------------------------------------------------------------------------------------

describe("Users tab", () => {
  it("lists users with role chips (with location), teams, manager and status", async () => {
    renderPage();
    const r = await row("Priya Rao");
    const cells = within(r);
    expect(cells.getByText("Senior Recruiter")).toBeInTheDocument();
    expect(within(cells.getByRole("list", { name: "Roles of Priya Rao" })).getByText(/Location Ops Admin · Dallas/)).toBeInTheDocument();
    expect(cells.getByText("Team Rohit")).toBeInTheDocument();
    expect(cells.getByText("Rohit Lead")).toBeInTheDocument();
    expect(cells.getByText("active")).toBeInTheDocument();
    // lead tag on teams, inactive user offers reactivate instead of deactivate/grant
    expect(within(await row("Rohit Lead")).getByText("lead")).toBeInTheDocument();
    const old = within(await row("Old Timer"));
    expect(old.getByRole("button", { name: "Reactivate Old Timer" })).toBeInTheDocument();
    expect(old.queryByRole("button", { name: /Grant role/ })).not.toBeInTheDocument();
  });

  it("offers no actions on the admin's own row (AD-2)", async () => {
    renderPage();
    const self = within(await row("Ada Admin"));
    expect(self.getByText("you")).toBeInTheDocument();
    expect(self.queryAllByRole("button")).toHaveLength(0);
    expect(self.getByText(/ask another admin/)).toBeInTheDocument();
  });

  it("searches (debounced) and pages with the cursor", async () => {
    renderPage();
    await row("Priya Rao");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(calls.some((c) => c.url.searchParams.get("cursor") === "c2")).toBe(true));
    await waitFor(() => expect(screen.getByText("Page 2")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("Page 1")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "priya" } });
    await waitFor(() => expect(calls.some((c) => c.url.searchParams.get("search") === "priya")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Old Timer")).not.toBeInTheDocument());
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("creates a user with the CSRF header and announces it", async () => {
    routes["POST /api/v1/admin/users"] = () => ({ status: 201, body: { id: "u-new" } });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "New user" }));
    const dlg = await screen.findByRole("dialog", { name: "New user" });
    expect(within(dlg).getByLabelText("Email")).toHaveFocus();
    fireEvent.change(within(dlg).getByLabelText("Email"), { target: { value: "neo@eureka.example" } });
    fireEvent.change(within(dlg).getByLabelText("Name"), { target: { value: "Neo Person" } });
    fireEvent.change(within(dlg).getByLabelText(/Designation/), { target: { value: "Recruiter" } });
    await within(dlg).findByRole("option", { name: "Dallas" });
    fireEvent.change(within(dlg).getByLabelText(/Primary location/), { target: { value: "loc-dal" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create user" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(lastWrite()).toMatchObject({ method: "POST", path: "/api/v1/admin/users",
      body: { email: "neo@eureka.example", displayName: "Neo Person", designation: "Recruiter", primaryLocationId: "loc-dal" } });
    expect(lastWrite().headers["x-csrf-token"]).toBe("tok");
    await waitFor(() => expect(status()).toHaveTextContent("Created Neo Person."));
  });

  it("explains a duplicate email (409) inside the dialog", async () => {
    routes["POST /api/v1/admin/users"] = () => ({ status: 409, body: { title: "Conflict", status: 409 } });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "New user" }));
    const dlg = await screen.findByRole("dialog", { name: "New user" });
    fireEvent.change(within(dlg).getByLabelText("Email"), { target: { value: "dup@eureka.example" } });
    fireEvent.change(within(dlg).getByLabelText("Name"), { target: { value: "Dup" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create user" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("A user with this email already exists.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("deactivates after a confirmation that says sessions are revoked immediately", async () => {
    routes["POST /api/v1/admin/users/u-priya/deactivate"] = () => ({ status: 204 });
    renderPage();
    fireEvent.click(within(await row("Priya Rao")).getByRole("button", { name: "Deactivate Priya Rao" }));
    const dlg = await screen.findByRole("dialog", { name: "Deactivate Priya Rao?" });
    expect(dlg).toHaveAccessibleDescription(/sessions are revoked immediately/i);
    expect(within(dlg).getByText(/roles must be granted again/i)).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(lastWrite()).toMatchObject({ method: "POST", path: "/api/v1/admin/users/u-priya/deactivate" });
    expect(lastWrite().headers["x-csrf-token"]).toBe("tok");
    await waitFor(() => expect(status()).toHaveTextContent(/deactivated and signed out/));
  });

  it("maps self_change from the server to a friendly message", async () => {
    routes["POST /api/v1/admin/users/u-old/reactivate"] = () => problem(403, "self_change");
    renderPage();
    fireEvent.click(within(await row("Old Timer")).getByRole("button", { name: "Reactivate Old Timer" }));
    const dlg = await screen.findByRole("dialog", { name: "Reactivate Old Timer?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Reactivate" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(ERROR_MESSAGES.self_change!);
  });

  it("closes a dialog on Escape and returns focus to the opener", async () => {
    renderPage();
    const opener = within(await row("Priya Rao")).getByRole("button", { name: "Deactivate Priya Rao" });
    opener.focus();
    fireEvent.click(opener);
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes on Escape even when focus has fallen to the page body (e.g. after a failed submit)", async () => {
    renderPage();
    fireEvent.click(within(await row("Priya Rao")).getByRole("button", { name: "Deactivate Priya Rao" }));
    await screen.findByRole("dialog");
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("grant role: location only for location-bound roles, second-approver note for restricted roles", async () => {
    routes["POST /api/v1/admin/role-requests"] = (_u, init) =>
      JSON.parse(String(init.body)).role === "hr" ? { status: 201, body: { id: "rq9", status: "pending_approval" } } : { status: 201, body: { id: "rq8", status: "applied" } };
    renderPage();
    fireEvent.click(within(await row("Priya Rao")).getByRole("button", { name: "Grant role to Priya Rao" }));
    const dlg = await screen.findByRole("dialog", { name: "Grant a role to Priya Rao" });
    const roleSel = await within(dlg).findByLabelText("Role");
    expect(within(dlg).queryByLabelText("Location")).not.toBeInTheDocument();

    fireEvent.change(roleSel, { target: { value: "location_ops_admin" } });
    const submit = within(dlg).getByRole("button", { name: "Grant role" });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: "loc-hyd" } });
    expect(submit).toBeEnabled();
    expect(within(dlg).queryByText(/needs a second approver/)).not.toBeInTheDocument();

    fireEvent.change(roleSel, { target: { value: "hr" } });
    expect(within(dlg).queryByLabelText("Location")).not.toBeInTheDocument();
    expect(within(dlg).getByText(/needs a second approver/)).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Request approval" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(lastWrite().body).toEqual({ userId: "u-priya", role: "hr" });
    await waitFor(() => expect(status()).toHaveTextContent(/waiting for a second approver/));
  });

  it("single-admin mode: a restricted role is granted at once, with no second-approver warning", async () => {
    routes["GET /api/v1/admin/meta"] = () => ({ body: { ...META, singleAdminMode: true } });
    routes["POST /api/v1/admin/role-requests"] = () => ({ status: 201, body: { id: "rq7", status: "applied" } });
    renderPage();
    fireEvent.click(within(await row("Priya Rao")).getByRole("button", { name: "Grant role to Priya Rao" }));
    const dlg = await screen.findByRole("dialog", { name: "Grant a role to Priya Rao" });
    fireEvent.change(await within(dlg).findByLabelText("Role"), { target: { value: "hr" } });
    expect(within(dlg).getByText(/Single-admin mode is on/)).toBeInTheDocument();
    expect(within(dlg).queryByText(/needs a second approver/)).not.toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Grant role" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(status()).toHaveTextContent(/Granted HR to Priya Rao/));
  });

  it("grant role sends locationId and reports an applied grant", async () => {
    routes["POST /api/v1/admin/role-requests"] = () => ({ status: 201, body: { id: "rq8", status: "applied" } });
    renderPage();
    fireEvent.click(within(await row("Rohit Lead")).getByRole("button", { name: "Grant role to Rohit Lead" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(await within(dlg).findByLabelText("Role"), { target: { value: "location_ops_admin" } });
    fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: "loc-dal" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Grant role" }));
    await waitFor(() => expect(status()).toHaveTextContent("Granted Location Ops Admin to Rohit Lead."));
    expect(lastWrite().body).toEqual({ userId: "u-lead", role: "location_ops_admin", locationId: "loc-dal" });
  });

  it("grant role maps location_required", async () => {
    routes["POST /api/v1/admin/role-requests"] = () => problem(422, "location_required");
    renderPage();
    fireEvent.click(within(await row("Rohit Lead")).getByRole("button", { name: "Grant role to Rohit Lead" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(await within(dlg).findByLabelText("Role"), { target: { value: "location_ops_admin" } });
    fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: "loc-dal" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Grant role" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(ERROR_MESSAGES.location_required!);
  });

  it("revokes a role (with its location) after confirming", async () => {
    routes["DELETE /api/v1/admin/users/u-priya/roles/location_ops_admin"] = () => ({ status: 204 });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Location Ops Admin · Dallas from Priya Rao" }));
    const dlg = await screen.findByRole("dialog", { name: "Revoke Location Ops Admin · Dallas?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Revoke role" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(lastWrite()).toMatchObject({ method: "DELETE", path: "/api/v1/admin/users/u-priya/roles/location_ops_admin" });
    expect(lastWrite().url.searchParams.get("locationId")).toBe("loc-dal");
    await waitFor(() => expect(status()).toHaveTextContent("Revoked Location Ops Admin · Dallas from Priya Rao."));
  });

  it("sets a manager and maps cycle", async () => {
    let fail = true;
    routes["PUT /api/v1/admin/users/u-lead/manager"] = () => (fail ? problem(422, "cycle") : { status: 204 });
    renderPage();
    fireEvent.click(within(await row("Rohit Lead")).getByRole("button", { name: "Set manager for Rohit Lead" }));
    const dlg = await screen.findByRole("dialog", { name: "Set manager for Rohit Lead" });
    await within(dlg).findByRole("option", { name: /Priya Rao/ });
    expect(within(dlg).queryByRole("option", { name: /Rohit Lead/ })).not.toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Manager"), { target: { value: "u-priya" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save manager" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(ERROR_MESSAGES.cycle!);
    expect(lastWrite().body).toEqual({ managerId: "u-priya" });

    fail = false;
    fireEvent.change(within(dlg).getByLabelText("Manager"), { target: { value: "" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save manager" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(lastWrite().body).toEqual({ managerId: null });
  });
});

// ---- approvals -----------------------------------------------------------------------------------

describe("Approvals tab", () => {
  it("disables approve (with a reason) when I am the requester or the grantee", async () => {
    renderPage("approvals");
    const mine = within(await row("Priya Rao"));
    const approveMine = mine.getByRole("button", { name: "Approve HR for Priya Rao" });
    expect(approveMine).toBeDisabled();
    expect(approveMine).toHaveAccessibleDescription("You requested this. Another admin has to approve it.");
    expect(mine.getByRole("button", { name: "Reject HR for Priya Rao" })).toBeEnabled();

    const forMe = within(await row("Ada Admin"));
    expect(forMe.getByRole("button", { name: /^Approve/ })).toHaveAccessibleDescription("This request is for you. Another admin has to approve it.");
    expect(forMe.getByText("Hyderabad")).toBeInTheDocument();

    expect(within(await row("Rohit Lead")).getByRole("button", { name: "Approve HR for Rohit Lead" })).toBeEnabled();
  });

  it("approves another admin's request", async () => {
    routes["POST /api/v1/admin/role-requests/rq2/approve"] = () => ({ body: { status: "approved" } });
    renderPage("approvals");
    fireEvent.click(within(await row("Rohit Lead")).getByRole("button", { name: "Approve HR for Rohit Lead" }));
    await waitFor(() => expect(status()).toHaveTextContent("Approved HR for Rohit Lead."));
    expect(lastWrite()).toMatchObject({ method: "POST", path: "/api/v1/admin/role-requests/rq2/approve" });
    expect(lastWrite().headers["x-csrf-token"]).toBe("tok");
  });

  it("shows second_approver_required from the server as a friendly alert", async () => {
    routes["POST /api/v1/admin/role-requests/rq2/approve"] = () => problem(403, "second_approver_required");
    renderPage("approvals");
    fireEvent.click(within(await row("Rohit Lead")).getByRole("button", { name: "Approve HR for Rohit Lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ERROR_MESSAGES.second_approver_required!);
  });

  it("rejects a request", async () => {
    routes["POST /api/v1/admin/role-requests/rq1/reject"] = () => ({ body: { status: "rejected" } });
    renderPage("approvals");
    fireEvent.click(within(await row("Priya Rao")).getByRole("button", { name: "Reject HR for Priya Rao" }));
    await waitFor(() => expect(status()).toHaveTextContent("Rejected HR for Priya Rao."));
  });

  it("filters by status", async () => {
    renderPage("approvals");
    await row("Priya Rao");
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "expired" } });
    await waitFor(() => expect(calls.some((c) => c.url.searchParams.get("status") === "expired")).toBe(true));
  });
});

// ---- teams ---------------------------------------------------------------------------------------

const MOVER: Me = { ...ME, capabilities: [...ME.capabilities, "team:move_member"] };
const teamCard = async (name: string) => (await screen.findByRole("heading", { name })).closest("section")!;

describe("Teams tab", () => {
  it("lists teams with lead and members", async () => {
    renderPage("teams");
    const t = within(await teamCard("Team Rohit"));
    expect(t.getByText("Rohit Lead")).toBeInTheDocument();
    expect(within(t.getByRole("list", { name: "Members of Team Rohit" })).getAllByRole("listitem")).toHaveLength(2);
    expect(within(await teamCard("Team Anjali")).getByText("No members yet.")).toBeInTheDocument();
  });

  it("disables Move to team when the role lacks team:move_member", async () => {
    renderPage("teams");
    const btn = within(await teamCard("Team Rohit")).getByRole("button", { name: "Move Priya Rao to another team" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/move team member/);
  });

  it("moves a member with the default reassignment (old lead) and shows the result", async () => {
    routes["POST /api/v1/teams/t1/move-member"] = () => ({ body: { movedCandidates: 3, reassignedTo: { id: "u-lead", displayName: "Rohit Lead" } } });
    renderPage("teams", MOVER);
    fireEvent.click(within(await teamCard("Team Rohit")).getByRole("button", { name: "Move Priya Rao to another team" }));
    const dlg = await screen.findByRole("dialog", { name: "Move Priya Rao to another team" });
    const reassign = within(dlg).getByLabelText("Reassign candidates to") as HTMLSelectElement;
    expect(reassign.selectedOptions[0]).toHaveTextContent("Rohit Lead (lead of Team Rohit, default)");
    expect(within(reassign).getAllByRole("option").map((o) => o.textContent)).toEqual(["Rohit Lead (lead of Team Rohit, default)", "Sam Member"]);
    expect(within(within(dlg).getByLabelText("Move to team")).queryByRole("option", { name: "Team Rohit" })).not.toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Move to team"), { target: { value: "t2" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Move" }));

    const res = await screen.findByRole("dialog", { name: "Priya Rao moved to Team Anjali" });
    expect(res).toHaveTextContent("3 candidates stayed with Team Rohit and were reassigned to Rohit Lead.");
    expect(within(res).getByRole("button", { name: "Done" })).toHaveFocus();
    expect(lastWrite()).toMatchObject({ method: "POST", path: "/api/v1/teams/t1/move-member", body: { userId: "u-priya", toTeamId: "t2" } });
    expect(lastWrite().body).not.toHaveProperty("reassignTo");
    await waitFor(() => expect(status()).toHaveTextContent(/Moved Priya Rao to Team Anjali/));
    fireEvent.click(within(res).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends an explicit reassignTo and maps invalid_reassign_target / not_in_scope", async () => {
    let detail = "invalid_reassign_target";
    routes["POST /api/v1/teams/t1/move-member"] = () => problem(422, detail);
    renderPage("teams", MOVER);
    fireEvent.click(within(await teamCard("Team Rohit")).getByRole("button", { name: "Move Priya Rao to another team" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Move to team"), { target: { value: "t2" } });
    fireEvent.change(within(dlg).getByLabelText("Reassign candidates to"), { target: { value: "u-sam" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Move" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(ERROR_MESSAGES.invalid_reassign_target!);
    expect(lastWrite().body).toEqual({ userId: "u-priya", toTeamId: "t2", reassignTo: "u-sam" });

    detail = "not_in_scope";
    fireEvent.click(within(dlg).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(within(dlg).getByRole("alert")).toHaveTextContent(ERROR_MESSAGES.not_in_scope!));
  });

  it("adds a member and maps already_member (409)", async () => {
    routes["POST /api/v1/admin/teams/t2/members"] = () => problem(409, "already_member");
    renderPage("teams");
    fireEvent.click(within(await teamCard("Team Anjali")).getByRole("button", { name: "Add member to Team Anjali" }));
    const dlg = await screen.findByRole("dialog", { name: "Add member to Team Anjali" });
    expect(await within(dlg).findByRole("option", { name: /Priya Rao .* · in Team Rohit/ })).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Person"), { target: { value: "u-priya" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add member" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(ERROR_MESSAGES.already_member!);
    expect(lastWrite().body).toEqual({ userId: "u-priya" });
  });

  it("creates a team and changes a lead", async () => {
    routes["POST /api/v1/admin/teams"] = () => ({ status: 201, body: { id: "t9" } });
    routes["PUT /api/v1/admin/teams/t2/lead"] = () => ({ status: 204 });
    renderPage("teams");
    fireEvent.click(await screen.findByRole("button", { name: "New team" }));
    let dlg = await screen.findByRole("dialog", { name: "New team" });
    fireEvent.change(within(dlg).getByLabelText("Team name"), { target: { value: "Team Neo" } });
    await within(dlg).findByRole("option", { name: /Rohit Lead/ });
    fireEvent.change(within(dlg).getByLabelText("Lead"), { target: { value: "u-lead" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(status()).toHaveTextContent("Created Team Neo."));
    expect(lastWrite().body).toEqual({ name: "Team Neo", leadId: "u-lead" });

    fireEvent.click(within(await teamCard("Team Anjali")).getByRole("button", { name: "Change lead of Team Anjali" }));
    dlg = await screen.findByRole("dialog", { name: "Change lead of Team Anjali" });
    await within(dlg).findByRole("option", { name: /Priya Rao/ });
    fireEvent.change(within(dlg).getByLabelText("New lead"), { target: { value: "u-priya" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Change lead" }));
    await waitFor(() => expect(status()).toHaveTextContent("Priya Rao now leads Team Anjali."));
    expect(lastWrite()).toMatchObject({ method: "PUT", path: "/api/v1/admin/teams/t2/lead", body: { leadId: "u-priya" } });
  });
});

// ---- error mapping -------------------------------------------------------------------------------

describe("friendlyError", () => {
  it.each(["self_change", "second_approver_required", "location_required", "already_member", "not_in_scope", "invalid_reassign_target", "cycle", "restricted_role", "location_not_allowed"])(
    "maps %s", (code) => {
      const msg = friendlyError(new ApiError(403, code, code));
      expect(msg).toBe(ERROR_MESSAGES[code]);
      expect(msg).not.toContain(code);
    });

  it("falls back by status and context", () => {
    expect(friendlyError(new ApiError(409, "Conflict", undefined, "Conflict"), "createUser")).toMatch(/already exists/);
    expect(friendlyError(new ApiError(422, "x"), "createUser")).toMatch(/Google domain/);
    expect(friendlyError(new ApiError(409, "Conflict"), "addMember")).toBe(ERROR_MESSAGES.already_member);
    expect(friendlyError(new ApiError(403, "Forbidden"))).toMatch(/permission/);
    expect(friendlyError(new ApiError(500, "boom", "boom"))).toBe("boom");
    expect(friendlyError(new Error("offline"))).toBe("offline");
  });
});
