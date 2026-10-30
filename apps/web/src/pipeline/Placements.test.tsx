import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../App";
import { PlacementsPage } from "./PlacementsPage";
import { EMPTY_LOOKUPS, ROLE_LOOKUPS, meFor, mockApi, plc, problem, wrap, type Handler } from "./testkit";

const RECRUITER = meFor("recruiter");
const P1 = plc("p1");
const P2 = plc("p2", {
  candidate: { id: "c2", name: "Divya Menon" }, status: "joined", isFirstPlacement: true, vendor: null,
  allowedTransitions: ["bgc_failed"],
});
const FULL_P1 = {
  ...P1,
  contacts: [
    { kind: "vendor_poc", name: "Pat Lee", email: "pat@vendor.example", phone: null },
    { kind: "invoicing_poc", name: "Ivy Chen", email: null, phone: "+14695550123" },
  ],
  assignment: null,
};
const FULL_P2 = { ...P2, contacts: [], assignment: { assignmentNo: 2, startDate: "2026-09-01", endDate: null, endReason: null } };

let api: ReturnType<typeof mockApi>;
const base = (): Record<string, Handler> => ({
  "GET /api/v1/lookups": () => ({ body: EMPTY_LOOKUPS }),
  "GET /api/v1/placements": () => ({ body: { items: [P1, P2], nextCursor: null } }),
  "GET /api/v1/placements/p1": () => ({ body: FULL_P1 }),
  "GET /api/v1/placements/p2": () => ({ body: FULL_P2 }),
  // interview-alerts: the drawer's Contracts section.
  "GET /api/v1/placements/p1/contracts": () => ({ body: { items: [], canAdd: false } }),
  "GET /api/v1/placements/p2/contracts": () => ({ body: { items: [], canAdd: false } }),
});
beforeEach(() => { api = mockApi(base()); });
afterEach(() => vi.restoreAllMocks());

const lastList = () => api.gets("/api/v1/placements").at(-1)!.url.searchParams;
const rowOf = async (name: string) => (await screen.findByText(name, { selector: "b" })).closest("tr")!;
const openDrawer = async (name: string) => {
  fireEvent.click(within(await rowOf(name)).getByRole("button", { name: /^Open placement of / }));
  return screen.findByRole("dialog", { name: new RegExp(`^${name}`) });
};

