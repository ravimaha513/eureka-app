import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilities, type Permission, type Role } from "@eureka/shared";
import { visibleNav } from "../nav";
import { InterviewReportsPage } from "./InterviewReportsPage";
import { InterviewsPage, type Interview } from "./InterviewsPage";

const capsFor = (role: Role) =>
  capabilities({ userId: "u1", roles: [{ role, locationId: "loc" }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], subtreeCoachedTeamIds: [] });
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(typeof value === "string" ? value : JSON.stringify(value), { headers });
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

afterEach(() => vi.restoreAllMocks());

describe("interview reports navigation", () => {
  it.each([
    ["lead", true], ["manager", true], ["ceo", true], ["location_incharge", true], ["recruiter", true],
    // report:read without interview:read, or interview:read without report:read.
    ["hr", false], ["accounts", false], ["interview_coach", false], ["org_admin", false],
  ] as const)("%s sees Interview reports: %s", (role, shown) => {
    expect(visibleNav(capsFor(role)).some((n) => n.key === "interview-reports")).toBe(shown);
  });
});

const group = { key: "c1", label: "Coach One", interviews: 4, cleared: 2, completed: 3, totalDurationMin: 240, avgDurationMin: 60 };
const daily = {
  from: "x", to: "y", truncated: false, totals: { interviews: 2, cleared: 1, withCandidateFeedback: 1 },
  items: [
    { id: "i1", startsAt: "2026-10-01T14:00:00Z", endsAt: "2026-10-01T15:00:00Z", durationMin: 60, round: "L1", callStatus: "completed", cleared: true,
      candidate: { id: "c", name: "Alex Doe" }, technology: "Java", client: "Acme", recruiter: "Rita", team: "Team A", location: "Dallas",
      coach: { id: "c1", name: "Coach One" }, candidateFeedback: { rating: 4, notes: "Went well", format: null, nextStep: "Round 2", submittedAt: "2026-10-01T16:00:00Z" } },
    { id: "i2", startsAt: "2026-10-01T17:00:00Z", endsAt: "2026-10-01T17:30:00Z", durationMin: 30, round: "L2", callStatus: "scheduled", cleared: false,
      candidate: { id: "d", name: "Bo Lee" }, technology: "Python", client: null, recruiter: "Rita", team: "Team A", location: null,
      coach: null, candidateFeedback: null },
  ],
};

function setupReports(caps: Permission[]) {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes("/daily/export")) return json("csv", { "content-disposition": `attachment; filename="interviews-daily-2026-10-01.csv"`, "x-export-rows": "2", "x-export-truncated": "false" });
    if (path.includes("/export")) return json("csv", { "content-disposition": `attachment; filename="interviews-by-coach-2026-10-01.csv"`, "x-export-rows": "1", "x-export-truncated": "false" });
    if (path.includes("/daily")) return json(daily);
    return json({ from: "x", to: "y", groupBy: new URL(path, "http://h").searchParams.get("groupBy"), truncated: false, groups: [group],
      totals: { interviews: 4, cleared: 2, completed: 3, totalDurationMin: 240, avgDurationMin: 60 } });
  });
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  wrap(<InterviewReportsPage me={{ capabilities: caps }} />);
  return fetch;
}

describe("interview reports page", () => {
  it("shows totals and groups, switches the grouping, and exports with report:export", async () => {
    const fetch = setupReports(["report:read", "interview:read", "report:export"]);
    const table = await screen.findByRole("table", { name: "Interviews by interview coach" });
    expect(within(table).getByText("Coach One")).toBeInTheDocument();
    expect(within(table).getByText("4 h 0 min")).toBeInTheDocument();
    expect(screen.getByText("50% of interviews")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "duration" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("groupBy=duration"), expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/reports/interviews/export", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("Exported 1 row.")).toBeInTheDocument();
  });

  it("hides the export without report:export", async () => {
    setupReports(["report:read", "interview:read"]);
    await screen.findByRole("table", { name: "Interviews by interview coach" });
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("daily report highlights cleared rows and shows the candidate's feedback", async () => {
    setupReports(["report:read", "interview:read", "report:export"]);
    fireEvent.click(screen.getByRole("tab", { name: "Daily interviews" }));
    const table = await screen.findByRole("table", { name: "Daily interviews" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveClass("row-cleared");
    expect(rows[1]).not.toHaveClass("row-cleared");
    expect(within(rows[0]!).getByRole("img", { name: "Candidate rating: 4 out of 5" })).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Went well")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Next step: Round 2")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("No feedback yet")).toBeInTheDocument();
    expect(screen.getByText("2 interviews, 1 cleared, 1 with candidate feedback.")).toBeInTheDocument();
  });
});

describe("interview board", () => {
  const row: Interview = {
    id: "i1", submissionId: "s1", candidate: { id: "c", name: "Alex Doe" }, recruiter: { id: "u", name: "Recruiter" }, team: null, location: null,
    client: null, round: "Technical", startsAt: "2026-10-01T14:00:00Z", endsAt: "2026-10-01T15:00:00Z", coach: null, inviteReceived: false,
    callStatus: "completed", cleared: true, consentCaptured: false, otterUrl: null, recordingUrl: null, systemName: null,
    editableFields: [], feedbackKinds: [], candidateFeedback: { rating: 5, notes: "Great panel", submittedAt: "2026-10-01T16:10:00Z" },
  };
  it("highlights cleared rows green and shows the candidate feedback column", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes("/lookups")) return json({ technologies: [], clients: [], vendors: [], implementationPartners: [], roles: [], coaches: [], locations: [] });
      return json({ items: [row, { ...row, id: "i2", candidate: { id: "d", name: "Bo Lee" }, cleared: false, candidateFeedback: null }], nextCursor: null });
    });
    wrap(<InterviewsPage me={{ id: "u", email: "a@example.com", displayName: "R", roles: [], capabilities: ["interview:read"], csrfToken: "t" }} />);
    const alex = (await screen.findByText("Alex Doe")).closest("tr")!;
    expect(screen.getByRole("columnheader", { name: "Candidate feedback" })).toBeInTheDocument();
    expect(alex).toHaveClass("row-cleared");
    expect(within(alex).getByRole("img", { name: "Candidate rating: 5 out of 5" })).toBeInTheDocument();
    expect(within(alex).getByText("Great panel")).toBeInTheDocument();
    const bo = screen.getByText("Bo Lee").closest("tr")!;
    expect(bo).not.toHaveClass("row-cleared");
    expect(within(bo).getByText("No feedback yet")).toBeInTheDocument();
  });
});
