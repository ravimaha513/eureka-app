import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkPage } from "./PaperworkPage";
import { meFor, mockApi, problem, wrap, type Handler } from "../pipeline/testkit";
import type { PaperworkDetail, QueueRow } from "./paperworkApi";

const HR = { ...meFor("hr"), roles: [{ key: "hr", label: "HR", locationId: null }] };
const ROW: QueueRow = {
  placementId: "p1", candidate: { id: "c1", name: "Asha Iyer" }, recruiter: { id: "r1", name: "Rohit Rao" },
  placement: { status: "paperwork", placementType: "w2", tentativeStart: "2031-01-05", client: { id: "cl1", name: "Northwind Financial" } },
  checklist: { total: 3, open: 2, requiredOpen: 1, overdue: 1, nextDue: "2026-01-02" }, bgc: { status: "initiated" },
};
const IMM_ROW: QueueRow = { ...ROW, placementId: "p2", candidate: { id: "c2", name: "Divya Menon" }, placement: null,
  checklist: { total: 0, open: 0, requiredOpen: 0, overdue: 0, nextDue: null }, bgc: { status: "not_started" } };
const allActions = { transition: ["received", "waived"], editNotes: true, assign: true };
const DETAIL: PaperworkDetail = {
  ...ROW,
  items: [
    { id: "i1", docType: "sample_doc_a", ownerRole: "hr", required: true, status: "pending", statusReason: null, statusChangedAt: null,
      assignee: null, dueOn: "2026-01-02", overdue: true, notes: null, documentId: null, version: 1, templateVersion: 1, actions: allActions },
    { id: "i2", docType: "sample_doc_b", ownerRole: "immigration", required: false, status: "verified", statusReason: null, statusChangedAt: null,
      assignee: { id: "u-imm", name: "Imm User" }, dueOn: null, overdue: false, notes: "Fictional note", documentId: null, version: 3,
      templateVersion: 1, actions: { transition: ["pending"], editNotes: true, assign: true } },
  ],
  bgc: {
    status: "initiated", bgcCompany: "Fictional Checks LLC", initiatedOn: "2026-01-01", completedOn: null, helpedBy: null,
    educationLevel: null, employmentYears: 7, addressYears: null, notes: null, statusReason: null, statusChangedAt: null, version: 2,
    history: [{ at: "2026-01-01T10:00:00Z", actor: { id: "u-me", name: "Test User" }, from: "not_started", to: "initiated", changed: ["status", "bgc_company"], reason: null }],
    actions: { update: true, transition: ["in_progress", "cleared", "failed"], failPlacement: false },
  },
};

let api: ReturnType<typeof mockApi>;
const base = (): Record<string, Handler> => ({
  "GET /api/v1/paperwork": () => ({ body: { items: [ROW, IMM_ROW], nextCursor: null } }),
  "GET /api/v1/paperwork/templates": () => problem(403, { detail: "Not permitted" }),
  "GET /api/v1/paperwork/placements/p1": () => ({ body: DETAIL }),
  "GET /api/v1/paperwork/items/i2/history": () => ({ body: { items: [
    { at: "2026-01-03T10:00:00Z", actor: { id: "u-imm", name: "Imm User" }, from: "received", to: "verified", changed: ["status"], reason: null },
    { at: "2026-01-02T10:00:00Z", actor: { id: "u-me", name: "Test User" }, from: null, to: null, changed: ["due_on", "notes"], reason: null },
  ] } }),
});
beforeEach(() => { api = mockApi(base()); });
afterEach(() => vi.restoreAllMocks());

const lastQueue = () => api.gets("/api/v1/paperwork").at(-1)!.url.searchParams;
const openDrawer = async () => {
  const row = (await screen.findByText("Asha Iyer", { selector: "b" })).closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: "Open paperwork of Asha Iyer" }));
  return screen.findByRole("dialog", { name: "Paperwork · Asha Iyer" });
};

