import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilities, type Role } from "@eureka/shared";
import { setCsrf, type Me } from "../api";
import { HotListPage } from "./HotListPage";

// ---- fixtures (shapes from apps/api/src/modules/hotlist) ---------------------------------------

const meFor = (role: Role): Me => ({
  id: "u-me", email: "me@eureka.example", displayName: "Test User", csrfToken: "tok",
  roles: [{ key: role, label: role, locationId: null }],
  capabilities: capabilities({ userId: "u-me", roles: [{ role }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [] }),
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const V1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cand = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, technology: "Java", status: "active", visibility: "team", priority: "P2",
  team: { id: "t1", name: "Team Rohit" }, recruiter: null, location: { id: "l", name: "Dallas" },
  marketingStartDate: "2026-09-01", daysInMarket: 28, technicalRating: null, phone: "+14695550001", phoneMasked: false,
  canOpenProfile: true, ...extra,
});
const ITEMS = [
  cand(A, "Asha Iyer"),
  cand(B, "Bala Rao"),
  cand(C, "Chitra Das", { team: { id: "t2", name: "Team Anjali" }, phone: "•••-•••-42", phoneMasked: true, canOpenProfile: false }),
];
const VIEW = { id: V1, name: "Bench Java", filters: { status: "bench", technology: "Java" }, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" };

// ---- fetch router ------------------------------------------------------------------------------

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
type Handler = (url: URL, body: unknown) => Reply;
interface Call { method: string; path: string; url: URL; body: unknown }
let routes: Record<string, Handler>;
let calls: Call[];

const problem = (status: number, detail?: string): Reply => ({ status, body: { type: "about:blank", title: "Error", status, detail } });

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  routes = {
    "GET /api/v1/hotlist": () => ({ body: { items: ITEMS, nextCursor: null } }),
    "GET /api/v1/hotlist/views": () => ({ body: { items: [VIEW] } }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, url, body });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 599 });
    const r = h(url, body);
    const status = r.status ?? 200;
    if (r.text !== undefined) return new Response(r.text, { status, headers: r.headers });
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => vi.restoreAllMocks());

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const lastCall = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).at(-1);
const rowOf = async (name: string) => (await screen.findByText(name, { selector: "b" })).closest("tr")!;
const views = () => screen.getByRole("region", { name: "Saved views" });

// ---- saved views -------------------------------------------------------------------------------