describe("Placements list", () => {
  it("shows status, the first-placement badge, and no rate column when rates are withheld", async () => {
    wrap(<PlacementsPage me={RECRUITER} />);
    const first = await rowOf("Divya Menon");
    expect(within(first).getByText("First placement")).toHaveClass("badge");
    expect(within(first).getByText("Joined")).toHaveClass("badge", "st-joined");
    expect(within(first).getByText("No vendor")).toBeInTheDocument();
    const other = await rowOf("Asha Iyer");
    expect(within(other).queryByText("First placement")).not.toBeInTheDocument();
    expect(within(other).getByText(/Hybrid · Dallas, TX/)).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Rate" })).not.toBeInTheDocument();
    expect(screen.getByText("2 placements on page 1.")).toBeInTheDocument();
  });

  it("shows rates only where the API returns them", async () => {
    api.routes["GET /api/v1/placements"] = () => ({ body: { items: [{ ...P1, rate: 80 }, P2], nextCursor: null } });
    wrap(<PlacementsPage me={RECRUITER} />);
    expect(await screen.findByRole("columnheader", { name: "Rate" })).toBeInTheDocument();
    expect(within(await rowOf("Asha Iyer")).getByText("$80.00/hr")).toBeInTheDocument();
    expect(within(await rowOf("Divya Menon")).queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("filters by status chip", async () => {
    wrap(<PlacementsPage me={RECRUITER} />);
    await rowOf("Asha Iyer");
    fireEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "BGC failed" }));
    await waitFor(() => expect(lastList().get("status")).toBe("bgc_failed"));
  });

  it("explains a load failure with a retry", async () => {
    api.routes["GET /api/v1/placements"] = () => problem(403, { detail: "not_permitted" });
    wrap(<PlacementsPage me={RECRUITER} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("Placement detail", () => {
  it("lists the paperwork checklist copied at creation", async () => {
    api.routes["GET /api/v1/placements/p1"] = () => ({ body: { ...FULL_P1, checklist: [
      { docType: "offer_letter", ownerRole: "hr", required: true, status: "pending" },
      { docType: "direct_deposit", ownerRole: "accounts", required: false, status: "pending" },
    ] } });
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    const table = await within(drawer).findByRole("table", { name: "Paperwork checklist" });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([
      ["Offer letter", "HR", "Required", "Pending", "—"],
      ["Direct deposit", "Accounts", "Optional", "Pending", "—"],
    ]);
    expect(within(drawer).getByText(/0 of 2 done \(1 required open\)/)).toBeInTheDocument();
    // No bgc key (no document:read over this placement): no BGC section.
    expect(within(drawer).queryByRole("heading", { name: "Background check" })).not.toBeInTheDocument();
  });

  it("shows checklist progress, overdue items and the BGC status (migration 0044)", async () => {
    api.routes["GET /api/v1/placements/p1"] = () => ({ body: { ...FULL_P1, bgc: { status: "in_progress" }, checklist: [
      { id: "i1", docType: "sample_doc_a", ownerRole: "hr", required: true, status: "verified", dueOn: null, overdue: false },
      { id: "i2", docType: "sample_doc_b", ownerRole: "immigration", required: true, status: "received", dueOn: "2026-01-05", overdue: true },
      { id: "i3", docType: "sample_doc_c", ownerRole: "accounts", required: false, status: "waived", dueOn: null, overdue: false },
    ] } });
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    expect(await within(drawer).findByText(/2 of 3 done \(1 required open, 1 overdue\)/)).toBeInTheDocument();
    expect(within(drawer).getByRole("progressbar", { name: "Paperwork done" })).toHaveAttribute("value", "2");
    const table = within(drawer).getByRole("table", { name: "Paperwork checklist" });
    expect(within(table).getByText("Overdue")).toHaveClass("badge", "overdue");
    expect(within(drawer).getByRole("heading", { name: "Background check" })).toBeInTheDocument();
    expect(within(drawer).getByText("In progress")).toHaveClass("badge", "bgc-in_progress");
  });

  it("says when the placement type has no checklist, and hides the section for servers without one", async () => {
    api.routes["GET /api/v1/placements/p1"] = () => ({ body: { ...FULL_P1, checklist: [] } });
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    expect(await within(drawer).findByText(/No paperwork checklist is set up for .* placements\./)).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Close placement details" }));
    const second = await openDrawer("Divya Menon");
    await within(second).findByText("Assignment no.");
    expect(within(second).queryByRole("heading", { name: "Paperwork checklist" })).not.toBeInTheDocument();
  });

  it("shows contacts and the assignment once the full record loads", async () => {
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    const contacts = await within(drawer).findByRole("table", { name: "Contacts" });
    expect(within(contacts).getByText("Vendor POC")).toBeInTheDocument();
    expect(within(contacts).getByRole("link", { name: "pat@vendor.example" })).toHaveAttribute("href", "mailto:pat@vendor.example");
    expect(within(contacts).getByText("+14695550123")).toBeInTheDocument();
    expect(within(drawer).getByText(/No assignment yet/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });

    const joined = await openDrawer("Divya Menon");
    expect(await within(joined).findByText("No contacts recorded.")).toBeInTheDocument();
    expect(within(joined).getByText("Ongoing")).toBeInTheDocument();
    expect(within(joined).getByText("2")).toBeInTheDocument();
  });

  it("offers status changes from allowedTransitions and moves forward", async () => {
    api.routes["PATCH /api/v1/placements/p1/status"] = () => ({ body: { id: "p1", status: "paperwork" } });
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    const group = within(drawer).getByRole("group", { name: "Status" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Move to Paperwork", "Mark backout…", "Mark BGC failed…"]);
    fireEvent.click(within(group).getByRole("button", { name: "Move to Paperwork" }));
    await waitFor(() => expect(within(drawer).getByRole("status")).toHaveTextContent("Placement moved to Paperwork."));
    expect(api.writes()[0]).toMatchObject({ method: "PATCH", path: "/api/v1/placements/p1/status", body: { to: "paperwork" } });
  });

  it("confirms a backout with a required reason", async () => {
    api.routes["PATCH /api/v1/placements/p1/status"] = () => ({ body: { id: "p1", status: "backout" } });
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    fireEvent.click(within(drawer).getByRole("button", { name: "Mark backout…" }));
    const dlg = screen.getByRole("dialog", { name: "Mark backout for Asha Iyer?" });
    expect(within(dlg).getByLabelText("Reason")).toHaveFocus();
    fireEvent.click(within(dlg).getByRole("button", { name: "Mark backout" }));
    expect(api.writes()).toHaveLength(0);
    expect(within(dlg).getByLabelText("Reason")).toHaveAccessibleDescription(expect.stringContaining("Give a reason."));
    fireEvent.change(within(dlg).getByLabelText("Reason"), { target: { value: "Accepted a counter-offer" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Mark backout" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Mark backout/ })).not.toBeInTheDocument());
    expect(api.writes()[0]!.body).toEqual({ to: "backout", reason: "Accepted a counter-offer" });
    expect(within(drawer).getByRole("status")).toHaveTextContent("Placement marked Backout.");
  });

  it("offers only BGC failed after joining and maps reason_required", async () => {
    api.routes["PATCH /api/v1/placements/p2/status"] = () => problem(422, { detail: "reason_required" });
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Divya Menon");
    const group = within(drawer).getByRole("group", { name: "Status" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Mark BGC failed…"]);
    fireEvent.click(within(group).getByRole("button", { name: "Mark BGC failed…" }));
    const dlg = screen.getByRole("dialog", { name: "Mark BGC failed for Divya Menon?" });
    expect(within(dlg).getByText(/open assignment ends/)).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Reason"), { target: { value: "Records mismatch" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Mark BGC failed" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("Give a reason for this status change.");
  });

  it("shows no status actions when none are allowed", async () => {
    api.routes["GET /api/v1/placements"] = () => ({ body: { items: [{ ...P1, allowedTransitions: [] }], nextCursor: null } });
    api.routes["GET /api/v1/placements/p1"] = () => ({ body: { ...FULL_P1, allowedTransitions: [] } });
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    await within(drawer).findByRole("table", { name: "Contacts" });
    expect(within(drawer).queryByRole("group", { name: "Status" })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /Move to|Mark/ })).not.toBeInTheDocument();
  });

  it("maps an invalid_transition refusal", async () => {
    api.routes["PATCH /api/v1/placements/p1/status"] = () => problem(422, { detail: "invalid_transition" });
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    fireEvent.click(within(drawer).getByRole("button", { name: "Move to Paperwork" }));
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("That status change isn't allowed");
  });

  it("opens a placement passed in from another screen", async () => {
    wrap(<PlacementsPage me={RECRUITER} initialOpenId="p2" />);
    const drawer = await screen.findByRole("dialog", { name: "Divya Menon · Northwind Financial" });
    expect(await within(drawer).findByText("Ongoing")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Placements" })).toHaveFocus());
  });
});

describe("Placements report (migration 0160)", () => {
  const LOOKUPS = {
    technologies: [{ id: "tech1", name: "Java" }], clients: [{ id: "cl1", name: "Northwind Financial" }],
    vendors: [{ id: "v1", name: "Contoso Staffing" }], implementationPartners: [], roles: ROLE_LOOKUPS, locations: [{ id: "loc", name: "Dallas" }], coaches: [],
  };

  it("filters by vendor, end client, technology and location", async () => {
    api.routes["GET /api/v1/lookups"] = () => ({ body: LOOKUPS });
    wrap(<PlacementsPage me={RECRUITER} />);
    await rowOf("Asha Iyer");
    fireEvent.change(await screen.findByLabelText("Vendor"), { target: { value: "v1" } });
    fireEvent.change(screen.getByLabelText("End client"), { target: { value: "cl1" } });
    fireEvent.change(screen.getByLabelText("Technology"), { target: { value: "tech1" } });
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "loc" } });
    await waitFor(() => expect(lastList().get("locationId")).toBe("loc"));
    expect([lastList().get("vendorId"), lastList().get("clientId"), lastList().get("technologyId")]).toEqual(["v1", "cl1", "tech1"]);
  });

  it("shows the technology and the re-confirmed badge", async () => {
    api.routes["GET /api/v1/placements"] = () => ({ body: { items: [{ ...P1, reconfirmed: true, technology: { id: "tech1", name: "Java" } }], nextCursor: null } });
    wrap(<PlacementsPage me={RECRUITER} />);
    const row = await rowOf("Asha Iyer");
    expect(within(row).getByText("Re-confirmed")).toHaveClass("badge");
    expect(within(row).getByText("Java")).toBeInTheDocument();
  });

  it("exports with the filters for report:export holders only", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    api.routes["POST /api/v1/placements/export"] = () => ({ body: "csv" });
    const { unmount } = wrap(<PlacementsPage me={RECRUITER} />);
    await rowOf("Asha Iyer");
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
    unmount();
    wrap(<PlacementsPage me={meFor("lead")} />);
    await rowOf("Asha Iyer");
    fireEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Joined" }));
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ status: "joined" });
  });

  it("confirms a joining issue with a required reason", async () => {
    api.routes["GET /api/v1/placements/p1"] = () => ({ body: { ...FULL_P1, allowedTransitions: ["paperwork", "backout", "joining_issue"] } });
    api.routes["PATCH /api/v1/placements/p1/status"] = () => ({ body: { id: "p1", status: "joining_issue" } });
    wrap(<PlacementsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    fireEvent.click(await within(drawer).findByRole("button", { name: "Mark joining issue…" }));
    const dlg = screen.getByRole("dialog", { name: "Mark joining issue for Asha Iyer?" });
    fireEvent.change(within(dlg).getByLabelText("Reason"), { target: { value: "Client postponed the start" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Mark joining issue" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ to: "joining_issue", reason: "Client postponed the start" });
  });
});

describe("Placements filters in the URL", () => {
  it("restores filters from a link and keeps them while a placement is opened and closed", async () => {
    api.routes["GET /api/v1/hotlist"] = () => ({ body: { items: [], nextCursor: null } });
    window.history.replaceState(null, "", "/placements?status=joined&vendorId=v1&from=nope");
    wrap(<Shell me={RECRUITER} onSignOut={() => undefined} />);
    await rowOf("Asha Iyer");
    expect(lastList().get("status")).toBe("joined");
    expect(lastList().get("vendorId")).toBe("v1");
    expect(lastList().get("from")).toBeNull();

    const drawer = await openDrawer("Asha Iyer");
    await waitFor(() => expect(window.location.pathname).toBe("/placements/p1"));
    expect(new URLSearchParams(window.location.search).get("status")).toBe("joined");
    fireEvent.click(within(drawer).getByRole("button", { name: "Close placement details" }));
    await waitFor(() => expect(window.location.pathname).toBe("/placements"));
    expect(new URLSearchParams(window.location.search).get("vendorId")).toBe("v1");

    // Another screen starts fresh.
    const nav = screen.getByRole("complementary", { name: "Main navigation" });
    fireEvent.click(within(nav).getByRole("button", { name: "Submissions" }));
    await waitFor(() => expect(window.location.pathname).toBe("/submissions"));
    expect(window.location.search).toBe("");
  });
});

describe("Placements team filter and cleared interviews (migration 0360)", () => {
  const TEAMS = { items: [{ id: "t1", name: "Team Rohit" }, { id: "t2", name: "Team Anjali" }] };
  const CLEARED = {
    id: "i1", submissionId: "s1", candidate: { id: "c1", name: "Kumar Sakesh" }, recruiter: { id: "r1", name: "Jason" },
    team: { id: "t2", name: "Team Anjali" }, location: null, client: { id: "cl1", name: "Intuit" }, round: "L1",
    startsAt: "2026-10-30T21:00:00Z", endsAt: "2026-10-30T22:00:00Z", coach: null, inviteReceived: true,
    callStatus: "completed", cleared: true, consentCaptured: true, otterUrl: null, recordingUrl: null, systemName: null,
    editableFields: [], feedbackKinds: [], result: "cleared", resultAt: "2026-10-30T22:10:00Z",
    submissionStatus: "interview_completed", placement: null,
  };

  it("filters placements by team when the caller sees more than one", async () => {
    api.routes["GET /api/v1/placements/teams"] = () => ({ body: TEAMS });
    wrap(<PlacementsPage me={RECRUITER} />);
    const team = await screen.findByRole("combobox", { name: /^Team$/ });
    fireEvent.change(team, { target: { value: "t2" } });
    await waitFor(() => expect(lastList().get("teamId")).toBe("t2"));
  });

  it("hides the team filter for a single team (a team lead)", async () => {
    api.routes["GET /api/v1/placements/teams"] = () => ({ body: { items: [TEAMS.items[0]] } });
    wrap(<PlacementsPage me={RECRUITER} />);
    await rowOf("Asha Iyer");
    expect(screen.queryByRole("combobox", { name: /^Team$/ })).not.toBeInTheDocument();
  });

  it("lists cleared interviews latest first, by team", async () => {
    api.routes["GET /api/v1/placements/teams"] = () => ({ body: TEAMS });
    api.routes["GET /api/v1/interviews"] = () => ({ body: { items: [CLEARED], nextCursor: null } });
    wrap(<PlacementsPage me={RECRUITER} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Cleared interviews" }));
    const row = (await screen.findByText("Kumar Sakesh", { selector: "b" })).closest("tr")!;
    expect(within(row).getByText("Intuit")).toBeInTheDocument();
    expect(within(row).getByText("Team Anjali")).toBeInTheDocument();
    const q = () => api.gets("/api/v1/interviews").at(-1)!.url.searchParams;
    expect(q().get("result")).toBe("cleared");
    expect(q().get("sort")).toBe("desc");
    fireEvent.change(screen.getByRole("combobox", { name: /^Team$/ }), { target: { value: "t1" } });
    await waitFor(() => expect(q().get("teamId")).toBe("t1"));
  });
});
