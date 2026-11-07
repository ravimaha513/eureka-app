import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@eureka/shared";
import { visibleNav } from "../nav";
import { meFor, mockApi, problem, wrap } from "../pipeline/testkit";
import { DashboardPage } from "./DashboardPage";
import { periodRange, type Dashboard } from "./dashboardApi";

const THRESHOLDS = { staleSubmissionDays: 7, feedbackGraceHours: 24, feedbackLookbackDays: 30, placementStallDays: 5 };
const item = (id: string, name: string | null, extra: Partial<Dashboard["needsAttention"]["sections"][number]["items"][number]> = {}) => ({
  id, candidate: { id: `c-${id}`, name }, recruiter: { id: "u1", name: "Priya Shah" }, since: "2026-09-20T10:00:00Z",
  ageDays: 11, status: "submitted", detail: {}, ...extra,
});

const LEAD: Dashboard = {
  period: { from: "2026-09-24T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
  groupBy: "recruiter",
  metrics: ["submissions", "interviewsScheduled", "interviewsCleared", "placementsCreated", "placementsJoined", "candidatesAdded"],
  totals: { submissions: 4, interviewsScheduled: 2, interviewsCleared: 1, placementsCreated: 2, placementsJoined: 1, candidatesAdded: 2 },
  groups: [
    { id: "u1", name: "Priya Shah", counts: { submissions: 3, interviewsScheduled: 2, interviewsCleared: 1, placementsCreated: 1, placementsJoined: 1, candidatesAdded: 1 } },
    { id: null, name: null, counts: { submissions: 1, interviewsScheduled: 0, interviewsCleared: 0, placementsCreated: 1, placementsJoined: 0, candidatesAdded: 1 } },
  ],
  series: [
    { date: "2026-09-29", counts: { submissions: 1, interviewsScheduled: 0, placementsJoined: 0 } },
    { date: "2026-09-30", counts: { submissions: 3, interviewsScheduled: 2, placementsJoined: 1 } },
  ],
  needsAttention: {
    thresholds: THRESHOLDS,
    sections: [
      { kind: "submissionStale", total: 3, items: [item("s1", "Asha Iyer", { detail: { client: "Northwind Financial", jobTitle: "Java Developer" } })] },
      { kind: "interviewFeedbackMissing", total: 0, items: [] },
      { kind: "placementStalled", total: 1, items: [item("p1", null, {
        status: "ready", ageDays: 1, detail: { tentativeStart: "2026-09-28", reason: "start_date_passed" },
      })] },
    ],
  },
};

/** HR: placements and candidates only; no submission or interview access. */
const HR: Dashboard = {
  ...LEAD,
  groupBy: "location",
  metrics: ["placementsCreated", "placementsJoined", "candidatesAdded"],
  totals: { placementsCreated: 3, placementsJoined: 2, candidatesAdded: 5 },
  groups: [{ id: "loc", name: "Dallas", counts: { placementsCreated: 3, placementsJoined: 2, candidatesAdded: 5 } }],
  needsAttention: { thresholds: THRESHOLDS, sections: [{ kind: "placementStalled", total: 0, items: [] }] },
};

let api: ReturnType<typeof mockApi>;
const OPTIONS = { coaches: [{ id: "co1", name: "Meera Coach" }], technologies: [{ id: "t-java", name: "Java" }, { id: "t-py", name: "Python" }] };
beforeEach(() => {
  api = mockApi({ "GET /api/v1/dashboard": () => ({ body: LEAD }), "GET /api/v1/dashboard/filters": () => ({ body: OPTIONS }) });
});
afterEach(() => vi.restoreAllMocks());
const lastQuery = () => api.gets("/api/v1/dashboard").at(-1)!.url.searchParams;

describe("Dashboard", () => {
  it("shows totals as tiles and a breakdown by the server's grouping", async () => {
    wrap(<DashboardPage />);
    const tiles = await screen.findByRole("list", { name: "Activity totals" });
    const tile = (label: string) => within(tiles).getByText(label, { selector: ".tilelabel > span" }).closest("li")!;
    expect(within(tile("Submissions")).getByText("4")).toBeInTheDocument();
    expect(within(tile("Joined")).getByText("1")).toBeInTheDocument();
    expect(within(tile("Candidates added")).getByText("2")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Activity by recruiter" });
    expect(within(table).getByRole("columnheader", { name: "Recruiter" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Priya Shah");
    expect(within(rows[2]!).getByText("Unassigned")).toBeInTheDocument();
    expect(screen.getByLabelText("Group by")).toHaveValue("recruiter");
  });

  it("charts activity over time and lists pipeline activity as period counts, with no bar for zero", async () => {
    api.routes["GET /api/v1/dashboard"] = () => ({ body: { ...LEAD, totals: { ...LEAD.totals, interviewsCleared: 0 } } });
    wrap(<DashboardPage />);
    expect(await screen.findByRole("img", { name: /^Activity per day: Submissions 4 in total, Interviews 2 in total, Interviews cleared 0 in total$/ })).toBeInTheDocument();
    const stages = screen.getByRole("list", { name: "Pipeline activity in the period" });
    const items = within(stages).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Submissions4", "Interviews2", "Interviews cleared0", "Placements2", "Joined1"]);
    expect(items[2]!.querySelector(".dash-bar > span")).toBeNull();
    expect(items[0]!.querySelector(".dash-bar > span")).not.toBeNull();
    expect(screen.getByText(/not a cohort/)).toBeInTheDocument();
    // No part-to-whole charts of unrelated counts.
    expect(screen.queryByRole("img", { name: /^Activity mix/ })).not.toBeInTheDocument();
  });

  it("lets the user choose which metrics the time chart plots", async () => {
    wrap(<DashboardPage />);
    await screen.findByRole("img", { name: /^Activity per day/ });
    const picker = screen.getByRole("group", { name: "Metrics to plot" });
    fireEvent.click(within(picker).getByRole("button", { name: "Interviews" }));
    expect(screen.getByRole("img", { name: /^Activity per day/ }).getAttribute("aria-label")).not.toMatch(/Interviews 2/);
    fireEvent.click(within(picker).getByRole("button", { name: "Joined" }));
    expect(screen.getByRole("img", { name: /^Activity per day/ }).getAttribute("aria-label")).toMatch(/Joined 1 in total/);
  });

  it("asks for the daily series in the browser's time zone", async () => {
    wrap(<DashboardPage />);
    await screen.findByRole("table", { name: "Activity by recruiter" });
    expect(lastQuery().get("tz")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("explains each needs-attention list with the thresholds in use", async () => {
    wrap(<DashboardPage />);
    const stale = await screen.findByRole("region", { name: /^Stale submissions/ });
    expect(within(stale).getByText(/no status change for 7 days or more/)).toBeInTheDocument();
    expect(within(stale).getByText("Northwind Financial · Java Developer")).toBeInTheDocument();
    expect(within(stale).getByText("11 days")).toBeInTheDocument();
    expect(within(stale).getByText("Showing the oldest 1 of 3.")).toBeInTheDocument();

    const feedback = screen.getByRole("region", { name: /^Interviews without feedback/ });
    expect(within(feedback).getByText(/over 24 hours ago \(within the last 30 days\)/)).toBeInTheDocument();
    expect(within(feedback).getByText("Every recent interview has feedback.")).toBeInTheDocument();

    const placements = screen.getByRole("region", { name: /^Placements awaiting the next step/ });
    expect(within(placements).getByText("Not visible to you")).toBeInTheDocument();
    expect(within(placements).getByText(/has passed/)).toBeInTheDocument();
    expect(within(placements).getByText("Ready")).toBeInTheDocument();
  });

  it("shows only the metrics and lists the API returns", async () => {
    api.routes["GET /api/v1/dashboard"] = () => ({ body: HR });
    wrap(<DashboardPage />);
    const table = await screen.findByRole("table", { name: "Activity by location" });
    expect(within(table).queryByRole("columnheader", { name: "Submissions" })).not.toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Placements" })).toBeInTheDocument();
    expect(screen.queryByText("Submissions", { selector: ".tilelabel > span" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Stale submissions/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: /^Placements awaiting/ })).toBeInTheDocument();
  });

  it("requests the chosen period and grouping", async () => {
    wrap(<DashboardPage />);
    await screen.findByRole("table", { name: "Activity by recruiter" });
    const first = lastQuery();
    expect(Date.parse(first.get("to")!) - Date.parse(first.get("from")!)).toBeGreaterThanOrEqual(7 * 86_400_000 - 3_600_000);
    expect(first.get("groupBy")).toBeNull(); // the server picks the default for the role

    fireEvent.click(within(screen.getByRole("group", { name: "Period" })).getByRole("button", { name: "Last 30 days" }));
    await waitFor(() => {
      const q = lastQuery();
      expect(Math.round((Date.parse(q.get("to")!) - Date.parse(q.get("from")!)) / 86_400_000)).toBe(30);
    });
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "team" } });
    await waitFor(() => expect(lastQuery().get("groupBy")).toBe("team"));
  });

  it("opens a needs-attention row on the screen that handles it, when the user has that screen", async () => {
    const onOpen = vi.fn();
    wrap(<DashboardPage canOpen={(t) => t === "placements"} onOpen={onOpen} />);
    const placements = await screen.findByRole("region", { name: /^Placements awaiting/ });
    fireEvent.click(within(placements).getByRole("button", { name: "Open this item in Placements" }));
    expect(onOpen).toHaveBeenCalledWith("placements", "p1");
    const stale = screen.getByRole("region", { name: /^Stale submissions/ });
    expect(within(stale).queryByRole("button", { name: /^Open/ })).not.toBeInTheDocument();
  });

  it("ranks the groups for the chosen metric and sums the open needs-attention items", async () => {
    wrap(<DashboardPage />);
    const rank = await screen.findByRole("list", { name: "Most active by recruiter" });
    const rows = within(rank).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Priya Shah");
    expect(rows[0]).toHaveTextContent("3");
    expect(rows[1]).toHaveTextContent("Unassigned");
    fireEvent.change(screen.getByLabelText("Metric to rank"), { target: { value: "placementsJoined" } });
    expect(within(screen.getByRole("list", { name: "Most active by recruiter" })).getAllByRole("listitem")[0]).toHaveTextContent(/Priya Shah1/);

    expect(screen.getByRole("region", { name: /^Needs attention 4 open$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^All 2 rows in the table/ }));
    expect(document.activeElement).toBe(screen.getByRole("table", { name: "Activity by recruiter" }).parentElement);
  });

  it("lists needs attention before the activity counts and shows five rows until asked for all", async () => {
    const many = Array.from({ length: 7 }, (_, n) => item(`s${n}`, `Cand ${n}`, { ageDays: 20 - n }));
    api.routes["GET /api/v1/dashboard"] = () => ({ body: { ...LEAD, needsAttention: { ...LEAD.needsAttention,
      sections: [{ kind: "submissionStale", total: 7, items: many }] } } });
    wrap(<DashboardPage canOpen={() => true} onOpen={vi.fn()} />);
    const stale = await screen.findByRole("region", { name: /^Stale submissions/ });
    const attention = screen.getByRole("region", { name: /^Needs attention/ });
    const totals = screen.getByRole("list", { name: "Activity totals" });
    expect(attention.compareDocumentPosition(totals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(stale).getAllByRole("button", { name: /^Open Cand/ })).toHaveLength(5);
    fireEvent.click(within(stale).getByRole("button", { name: /^Show all 7/ }));
    expect(within(stale).getAllByRole("button", { name: /^Open Cand/ })).toHaveLength(7);
    expect(within(stale).getByRole("button", { name: /^Show fewer/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("states each change against the previous period as an absolute and a percent, and a zero base as new", async () => {
    let call = 0;
    api.routes["GET /api/v1/dashboard"] = () => (++call % 2 === 1 ? { body: LEAD }
      : { body: { ...LEAD, totals: { submissions: 2, interviewsScheduled: 2, interviewsCleared: 0, placementsCreated: 4, placementsJoined: 1, candidatesAdded: 2 } } });
    wrap(<DashboardPage />);
    const tiles = await screen.findByRole("list", { name: "Activity totals" });
    const tile = (label: string) => within(tiles).getByText(label).closest("li")!;
    await waitFor(() => expect(tile("Submissions")).toHaveTextContent("+2 (+100%)"));
    expect(tile("Interviews")).toHaveTextContent("No change");
    expect(tile("Interviews cleared")).toHaveTextContent("New·prev 0");
    expect(tile("Placements")).toHaveTextContent("−2 (−50%)");
    expect(screen.getByText("Change vs previous 7 days")).toBeInTheDocument();
  });

  it("applies the small-screen filter sheet only on Apply", async () => {
    wrap(<DashboardPage />);
    await screen.findByRole("table", { name: "Activity by recruiter" });
    const before = api.gets("/api/v1/dashboard").length;
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Last 90 days" }));
    fireEvent.change(within(sheet).getByLabelText("Group by"), { target: { value: "location" } });
    expect(api.gets("/api/v1/dashboard")).toHaveLength(before);
    fireEvent.click(within(sheet).getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => {
      const q = lastQuery();
      expect(q.get("groupBy")).toBe("location");
      expect(Math.round((Date.parse(q.get("to")!) - Date.parse(q.get("from")!)) / 86_400_000)).toBe(90);
    });
  });

  it("explains a load failure with a retry", async () => {
    api.routes["GET /api/v1/dashboard"] = () => problem(403, { detail: "Not permitted" });
    wrap(<DashboardPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission");
    api.routes["GET /api/v1/dashboard"] = () => ({ body: LEAD });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table", { name: "Activity by recruiter" })).toBeInTheDocument();
  });
});

describe("Dashboard navigation", () => {
  it.each(["manager", "assoc_director", "ceo", "bu_head"] as Role[])(
    "%s has a Dashboard", (role) => {
      expect(visibleNav(meFor(role).capabilities).map((n) => n.key)).toContain("dashboard");
    });
  it.each(["recruiter", "lead", "location_incharge", "location_ops_admin", "hr", "immigration", "interview_coach", "org_admin",
    "documents_team", "associate_hr"] as Role[])(
    "%s has no Dashboard (no dashboard:read: Manager and above only)", (role) => {
      expect(visibleNav(meFor(role).capabilities).map((n) => n.key)).not.toContain("dashboard");
    });
});

describe("periodRange", () => {
  it("covers whole local days, today included", () => {
    const r = periodRange(7, new Date(2026, 8, 30, 15, 30));
    expect(new Date(r.to)).toEqual(new Date(2026, 9, 1));
    expect(new Date(r.from)).toEqual(new Date(2026, 8, 24));
  });
});

describe("Sales reports (migration 0160)", () => {
  it("groups by manager or candidate and exports the grouped counts for report:export holders", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    api.routes["POST /api/v1/dashboard/export"] = () => ({ body: "csv" });
    wrap(<DashboardPage canExport />);
    await screen.findByRole("table", { name: "Activity by recruiter" });
    const select = screen.getByLabelText("Group by");
    expect(within(select).getByRole("option", { name: "Manager" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Candidate" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "manager" } });
    await waitFor(() => expect(lastQuery().get("groupBy")).toBe("manager"));
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.path).toBe("/api/v1/dashboard/export");
    expect(api.writes()[0]!.body).toMatchObject({ groupBy: "recruiter" }); // the grouping shown (the mock answers recruiter)
  });

  it("offers no export without report:export and says when the groups are cut", async () => {
    api.routes["GET /api/v1/dashboard"] = () => ({ body: { ...LEAD, groupsTruncated: true } });
    wrap(<DashboardPage />);
    await screen.findByRole("table", { name: "Activity by recruiter" });
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
    expect(screen.getByText(/most active; totals include everyone/)).toBeInTheDocument();
  });
});

describe("Coach and technology (migration 0580)", () => {
  const PLACED: Dashboard = {
    ...LEAD,
    groupBy: "coach",
    metrics: ["placementsCreated", "placementsJoined"],
    totals: { placementsCreated: 3, placementsJoined: 1 },
    groups: [
      { id: "co1", name: "Meera Coach", counts: { placementsCreated: 2, placementsJoined: 1 } },
      { id: null, name: null, counts: { placementsCreated: 1, placementsJoined: 0 } },
    ],
  };

  it("groups placements by coach and explains that cleared rounds are not placements", async () => {
    wrap(<DashboardPage />);
    await screen.findByRole("table", { name: "Activity by recruiter" });
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    api.routes["GET /api/v1/dashboard"] = () => ({ body: PLACED });
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "coach" } });
    await waitFor(() => expect(lastQuery().get("groupBy")).toBe("coach"));
    const table = await screen.findByRole("table", { name: "Activity by coach" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Meera Coach");
    expect(within(table).getByText("No coach")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/Cleared L1\/L2 rounds are not placements/);
  });

  it("filters by technology and coach, and exports with the same filters", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    api.routes["POST /api/v1/dashboard/export"] = () => ({ body: "csv" });
    wrap(<DashboardPage canExport />);
    const tech = await screen.findByRole("combobox", { name: "Technology" });
    expect(within(tech).getAllByRole("option").map((o) => o.textContent)).toEqual(["All technologies", "Java", "Python"]);
    fireEvent.change(tech, { target: { value: "t-py" } });
    await waitFor(() => expect(lastQuery().get("technologyId")).toBe("t-py"));
    fireEvent.change(screen.getByRole("combobox", { name: "Coach" }), { target: { value: "co1" } });
    await waitFor(() => expect(lastQuery().get("coachId")).toBe("co1"));
    expect(lastQuery().get("technologyId")).toBe("t-py");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({ technologyId: "t-py", coachId: "co1" });
    // Back to all technologies drops the parameter.
    fireEvent.change(tech, { target: { value: "" } });
    await waitFor(() => expect(lastQuery().get("technologyId")).toBeNull());
  });

  it("hides the filters when there is nothing to choose", async () => {
    api.routes["GET /api/v1/dashboard/filters"] = () => ({ body: { coaches: [], technologies: [] } });
    wrap(<DashboardPage />);
    await screen.findByRole("table", { name: "Activity by recruiter" });
    expect(screen.queryByRole("combobox", { name: "Technology" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Coach" })).not.toBeInTheDocument();
  });
});
