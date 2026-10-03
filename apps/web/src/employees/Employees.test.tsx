import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meFor, mockApi, problem, wrap, type Handler } from "../pipeline/testkit";
import { EmployeesPage } from "./EmployeesPage";
import { ReportsPage } from "./JoiningsExitsReport";
import type { Employee, EmployeeDetail, JoiningsExits } from "./employeesApi";

const NONE = { endAssignment: false, setEndDate: false, exit: false, returnToMarket: false };
const emp = (id: string, extra: Partial<Employee> = {}): Employee => ({
  id, candidate: { id: `c-${id}`, name: "Asha Iyer" }, status: "on_assignment", employeeSince: "2026-06-01", statusSince: "2026-06-01",
  exitedOn: null, exitReason: null, location: { id: "loc", name: "Dallas" }, team: { id: "t1", name: "Team Rohit" },
  assignment: { id: `a-${id}`, assignmentNo: 1, placementId: `p-${id}`, startDate: "2026-06-01", endDate: null, endReason: null, plannedEndDate: "2026-10-20", client: { id: "cl1", name: "Northwind Financial" } },
  actions: { endAssignment: true, setEndDate: true, exit: false, returnToMarket: false },
  ...extra,
});
const E1 = emp("e1");
const E2 = emp("e2", {
  candidate: { id: "c-e2", name: "Divya Menon" }, status: "bench", statusSince: "2026-09-15",
  assignment: { id: "a-e2", assignmentNo: 2, placementId: "p-e2", startDate: "2026-01-05", endDate: "2026-09-15", endReason: "completed", plannedEndDate: null, client: { id: "cl1", name: "Northwind Financial" } },
  actions: { endAssignment: false, setEndDate: false, exit: true, returnToMarket: true },
});
const detail = (e: Employee, extra: Partial<EmployeeDetail> = {}): EmployeeDetail => ({
  ...e,
  assignments: e.assignment ? [{ ...e.assignment, client: e.assignment.client!, isFirstPlacement: true }] : [],
  history: [
    { id: "2", kind: "end_date_set", at: "2026-09-01T10:00:00Z", actor: "HR One", assignmentId: e.assignment?.id ?? null, fromStatus: "on_assignment", toStatus: "on_assignment", effectiveOn: "2026-10-20", previousOn: null, reason: null },
    { id: "1", kind: "started", at: "2026-06-01T10:00:00Z", actor: "Rohit", assignmentId: e.assignment?.id ?? null, fromStatus: null, toStatus: "on_assignment", effectiveOn: "2026-06-01", previousOn: null, reason: null },
  ],
  ...extra,
});

