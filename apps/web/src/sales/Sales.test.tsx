import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilities, type Role } from "@eureka/shared";
import { setCsrf, type Me } from "../api";
import { Shell } from "../App";
import { CandidateProfile } from "./CandidateProfile";
import { CandidatesPage } from "./CandidatesPage";
import { HotListPage } from "./HotListPage";
import { DUPLICATE_WARNING } from "./LogSubmissionDialog";

// ---- fixtures (shapes from apps/api/src/modules/candidates/candidates.service.ts) ---------------

const meFor = (role: Role): Me => ({
  id: "u-me", email: "me@eureka.example", displayName: "Test User", csrfToken: "tok",
  roles: [{ key: role, label: role, locationId: null }],
  capabilities: capabilities({ userId: "u-me", roles: [{ role, locationId: "loc" }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [] }),
});
const RECRUITER = meFor("recruiter");
const LEAD = meFor("lead");
const LOC_ADMIN = meFor("location_ops_admin");
const ORG_ADMIN = meFor("org_admin");

const CID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TECH = "33333333-3333-4333-8333-333333333333";
const LOC = "44444444-4444-4444-8444-444444444444";
const CLIENT = "55555555-5555-4555-8555-555555555555";
const VENDOR = "66666666-6666-4666-8666-666666666666";
const LOOKUPS = {
  technologies: [{ id: TECH, name: "Java" }], clients: [{ id: CLIENT, name: "Northwind Financial" }],
  vendors: [{ id: VENDOR, name: "Contoso Staffing" }], locations: [{ id: LOC, name: "Dallas" }], coaches: [],
};

const cand = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, technology: "Java", status: "active", visibility: "team", priority: "P2",
  team: { id: "t1", name: "Team Rohit" }, recruiter: { id: "u-me", name: "Test User" }, location: { id: LOC, name: "Dallas" },
  marketingStartDate: "2026-09-01", daysInMarket: 28, technicalRating: null, phone: "+14695550001", phoneMasked: false, ...extra,
});
const OWN = cand(CID, "Asha Iyer", { canOpenProfile: true });
const FOREIGN = cand(OTHER, "Divya Menon", {
  visibility: "all_teams", team: { id: "t2", name: "Team Anjali" }, recruiter: null,
  phone: "•••-•••-42", phoneMasked: true, canOpenProfile: false,
});
const PROFILE = { ...cand(CID, "Asha Iyer"), dobMasked: "•• / •• / 1994", rowVersion: 3 };

// ---- fetch router ------------------------------------------------------------------------------

type Reply = { status?: number; body?: unknown };
type Handler = (url: URL, body: unknown) => Reply;
interface Call { method: string; path: string; url: URL; body: unknown; headers: Record<string, string> }
let routes: Record<string, Handler>;
let calls: Call[];

const problem = (status: number, extra: Record<string, unknown> = {}): Reply =>
  ({ status, body: { type: "about:blank", title: "Error", status, ...extra } });

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  routes = {
    "GET /api/v1/hotlist/views": () => ({ body: { items: [] } }),
    "GET /api/v1/hotlist": (u) => ({ body: { items: u.searchParams.get("cursor") ? [FOREIGN] : [OWN, FOREIGN], nextCursor: u.searchParams.get("cursor") ? null : OTHER } }),
    "GET /api/v1/candidates": () => ({ body: { items: [OWN], nextCursor: null } }),
    [`GET /api/v1/candidates/${CID}`]: () => ({ body: PROFILE }),
    "GET /api/v1/lookups": () => ({ body: LOOKUPS }),
    [`GET /api/v1/candidates/${CID}/timeline`]: () => ({ body: { items: [], nextCursor: null } }),
    "GET /api/v1/batches": () => ({ body: { items: [], canCreate: false } }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, url, body, headers: (init.headers ?? {}) as Record<string, string> });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 599 });
    const r = h(url, body);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { "content-type": "application/problem+json" } });
  });
});
afterEach(() => vi.restoreAllMocks());

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={client()}>{ui}</QueryClientProvider>);
const writes = () => calls.filter((c) => c.method !== "GET");
const lastGet = (path: string) => calls.filter((c) => c.method === "GET" && c.path === path).at(-1)!;
const rowOf = async (name: string) => (await screen.findByText(name, { selector: "b" })).closest("tr")!;

// ---- Hot List ----------------------------------------------------------------------------------