describe("Paperwork queue", () => {
  it("lists placements with checklist progress, overdue counts and BGC status", async () => {
    wrap(<PaperworkPage me={HR} />);
    const row = (await screen.findByText("Asha Iyer", { selector: "b" })).closest("tr")!;
    expect(within(row).getByText(/1 of 3 done/)).toBeInTheDocument();
    expect(within(row).getByText("1 required open")).toBeInTheDocument();
    expect(within(row).getByText("1 overdue")).toHaveClass("badge", "overdue");
    expect(within(row).getByText("Initiated")).toHaveClass("badge", "bgc-initiated");
    expect(within(row).getByText("Paperwork")).toHaveClass("badge", "st-paperwork");
    // Immigration-style row: the placement itself is not readable.
    const other = (await screen.findByText("Divya Menon", { selector: "b" })).closest("tr")!;
    expect(within(other).getByText("Not visible to you")).toBeInTheDocument();
    expect(within(other).getByText("No checklist")).toBeInTheDocument();
    expect(screen.getByText("2 placements on page 1.")).toBeInTheDocument();
    expect(lastQueue().get("view")).toBe("outstanding");
    // No template access: no tabs.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("filters by view, owner role, assignment, BGC and placement status", async () => {
    wrap(<PaperworkPage me={HR} />);
    await screen.findByText("Asha Iyer", { selector: "b" });
    fireEvent.click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: "Overdue" }));
    await waitFor(() => expect(lastQueue().get("view")).toBe("overdue"));
    fireEvent.change(screen.getByRole("combobox", { name: "Owner role" }), { target: { value: "immigration" } });
    await waitFor(() => expect(lastQueue().get("ownerRole")).toBe("immigration"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Assigned to me" }));
    await waitFor(() => expect(lastQueue().get("mine")).toBe("true"));
    fireEvent.change(screen.getByRole("combobox", { name: "BGC status" }), { target: { value: "failed" } });
    await waitFor(() => expect(lastQueue().get("bgcStatus")).toBe("failed"));
    fireEvent.change(screen.getByRole("combobox", { name: "Placement status" }), { target: { value: "joined" } });
    await waitFor(() => expect(lastQueue().get("placementStatus")).toBe("joined"));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect([...lastQueue().keys()].sort()).toEqual(["limit", "view"]));
  });

  it("explains a load failure with a retry", async () => {
    api.routes["GET /api/v1/paperwork"] = () => problem(403, { detail: "Not permitted" });
    wrap(<PaperworkPage me={HR} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("Paperwork drawer", () => {
  it("shows items with notes, overdue flags, the BGC record and its history", async () => {
    wrap(<PaperworkPage me={HR} />);
    const drawer = await openDrawer();
    const table = await within(drawer).findByRole("table", { name: "Paperwork checklist" });
    expect(within(table).getByText("Sample doc a")).toBeInTheDocument();
    expect(within(table).getByText("Overdue")).toHaveClass("badge", "overdue");
    expect(within(table).getByText("Fictional note")).toBeInTheDocument();
    expect(within(drawer).getByText("Fictional Checks LLC")).toBeInTheDocument();
    expect(within(drawer).getByRole("list", { name: "Background check history" })).toHaveTextContent("Not started → Initiated (BGC company)");
    fireEvent.click(within(table).getByRole("button", { name: "History of Sample doc b" }));
    expect(await within(drawer).findByRole("list", { name: "History of Sample doc b" })).toHaveTextContent("Received → Verified");
  });

  it("marks an item received with notes and the version it was read at", async () => {
    api.routes["PATCH /api/v1/paperwork/items/i1"] = () => ({ body: { ...DETAIL.items[0], status: "received", version: 2 } });
    wrap(<PaperworkPage me={HR} />);
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole("button", { name: "Update Sample doc a" }));
    const dlg = screen.getByRole("dialog", { name: "Update Sample doc a" });
    expect(within(dlg).getByLabelText("Status")).toHaveFocus();
    fireEvent.change(within(dlg).getByLabelText("Status"), { target: { value: "received" } });
    fireEvent.change(within(dlg).getByLabelText("Notes"), { target: { value: "Fictional: original seen" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Update Sample doc a" })).not.toBeInTheDocument());
    expect(api.writes()[0]).toMatchObject({ method: "PATCH", path: "/api/v1/paperwork/items/i1",
      body: { status: "received", notes: "Fictional: original seen", expectedVersion: 1 } });
    expect(within(drawer).getByRole("status")).toHaveTextContent("Sample doc a marked Received.");
  });

  it("requires a reason to waive, assigns to me and sets a due date", async () => {
    api.routes["PATCH /api/v1/paperwork/items/i1"] = () => ({ body: DETAIL.items[0] });
    wrap(<PaperworkPage me={HR} />);
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole("button", { name: "Update Sample doc a" }));
    const dlg = screen.getByRole("dialog", { name: "Update Sample doc a" });
    fireEvent.change(within(dlg).getByLabelText("Status"), { target: { value: "waived" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(api.writes()).toHaveLength(0);
    expect(within(dlg).getByLabelText("Reason")).toHaveAccessibleDescription(expect.stringContaining("Give a reason."));
    fireEvent.change(within(dlg).getByLabelText("Reason"), { target: { value: "Fictional: not applicable" } });
    fireEvent.change(within(dlg).getByLabelText("Assignee"), { target: { value: HR.id } });
    fireEvent.change(within(dlg).getByLabelText("Due date"), { target: { value: "2026-02-01" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ status: "waived", reason: "Fictional: not applicable", assigneeId: HR.id, dueOn: "2026-02-01", expectedVersion: 1 });
  });

  it("maps a lost update and refuses an empty change", async () => {
    api.routes["PATCH /api/v1/paperwork/items/i1"] = () => problem(409, { detail: "version_mismatch" });
    wrap(<PaperworkPage me={HR} />);
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole("button", { name: "Update Sample doc a" }));
    const dlg = screen.getByRole("dialog", { name: "Update Sample doc a" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(within(dlg).getByRole("alert")).toHaveTextContent("Change at least one field.");
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText("Status"), { target: { value: "received" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(await within(dlg).findByText(/Someone else changed this/)).toBeInTheDocument();
  });

  it("records a failed check with a reason; offers to fail the placement only when allowed", async () => {
    api.routes["PATCH /api/v1/paperwork/placements/p1/bgc"] = () => ({ body: { ...DETAIL.bgc, status: "failed" } });
    wrap(<PaperworkPage me={HR} />);
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole("button", { name: "Update background check" }));
    let dlg = screen.getByRole("dialog", { name: "Update background check" });
    fireEvent.change(within(dlg).getByLabelText("Status"), { target: { value: "failed" } });
    expect(within(dlg).queryByRole("checkbox", { name: /Also mark the placement/ })).not.toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText("Reason"), { target: { value: "Fictional finding" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ status: "failed", reason: "Fictional finding", expectedVersion: 2 });

    // A user who also holds the placement rights gets the combined option.
    api.routes["GET /api/v1/paperwork/placements/p1"] = () => ({ body: { ...DETAIL, bgc: { ...DETAIL.bgc, actions: { ...DETAIL.bgc.actions, failPlacement: true } } } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Close paperwork details" }));
    const again = await openDrawer();
    await waitFor(() => expect(within(again).getByRole("button", { name: "Update background check" })).toBeInTheDocument());
    fireEvent.click(within(again).getByRole("button", { name: "Update background check" }));
    dlg = screen.getByRole("dialog", { name: "Update background check" });
    fireEvent.change(within(dlg).getByLabelText("Status"), { target: { value: "failed" } });
    fireEvent.change(within(dlg).getByLabelText("Reason"), { target: { value: "Fictional finding" } });
    fireEvent.click(await within(dlg).findByRole("checkbox", { name: /Also mark the placement BGC failed/ }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]!.body).toMatchObject({ status: "failed", failPlacement: true });
  });
});

describe("Templates", () => {
  const TEMPLATES = { canPublish: true, templates: [
    { kind: "paperwork", placementType: "w2", version: 2, publishedAt: "2026-01-01T00:00:00Z", publishedBy: null,
      items: [{ docType: "sample_doc_a", ownerRole: "hr", required: true }, { docType: "sample_doc_c", ownerRole: "accounts", required: false }] },
    { kind: "paperwork", placementType: "w2", version: 1, publishedAt: "2025-12-01T00:00:00Z", publishedBy: null, items: [] },
  ] };

  it("shows the latest version per type and publishes a new one from it", async () => {
    api.routes["GET /api/v1/paperwork/templates"] = () => ({ body: TEMPLATES });
    api.routes["POST /api/v1/paperwork/templates"] = () => ({ status: 201, body: { kind: "paperwork", placementType: "w2", version: 3 } });
    wrap(<PaperworkPage me={HR} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Templates" }));
    const table = screen.getByRole("table", { name: "Paperwork templates" });
    const w2 = within(table).getByText("W2").closest("tr")!;
    expect(w2).toHaveTextContent(/v2/);
    expect(w2).toHaveTextContent("Sample doc a (HR); Sample doc c (Accounts, optional)");
    fireEvent.click(within(w2).getByRole("button", { name: "New paperwork version for W2" }));
    const dlg = screen.getByRole("dialog", { name: "New paperwork template version for W2" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add document" }));
    fireEvent.change(within(dlg).getByLabelText("Document type 3"), { target: { value: "Bad Type" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Publish version" }));
    expect(within(dlg).getByRole("alert")).toHaveTextContent("snake_case");
    fireEvent.change(within(dlg).getByLabelText("Document type 3"), { target: { value: "sample_doc_d" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove document 1" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Publish version" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ kind: "paperwork", placementType: "w2", expectedVersion: 2, items: [
      { docType: "sample_doc_c", ownerRole: "accounts", required: false }, { docType: "sample_doc_d", ownerRole: "hr", required: true }] });
    expect(await screen.findByText("Published version 3.")).toBeInTheDocument();
  });

  it("read-only roles see no publish buttons", async () => {
    api.routes["GET /api/v1/paperwork/templates"] = () => ({ body: { ...TEMPLATES, canPublish: false } });
    wrap(<PaperworkPage me={HR} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Templates" }));
    expect(screen.queryByRole("button", { name: /New .* version/ })).not.toBeInTheDocument();
  });
});