describe("Hot List saved views", () => {
  it("applying a saved view sets every filter and reloads page 1", async () => {
    wrap(<HotListPage me={meFor("recruiter")} />);
    await rowOf("Asha Iyer");
    const picker = within(views()).getByLabelText("Saved view");
    await within(picker).findByRole("option", { name: "Bench Java" });
    fireEvent.change(picker, { target: { value: V1 } });
    await waitFor(() => {
      const p = lastCall("GET", "/api/v1/hotlist")!.url.searchParams;
      expect(p.get("status")).toBe("bench");
      expect(p.get("technology")).toBe("Java");
    });
    expect(screen.getByLabelText("Status")).toHaveValue("bench");
    expect(screen.getByLabelText("Technology")).toHaveValue("Java");
    expect(within(views()).getByRole("status")).toHaveTextContent("Showing saved view “Bench Java”.");
  });

  it("saves the current filters under a name", async () => {
    routes["POST /api/v1/hotlist/views"] = (_u, b) => ({ status: 201, body: { ...VIEW, id: "new", ...(b as object) } });
    wrap(<HotListPage me={meFor("recruiter")} />);
    await rowOf("Asha Iyer");
    fireEvent.change(screen.getByLabelText("Visibility"), { target: { value: "all_teams" } });
    fireEvent.click(within(views()).getByRole("button", { name: "Save current filters…" }));
    const form = within(views()).getByRole("form", { name: "Save view" });
    fireEvent.change(within(form).getByLabelText("View name"), { target: { value: "  Open to all  " } });
    fireEvent.click(within(form).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(lastCall("POST", "/api/v1/hotlist/views")?.body).toEqual({ name: "Open to all", filters: { visibility: "all_teams" } }));
    expect(await within(views()).findByText("Saved view “Open to all”.")).toBeInTheDocument();
  });

  it("explains a duplicate name", async () => {
    routes["POST /api/v1/hotlist/views"] = () => problem(409, "view_name_taken");
    wrap(<HotListPage me={meFor("recruiter")} />);
    await rowOf("Asha Iyer");
    fireEvent.click(within(views()).getByRole("button", { name: "Save current filters…" }));
    fireEvent.change(within(views()).getByLabelText("View name"), { target: { value: "Bench Java" } });
    fireEvent.click(within(views()).getByRole("button", { name: "Save view" }));
    expect(await within(views()).findByRole("alert")).toHaveTextContent("You already have a saved view with that name.");
  });

  it("renames, updates and deletes the chosen view (delete asks first)", async () => {
    routes[`PATCH /api/v1/hotlist/views/${V1}`] = (_u, b) => ({ body: { ...VIEW, ...(b as object) } });
    routes[`DELETE /api/v1/hotlist/views/${V1}`] = () => ({ status: 204 });
    wrap(<HotListPage me={meFor("recruiter")} />);
    await rowOf("Asha Iyer");
    const picker = within(views()).getByLabelText("Saved view");
    await within(picker).findByRole("option", { name: "Bench Java" });
    expect(within(views()).queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: V1 } });

    fireEvent.click(within(views()).getByRole("button", { name: "Rename" }));
    const name = within(views()).getByLabelText("View name");
    expect(name).toHaveValue("Bench Java");
    fireEvent.change(name, { target: { value: "Java on bench" } });
    fireEvent.click(within(views()).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(lastCall("PATCH", `/api/v1/hotlist/views/${V1}`)?.body).toEqual({ name: "Java on bench" }));

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "active" } });
    fireEvent.click(within(views()).getByRole("button", { name: "Update with current filters" }));
    await waitFor(() => expect(lastCall("PATCH", `/api/v1/hotlist/views/${V1}`)?.body)
      .toEqual({ filters: { status: "active", technology: "Java" } }));

    fireEvent.click(within(views()).getByRole("button", { name: "Delete" }));
    expect(lastCall("DELETE", `/api/v1/hotlist/views/${V1}`)).toBeUndefined();
    fireEvent.click(within(within(views()).getByRole("group", { name: "Confirm delete" })).getByRole("button", { name: "Delete view" }));
    await waitFor(() => expect(lastCall("DELETE", `/api/v1/hotlist/views/${V1}`)).toBeDefined());
    expect(await within(views()).findByText("Deleted view “Bench Java”.")).toBeInTheDocument();
  });
});

// ---- export ------------------------------------------------------------------------------------

describe("Hot List export", () => {
  let created: Blob[];
  let clicked: string[];
  beforeEach(() => {
    created = []; clicked = [];
    Object.assign(URL, { createObjectURL: (b: Blob) => { created.push(b); return "blob:x"; }, revokeObjectURL: () => undefined });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
  });

  it.each(["recruiter", "location_ops_admin", "org_admin", "hr"] as const)("is not offered to %s (no report:export)", async (role) => {
    wrap(<HotListPage me={meFor(role)} />);
    await rowOf("Asha Iyer");
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("downloads the current view for a lead and reports the row count", async () => {
    routes["POST /api/v1/hotlist/export"] = () => ({
      text: "﻿Candidate\r\nAsha Iyer\r\nBala Rao\r\n",
      headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="hotlist-2026-10-01.csv"', "x-export-rows": "2", "x-export-truncated": "false" },
    });
    wrap(<HotListPage me={meFor("lead")} />);
    await rowOf("Asha Iyer");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "bench" } });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Exported 2 rows.")).toBeInTheDocument();
    expect(lastCall("POST", "/api/v1/hotlist/export")?.body).toEqual({ status: "bench" });
    expect(clicked).toEqual(["hotlist-2026-10-01.csv"]);
    expect(created).toHaveLength(1);
    expect(screen.getByText(/Phones are masked/)).toBeInTheDocument();
  });

  it("says when the export hit the row cap", async () => {
    routes["POST /api/v1/hotlist/export"] = () => ({
      text: "x", headers: { "content-disposition": 'attachment; filename="h.csv"', "x-export-rows": "50000", "x-export-truncated": "true" },
    });
    wrap(<HotListPage me={meFor("manager")} />);
    await rowOf("Asha Iyer");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Exported the first 50,000 rows (the export limit). Narrow the filters to export the rest.")).toBeInTheDocument();
  });

  it("shows the rate-limit message", async () => {
    routes["POST /api/v1/hotlist/export"] = () => problem(429, "Too many exports; try again in a few minutes");
    wrap(<HotListPage me={meFor("ceo")} />);
    await rowOf("Asha Iyer");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Too many exports; try again in a few minutes")).toHaveAttribute("role", "alert");
    expect(clicked).toEqual([]);
  });
});

