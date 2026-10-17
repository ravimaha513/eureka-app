import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meFor, mockApi, problem, wrap } from "../pipeline/testkit";
import { PerformancePage } from "./PerformancePage";
import { dayRange, periodStartOf, type People, type Summary, type Target } from "./performanceApi";

const zero = { submissions: 0, interviews: 0, interviewsCleared: 0, placements: 0, joined: 0 };
const SUMMARY: Summary = {
  period: { from: "2026-09-18T00:00:00.000Z", to: "2026-10-18T00:00:00.000Z" },
  kinds: ["submissions", "interviews", "interviewsCleared", "placements", "joined"],
  totals: { counts: { submissions: 4, interviews: 2, interviewsCleared: 1, placements: 1, joined: 0 },
    ratios: { submissionToInterview: 0.5, interviewToPlacement: 0.5, placement: 0.25 } },
  people: [
    { user: { id: "u-priya", name: "Priya Shah", designation: "Senior Recruiter", active: true }, team: { id: "t1", name: "Team Rohit" },
      counts: { submissions: 3, interviews: 2, interviewsCleared: 1, placements: 1, joined: 0 },
      ratios: { submissionToInterview: 0.667, interviewToPlacement: 0.5, placement: 0.333 } },
    { user: { id: "u-ravi", name: "Ravi Kumar", designation: null, active: true }, team: { id: "t1", name: "Team Rohit" },
      counts: { ...zero, submissions: 1 }, ratios: { submissionToInterview: 0, interviewToPlacement: null, placement: 0 } },
  ],
};
const TARGET: Target = {
  id: "tg1", user: { id: "u-priya", name: "Priya Shah" }, periodKind: "month", periodStart: "2026-10-01", periodEnd: "2026-10-31",
  targets: { submissions: 10, interviews: 4, placements: null }, actuals: { submissions: 3, interviews: 2, placements: null },
  status: "inProgress", setBy: { id: "u-me", name: "Test User" }, updatedAt: "2026-10-02T10:00:00Z", canManage: true,
};
const PEOPLE: People = {
  people: [
    { id: "u-priya", name: "Priya Shah", designation: "Senior Recruiter", team: { id: "t1", name: "Team Rohit" }, memberOfTeamId: "t1",
      canSetTarget: true, canChangeDesignation: true, canMoveTeam: true },
    { id: "u-ravi", name: "Ravi Kumar", designation: null, team: { id: "t1", name: "Team Rohit" }, memberOfTeamId: "t1",
      canSetTarget: true, canChangeDesignation: true, canMoveTeam: true },
  ],
  moveTeams: [{ id: "t1", name: "Team Rohit" }, { id: "t2", name: "Team Anjali" }],
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/v1/performance/summary": () => ({ body: SUMMARY }),
    "GET /api/v1/performance/active-candidates": () => ({ body: { total: 1, truncated: false, items: [{
      placementId: "p1", assignmentId: "a1", candidate: { id: "c1", name: "Asha Iyer" }, client: "Northwind Financial", vendor: "Contoso Staffing",
      implementationPartner: null, workMode: "remote", joiningDate: "2026-09-01", endDate: null, recruiter: { id: "u-priya", name: "Priya Shah" },
      team: "Team Rohit", location: "Dallas" }] } }),
    "GET /api/v1/performance/targets": () => ({ body: { truncated: false, items: [TARGET] } }),
    "GET /api/v1/performance/people": () => ({ body: PEOPLE }),
    "GET /api/v1/performance/activity": () => ({ body: { kind: "submissions", total: 1, items: [{
      id: "s1", at: "2026-10-01T15:00:00Z", candidate: { id: "c9", name: "Meera Rao" }, recruiter: { id: "u-priya", name: "Priya Shah" },
      team: "Team Rohit", client: "Northwind Financial", status: "under_review", detail: { jobTitle: "Java Developer" } }] } }),
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Performance", () => {
  it("shows totals, ratios and one row per person; a count opens its rows", async () => {
    wrap(<PerformancePage me={meFor("manager")} />);
    const table = await screen.findByRole("table", { name: "By person" });
    const priya = within(table).getByText("Priya Shah").closest("tr")!;
    expect(within(priya).getByText("Senior Recruiter")).toBeInTheDocument();
    expect(within(priya).getByText("66.7%")).toBeInTheDocument();
    const ravi = within(table).getByText("Ravi Kumar").closest("tr")!;
    expect(within(ravi).getByText("—")).toBeInTheDocument();
    const totals = screen.getByRole("list", { name: "Totals" });
    expect(within(totals).getByText("25%")).toBeInTheDocument();

    fireEvent.click(within(priya).getByRole("button", { name: "Submissions of Priya Shah: 3" }));
    const rows = await screen.findByRole("table", { name: "Submissions rows" });
    expect(within(rows).getByText("Meera Rao")).toBeInTheDocument();
    const q = api.gets("/api/v1/performance/activity").at(-1)!.url.searchParams;
    expect([q.get("kind"), q.get("userId"), q.get("offset")]).toEqual(["submissions", "u-priya", "0"]);
    expect(q.get("from")).toBe(api.gets("/api/v1/performance/summary").at(-1)!.url.searchParams.get("from"));

    const active = screen.getByRole("table", { name: "Active candidates" });
    expect(within(active).getByText("Asha Iyer")).toBeInTheDocument();
    expect(within(active).getByText("Contoso Staffing")).toBeInTheDocument();
  });

  it("a manager sets a target for the period containing the chosen day", async () => {
    api.routes["PUT /api/v1/performance/targets"] = () => ({ body: { created: true, target: TARGET } });
    wrap(<PerformancePage me={meFor("manager")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set target" }));
    const dialog = await screen.findByRole("dialog", { name: "Set target" });
    await waitFor(() => expect(within(dialog).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Person" }), { target: { value: "u-ravi" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Period" }), { target: { value: "week" } });
    fireEvent.change(within(dialog).getByLabelText("Any day in the period"), { target: { value: "2026-10-15" } });
    fireEvent.change(within(dialog).getByLabelText("Submissions"), { target: { value: "8" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save target" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ method: "PUT", path: "/api/v1/performance/targets",
      body: { userId: "u-ravi", periodKind: "week", periodStart: "2026-10-12", submissions: 8, interviews: null, placements: null } });
    expect(await screen.findByRole("status")).toHaveTextContent("Target set for Ravi Kumar.");
  });

  it("shows server errors in the dialog", async () => {
    api.routes["PUT /api/v1/users/u-ravi/designation"] = () => problem(403, { detail: "not_in_scope" });
    wrap(<PerformancePage me={meFor("manager")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change designation of Ravi Kumar" }));
    const dialog = await screen.findByRole("dialog", { name: "Designation of Ravi Kumar" });
    fireEvent.change(within(dialog).getByLabelText("Designation"), { target: { value: "Recruiter II" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("That person is outside your hierarchy.");
    expect(api.writes()[0]).toMatchObject({ body: { designation: "Recruiter II" } });
  });

  it("moves a person to another team through the team move endpoint", async () => {
    api.routes["POST /api/v1/teams/t1/move-member"] = () => ({ body: { movedCandidates: 2, reassignedTo: { id: "u-lead", displayName: "Rohit Lead" } } });
    wrap(<PerformancePage me={meFor("manager")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Move Priya Shah to another team" }));
    const dialog = await screen.findByRole("dialog", { name: "Move Priya Shah to another team" });
    expect(within(dialog).queryByRole("option", { name: "Team Rohit" })).toBeNull();
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Move to team" }), { target: { value: "t2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Moved Priya Shah to Team Anjali. 2 candidates reassigned to Rohit Lead.");
    expect(api.writes()[0]).toMatchObject({ body: { userId: "u-priya", toTeamId: "t2" } });
  });

  it("a recruiter reads their numbers and targets without the manager actions", async () => {
    api.routes["GET /api/v1/performance/targets"] = () => ({ body: { truncated: false, items: [{ ...TARGET, canManage: false }] } });
    api.routes["GET /api/v1/performance/people"] = () => ({ body: { people: [{ ...PEOPLE.people[0]!, canSetTarget: false, canChangeDesignation: false, canMoveTeam: false }], moveTeams: [] } });
    wrap(<PerformancePage me={meFor("recruiter")} />);
    const targets = await screen.findByRole("table", { name: "Targets" });
    expect(within(targets).getByText("3 / 10")).toBeInTheDocument();
    expect(within(targets).getByText("In progress")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set target" })).toBeNull();
    expect(within(targets).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("table", { name: "Teams and designations" })).toBeNull();
  });

  it("refuses an inverted period without calling the API", async () => {
    wrap(<PerformancePage me={meFor("lead")} />);
    await screen.findByRole("table", { name: "By person" });
    const n = api.gets("/api/v1/performance/summary").length;
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2030-01-01" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a start date on or before the end date.");
    expect(api.gets("/api/v1/performance/summary")).toHaveLength(n);
  });
});

describe("period helpers", () => {
  it("finds the start of the week, month and quarter", () => {
    expect(periodStartOf("week", "2026-10-15")).toBe("2026-10-12");
    expect(periodStartOf("week", "2026-10-12")).toBe("2026-10-12");
    expect(periodStartOf("week", "2026-10-18")).toBe("2026-10-12");
    expect(periodStartOf("month", "2026-10-15")).toBe("2026-10-01");
    expect(periodStartOf("quarter", "2026-11-30")).toBe("2026-10-01");
    expect(periodStartOf("quarter", "2026-03-31")).toBe("2026-01-01");
  });

  it("turns local days into an instant range ending at the next midnight", () => {
    const r = dayRange("2026-10-01", "2026-10-07");
    expect(Date.parse(r.to) - Date.parse(r.from)).toBeGreaterThanOrEqual(7 * 86_400_000 - 3_600_000);
    expect(new Date(r.from).getDate()).toBe(1);
  });
});
