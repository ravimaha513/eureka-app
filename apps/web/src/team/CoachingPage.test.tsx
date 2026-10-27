import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "../api";
import { CoachingPage } from "./CoachingPage";

// Shapes from docs/admin-api.md AD-11 (GET /api/v1/coach-assignments).
const DATA = {
  items: [
    { id: "t1", name: "Team Rohit", lead: { id: "u-l1", displayName: "Rohit Lead" }, coaches: [{ id: "u-coach", displayName: "Cora Coach" }] },
    { id: "t2", name: "Team Anjali", lead: { id: "u-l2", displayName: "Anjali Lead" }, coaches: [] },
  ],
  coaches: [{ id: "u-coach", displayName: "Cora Coach", email: "c@eureka.example", role: "interview_coach" }],
};

let writes: { method: string; path: string; body: unknown }[];
let reply: Record<string, { status: number; body?: unknown }>;

beforeEach(() => {
  setCsrf("tok");
  writes = [];
  reply = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/api/v1/coach-assignments") return new Response(JSON.stringify(DATA), { status: 200 });
    writes.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = reply[`${method} ${path}`] ?? { status: 204 };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/problem+json" } });
  });
});
afterEach(() => vi.restoreAllMocks());

const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CoachingPage /></QueryClientProvider>,
);
const card = async (name: string) => (await screen.findByRole("heading", { name })).closest("section")!;

describe("Coach assignments (Interview Lead, AD-11)", () => {
  it("lists every team with the lead's coaches and assigns one through the team endpoint", async () => {
    renderPage();
    expect(within(within(await card("Team Rohit")).getByRole("list", { name: "Coaches of Team Rohit" })).getByText("Cora Coach")).toBeInTheDocument();
    fireEvent.click(within(await card("Team Anjali")).getByRole("button", { name: "Add coach to Team Anjali" }));
    const dlg = await screen.findByRole("dialog", { name: "Add coach to Team Anjali" });
    fireEvent.change(within(dlg).getByLabelText("Coach"), { target: { value: "u-coach" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add coach" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Cora Coach now coaches Team Anjali."));
    expect(writes).toEqual([{ method: "POST", path: "/api/v1/teams/t2/coaches", body: { userId: "u-coach" } }]);
  });

  it("removes a coach and shows a refused change", async () => {
    reply["DELETE /api/v1/teams/t1/coaches/u-coach"] = { status: 403, body: { status: 403, detail: "not_in_scope" } };
    renderPage();
    fireEvent.click(within(await card("Team Rohit")).getByRole("button", { name: "Remove coach Cora Coach from Team Rohit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You can only assign coaches who report to you.");
    expect(writes).toEqual([{ method: "DELETE", path: "/api/v1/teams/t1/coaches/u-coach", body: undefined }]);
  });
});