describe("Hot List", () => {
  it("masks other teams' phones with a hidden explanation, labels Open to all teams, never shows DOB", async () => {
    wrap(<HotListPage me={RECRUITER} onOpenProfile={() => undefined} />);
    const foreign = await rowOf("Divya Menon");
    // The recruiter may change status, so the first column holds the row-selection checkbox.
    const phoneCell = within(foreign).getAllByRole("cell")[8]!;
    expect(phoneCell).toHaveClass("masked");
    expect(within(phoneCell).getByText("•••-•••-42")).toHaveAttribute("aria-hidden", "true");
    expect(within(phoneCell).getByText(/Phone hidden, ends in 42\. Not your team's candidate\./)).toHaveClass("sr-only");
    expect(within(foreign).getByText("Open to all teams")).toHaveClass("badge");
    expect(within(await rowOf("Asha Iyer")).getByText("+14695550001")).toBeInTheDocument();
    expect(screen.queryByText(/date of birth|1994/i)).not.toBeInTheDocument();
    expect(screen.getByText("2 candidates on page 1, more on the next page.")).toHaveAttribute("role", "status");
  });

  it("links only openable profiles and explains the others", async () => {
    const open = vi.fn();
    wrap(<HotListPage me={RECRUITER} onOpenProfile={open} />);
    const foreign = await rowOf("Divya Menon");
    expect(within(foreign).queryByRole("button", { name: /Open profile/ })).not.toBeInTheDocument();
    expect(within(foreign).getByText("Profile belongs to another team")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open profile of Asha Iyer" }));
    expect(open).toHaveBeenCalledWith(CID);
  });

  it("offers no profile links to users without candidate:read", async () => {
    wrap(<HotListPage me={ORG_ADMIN} onOpenProfile={() => undefined} />);
    await rowOf("Asha Iyer");
    expect(screen.queryByRole("button", { name: /Open profile/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Profile belongs to another team")).not.toBeInTheDocument();
  });

  it("filters by name, technology, status and visibility and resets to page 1", async () => {
    wrap(<HotListPage me={RECRUITER} />);
    await rowOf("Asha Iyer");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastGet("/api/v1/hotlist").url.searchParams.get("cursor")).toBe(OTHER));
    expect(screen.getByText("Page 2")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "on_hold" } });
    fireEvent.change(screen.getByLabelText("Visibility"), { target: { value: "all_teams" } });
    fireEvent.change(screen.getByLabelText("Search name"), { target: { value: " divya " } });
    fireEvent.change(screen.getByLabelText("Technology"), { target: { value: "Java" } });
    await waitFor(() => {
      const p = lastGet("/api/v1/hotlist").url.searchParams;
      expect(p.get("search")).toBe("divya");
      expect(p.get("technology")).toBe("Java");
    });
    const p = lastGet("/api/v1/hotlist").url.searchParams;
    expect(p.get("status")).toBe("on_hold");
    expect(p.get("visibility")).toBe("all_teams");
    expect(p.get("cursor")).toBeNull();
    expect(screen.getByText("Page 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect([...lastGet("/api/v1/hotlist").url.searchParams.keys()]).toEqual(["limit"]));
  });

  it("opens a quick-view drawer that closes on Escape and returns focus", async () => {
    const open = vi.fn();
    wrap(<HotListPage me={RECRUITER} onOpenProfile={open} />);
    const trigger = within(await rowOf("Divya Menon")).getByRole("button", { name: "Quick view of Divya Menon" });
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "Divya Menon" });
    expect(drawer).toHaveFocus();
    expect(within(drawer).getByText("Team Anjali")).toBeInTheDocument();
    expect(within(drawer).getByText(/Profile belongs to another team/)).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "Open full profile" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(within(await rowOf("Asha Iyer")).getByRole("button", { name: "Quick view of Asha Iyer" }));
    const own = screen.getByRole("dialog", { name: "Asha Iyer" });
    expect(within(own).getByRole("button", { name: "Open full profile" })).toHaveFocus();
    fireEvent.click(within(own).getByRole("button", { name: "Open full profile" }));
    expect(open).toHaveBeenCalledWith(CID);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the rate-limit message from the server", async () => {
    routes["GET /api/v1/hotlist"] = () => problem(429, { title: "Too Many Requests", detail: "Too many Hot List requests; try again in a minute" });
    wrap(<HotListPage me={RECRUITER} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many Hot List requests; try again in a minute");
  });
});

// ---- Candidates + create -----------------------------------------------------------------------

describe("Candidates list and create", () => {
  it("shows New candidate only with candidate:create", async () => {
    const { unmount } = wrap(<CandidatesPage me={LOC_ADMIN} />);
    await rowOf("Asha Iyer");
    expect(screen.queryByRole("button", { name: "New candidate" })).not.toBeInTheDocument();
    unmount();
    wrap(<CandidatesPage me={RECRUITER} />);
    expect(await screen.findByRole("button", { name: "New candidate" })).toBeInTheDocument();
  });

  it("validates before sending, maps 422 field errors, then creates and opens the profile", async () => {
    const open = vi.fn();
    let n = 0;
    routes["POST /api/v1/candidates"] = () => (++n === 1
      ? problem(422, { title: "Validation failed", errors: [{ path: "phone", message: "E.164 format, e.g. +14695550142" }] })
      : { status: 201, body: { id: "new-id" } });
    wrap(<CandidatesPage me={RECRUITER} onOpenProfile={open} />);
    fireEvent.click(await screen.findByRole("button", { name: "New candidate" }));
    const dlg = screen.getByRole("dialog", { name: "New candidate" });
    expect(within(dlg).getByLabelText("First name")).toHaveFocus();

    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    expect(writes()).toHaveLength(0);
    expect(within(dlg).getByLabelText("First name")).toHaveAttribute("aria-invalid", "true");
    expect(within(dlg).getByLabelText("First name")).toHaveAccessibleDescription("Enter a first name.");
    expect(await within(dlg).findByRole("option", { name: "Java" })).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Technology")).toHaveAttribute("aria-invalid", "true");
    expect(within(dlg).getByLabelText("Technology")).toHaveAccessibleDescription("Choose a technology.");
    expect(within(dlg).getByLabelText("First name")).toHaveFocus();

    fireEvent.change(within(dlg).getByLabelText("First name"), { target: { value: "Ravi" } });
    fireEvent.change(within(dlg).getByLabelText("Last name"), { target: { value: "Kumar" } });
    fireEvent.change(within(dlg).getByLabelText("Phone (optional)"), { target: { value: "+14695550199" } });
    fireEvent.change(within(dlg).getByLabelText("Technology"), { target: { value: TECH } });
    fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: LOC } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));

    const phone = within(dlg).getByLabelText("Phone (optional)");
    await waitFor(() => expect(phone).toHaveAttribute("aria-invalid", "true"));
    expect(phone).toHaveAccessibleDescription(expect.stringContaining("E.164 format, e.g. +14695550142"));
    expect(within(dlg).getByRole("alert")).toHaveTextContent("Some fields need attention");
    expect(writes()[0]!.body).toEqual({ firstName: "Ravi", lastName: "Kumar", phone: "+14695550199", technologyId: TECH, locationId: LOC });
    expect(writes()[0]!.headers["x-csrf-token"]).toBe("tok");

    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("new-id"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains a 403 when creating in a team outside the user's scope", async () => {
    routes["POST /api/v1/candidates"] = () => problem(403, { detail: "Not permitted to create candidates in this team" });
    wrap(<CandidatesPage me={RECRUITER} />);
    fireEvent.click(await screen.findByRole("button", { name: "New candidate" }));
    const dlg = screen.getByRole("dialog", { name: "New candidate" });
    fireEvent.change(within(dlg).getByLabelText("First name"), { target: { value: "A" } });
    fireEvent.change(within(dlg).getByLabelText("Last name"), { target: { value: "B" } });
    await within(dlg).findByRole("option", { name: "Dallas" });
    fireEvent.change(within(dlg).getByLabelText("Technology"), { target: { value: TECH } });
    fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: LOC } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("You can't create candidates in that team.");
  });

  it("falls back to known locations and typed IDs when the lookup list is unavailable", async () => {
    routes["GET /api/v1/lookups"] = () => problem(503, { title: "Unavailable" });
    routes["POST /api/v1/candidates"] = () => ({ status: 201, body: { id: "new-id" } });
    wrap(<CandidatesPage me={RECRUITER} />);
    fireEvent.click(await screen.findByRole("button", { name: "New candidate" }));
    const dlg = screen.getByRole("dialog", { name: "New candidate" });
    await waitFor(() => expect(within(dlg).getByLabelText("Technology").tagName).toBe("INPUT"));
    expect(within(dlg).getByLabelText("Technology")).toHaveAccessibleDescription(expect.stringContaining("paste the ID"));
    // Locations seen on the list are offered, with a typed ID as the last resort.
    fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: "__other__" } });
    fireEvent.change(within(dlg).getByLabelText("Location ID"), { target: { value: LOC } });
    fireEvent.change(within(dlg).getByLabelText("First name"), { target: { value: "A" } });
    fireEvent.change(within(dlg).getByLabelText("Last name"), { target: { value: "B" } });
    fireEvent.change(within(dlg).getByLabelText("Technology"), { target: { value: TECH } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    await waitFor(() => expect(writes()[0]!.body).toEqual({ firstName: "A", lastName: "B", technologyId: TECH, locationId: LOC }));
  });
});

