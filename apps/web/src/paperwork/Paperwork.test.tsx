import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkPage } from "./PaperworkPage";
import { EMPTY_LOOKUPS, meFor, mockApi, problem, wrap, type Handler } from "../pipeline/testkit";
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
    status: "initiated", bgcCompany: "Fictional Checks LLC", initiatedOn: "2026-01-01",
    educationLevel: null, employmentYears: 7, addressYears: null, employment: [], addresses: [], notes: null, statusReason: null, statusChangedAt: null, version: 2,
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
beforeEach(() => {
  window.history.replaceState(null, "", "/paperwork");
  api = mockApi({
    "GET /api/v1/lookups": () => ({ body: EMPTY_LOOKUPS }),
    "GET /api/v1/placements/p1/documents": () => ({ body: { canUpload: true, canUploadRestricted: false, canViewRestricted: false, items: [] } }),
    ...base(),
  });
});
afterEach(() => vi.restoreAllMocks());

const lastQueue = () => api.gets("/api/v1/paperwork").at(-1)!.url.searchParams;
/** Opens Asha Iyer's page from the queue (the candidate name is the link) and, optionally, a tab. */
const openPage = async (tab?: string) => {
  fireEvent.click(await screen.findByRole("link", { name: "Asha Iyer" }));
  await screen.findByRole("heading", { level: 1, name: "Asha Iyer" });
  if (tab) fireEvent.click(screen.getByRole("tab", { name: tab }));
  return screen.getByRole("tabpanel");
};

