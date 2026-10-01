import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlacementsPage } from "./PlacementsPage";
import { meFor, mockApi, plc, problem, wrap, type Handler } from "./testkit";

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
  "GET /api/v1/placements": () => ({ body: { items: [P1, P2], nextCursor: null } }),
  "GET /api/v1/placements/p1": () => ({ body: FULL_P1 }),
  "GET /api/v1/placements/p2": () => ({ body: FULL_P2 }),
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
      ["Offer letter", "HR", "Required", "Pending"],
      ["Direct deposit", "Accounts", "Optional", "Pending"],
    ]);
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
