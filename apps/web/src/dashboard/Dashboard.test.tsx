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
beforeEach(() => { api = mockApi({ "GET /api/v1/dashboard": () => ({ body: LEAD }) }); });
afterEach(() => vi.restoreAllMocks());
const lastQuery = () => api.gets("/api/v1/dashboard").at(-1)!.url.searchParams;

describe("Dashboard", () => {
  it("shows totals as tiles and a breakdown by the server's grouping", async () => {
    wrap(<DashboardPage />);
    const tiles = await screen.findByRole("list");
    const tile = (label: string) => within(tiles).getByText(label, { selector: ".tilelabel" }).closest("li")!;
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

  it("charts activity over time, the funnel, the mix, the share by group and the needs-attention split", async () => {
    wrap(<DashboardPage />);
    expect(await screen.findByRole("img", { name: /^Activity per day: Submissions 4 in total, Interviews 2 in total, Interviews cleared 0 in total$/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Pipeline funnel: Submissions 4, Interviews 2/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Activity mix: Submissions 4, Interviews 2/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Submissions by recruiter: Priya Shah 3, Unassigned 1" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Needs attention by kind: Stale submissions 3/ })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Metric to chart" })).getByRole("button", { name: "Joined" }));
    expect(screen.getByRole("img", { name: "Joined by recruiter: Priya Shah 1, Unassigned 0" })).toBeInTheDocument();
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
    expect(screen.queryByText("Submissions", { selector: ".tilelabel" })).not.toBeInTheDocument();
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
  it.each(["recruiter", "lead", "manager", "assoc_director", "location_incharge", "location_ops_admin", "ceo", "hr", "bu_head"] as Role[])(
    "%s has a Dashboard", (role) => {
      expect(visibleNav(meFor(role).capabilities).map((n) => n.key)).toContain("dashboard");
    });
  it.each(["interview_coach", "org_admin", "immigration", "documents_team", "associate_hr"] as Role[])(
    "%s has no Dashboard (no report:read)", (role) => {
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