describe("Paperwork queue", () => {
  it("lists placements with checklist progress, overdue counts and BGC status", async () => {
    wrap(<PaperworkPage me={HR} />);
    const row = (await screen.findByRole("link", { name: "Asha Iyer" })).closest("tr")!;
    expect(within(row).getByText(/1 of 3 done/)).toBeInTheDocument();
    expect(within(row).getByText("1 required open")).toBeInTheDocument();
    expect(within(row).getByText("1 overdue")).toHaveClass("badge", "overdue");
    expect(within(row).getByText("Initiated")).toHaveClass("badge", "bgc-initiated");
    expect(within(row).getByText("Paperwork")).toHaveClass("badge", "st-paperwork");
    // Immigration-style row: the placement itself is not readable.
    const other = (await screen.findByRole("link", { name: "Divya Menon" })).closest("tr")!;
    expect(within(other).getByText("Not visible to you")).toBeInTheDocument();
    expect(within(other).getByText("No checklist")).toBeInTheDocument();
    expect(screen.getByText("2 placements on page 1.")).toBeInTheDocument();
    expect(lastQueue().get("view")).toBe("outstanding");
    // No template access: no tabs.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("filters by view, owner role, assignment, BGC and placement status", async () => {
    wrap(<PaperworkPage me={HR} />);
    await screen.findByRole("link", { name: "Asha Iyer" });
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

describe("Paperwork page", () => {
  it("opens from the candidate link with documents first; back returns to the queue", async () => {
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage();
    expect(screen.getByRole("tab", { name: "Documents" })).toHaveAttribute("aria-selected", "true");
    expect(await within(panel).findByRole("heading", { name: "Placement documents" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const rail = screen.getByRole("complementary", { name: "Placement summary" });
    expect(within(rail).getByText("Northwind Financial")).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "1 checklist item overdue" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "← Paperwork & BGC" }));
    expect(await screen.findByRole("table", { name: "Paperwork queue" })).toBeInTheDocument();
  });

  it("checklist tab shows items with notes, overdue flags and history; activity shows the BGC history", async () => {
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Checklist");
    const table = await within(panel).findByRole("table", { name: "Paperwork checklist" });
    expect(within(table).getByText("Sample doc a")).toBeInTheDocument();
    expect(within(table).getByText("Overdue")).toHaveClass("badge", "overdue");
    expect(within(table).getByText("Fictional note")).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: "History of Sample doc b" }));
    expect(await within(panel).findByRole("list", { name: "History of Sample doc b" })).toHaveTextContent("Received → Verified");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByRole("list", { name: "Background check history" })).toHaveTextContent("Not started → Initiated (BGC company)");
  });

  it("marks an item received with notes and the version it was read at", async () => {
    api.routes["PATCH /api/v1/paperwork/items/i1"] = () => ({ body: { ...DETAIL.items[0], status: "received", version: 2 } });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Checklist");
    fireEvent.click(await within(panel).findByRole("button", { name: "Update Sample doc a" }));
    const dlg = screen.getByRole("dialog", { name: "Update Sample doc a" });
    expect(within(dlg).getByLabelText("Status")).toHaveFocus();
    fireEvent.change(within(dlg).getByLabelText("Status"), { target: { value: "received" } });
    fireEvent.change(within(dlg).getByLabelText("Notes"), { target: { value: "Fictional: original seen" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Update Sample doc a" })).not.toBeInTheDocument());
    expect(api.writes()[0]).toMatchObject({ method: "PATCH", path: "/api/v1/paperwork/items/i1",
      body: { status: "received", notes: "Fictional: original seen", expectedVersion: 1 } });
    expect(screen.getByText("Sample doc a marked Received.")).toBeInTheDocument();
  });

  it("requires a reason to waive, assigns to me and sets a due date", async () => {
    api.routes["PATCH /api/v1/paperwork/items/i1"] = () => ({ body: DETAIL.items[0] });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Checklist");
    fireEvent.click(await within(panel).findByRole("button", { name: "Update Sample doc a" }));
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

  it("links a document of this candidate or placement and maps invalid_document", async () => {
    const doc = (id: string, extra: Record<string, unknown>) => ({
      id, candidateId: "c1", placementId: null, docType: "offer_letter", docTypeLabel: "Offer letter", classification: "internal",
      status: "clean", reason: null, contentType: "application/pdf", sizeBytes: 1000, sha256: null,
      uploadedBy: { id: "u-me", name: "Test User" }, createdAt: "2026-01-02T10:00:00Z", scannedAt: null, ...extra,
    });
    const listing = { canUpload: true, canUploadRestricted: true, canViewRestricted: true };
    api.routes["GET /api/v1/candidates/c1/documents"] = () => ({ body: { ...listing, items: [
      doc("d-cand", {}), doc("d-here", { placementId: "p1", docTypeLabel: "Form I-9" }),
      doc("d-other", { placementId: "p-old", docTypeLabel: "Other placement" }), doc("d-bad", { status: "infected", docTypeLabel: "Blocked" }),
    ] } });
    api.routes["GET /api/auth/step-up"] = () => ({ body: { active: false, expiresAt: null, method: null, mode: "dev", ttlMinutes: 10 } });
    let reply: "ok" | "bad" = "bad";
    api.routes["PATCH /api/v1/paperwork/items/i1"] = () => (reply === "bad" ? problem(422, { detail: "invalid_document" }) : { body: DETAIL.items[0] });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Checklist");
    fireEvent.click(await within(panel).findByRole("button", { name: "Update Sample doc a" }));
    const dlg = screen.getByRole("dialog", { name: "Update Sample doc a" });
    const picker = within(dlg).getByLabelText("Linked document");
    await waitFor(() => expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "No document", "Offer letter · Jan 2, 2026", "Form I-9 · Jan 2, 2026 · this placement"]));
    fireEvent.change(picker, { target: { value: "d-here" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(await within(dlg).findByText(/That document can't be linked/)).toBeInTheDocument();
    expect(api.writes()[0]!.body).toEqual({ documentId: "d-here", expectedVersion: 1 });
    reply = "ok";
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Update Sample doc a" })).not.toBeInTheDocument());
  });

  it("maps a lost update and refuses an empty change", async () => {
    api.routes["PATCH /api/v1/paperwork/items/i1"] = () => problem(409, { detail: "version_mismatch" });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Checklist");
    fireEvent.click(await within(panel).findByRole("button", { name: "Update Sample doc a" }));
    const dlg = screen.getByRole("dialog", { name: "Update Sample doc a" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(within(dlg).getByRole("alert")).toHaveTextContent("Change at least one field.");
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText("Status"), { target: { value: "received" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(await within(dlg).findByText(/Someone else changed this/)).toBeInTheDocument();
  });
});

describe("Paperwork page: background check", () => {
  it("records a failed check with a reason inline; no placement option without the right", async () => {
    api.routes["PATCH /api/v1/paperwork/placements/p1/bgc"] = () => ({ body: { ...DETAIL.bgc, status: "failed" } });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    expect(within(panel).getByRole("list", { name: "Background check progress" })).toHaveTextContent(/Not started.*Initiated.*In progress.*Cleared \/ Failed/);
    const move = within(panel).getByRole("combobox", { name: "Move to" });
    fireEvent.click(within(panel).getByRole("button", { name: "Update status" }));
    expect(move).toHaveAccessibleDescription(expect.stringContaining("Pick a status."));
    fireEvent.change(move, { target: { value: "failed" } });
    expect(within(panel).queryByRole("checkbox", { name: /Also mark the placement/ })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Update status" }));
    expect(api.writes()).toHaveLength(0);
    expect(within(panel).getByLabelText("Reason")).toHaveAccessibleDescription(expect.stringContaining("Give a reason."));
    fireEvent.change(within(panel).getByLabelText("Reason"), { target: { value: "Fictional finding" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Update status" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ status: "failed", reason: "Fictional finding", expectedVersion: 2 });
    expect(await screen.findByText("Background check marked Failed.")).toBeInTheDocument();
  });

  it("clearing the check requires the actual start date, then shows it on the placement", async () => {
    api.routes["PATCH /api/v1/paperwork/placements/p1/bgc"] = () => ({ body: { ...DETAIL.bgc, status: "cleared" } });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    expect(within(panel).queryByLabelText("Actual start date")).not.toBeInTheDocument();
    fireEvent.change(within(panel).getByRole("combobox", { name: "Move to" }), { target: { value: "cleared" } });
    const start = within(panel).getByLabelText("Actual start date");
    fireEvent.click(within(panel).getByRole("button", { name: "Update status" }));
    expect(await within(panel).findByText("Enter the actual start date.")).toBeInTheDocument();
    expect(start).toHaveAttribute("aria-invalid", "true");
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(start, { target: { value: "2031-01-12" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Update status" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({ status: "cleared", actualStart: "2031-01-12" });
  });

  it("offers to fail the placement too when the caller holds that right", async () => {
    api.routes["GET /api/v1/paperwork/placements/p1"] = () => ({ body: { ...DETAIL, bgc: { ...DETAIL.bgc, actions: { ...DETAIL.bgc.actions, failPlacement: true } } } });
    api.routes["PATCH /api/v1/paperwork/placements/p1/bgc"] = () => ({ body: { ...DETAIL.bgc, status: "failed" } });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    fireEvent.change(within(panel).getByRole("combobox", { name: "Move to" }), { target: { value: "failed" } });
    fireEvent.change(within(panel).getByLabelText("Reason"), { target: { value: "Fictional finding" } });
    fireEvent.click(within(panel).getByRole("checkbox", { name: /Also mark the placement BGC failed/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Update status" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({ status: "failed", failPlacement: true });
  });

  it("edits check details in place and saves only what changed", async () => {
    api.routes["PATCH /api/v1/paperwork/placements/p1/bgc"] = () => ({ body: DETAIL.bgc });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    expect(within(panel).getByText("Fictional Checks LLC")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Edit check details" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent("Change at least one field.");
    fireEvent.change(within(panel).getByLabelText("Education level"), { target: { value: "Master's" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ educationLevel: "Master's", expectedVersion: 2 });
  });

  it("saves notes in place when the caller may update; read-only otherwise", async () => {
    api.routes["PATCH /api/v1/paperwork/placements/p1/bgc"] = () => ({ body: { ...DETAIL.bgc, notes: "Fictional note" } });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    const save = within(panel).getByRole("button", { name: "Save notes" });
    expect(save).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText("Add or edit notes"), { target: { value: " Fictional note " } });
    fireEvent.click(save);
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ notes: "Fictional note", expectedVersion: 2 });
    expect(await screen.findByText("Notes saved.")).toBeInTheDocument();
  });

  it("without update rights: no forms, notes and rows read-only", async () => {
    api.routes["GET /api/v1/paperwork/placements/p1"] = () => ({ body: { ...DETAIL, bgc: { ...DETAIL.bgc, notes: "Fictional BGC note",
      employment: [EMP], actions: { update: false, transition: [], failPlacement: false } } } });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    expect(within(panel).getByText("Fictional BGC note")).toBeInTheDocument();
    expect(within(panel).getByText("Fictional Corp")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Save notes" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Update status" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /Add employer|Edit|Mark verified/ })).not.toBeInTheDocument();
  });
});

const EMP = { id: "e1", kind: "employment" as const, employer: "Fictional Corp", title: "Analyst", street: null, city: null, region: null,
  postalCode: null, country: null, startMonth: "2019-03", endMonth: "2023-06", verification: "pending" as const, notes: "Fictional employer note", version: 1 };
const EMP2 = { ...EMP, id: "e2", employer: "Sample Works", title: null, startMonth: "2023-09", endMonth: null, verification: "verified" as const, notes: null };

describe("Paperwork page: employment and address history rows", () => {
  it("shows the years recorded before rows existed in the empty state", async () => {
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    expect(within(panel).getByText(/No employers recorded yet\. Recorded before history rows: 7 years checked back\./)).toBeInTheDocument();
    expect(within(panel).getByText("No addresses recorded yet.")).toBeInTheDocument();
  });

  it("adds an employer with notes; validates required fields and month order", async () => {
    api.routes["POST /api/v1/paperwork/placements/p1/bgc/entries"] = () => ({ status: 201, body: { ...DETAIL.bgc, employment: [EMP] } });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    fireEvent.click(within(panel).getByRole("button", { name: "+ Add employer" }));
    const form = within(panel).getByRole("form", { name: "Add employer" });
    fireEvent.click(within(form).getByRole("button", { name: "Add employer" }));
    expect(within(form).getByLabelText("Employer")).toHaveAccessibleDescription(expect.stringContaining("Enter the employer."));
    expect(within(form).getByLabelText("From")).toHaveAccessibleDescription(expect.stringContaining("Pick the first month."));
    fireEvent.change(within(form).getByLabelText("Employer"), { target: { value: " Fictional Corp " } });
    fireEvent.change(within(form).getByLabelText("Title (optional)"), { target: { value: "Analyst" } });
    fireEvent.change(within(form).getByLabelText("From"), { target: { value: "2019-03" } });
    fireEvent.change(within(form).getByLabelText("To"), { target: { value: "2018-01" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add employer" }));
    expect(within(form).getByLabelText("To")).toHaveAccessibleDescription(expect.stringContaining("“To” must be on or after “From”."));
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText("To"), { target: { value: "2023-06" } });
    fireEvent.change(within(form).getByLabelText("Notes (optional)"), { target: { value: "Fictional employer note" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add employer" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ method: "POST", path: "/api/v1/paperwork/placements/p1/bgc/entries", body: {
      kind: "employment", employer: "Fictional Corp", title: "Analyst", notes: "Fictional employer note",
      startMonth: "2019-03", endMonth: "2023-06", verification: "pending" } });
    expect(await screen.findByText("Fictional Corp added.")).toBeInTheDocument();
  });

  it("lists rows with notes, flags gaps, marks one verified and edits another", async () => {
    api.routes["GET /api/v1/paperwork/placements/p1"] = () => ({ body: { ...DETAIL, bgc: { ...DETAIL.bgc, employment: [EMP2, EMP] } } });
    api.routes["PATCH /api/v1/paperwork/placements/p1/bgc/entries/e1"] = () => ({ body: DETAIL.bgc });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    const table = within(panel).getByRole("table", { name: "Employment history, newest first" });
    const row = within(table).getByRole("button", { name: "Edit Fictional Corp" }).closest("tr")!;
    expect(row).toHaveTextContent("Fictional employer note");
    expect(within(row).getByText("Pending")).toHaveClass("badge", "ver-pending");
    expect(within(table).getByText("Present")).toBeInTheDocument();
    expect(within(panel).getByRole("note")).toHaveTextContent(/Gap: Jul 2023 – Aug 2023 \(2 mo\)/);
    expect(screen.getByRole("tab", { name: "Background check" }).querySelector(".tabdot")).not.toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Mark verified Fictional Corp" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ verification: "verified", expectedVersion: 1 });

    fireEvent.click(within(row).getByRole("button", { name: "Edit Fictional Corp" }));
    const form = within(panel).getByRole("form", { name: "Edit Fictional Corp" });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Change at least one field.");
    fireEvent.click(within(form).getByRole("checkbox", { name: "Currently works here" }));
    fireEvent.change(within(form).getByLabelText("Notes (optional)"), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]!.body).toEqual({ notes: null, endMonth: null, expectedVersion: 1 });
  });

  it("adds an address without a street and removes one after confirming", async () => {
    const ADDR = { ...EMP, id: "a1", kind: "address" as const, employer: null, title: null, street: "1 Fictional Way", city: "Old Town",
      region: "TX", postalCode: "00000", country: "US", startMonth: "2017-06", endMonth: null, notes: null };
    api.routes["GET /api/v1/paperwork/placements/p1"] = () => ({ body: { ...DETAIL, bgc: { ...DETAIL.bgc, addresses: [ADDR] } } });
    api.routes["POST /api/v1/paperwork/placements/p1/bgc/entries"] = () => ({ status: 201, body: DETAIL.bgc });
    api.routes["DELETE /api/v1/paperwork/placements/p1/bgc/entries/a1"] = () => ({ body: DETAIL.bgc });
    wrap(<PaperworkPage me={HR} />);
    const panel = await openPage("Background check");
    const table = within(panel).getByRole("table", { name: "Address history, newest first" });
    expect(within(table).getByText("1 Fictional Way")).toBeInTheDocument();
    expect(within(table).getByText("Old Town, TX, 00000")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "+ Add address" }));
    const form = within(panel).getByRole("form", { name: "Add address" });
    fireEvent.change(within(form).getByLabelText("City"), { target: { value: "Sample City" } });
    fireEvent.change(within(form).getByLabelText("Country"), { target: { value: "India" } });
    fireEvent.change(within(form).getByLabelText("From"), { target: { value: "2015-08" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: "Current address" }));
    fireEvent.change(within(form).getByLabelText("Verification"), { target: { value: "verified" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add address" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ kind: "address", city: "Sample City", country: "India", startMonth: "2015-08", verification: "verified" });

    fireEvent.click(within(table).getByRole("button", { name: "Edit Old Town, TX, US" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Remove" }));
    const dlg = screen.getByRole("dialog", { name: "Remove address?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]).toMatchObject({ method: "DELETE", path: "/api/v1/paperwork/placements/p1/bgc/entries/a1" });
    expect(await screen.findByText("Old Town, TX, US removed.")).toBeInTheDocument();
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
