import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meFor, mockApi, wrap } from "../pipeline/testkit";
import { ReportsPage } from "../employees/JoiningsExitsReport";

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/v1/reports/joinings-exits": (url) => ({ body: {
      from: url.searchParams.get("from"), to: url.searchParams.get("to"),
      totals: { joinings: 2, firstPlacements: 1, exits: 1, exitsByReason: { completed: 1, resigned: 0 } },
      byTeam: [{ team: { id: "t1", name: "Team Rohit" }, joinings: 2, exits: 1 }],
      byCompany: [{ company: null, joinings: 2, firstAssignments: 1, laterAssignments: 1, exits: 1 }],
      items: [], truncated: false } }),
    "GET /api/v1/reports/active-employees": () => ({ body: { month: "2026-10", from: "2026-10-01", to: "2026-10-31", total: 0, byClient: [], byCompany: [] } }),
    "GET /api/v1/reports/market": () => ({ body: { asOf: "2026-10-03T12:00:00Z", groupBy: "technology", placedBetween: null, inMarketStatuses: [], placedStatuses: [],
      statuses: [], totals: { candidates: 0, inMarket: 0, placed: 0, placedInPeriod: null, byStatus: {} }, groups: [] } }),
  });
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-03T12:00:00") });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Reports layout (wave 2)", () => {
  it("gives every table a visible heading and lists exits by reason in the Exits tile", async () => {
    wrap(<ReportsPage me={meFor("hr")} />);
    expect(await screen.findByRole("heading", { name: "By team" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "By payroll company" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Events/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Active employees/ })).toBeInTheDocument();
    expect(screen.getByText("Completed").closest("div")).toHaveTextContent("Completed1");
  });

  it("presets set the period; the default is the 90-day preset", async () => {
    wrap(<ReportsPage me={meFor("hr")} />);
    await screen.findByRole("heading", { name: "By team" });
    expect(screen.getByRole("button", { name: "Last 90 days" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
    await waitFor(() => expect(api.gets("/api/v1/reports/joinings-exits").at(-1)!.url.searchParams.get("from")).toBe("2026-09-03"));
    expect(screen.getByRole("button", { name: "Last 30 days" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches report tabs with the arrow keys", async () => {
    wrap(<ReportsPage me={meFor("ceo")} />);
    const list = screen.getByRole("tablist", { name: "Reports" });
    const first = within(list).getByRole("tab", { name: "Joinings and exits" });
    expect(within(list).getByRole("tab", { name: "Market" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(within(list).getByRole("tab", { name: "Market" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("tabpanel")).toHaveTextContent(/Candidates in market/);
  });
});