// ---- bulk actions ------------------------------------------------------------------------------

describe("Hot List bulk actions", () => {
  const bulk = () => screen.getByRole("region", { name: "Bulk actions" });

  it("offers no selection to users who cannot change candidates", async () => {
    wrap(<HotListPage me={meFor("org_admin")} />);
    await rowOf("Asha Iyer");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();
  });

  it("a recruiter gets status changes only; a lead also gets visibility", async () => {
    const { unmount } = wrap(<HotListPage me={meFor("recruiter")} />);
    await rowOf("Asha Iyer");
    expect(within(bulk()).getByLabelText("Set status")).toBeInTheDocument();
    expect(within(bulk()).queryByLabelText("Set visibility")).not.toBeInTheDocument();
    expect([...within(within(bulk()).getByLabelText("Set status")).getAllByRole("option")].map((o) => o.textContent))
      .toEqual(["Choose a status", "Active", "On hold", "Full of interviews", "Stopped"]);
    unmount();
    wrap(<HotListPage me={meFor("lead")} />);
    await rowOf("Asha Iyer");
    expect(within(bulk()).getByLabelText("Set visibility")).toBeInTheDocument();
  });

  it("selects the page (other teams' rows are not selectable) and reports each record's outcome", async () => {
    routes["POST /api/v1/hotlist/bulk/status"] = (_u, b) => {
      const ids = (b as { ids: string[] }).ids;
      return { body: { succeeded: 1, failed: 1, results: [{ id: ids[0], ok: true }, { id: ids[1], ok: false, error: "forbidden" }] } };
    };
    wrap(<HotListPage me={meFor("recruiter")} />);
    await rowOf("Asha Iyer");
    expect(within(await rowOf("Chitra Das")).getByRole("checkbox", { name: "Select Chitra Das" })).toBeDisabled();
    expect(within(bulk()).getByRole("button", { name: "Apply status" })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all candidates on this page" }));
    expect(screen.getByRole("checkbox", { name: "Select Asha Iyer" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Bala Rao" })).toBeChecked();
    expect(within(bulk()).getByText("selected", { exact: false })).toHaveTextContent("2 candidates selected");

    fireEvent.change(within(bulk()).getByLabelText("Set status"), { target: { value: "on_hold" } });
    fireEvent.click(within(bulk()).getByRole("button", { name: "Apply status" }));
    await waitFor(() => expect(lastCall("POST", "/api/v1/hotlist/bulk/status")?.body).toEqual({ ids: [A, B], to: "on_hold" }));
    const status = await within(bulk()).findByText("1 updated, 1 not changed.");
    expect(status.closest("[role=status]")).toHaveTextContent("Bala Rao: you don't have permission to change this candidate");
    // The list reloads and the selection is cleared.
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/api/v1/hotlist").length).toBeGreaterThan(1));
    expect(screen.getByRole("checkbox", { name: "Select Asha Iyer" })).not.toBeChecked();
  });

  it("a lead changes visibility for the selected rows", async () => {
    routes["POST /api/v1/hotlist/bulk/visibility"] = () => ({ body: { succeeded: 1, failed: 0, results: [{ id: B, ok: true }] } });
    wrap(<HotListPage me={meFor("lead")} />);
    fireEvent.click(within(await rowOf("Bala Rao")).getByRole("checkbox", { name: "Select Bala Rao" }));
    fireEvent.change(within(bulk()).getByLabelText("Set visibility"), { target: { value: "all_teams" } });
    fireEvent.click(within(bulk()).getByRole("button", { name: "Apply visibility" }));
    expect(await within(bulk()).findByText("1 updated.")).toBeInTheDocument();
    expect(lastCall("POST", "/api/v1/hotlist/bulk/visibility")?.body).toEqual({ ids: [B], visibility: "all_teams" });
  });
});
