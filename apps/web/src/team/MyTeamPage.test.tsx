import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "../api";
import { MyTeamPage } from "./MyTeamPage";

// Shapes from docs/admin-api.md AD-10 (GET /api/v1/teams/mine).
const DATA = {
  items: [{ id: "t1", name: "Team Rohit", lead: { id: "u-l1", displayName: "Rohit Lead" }, members: [{ id: "u-priya", displayName: "Priya Rao" }] }],
  addable: [{ id: "u-new", displayName: "Nina New", email: "n@eureka.example" }],
};

let writes: { method: string; path: string; body: unknown }[];
let reply: Record<string, { status: number; body?: unknown }>;
let reads: number;

beforeEach(() => {
  setCsrf("tok");
  writes = [];
  reply = {};
  reads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/api/v1/teams/mine") { reads++; return new Response(JSON.stringify(DATA), { status: 200 }); }
    writes.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = reply[`${method} ${path}`] ?? { status: 204 };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body), {
      status: r.status, headers: { "content-type": r.status < 400 ? "application/json" : "application/problem+json" },
    });
  });
});
afterEach(() => vi.restoreAllMocks());

const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MyTeamPage /></QueryClientProvider>,
);
const card = async (name: string) => (await screen.findByRole("heading", { name })).closest("section")!;

describe("My team (AD-10, AD-14)", () => {
  it("adds an unassigned recruiter and reloads the team", async () => {
    renderPage();
    fireEvent.click(within(await card("Team Rohit")).getByRole("button", { name: "Add member to Team Rohit" }));
    const dlg = await screen.findByRole("dialog", { name: "Add member to Team Rohit" });
    fireEvent.change(within(dlg).getByLabelText("Recruiter"), { target: { value: "u-new" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Nina New joined Team Rohit."));
    expect(writes).toEqual([{ method: "POST", path: "/api/v1/teams/t1/members", body: { userId: "u-new" } }]);
    await waitFor(() => expect(reads).toBe(2));
  });

  it("removes a member after a confirm and reloads the team", async () => {
    reply["DELETE /api/v1/teams/t1/members/u-priya"] = { status: 200, body: { movedCandidates: 1, reassignedTo: { id: "u-l1" } } };
    renderPage();
    fireEvent.click(within(await card("Team Rohit")).getByRole("button", { name: "Remove Priya Rao from Team Rohit" }));
    const dlg = await screen.findByRole("dialog", { name: "Remove Priya Rao from Team Rohit?" });
    expect(writes).toEqual([]);
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Removed Priya Rao from Team Rohit. 1 candidate reassigned to Rohit Lead."));
    expect(writes).toEqual([{ method: "DELETE", path: "/api/v1/teams/t1/members/u-priya", body: undefined }]);
    await waitFor(() => expect(reads).toBe(2));
  });

  it("shows a refused removal in the dialog", async () => {
    reply["DELETE /api/v1/teams/t1/members/u-priya"] = { status: 403, body: { status: 403, detail: "not_in_scope" } };
    renderPage();
    fireEvent.click(within(await card("Team Rohit")).getByRole("button", { name: "Remove Priya Rao from Team Rohit" }));
    const dlg = await screen.findByRole("dialog", { name: "Remove Priya Rao from Team Rohit?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("You can only change a team you lead or one led in your hierarchy.");
  });
});
