import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilities, type Role } from "@eureka/shared";
import { setCsrf, type Me } from "../api";
import { CandidateProfile } from "./CandidateProfile";
import { HotListPage } from "./HotListPage";

/** Eureka App 4 candidate fields in the UI: Hot List filters, profile fields, companies and documents. */
const meFor = (role: Role): Me => ({
  id: "u-me", email: "me@eureka.example", displayName: "Test User", csrfToken: "tok",
  roles: [{ key: role, label: role, locationId: null }],
  capabilities: capabilities({ userId: "u-me", roles: [{ role, locationId: "loc" }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], subtreeCoachedTeamIds: [] }),
});

const CID = "11111111-1111-4111-8111-111111111111";
const LOC = "44444444-4444-4444-8444-444444444444";
const CO1 = "77777777-7777-4777-8777-777777777777";
const CO2 = "88888888-8888-4888-8888-888888888888";
const LOOKUPS = { technologies: [], clients: [], vendors: [], implementationPartners: [], roles: [], locations: [{ id: LOC, name: "Dallas" }], coaches: [] };

const ROW = {
  id: CID, name: "Asha Iyer", technology: "Java", status: "active", statusLabel: "Active/Remote", visibility: "team", priority: "P2",
  team: { id: "t1", name: "Team Rohit" }, recruiter: { id: "u-me", name: "Test User" }, location: { id: LOC, name: "Dallas" },
  marketingStartDate: "2026-09-01", daysInMarket: 28, technicalRating: null, phone: "+14695550001", phoneMasked: false,
  canOpenProfile: true, stay: "remote", ghLocation: null, visaCategory: "h1b", documentsStatus: "partial", hasResume: true,
  teamAssignedAt: "2026-08-15T10:00:00.000Z",
};
const PROFILE = {
  ...ROW, dobMasked: null, rowVersion: 3, inPersonOk: null, eligibility: ["in_person"], marketingLocations: ["Dallas, TX"],
  linkedinUrl: "https://www.linkedin.com/in/asha", resumeUrl: null, confirmations: 2,
  companies: { everify: { id: CO1, name: "Eureka Payroll LLC" }, offerLetter: null, form1099: null },
  actions: { edit: true, transition: [], visibility: false, rating: false, logSubmission: false },
};

type Reply = { status?: number; body?: unknown };
interface Call { method: string; url: URL; body: unknown }
let routes: Record<string, (u: URL, b: unknown) => Reply>;
let calls: Call[];

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  routes = {
    "GET /api/v1/hotlist/views": () => ({ body: { items: [] } }),
    "GET /api/v1/hotlist": () => ({ body: { items: [ROW], nextCursor: null } }),
    "GET /api/v1/lookups": () => ({ body: LOOKUPS }),
    [`GET /api/v1/candidates/${CID}`]: () => ({ body: PROFILE }),
    [`GET /api/v1/candidates/${CID}/timeline`]: () => ({ body: { items: [], nextCursor: null } }),
    "GET /api/v1/batches": () => ({ body: { items: [], canCreate: false } }),
    "GET /api/v1/candidate-companies": () => ({ body: { items: [{ id: CO1, name: "Eureka Payroll LLC", location: "Dallas" }, { id: CO2, name: "Eureka Consulting", location: "Dallas" }] } }),
    [`PUT /api/v1/candidates/${CID}/compliance`]: () => ({ body: { id: CID } }),
    [`PATCH /api/v1/candidates/${CID}`]: () => ({ body: { id: CID } }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const h = routes[`${method} ${url.pathname}`];
    if (!h) return new Response(JSON.stringify({ detail: `unmocked ${method} ${url.pathname}` }), { status: 599 });
    const r = h(url, body);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => vi.restoreAllMocks());

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const lastHotlist = () => calls.filter((c) => c.method === "GET" && c.url.pathname === "/api/v1/hotlist").at(-1)!.url.searchParams;

describe("Hot List filters and columns", () => {
  it("sends the location, visa, documents, resume and stay filters", async () => {
    wrap(<HotListPage me={meFor("recruiter")} onOpenProfile={() => undefined} />);
    await screen.findByText("Asha Iyer", { selector: "b" });
    await waitFor(() => expect(screen.getByRole("option", { name: "Dallas" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: LOC } });
    fireEvent.change(screen.getByLabelText("Visa"), { target: { value: "h1b" } });
    fireEvent.change(screen.getByLabelText("Documents"), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText("Resume"), { target: { value: "yes" } });
    fireEvent.change(screen.getByLabelText("Stay"), { target: { value: "remote" } });
    await waitFor(() => expect(lastHotlist().get("stay")).toBe("remote"));
    const p = lastHotlist();
    expect([p.get("locationId"), p.get("visa"), p.get("documents"), p.get("resume")]).toEqual([LOC, "h1b", "none", "yes"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastHotlist().get("stay")).toBeNull());
  });

  it("shows the visa, the stay and the derived status label", async () => {
    wrap(<HotListPage me={meFor("recruiter")} onOpenProfile={() => undefined} />);
    const row = (await screen.findByText("Asha Iyer", { selector: "b" })).closest("tr")!;
    expect(within(row).getByText("H-1B")).toBeInTheDocument();
    expect(within(row).getByText("Remote")).toBeInTheDocument();
    expect(within(row).getByText("Active/Remote")).toBeInTheDocument();
  });
});

describe("profile", () => {
  it("shows the new fields and the companies section; compliance editors change a company", async () => {
    wrap(<CandidateProfile id={CID} me={meFor("hr")} onBack={() => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Asha Iyer" });
    expect(screen.getByText("Partially received")).toBeInTheDocument();
    expect(screen.getByText("Eureka Payroll LLC")).toBeInTheDocument();
    expect(screen.getByText("In person")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open profile" })).toHaveAttribute("href", "https://www.linkedin.com/in/asha");
    // HR has no edit hint from the server here: canEditCompliance is absent, so no button.
    expect(screen.queryByRole("button", { name: "Edit companies and documents" })).not.toBeInTheDocument();
  });

  it("the compliance dialog sends only what changed", async () => {
    routes[`GET /api/v1/candidates/${CID}`] = () => ({ body: { ...PROFILE, canEditCompliance: true } });
    wrap(<CandidateProfile id={CID} me={meFor("hr")} onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit companies and documents" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("option", { name: "Eureka Consulting (Dallas)" }).length).toBe(3));
    fireEvent.change(within(dialog).getByLabelText("Offer letter company"), { target: { value: CO2 } });
    fireEvent.change(within(dialog).getByLabelText("Documents status"), { target: { value: "complete" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ offerLetterCompanyId: CO2, documentsStatus: "complete" });
  });

  it("Edit profile sends stay, eligibility and visa changes", async () => {
    wrap(<CandidateProfile id={CID} me={meFor("recruiter")} onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "Guest house: Dallas" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText("Stay"), { target: { value: LOC } });
    fireEvent.click(within(dialog).getByLabelText("Hybrid"));
    fireEvent.change(within(dialog).getByLabelText("Visa (marketed)"), { target: { value: "gc_ead" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ ghLocation: LOC, eligibility: ["in_person", "hybrid"], visaCategory: "gc_ead" });
  });

  it("rejects a non-LinkedIn link before sending", async () => {
    wrap(<CandidateProfile id={CID} me={meFor("recruiter")} onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("LinkedIn"), { target: { value: "https://example.com/x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText("Use an https://linkedin.com/… link.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