// ---- Profile -----------------------------------------------------------------------------------

const renderProfile = (me: Me, onBack = () => undefined) => wrap(<CandidateProfile id={CID} me={me} onBack={onBack} backLabel="Back to Hot List" />);

describe("Candidate profile", () => {
  it("shows the profile with actions for a recruiter only", async () => {
    renderProfile(RECRUITER);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Asha Iyer" });
    await waitFor(() => expect(h1).toHaveFocus());
    expect(screen.getByText("•• / •• / 1994")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log submission" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to On hold" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rating (1 to 5)")).not.toBeInTheDocument();
  });

  it("lets a lead toggle Open to all teams, without recruiter-only actions", async () => {
    routes[`PUT /api/v1/candidates/${CID}/visibility`] = (_u, b) => ({ body: { id: CID, ...(b as object) } });
    renderProfile(LEAD);
    const sw = await screen.findByRole("switch", { name: "Open to all teams" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Log submission" })).toBeInTheDocument(); // leads can submit (sales line)
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Asha Iyer is now open to all teams."));
    expect(writes()[0]).toMatchObject({ method: "PUT", body: { visibility: "all_teams" } });
  });

  it("lets a location admin set the technical rating and nothing else", async () => {
    routes[`PUT /api/v1/candidates/${CID}/technical-rating`] = (_u, b) => ({ body: { id: CID, technicalRating: (b as { rating: number }).rating } });
    renderProfile(LOC_ADMIN);
    const sel = await screen.findByLabelText("Rating (1 to 5)");
    expect(screen.queryByRole("button", { name: "Edit profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log submission" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.change(sel, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rating" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Technical rating set to 4 of 5."));
    expect(writes()[0]!.body).toEqual({ rating: 4 });
  });

  it("explains a 404 (another team's profile) and focuses the heading", async () => {
    routes[`GET /api/v1/candidates/${CID}`] = () => problem(404, { title: "Not Found" });
    const back = vi.fn();
    renderProfile(RECRUITER, back);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Candidate not available" });
    await waitFor(() => expect(h1).toHaveFocus());
    expect(screen.getByRole("alert")).toHaveTextContent("belongs to another team");
    fireEvent.click(screen.getByRole("button", { name: "← Back to Hot List" }));
    expect(back).toHaveBeenCalled();
  });

  it("changes status, and explains a rejected transition", async () => {
    let n = 0;
    routes[`POST /api/v1/candidates/${CID}/transition`] = () => (++n === 1 ? { body: { id: CID, status: "on_hold" } } : problem(422, { title: "Unprocessable", detail: "Request violates a data rule" }));
    renderProfile(RECRUITER);
    fireEvent.click(await screen.findByRole("button", { name: "Move to On hold" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Status changed to On hold."));
    expect(writes()[0]!.body).toEqual({ to: "on_hold" });
    fireEvent.click(screen.getByRole("button", { name: "Move to Stopped" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That status change isn't allowed");
  });

  it("confirms before terminating", async () => {
    routes[`POST /api/v1/candidates/${CID}/transition`] = () => ({ body: { id: CID, status: "terminated" } });
    renderProfile(RECRUITER);
    fireEvent.click(await screen.findByRole("button", { name: "Terminate…" }));
    const dlg = screen.getByRole("dialog", { name: "Terminate Asha Iyer?" });
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(dlg).getByRole("button", { name: "Terminate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes()[0]!.body).toEqual({ to: "terminated" });
  });

  it("edits only changed profile fields and maps 422 errors to fields", async () => {
    let n = 0;
    routes[`PATCH /api/v1/candidates/${CID}`] = () => (++n === 1
      ? problem(422, { title: "Validation failed", errors: [{ path: "marketingEmail", message: "Invalid email" }] })
      : { body: { id: CID } });
    renderProfile(RECRUITER);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dlg = screen.getByRole("dialog", { name: "Edit Asha Iyer" });
    expect(within(dlg).getByLabelText("Priority")).toHaveValue("P2");
    expect(within(dlg).getByLabelText("Marketing start date")).toHaveValue("2026-09-01");

    fireEvent.click(within(dlg).getByRole("button", { name: "Save changes" }));
    expect(within(dlg).getByRole("alert")).toHaveTextContent("Nothing changed.");
    expect(writes()).toHaveLength(0);

    fireEvent.change(within(dlg).getByLabelText("Priority"), { target: { value: "P1" } });
    fireEvent.change(within(dlg).getByLabelText("Marketing email"), { target: { value: "asha@mkt.example" } });
    fireEvent.change(within(dlg).getByLabelText("In-person interviews"), { target: { value: "no" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save changes" }));
    const email = within(dlg).getByLabelText("Marketing email");
    await waitFor(() => expect(email).toHaveAttribute("aria-invalid", "true"));
    expect(email).toHaveAccessibleDescription(expect.stringContaining("Invalid email"));
    expect(writes()[0]!.body).toEqual({ priority: "P1", marketingEmail: "asha@mkt.example", inPersonOk: false });

    fireEvent.click(within(dlg).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Profile saved.");
  });

  it("shows the in-person preference and marketing contacts the server returns, and prefills Edit profile", async () => {
    routes[`GET /api/v1/candidates/${CID}`] = () => ({
      body: { ...PROFILE, inPersonOk: false, marketingEmail: "asha@mkt.example", vitelNumber: "+19725550100" },
    });
    routes[`PATCH /api/v1/candidates/${CID}`] = () => ({ body: { id: CID } });
    renderProfile(RECRUITER);
    await screen.findByRole("heading", { level: 1, name: "Asha Iyer" });
    const facts = screen.getByRole("heading", { name: "Details" }).closest("section")!;
    expect(within(facts).getByText("In-person interviews").nextElementSibling).toHaveTextContent("Remote only");
    expect(within(facts).getByText("Marketing email").nextElementSibling).toHaveTextContent("asha@mkt.example");
    expect(within(facts).getByText("VITEL number").nextElementSibling).toHaveTextContent("+19725550100");

    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    const dlg = screen.getByRole("dialog", { name: "Edit Asha Iyer" });
    expect(within(dlg).getByLabelText("Marketing email")).toHaveValue("asha@mkt.example");
    expect(within(dlg).getByLabelText("VITEL number")).toHaveValue("+19725550100");
    expect(within(dlg).getByLabelText("Marketing email")).toHaveAccessibleDescription(expect.stringContaining("not removed"));
    expect(within(dlg).getByLabelText("In-person interviews")).toHaveValue("no");
    // Unchanged prefilled values are not sent.
    fireEvent.click(within(dlg).getByRole("button", { name: "Save changes" }));
    expect(within(dlg).getByRole("alert")).toHaveTextContent("Nothing changed.");
    fireEvent.change(within(dlg).getByLabelText("In-person interviews"), { target: { value: "yes" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes()[0]!.body).toEqual({ inPersonOk: true });
  });

  it("hides marketing contacts the server withholds and says when the in-person preference is not recorded", async () => {
    routes[`GET /api/v1/candidates/${CID}`] = () => ({ body: { ...PROFILE, inPersonOk: null } });
    renderProfile(RECRUITER);
    await screen.findByRole("heading", { level: 1, name: "Asha Iyer" });
    expect(screen.getByText("In-person interviews").nextElementSibling).toHaveTextContent("Not recorded");
    expect(screen.queryByText("Marketing email")).not.toBeInTheDocument();
    expect(screen.queryByText("VITEL number")).not.toBeInTheDocument();
  });

  it("follows the record's actions over capabilities when the server sends them", async () => {
    routes[`GET /api/v1/candidates/${CID}`] = () => ({
      body: { ...PROFILE, actions: { edit: false, transition: ["confirmation", "terminated"], visibility: true, rating: false, logSubmission: false } },
    });
    renderProfile(RECRUITER);
    await screen.findByRole("heading", { level: 1, name: "Asha Iyer" });
    // A recruiter's capabilities would show these; the record says no.
    expect(screen.queryByRole("button", { name: "Edit profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log submission" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to On hold" })).not.toBeInTheDocument();
    // ...and these follow the hints even without the capability.
    expect(screen.getByRole("switch", { name: "Open to all teams" })).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Status" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Move to Confirmation", "Terminate…"]);
    expect(screen.queryByLabelText("Rating (1 to 5)")).not.toBeInTheDocument();
  });

  it("hides every action when the record allows none", async () => {
    routes[`GET /api/v1/candidates/${CID}`] = () => ({
      body: { ...PROFILE, actions: { edit: false, transition: [], visibility: false, rating: false, logSubmission: false } },
    });
    renderProfile(LEAD);
    await screen.findByRole("heading", { level: 1, name: "Asha Iyer" });
    expect(screen.queryByRole("heading", { name: "Manage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit profile|Log submission|Move to/ })).not.toBeInTheDocument();
  });

  it("explains a 403 on an Open-to-all-teams candidate the user can see but not change", async () => {
    routes[`PATCH /api/v1/candidates/${CID}`] = () => problem(403, { detail: "Not permitted" });
    renderProfile(RECRUITER);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dlg = screen.getByRole("dialog", { name: "Edit Asha Iyer" });
    fireEvent.change(within(dlg).getByLabelText("Priority"), { target: { value: "P1" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save changes" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("belongs to a team outside your scope");
  });
});

// ---- Log submission ----------------------------------------------------------------------------

describe("Log submission", () => {
  const openDialog = async () => {
    renderProfile(RECRUITER);
    fireEvent.click(await screen.findByRole("button", { name: "Log submission" }));
    const dlg = screen.getByRole("dialog", { name: "Log submission for Asha Iyer" });
    await within(dlg).findByRole("option", { name: "Northwind Financial" });
    return dlg;
  };
  const fill = (dlg: HTMLElement) => {
    fireEvent.change(within(dlg).getByLabelText("Job title"), { target: { value: "Senior Java Developer" } });
    fireEvent.change(within(dlg).getByLabelText("Client"), { target: { value: CLIENT } });
    fireEvent.change(within(dlg).getByLabelText("Rate per hour (optional)"), { target: { value: "65" } });
  };

  it("validates, posts, and closes when there is no duplicate", async () => {
    routes["POST /api/v1/submissions"] = () => ({ status: 201, body: { id: "s1", duplicateWarning: false } });
    const dlg = await openDialog();
    fireEvent.click(within(dlg).getByRole("button", { name: "Log submission" }));
    expect(writes()).toHaveLength(0);
    expect(within(dlg).getByLabelText("Job title")).toHaveAccessibleDescription("Enter the job title.");
    expect(within(dlg).getByLabelText("Client")).toHaveAttribute("aria-invalid", "true");
    fill(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Log submission" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes()[0]).toMatchObject({ path: "/api/v1/submissions", body: { candidateId: CID, jobTitle: "Senior Java Developer", clientId: CLIENT, rate: 65 } });
    expect(writes()[0]!.body).not.toHaveProperty("vendorId");
    expect(screen.getByRole("status")).toHaveTextContent("Submission logged.");
    expect(screen.queryByText(DUPLICATE_WARNING)).not.toBeInTheDocument();
  });

  it("sends the vendor picked from the lookup list", async () => {
    routes["POST /api/v1/submissions"] = () => ({ status: 201, body: { id: "s3", duplicateWarning: false } });
    const dlg = await openDialog();
    fill(dlg);
    expect(within(within(dlg).getByLabelText("Vendor (optional)")).getAllByRole("option").map((o) => o.textContent)).toEqual(["No vendor", "Contoso Staffing"]);
    fireEvent.change(within(dlg).getByLabelText("Vendor (optional)"), { target: { value: VENDOR } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Log submission" }));
    await waitFor(() => expect(writes()[0]!.body).toMatchObject({ clientId: CLIENT, vendorId: VENDOR }));
  });

  it("shows the duplicate warning in the dialog and keeps it on the page", async () => {
    routes["POST /api/v1/submissions"] = () => ({ status: 201, body: { id: "s2", duplicateWarning: true } });
    const dlg = await openDialog();
    fill(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Log submission" }));
    const done = await screen.findByRole("dialog", { name: "Submission logged" });
    expect(within(done).getByRole("alert")).toHaveTextContent(DUPLICATE_WARNING);
    expect(within(done).getByRole("button", { name: "Done" })).toHaveFocus();
    fireEvent.click(within(done).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(DUPLICATE_WARNING);
  });

  it("shows a 409 conflict as a duplicate warning and keeps the form", async () => {
    routes["POST /api/v1/submissions"] = () => problem(409, { title: "Conflict", detail: "A conflicting record exists" });
    const dlg = await openDialog();
    fill(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Log submission" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("A conflicting submission already exists");
    expect(within(dlg).getByText(DUPLICATE_WARNING)).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Job title")).toHaveValue("Senior Java Developer");
  });

  it("maps 422 errors to the matching fields", async () => {
    routes["POST /api/v1/submissions"] = () => problem(422, { title: "Validation failed", errors: [{ path: "jobTitle", message: "String must contain at most 160 character(s)" }] });
    const dlg = await openDialog();
    fill(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Log submission" }));
    const title = within(dlg).getByLabelText("Job title");
    await waitFor(() => expect(title).toHaveAttribute("aria-invalid", "true"));
    expect(title).toHaveAccessibleDescription("String must contain at most 160 character(s)");
  });

  it("is hidden without submission:create", async () => {
    renderProfile(LOC_ADMIN);
    await screen.findByRole("heading", { level: 1, name: "Asha Iyer" });
    expect(screen.queryByRole("button", { name: "Log submission" })).not.toBeInTheDocument();
  });
});

// ---- Focus after a failed submit ---------------------------------------------------------------
// The user presses the submit button (focus on it), so each test focuses it before clicking.

const submitWith = (dlg: HTMLElement, name: string) => {
  const btn = within(dlg).getByRole("button", { name });
  btn.focus();
  fireEvent.click(btn);
};

describe("Focus after a failed submit: New candidate", () => {
  const openCreate = async () => {
    wrap(<CandidatesPage me={RECRUITER} />);
    fireEvent.click(await screen.findByRole("button", { name: "New candidate" }));
    const dlg = screen.getByRole("dialog", { name: "New candidate" });
    await within(dlg).findByRole("option", { name: "Dallas" });
    return dlg;
  };
  const fillAll = (dlg: HTMLElement) => {
    fireEvent.change(within(dlg).getByLabelText("First name"), { target: { value: "Ravi" } });
    fireEvent.change(within(dlg).getByLabelText("Last name"), { target: { value: "Kumar" } });
    fireEvent.change(within(dlg).getByLabelText("Technology"), { target: { value: TECH } });
    fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: LOC } });
  };

  it("moves focus to the first invalid field of this round, not a stale one", async () => {
    const dlg = await openCreate();
    fireEvent.change(within(dlg).getByLabelText("First name"), { target: { value: "Ravi" } });
    submitWith(dlg, "Create candidate");
    const last = within(dlg).getByLabelText("Last name");
    await waitFor(() => expect(last).toHaveFocus());
    expect(last).toHaveAccessibleDescription("Enter a last name.");

    // Fix everything but the location: focus skips the fields that were invalid last round.
    fireEvent.change(last, { target: { value: "Kumar" } });
    fireEvent.change(within(dlg).getByLabelText("Technology"), { target: { value: TECH } });
    submitWith(dlg, "Create candidate");
    const loc = within(dlg).getByLabelText("Location");
    await waitFor(() => expect(loc).toHaveFocus());
    expect(loc).toHaveAccessibleDescription("Choose a location.");
    expect(writes()).toHaveLength(0);
  });

  it("focuses the field the server rejected (422) and announces the summary", async () => {
    routes["POST /api/v1/candidates"] = () => problem(422, { title: "Validation failed", errors: [{ path: "phone", message: "E.164 format" }] });
    const dlg = await openCreate();
    fillAll(dlg);
    fireEvent.change(within(dlg).getByLabelText("Phone (optional)"), { target: { value: "+14695550199" } });
    submitWith(dlg, "Create candidate");
    const phone = within(dlg).getByLabelText("Phone (optional)");
    await waitFor(() => expect(phone).toHaveFocus());
    expect(within(dlg).getByRole("alert")).toHaveTextContent("Some fields need attention");
  });

  it("focuses the announced error when the server refuses without field errors (403)", async () => {
    routes["POST /api/v1/candidates"] = () => problem(403, { detail: "Not permitted" });
    const dlg = await openCreate();
    fillAll(dlg);
    submitWith(dlg, "Create candidate");
    const alert = await within(dlg).findByRole("alert");
    expect(alert).toHaveTextContent("You can't create candidates in that team.");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(dlg).toContainElement(document.activeElement as HTMLElement);
  });
});

describe("Focus after a failed submit: Log submission", () => {
  const openLog = async () => {
    renderProfile(RECRUITER);
    fireEvent.click(await screen.findByRole("button", { name: "Log submission" }));
    const dlg = screen.getByRole("dialog", { name: "Log submission for Asha Iyer" });
    await within(dlg).findByRole("option", { name: "Northwind Financial" });
    return dlg;
  };
  const fillAll = (dlg: HTMLElement) => {
    fireEvent.change(within(dlg).getByLabelText("Job title"), { target: { value: "Senior Java Developer" } });
    fireEvent.change(within(dlg).getByLabelText("Client"), { target: { value: CLIENT } });
  };

  it("moves focus to the first invalid field after client-side validation", async () => {
    const dlg = await openLog();
    fireEvent.change(within(dlg).getByLabelText("Job title"), { target: { value: "Senior Java Developer" } });
    fireEvent.change(within(dlg).getByLabelText("Rate per hour (optional)"), { target: { value: "5000" } });
    submitWith(dlg, "Log submission");
    const clientSel = within(dlg).getByLabelText("Client");
    await waitFor(() => expect(clientSel).toHaveFocus());
    expect(clientSel).toHaveAccessibleDescription("Choose a client.");

    fireEvent.change(clientSel, { target: { value: CLIENT } });
    submitWith(dlg, "Log submission");
    const rate = within(dlg).getByLabelText("Rate per hour (optional)");
    await waitFor(() => expect(rate).toHaveFocus());
    expect(rate).toHaveAccessibleDescription("Enter an hourly rate between 0 and 1000.");
    expect(writes()).toHaveLength(0);
  });

  it("focuses the field the server rejected (422)", async () => {
    routes["POST /api/v1/submissions"] = () => problem(422, { title: "Validation failed", errors: [{ path: "jobTitle", message: "Too long" }] });
    const dlg = await openLog();
    fillAll(dlg);
    submitWith(dlg, "Log submission");
    const title = within(dlg).getByLabelText("Job title");
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveAccessibleDescription("Too long");
    expect(within(dlg).getByRole("alert")).toHaveTextContent("Some fields need attention");
  });

  it("focuses the announced error on a 409 conflict", async () => {
    routes["POST /api/v1/submissions"] = () => problem(409, { title: "Conflict" });
    const dlg = await openLog();
    fillAll(dlg);
    submitWith(dlg, "Log submission");
    const alert = await within(dlg).findByRole("alert");
    expect(alert).toHaveTextContent("A conflicting submission already exists");
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("focuses the announced error when the network fails", async () => {
    routes["POST /api/v1/submissions"] = () => problem(500, { title: "Internal error", detail: "Something broke on our side." });
    const dlg = await openLog();
    fillAll(dlg);
    submitWith(dlg, "Log submission");
    const alert = await within(dlg).findByRole("alert");
    expect(alert).toHaveTextContent("Something broke on our side.");
    await waitFor(() => expect(alert).toHaveFocus());
  });
});

// ---- Shell integration -------------------------------------------------------------------------

describe("Sales navigation", () => {
  it("opens a profile from the Hot List and returns to the same filtered list", async () => {
    wrap(<Shell me={RECRUITER} onSignOut={() => undefined} />);
    await rowOf("Asha Iyer");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "active" } });
    const link = await screen.findByRole("button", { name: "Open profile of Asha Iyer" });
    link.focus();
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { level: 1, name: "Asha Iyer" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Hot List" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "← Back to Hot List" }));
    expect(screen.getByRole("table", { name: "Hot List" })).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveValue("active");
    await waitFor(() => expect(screen.getByRole("button", { name: "Open profile of Asha Iyer" })).toHaveFocus());
  });

  it("shows the Candidates screen from the sidebar", async () => {
    wrap(<Shell me={RECRUITER} onSignOut={() => undefined} />);
    fireEvent.click(within(screen.getByRole("complementary", { name: "Main navigation" })).getByRole("button", { name: "Candidates" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Candidates" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Candidates" })).toBeInTheDocument();
  });
});
