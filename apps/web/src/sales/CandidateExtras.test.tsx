import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilities, type Role } from "@eureka/shared";
import { setCsrf, type Me } from "../api";
import { CandidateProfile } from "./CandidateProfile";
import { CandidatesPage } from "./CandidatesPage";

// Batches, timeline and the duplicate check (API: apps/api/src/modules/candidates, migration 0026).

const meFor = (role: Role): Me => ({
  id: "u-me", email: "me@eureka.example", displayName: "Test User", csrfToken: "tok",
  roles: [{ key: role, label: role, locationId: null }],
  capabilities: capabilities({ userId: "u-me", roles: [{ role, locationId: "loc" }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [] }),
});
const RECRUITER = meFor("recruiter");
const LEAD = meFor("lead");

const CID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TECH = "33333333-3333-4333-8333-333333333333";
const LOC = "44444444-4444-4444-8444-444444444444";
const B1 = "77777777-7777-4777-8777-777777777777";
const B2 = "88888888-8888-4888-8888-888888888888";
const LOOKUPS = { technologies: [{ id: TECH, name: "Java" }], clients: [], vendors: [], implementationPartners: [], locations: [{ id: LOC, name: "Dallas" }], coaches: [] };

const batch = (id: string, label: string, status = "planned") => ({
  id, label, location: { id: LOC, name: "Dallas" }, technology: { id: TECH, name: "Java" }, startMonth: "2026-11", sizePlanned: 20, status, candidatesInScope: 1,
});
const BATCHES = [batch(B1, "Java · Dallas · Nov 2026"), batch(B2, "Java · Dallas · Jan 2026", "cancelled")];

const CAND = {
  id: CID, name: "Asha Iyer", technology: "Java", status: "active", visibility: "team", priority: "P2",
  team: { id: "t1", name: "Team Rohit" }, recruiter: { id: "u-me", name: "Test User" }, location: { id: LOC, name: "Dallas" },
  marketingStartDate: "2026-09-01", daysInMarket: 28, technicalRating: null, phone: "+14695550001", phoneMasked: false,
};
const PROFILE = { ...CAND, dobMasked: null, rowVersion: 3, batch: { id: B1, label: "Java · Dallas · Nov 2026" } };

const ev = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, type, at: "2026-09-20T10:00:00Z", actor: { id: "u1", name: "Lead One" }, ref: null, from: null, to: null, ...extra,
});

type Reply = { status?: number; body?: unknown };
type Handler = (url: URL, body: unknown) => Reply;
interface Call { method: string; path: string; url: URL; body: unknown }
let routes: Record<string, Handler>;
let calls: Call[];
const problem = (status: number, extra: Record<string, unknown> = {}): Reply => ({ status, body: { type: "about:blank", title: "Error", status, ...extra } });

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  routes = {
    "GET /api/v1/candidates": () => ({ body: { items: [CAND], nextCursor: null } }),
    [`GET /api/v1/candidates/${CID}`]: () => ({ body: PROFILE }),
    [`GET /api/v1/candidates/${CID}/timeline`]: () => ({ body: { items: [], nextCursor: null } }),
    "GET /api/v1/lookups": () => ({ body: LOOKUPS }),
    "GET /api/v1/batches": () => ({ body: { items: BATCHES, canCreate: false } }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, url, body });
    const h = routes[`${method} ${url.pathname}`];
    if (!h) return new Response(JSON.stringify({ detail: `unmocked ${method} ${url.pathname}` }), { status: 599 });
    const r = h(url, body);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/problem+json" } });
  });
});
afterEach(() => vi.restoreAllMocks());

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const writes = () => calls.filter((c) => c.method !== "GET");
const lastGet = (path: string) => calls.filter((c) => c.method === "GET" && c.path === path).at(-1)!;