let api: ReturnType<typeof mockApi>;
const base = (): Record<string, Handler> => ({
  "GET /api/v1/employees": () => ({ body: { items: [E1, E2], nextCursor: null } }),
  "GET /api/v1/employees/e1": () => ({ body: detail(E1) }),
  "GET /api/v1/employees/e2": () => ({ body: detail(E2) }),
  "GET /api/v1/lookups": () => ({ body: { technologies: [], clients: [{ id: "cl1", name: "Northwind Financial" }], vendors: [], implementationPartners: [], locations: [{ id: "loc", name: "Dallas" }], coaches: [] } }),
});
beforeEach(() => {
  api = mockApi(base());
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-03T12:00:00") });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const lastList = () => api.gets("/api/v1/employees").at(-1)!.url.searchParams;
const rowOf = async (name: string) => (await screen.findByText(name, { selector: "b" })).closest("tr")!;
const openDrawer = async (name: string) => {
  fireEvent.click(within(await rowOf(name)).getByRole("button", { name: `Open employee ${name}` }));
  return screen.findByRole("dialog", { name: name });
};

describe("Employees list", () => {
  it("shows status, current client, assignment and planned end", async () => {
    wrap(<EmployeesPage me={meFor("hr")} />);
    const r1 = await rowOf("Asha Iyer");
    expect(within(r1).getByText("On assignment")).toHaveClass("badge", "emp-on_assignment");
    expect(within(r1).getByText("Northwind Financial")).toBeInTheDocument();
    expect(within(r1).getByText(/No\. 1/)).toBeInTheDocument();
    const r2 = await rowOf("Divya Menon");
    expect(within(r2).getByText("Bench")).toHaveClass("badge", "emp-bench");
    expect(screen.getByText("2 employees on page 1.")).toBeInTheDocument();
  });

  it("filters by status, location, client, ending soon and name", async () => {
    wrap(<EmployeesPage me={meFor("hr")} />);
    await rowOf("Asha Iyer");
    fireEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Bench" }));
    await waitFor(() => expect(lastList().get("status")).toBe("bench"));
    fireEvent.change(await screen.findByRole("combobox", { name: "Location" }), { target: { value: "loc" } });
    await waitFor(() => expect(lastList().get("locationId")).toBe("loc"));
    fireEvent.change(screen.getByRole("combobox", { name: "Current client" }), { target: { value: "cl1" } });
    await waitFor(() => expect(lastList().get("clientId")).toBe("cl1"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Ending within 30 days/ }));
    await waitFor(() => expect(lastList().get("endingWithinDays")).toBe("30"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Name" }), { target: { value: "Div" } });
    await waitFor(() => expect(lastList().get("search")).toBe("Div"));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect([...lastList().keys()]).toEqual(["limit"]));
  });

  it("explains a load failure with a retry", async () => {
    api.routes["GET /api/v1/employees"] = () => problem(403);
    wrap(<EmployeesPage me={meFor("hr")} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("Employee drawer", () => {
  it("shows assignment history and history entries", async () => {
    wrap(<EmployeesPage me={meFor("hr")} />);
    const d = await openDrawer("Asha Iyer");
    const table = await within(d).findByRole("table", { name: "Assignments" });
    expect(within(table).getByText("First placement")).toBeInTheDocument();
    expect(within(table).getByText("Ongoing")).toBeInTheDocument();
    const hist = within(d).getByRole("list", { name: "History" });
    expect(within(hist).getByText(/Planned end set to/)).toBeInTheDocument();
    expect(within(hist).getByText("Assignment started")).toBeInTheDocument();
  });

  it("offers only the actions the server allows (read-only roles see none)", async () => {
    api.routes["GET /api/v1/employees/e1"] = () => ({ body: detail({ ...E1, actions: NONE }) });
    wrap(<EmployeesPage me={meFor("ceo")} />);
    const d = await openDrawer("Asha Iyer");
    await within(d).findByRole("table", { name: "Assignments" });
    expect(within(d).queryByRole("group", { name: "Actions" })).not.toBeInTheDocument();
  });

  it("ends an assignment with a date and a reason", async () => {
    api.routes["POST /api/v1/assignments/a-e1/end"] = () => ({ body: { id: "a-e1", employeeStatus: "bench" } });
    wrap(<EmployeesPage me={meFor("hr")} />);
    const d = await openDrawer("Asha Iyer");
    fireEvent.click(within(d).getByRole("button", { name: /End assignment/ }));
    const dlg = await screen.findByRole("dialog", { name: /End the assignment of Asha Iyer/ });
    fireEvent.change(within(dlg).getByLabelText("Last day"), { target: { value: "2026-10-01" } });
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Reason" }), { target: { value: "resigned" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "End assignment" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ endDate: "2026-10-01", reason: "resigned" });
    expect(await screen.findAllByText("Assignment ended. The employee is on the bench.")).not.toHaveLength(0);
  });

  it("refuses a future end date in the form, and shows server refusals in the dialog", async () => {
    api.routes["POST /api/v1/assignments/a-e1/end"] = () => problem(422, { detail: "assignment_closed" });
    wrap(<EmployeesPage me={meFor("hr")} />);
    const d = await openDrawer("Asha Iyer");
    fireEvent.click(within(d).getByRole("button", { name: /End assignment/ }));
    const dlg = await screen.findByRole("dialog", { name: /End the assignment/ });
    fireEvent.change(within(dlg).getByLabelText("Last day"), { target: { value: "2026-10-09" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "End assignment" }));
    expect(await within(dlg).findByText(/can't be in the future/)).toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText("Last day"), { target: { value: "2026-10-02" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "End assignment" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("already ended");
  });

  it("extends the planned end date", async () => {
    api.routes["PUT /api/v1/assignments/a-e1/planned-end-date"] = () => ({ body: { id: "a-e1", plannedEndDate: "2027-01-31" } });
    wrap(<EmployeesPage me={meFor("accounts")} />);
    const d = await openDrawer("Asha Iyer");
    fireEvent.click(within(d).getByRole("button", { name: /Extend or change end date/ }));
    const dlg = await screen.findByRole("dialog", { name: /planned end date for Asha Iyer/ });
    fireEvent.change(within(dlg).getByLabelText("Planned end date"), { target: { value: "2027-01-31" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save end date" }));
    await waitFor(() => expect(api.writes()[0]?.body).toEqual({ plannedEndDate: "2027-01-31" }));
  });

  it("records an exit and returns a benched employee to marketing", async () => {
    api.routes["POST /api/v1/employees/e2/exit"] = () => ({ body: { id: "e2", status: "exited" } });
    api.routes["POST /api/v1/employees/e2/return-to-market"] = () => ({ body: { id: "e2", candidateStatus: "active" } });
    wrap(<EmployeesPage me={meFor("hr")} />);
    const d = await openDrawer("Divya Menon");
    fireEvent.click(within(d).getByRole("button", { name: /Reassign: return to marketing/ }));
    const conf = await screen.findByRole("dialog", { name: /Return Divya Menon to marketing/ });
    fireEvent.click(within(conf).getByRole("button", { name: "Return to marketing" }));
    await waitFor(() => expect(api.writes().map((w) => w.path)).toEqual(["/api/v1/employees/e2/return-to-market"]));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Divya Menon" })).getByRole("button", { name: /Record exit/ }));
    const ex = await screen.findByRole("dialog", { name: /Divya Menon left the company/ });
    fireEvent.change(within(ex).getByRole("combobox", { name: "Reason" }), { target: { value: "other" } });
    fireEvent.click(within(ex).getByRole("button", { name: "Record exit" }));
    await waitFor(() => expect(api.writes().at(-1)!.body).toEqual({ exitDate: "2026-10-03", reason: "other" }));
  });
});

const REPORT: JoiningsExits = {
  from: "2026-07-05", to: "2026-10-03",
  totals: { joinings: 2, firstPlacements: 1, exits: 1, exitsByReason: { completed: 1, terminated: 0, resigned: 0, bgc_failed: 0 } },
  byTeam: [{ team: { id: "t1", name: "Team Rohit" }, joinings: 2, exits: 1 }],
  items: [
    { kind: "exit", date: "2026-09-15", assignmentId: "a2", assignmentNo: 2, placementId: "p2", candidate: { id: "c2", name: "Divya Menon" }, client: "Northwind Financial", team: { id: "t1", name: "Team Rohit" }, recruiter: "r1a", location: "Dallas", isFirstPlacement: false, endReason: "completed" },
    { kind: "joining", date: "2026-08-01", assignmentId: "a1", assignmentNo: 1, placementId: "p1", candidate: { id: "c1", name: null }, client: "Northwind Financial", team: null, recruiter: null, location: null, isFirstPlacement: true, endReason: null },
  ],
  truncated: false,
};

describe("Joinings and exits report", () => {
  beforeEach(() => {
    api.routes["GET /api/v1/reports/joinings-exits"] = () => ({ body: REPORT });
  });

  it("loads the last 90 days with totals, teams and rows; hidden names stay hidden", async () => {
    wrap(<ReportsPage me={meFor("hr")} />);
    expect(await screen.findByText("Joinings", { selector: ".tilelabel" })).toBeInTheDocument();
    const q = api.gets("/api/v1/reports/joinings-exits").at(-1)!.url.searchParams;
    expect([q.get("from"), q.get("to")]).toEqual(["2026-07-05", "2026-10-03"]);
    const rows = within(screen.getByRole("table", { name: "Joinings and exits" })).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[2]!).getByText("Name hidden")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("First placement")).toBeInTheDocument();
    // HR reads reports but holds no report:export.
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("validates the period without calling the server", async () => {
    wrap(<ReportsPage me={meFor("hr")} />);
    await screen.findByText("Joinings", { selector: ".tilelabel" });
    const n = api.gets("/api/v1/reports/joinings-exits").length;
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-01" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("on or before");
    expect(api.gets("/api/v1/reports/joinings-exits")).toHaveLength(n);
  });

  it("exports for report:export holders and reports a rate limit", async () => {
    let calls = 0;
    api.routes["POST /api/v1/reports/joinings-exits/export"] = () => (++calls === 1 ? { body: "csv" } : problem(429, { detail: "Too many exports; try again in a few minutes" }));
    const created: Blob[] = [];
    Object.assign(URL, { createObjectURL: (b: Blob) => { created.push(b); return "blob:x"; }, revokeObjectURL: () => undefined });
    wrap(<ReportsPage me={meFor("lead")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ from: "2026-07-05", to: "2026-10-03" });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many exports");
  });
});
