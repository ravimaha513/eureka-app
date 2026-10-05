import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "../api";
import { CandidateWorkAuthorization, REVEAL_VISIBLE_MS } from "./CandidateWorkAuthorization";

// Work authorization on the candidate profile (API: apps/api/src/modules/work-authorization, migration 0042).

const CID = "11111111-1111-4111-8111-111111111111";
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASE = `/api/v1/candidates/${CID}/work-authorizations`;

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: "h1b", numberMasked: "••••••••", hasNumber: true, validFrom: "2025-10-01", validTo: "2028-09-30", status: "valid",
  expired: false, daysToExpiry: 700, rowVersion: 3, createdAt: "2026-09-20T10:00:00Z", updatedAt: "2026-09-21T10:00:00Z",
  updatedBy: { id: "u1", name: "Imm One" }, ...extra,
});

type Reply = { status?: number; body?: unknown };
interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }
let routes: Record<string, (body: unknown) => Reply>;
let calls: Call[];
const problem = (status: number, detail?: string): Reply => ({ status, body: { type: "about:blank", title: "Error", status, detail } });

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  routes = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, headers: (init.headers ?? {}) as Record<string, string> });
    const h = routes[`${method} ${url.pathname}`];
    if (!h) return new Response(JSON.stringify({ detail: "unmocked" }), { status: 599 });
    const r = h(body);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const wrap = () =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CandidateWorkAuthorization candidateId={CID} /></QueryClientProvider>);

describe("Work authorization section", () => {
  it("lists records with the number masked, expiry and status; no edit controls without canEdit", async () => {
    routes[`GET ${BASE}`] = () => ({ body: { canEdit: false, canReveal: true, items: [
      record(W1),
      record(W2, { type: "f1_opt", hasNumber: false, numberMasked: null, validTo: "2026-01-31", expired: true, daysToExpiry: -200 }),
    ] } });
    wrap();
    const table = await screen.findByRole("table", { name: "Work authorization records" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("H-1B")).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText("Number hidden")).toHaveTextContent("••••••••");
    expect(within(rows[0]!).getByText("Valid")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("F-1 OPT")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Expired")).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole("button", { name: /Show number/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add work authorization" })).toBeNull();
  });

  it("shows a number only after the audited reveal call, then hides it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    routes[`GET ${BASE}`] = () => ({ body: { canEdit: false, canReveal: true, items: [record(W1)] } });
    routes[`POST ${BASE}/${W1}/reveal`] = () => ({ body: { id: W1, number: "EAC2190012345" } });
    wrap();
    expect(screen.queryByText("EAC2190012345")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Show number for H-1B" }));
    expect(await screen.findByText("EAC2190012345")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/reveal"))).toEqual([expect.objectContaining({ method: "POST", path: `${BASE}/${W1}/reveal` })]);
    await act(async () => { vi.advanceTimersByTime(REVEAL_VISIBLE_MS + 10); });
    expect(screen.queryByText("EAC2190012345")).toBeNull();
  });

  it("a step-up refusal asks to confirm it's you, then shows the number", async () => {
    let stepped = false;
    routes[`GET ${BASE}`] = () => ({ body: { canEdit: false, canReveal: true, items: [record(W1)] } });
    routes[`POST ${BASE}/${W1}/reveal`] = () => stepped ? { body: { id: W1, number: "EAC2190012345" } } : problem(403, "step_up_required");
    routes["GET /api/auth/step-up"] = () => ({ body: { active: false, expiresAt: null, method: null, mode: "dev", ttlMinutes: 10 } });
    routes["POST /api/auth/step-up/dev"] = () => { stepped = true; return { body: { active: true, expiresAt: "2026-09-20T10:10:00Z" } }; };
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Show number for H-1B" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm (development)" }));
    expect(await screen.findByText("EAC2190012345")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides itself when the server says the candidate is not in scope", async () => {
    routes[`GET ${BASE}`] = () => problem(404);
    const { container } = wrap();
    await waitFor(() => expect(calls.length).toBe(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("adds a record (number normalized, empty dates as null)", async () => {
    let items = [] as unknown[];
    routes[`GET ${BASE}`] = () => ({ body: { canEdit: true, canReveal: true, items } });
    routes[`POST ${BASE}`] = () => { items = [record(W1)]; return { status: 201, body: { id: W1, rowVersion: 1 } }; };
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Add work authorization" }));
    const dialog = screen.getByRole("dialog", { name: "Add work authorization" });
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "h4_ead" } });
    fireEvent.change(within(dialog).getByLabelText("Number"), { target: { value: " eac 219 001 " } });
    fireEvent.change(within(dialog).getByLabelText("Expires on"), { target: { value: "2027-05-31" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Work authorization added.")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ type: "h4_ead", status: "valid", validFrom: null, validTo: "2027-05-31", number: "EAC219001" });
  });

  it("validates the number and dates before sending", async () => {
    routes[`GET ${BASE}`] = () => ({ body: { canEdit: true, canReveal: true, items: [] } });
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Add work authorization" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Number"), { target: { value: "no/slashes" } });
    fireEvent.change(within(dialog).getByLabelText("Valid from"), { target: { value: "2027-01-01" } });
    fireEvent.change(within(dialog).getByLabelText("Expires on"), { target: { value: "2026-01-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText("Use 1-40 letters, digits or hyphens.")).toBeInTheDocument();
    expect(within(dialog).getByText("The expiry date can't be before the start date.")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText("Number")).toHaveFocus());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("edits with If-Match; an empty number keeps it, the checkbox removes it; a conflict is explained", async () => {
    routes[`GET ${BASE}`] = () => ({ body: { canEdit: true, canReveal: true, items: [record(W1)] } });
    let reply: Reply = { body: { id: W1, rowVersion: 4 } };
    routes[`PATCH ${BASE}/${W1}`] = () => reply;
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Edit H-1B" }));
    let dialog = screen.getByRole("dialog", { name: "Edit work authorization" });
    fireEvent.change(within(dialog).getByLabelText("Status"), { target: { value: "revoked" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Work authorization saved.")).toBeInTheDocument();
    const first = calls.find((c) => c.method === "PATCH")!;
    expect(first.body).toEqual({ type: "h1b", status: "revoked", validFrom: "2025-10-01", validTo: "2028-09-30" });
    expect(first.headers["if-match"]).toBe('"3"');

    fireEvent.click(screen.getByRole("button", { name: "Edit H-1B" }));
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Remove the stored number"));
    reply = problem(412, "stale");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/Someone else changed this record/);
    expect(calls.filter((c) => c.method === "PATCH")[1]!.body).toMatchObject({ number: null });
  });
});