async function openCreate(me: Me = RECRUITER, onOpenProfile = vi.fn()) {
  wrap(<CandidatesPage me={me} onOpenProfile={onOpenProfile} />);
  fireEvent.click(await screen.findByRole("button", { name: "New candidate" }));
  const dlg = screen.getByRole("dialog", { name: "New candidate" });
  await within(dlg).findByRole("option", { name: "Java" });
  fireEvent.change(within(dlg).getByLabelText("First name"), { target: { value: "Ravi" } });
  fireEvent.change(within(dlg).getByLabelText("Last name"), { target: { value: "Kumar" } });
  fireEvent.change(within(dlg).getByLabelText("Technology"), { target: { value: TECH } });
  fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: LOC } });
  return { dlg, onOpenProfile };
}

describe("Candidates list: batches", () => {
  it("filters the list by batch and resets to page 1", async () => {
    wrap(<CandidatesPage me={RECRUITER} />);
    const sel = await screen.findByLabelText("Batch");
    await within(sel).findByRole("option", { name: "Java · Dallas · Nov 2026" });
    fireEvent.change(sel, { target: { value: B1 } });
    await waitFor(() => expect(lastGet("/api/v1/candidates").url.searchParams.get("batchId")).toBe(B1));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastGet("/api/v1/candidates").url.searchParams.get("batchId")).toBeNull());
  });

  it("offers New batch only when the server says the user may plan batches", async () => {
    const { unmount } = wrap(<CandidatesPage me={RECRUITER} />);
    await screen.findByLabelText("Batch");
    expect(screen.queryByRole("button", { name: "New batch" })).not.toBeInTheDocument();
    unmount();
    routes["GET /api/v1/batches"] = () => ({ body: { items: BATCHES, canCreate: true } });
    wrap(<CandidatesPage me={LEAD} />);
    expect(await screen.findByRole("button", { name: "New batch" })).toBeInTheDocument();
  });

  it("creates a batch: validates first, explains a 409, then posts and announces", async () => {
    routes["GET /api/v1/batches"] = () => ({ body: { items: BATCHES, canCreate: true } });
    let n = 0;
    routes["POST /api/v1/batches"] = () => (++n === 1 ? problem(409, { detail: "batch_exists" }) : { status: 201, body: { id: "b-new" } });
    wrap(<CandidatesPage me={LEAD} />);
    fireEvent.click(await screen.findByRole("button", { name: "New batch" }));
    const dlg = screen.getByRole("dialog", { name: "New batch" });
    await within(dlg).findByRole("option", { name: "Dallas" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create batch" }));
    expect(writes()).toHaveLength(0);
    expect(within(dlg).getByLabelText("Start month")).toHaveAccessibleDescription(expect.stringContaining("Choose the month training starts."));

    fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: LOC } });
    fireEvent.change(within(dlg).getByLabelText("Technology"), { target: { value: TECH } });
    fireEvent.change(within(dlg).getByLabelText("Start month"), { target: { value: "2026-11" } });
    fireEvent.change(within(dlg).getByLabelText("Planned size (optional)"), { target: { value: "25" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create batch" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("already exists");
    expect(writes()[0]!.body).toEqual({ locationId: LOC, technologyId: TECH, startMonth: "2026-11", sizePlanned: 25 });

    fireEvent.click(within(dlg).getByRole("button", { name: "Create batch" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Batch created.")).toHaveAttribute("role", "status");
  });
});

describe("Create candidate: contacts, batch and duplicate check", () => {
  it("normalizes the phone, sends the email and an open batch of the chosen location", async () => {
    routes["POST /api/v1/candidates"] = () => ({ status: 201, body: { id: "new-id" } });
    const { dlg, onOpenProfile } = await openCreate();
    const batchSel = await within(dlg).findByLabelText("Batch (optional)");
    // Cancelled batches are not offered.
    expect(within(batchSel).getAllByRole("option").map((o) => o.textContent)).toEqual(["No batch", "Java · Dallas · Nov 2026"]);
    expect(lastGet("/api/v1/batches").url.searchParams.get("locationId")).toBe(LOC);
    fireEvent.change(batchSel, { target: { value: B1 } });
    fireEvent.change(within(dlg).getByLabelText("Phone (optional)"), { target: { value: "+1 (469) 555-0199" } });
    fireEvent.change(within(dlg).getByLabelText("Personal email (optional)"), { target: { value: " ravi@example.com " } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    await waitFor(() => expect(onOpenProfile).toHaveBeenCalledWith("new-id"));
    expect(writes()[0]!.body).toEqual({
      firstName: "Ravi", lastName: "Kumar", technologyId: TECH, locationId: LOC, phone: "+14695550199", email: "ravi@example.com", batchId: B1,
    });
  });

  it("refuses a phone without a country code before sending", async () => {
    const { dlg } = await openCreate();
    fireEvent.change(within(dlg).getByLabelText("Phone (optional)"), { target: { value: "469 555 0199" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    expect(writes()).toHaveLength(0);
    const phone = within(dlg).getByLabelText("Phone (optional)");
    expect(phone).toHaveAttribute("aria-invalid", "true");
    // Focus after a failed submit is HANDOFF task 7 (older dialogs), not asserted here.
    expect(phone).toHaveAccessibleDescription(expect.stringContaining("Include the country code"));
  });

  it("on a likely duplicate shows only team and contact, links a readable profile, and creates on confirmation", async () => {
    routes["POST /api/v1/candidates"] = (_u, b) => ((b as { confirmDuplicate?: boolean }).confirmDuplicate
      ? { status: 201, body: { id: "new-id" } }
      : problem(409, { title: "Conflict", detail: "possible_duplicate" }));
    routes["POST /api/v1/candidates/duplicate-check"] = () => ({ body: { duplicates: [
      { candidateId: OTHER, team: "Team Rohit", contact: "Rohit Lead", matchedOn: ["phone"] },
      { candidateId: null, team: "Team Vikram", contact: "Vikram Lead", matchedOn: ["email", "phone"] },
    ] } });
    const { dlg, onOpenProfile } = await openCreate();
    fireEvent.change(within(dlg).getByLabelText("Phone (optional)"), { target: { value: "+14695550001" } });
    fireEvent.change(within(dlg).getByLabelText("Personal email (optional)"), { target: { value: "asha@example.com" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));

    const warn = await within(dlg).findByRole("alert");
    expect(warn).toHaveTextContent("Possible duplicate.");
    expect(warn).toHaveTextContent("Same phone: Team Rohit, contact Rohit Lead");
    expect(warn).toHaveTextContent("Same email and phone: Team Vikram, contact Vikram Lead");
    expect(within(warn).getAllByRole("button", { name: "Open existing profile" })).toHaveLength(1);
    expect(writes().map((w) => [w.path, w.body])).toEqual([
      ["/api/v1/candidates", { firstName: "Ravi", lastName: "Kumar", technologyId: TECH, locationId: LOC, phone: "+14695550001", email: "asha@example.com" }],
      ["/api/v1/candidates/duplicate-check", { firstName: "Ravi", lastName: "Kumar", phone: "+14695550001", email: "asha@example.com" }],
    ]);

    fireEvent.click(within(dlg).getByRole("button", { name: "Create anyway" }));
    await waitFor(() => expect(onOpenProfile).toHaveBeenCalledWith("new-id"));
    expect(writes()[2]!.body).toMatchObject({ confirmDuplicate: true });
  });

  it("opens the existing readable profile from the warning", async () => {
    routes["POST /api/v1/candidates"] = () => problem(409, { detail: "possible_duplicate" });
    routes["POST /api/v1/candidates/duplicate-check"] = () => ({ body: { duplicates: [{ candidateId: OTHER, team: "Team Rohit", contact: "l1", matchedOn: ["email"] }] } });
    const { dlg, onOpenProfile } = await openCreate();
    fireEvent.change(within(dlg).getByLabelText("Personal email (optional)"), { target: { value: "asha@example.com" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    fireEvent.click(await within(dlg).findByRole("button", { name: "Open existing profile" }));
    expect(onOpenProfile).toHaveBeenCalledWith(OTHER);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("editing the phone after a warning clears it (a new check is needed)", async () => {
    routes["POST /api/v1/candidates"] = () => problem(409, { detail: "possible_duplicate" });
    routes["POST /api/v1/candidates/duplicate-check"] = () => ({ body: { duplicates: [{ candidateId: null, team: "Team Vikram", contact: "l3", matchedOn: ["phone"] }] } });
    const { dlg } = await openCreate();
    fireEvent.change(within(dlg).getByLabelText("Phone (optional)"), { target: { value: "+14695550001" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    await within(dlg).findByRole("button", { name: "Create anyway" });
    fireEvent.change(within(dlg).getByLabelText("Phone (optional)"), { target: { value: "+14695550002" } });
    expect(within(dlg).queryByText(/Possible duplicate/)).not.toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Create candidate" })).toBeInTheDocument();
  });
});

describe("Candidate profile: batch and timeline", () => {
  const renderProfile = () => wrap(<CandidateProfile id={CID} me={RECRUITER} onBack={() => undefined} />);

  it("shows the batch and the timeline newest first, with older pages on demand", async () => {
    routes[`GET /api/v1/candidates/${CID}/timeline`] = (u) => (u.searchParams.get("cursor") === "3"
      ? { body: { items: [ev("2", "candidate.created", { to: "in_training", actor: null })], nextCursor: null } }
      : { body: { items: [
        ev("5", "candidate.status_changed", { from: "active", to: "on_hold" }),
        ev("4", "candidate.batch_changed", { ref: { type: "batch", id: B1, label: "Java · Dallas · Nov 2026" } }),
        ev("3", "submission.created", { ref: { type: "submission", id: "s1", label: null }, to: "submitted" }),
      ], nextCursor: "3" } });
    renderProfile();
    await screen.findByRole("heading", { level: 1, name: "Asha Iyer" });
    expect(screen.getByText("Java · Dallas · Nov 2026", { selector: "dd" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Candidate activity, newest first" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Status changed from Active to On hold · .* · Lead One$/),
      expect.stringMatching(/^Added to batch Java · Dallas · Nov 2026 · /),
      expect.stringMatching(/^Submission logged · /),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Show older activity" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));
    expect(within(list).getAllByRole("listitem")[3]).toHaveTextContent(/^Candidate created · [^·]+$/);
    expect(screen.queryByRole("button", { name: "Show older activity" })).not.toBeInTheDocument();
  });

  it("explains an empty timeline and a failed load", async () => {
    const { unmount } = renderProfile();
    expect(await screen.findByText("No activity recorded yet.")).toBeInTheDocument();
    unmount();
    routes[`GET /api/v1/candidates/${CID}/timeline`] = () => problem(500, { title: "Internal Server Error" });
    renderProfile();
    const section = (await screen.findByRole("heading", { name: "Timeline" })).closest("section")!;
    expect(await within(section).findByRole("alert")).toHaveTextContent("Internal Server Error");
  });

  it("moves the candidate to another open batch or out of it from Edit profile", async () => {
    routes[`PATCH /api/v1/candidates/${CID}`] = () => ({ body: { id: CID } });
    routes["GET /api/v1/batches"] = () => ({ body: { items: [...BATCHES, batch("99999999-9999-4999-8999-999999999999", "Java · Dallas · Dec 2026")], canCreate: false } });
    renderProfile();
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dlg = screen.getByRole("dialog", { name: "Edit Asha Iyer" });
    const sel = within(dlg).getByLabelText("Batch");
    await within(sel).findByRole("option", { name: "Java · Dallas · Dec 2026" });
    expect(sel).toHaveValue(B1);
    expect(within(sel).queryByRole("option", { name: "Java · Dallas · Jan 2026" })).not.toBeInTheDocument();
    fireEvent.change(sel, { target: { value: "" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes()[0]!.body).toEqual({ batchId: null });
  });

  it("explains a batch the server refuses", async () => {
    routes[`PATCH /api/v1/candidates/${CID}`] = () => problem(422, { title: "Unprocessable Entity", detail: "batch_not_allowed" });
    routes[`GET /api/v1/candidates/${CID}`] = () => ({ body: { ...PROFILE, batch: null } });
    renderProfile();
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dlg = screen.getByRole("dialog", { name: "Edit Asha Iyer" });
    const sel = within(dlg).getByLabelText("Batch");
    await within(sel).findByRole("option", { name: "Java · Dallas · Nov 2026" });
    fireEvent.change(sel, { target: { value: B1 } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save changes" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("That batch is at another location or no longer open.");
    expect(writes()[0]!.body).toEqual({ batchId: B1 });
  });
});
