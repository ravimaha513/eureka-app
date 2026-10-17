import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meFor, mockApi, problem, wrap } from "../pipeline/testkit";
import { ReportsPage } from "./JoiningsExitsReport";
import type { MarketReport } from "./marketReportApi";

const STATUSES = ["in_training", "active", "on_hold", "stopped", "full_of_interviews", "confirmation", "placed", "bench", "terminated"];
const by = (o: Record<string, number>) => Object.fromEntries(STATUSES.map((s) => [s, o[s] ?? 0]));
const REPORT: MarketReport = {
  asOf: "2026-10-03T12:00:00Z", groupBy: "technology", placedBetween: null,
  inMarketStatuses: ["active", "full_of_interviews"], placedStatuses: ["placed"], statuses: STATUSES,
  totals: { candidates: 7, inMarket: 4, placed: 2, placedInPeriod: null, byStatus: by({ active: 3, full_of_interviews: 1, placed: 2, bench: 1 }) },
  groups: [
    { id: "java", name: "Java", candidates: 5, inMarket: 3, placed: 2, placedInPeriod: null, byStatus: by({ active: 2, full_of_interviews: 1, placed: 2 }) },
    { id: null, name: null, candidates: 2, inMarket: 1, placed: 0, placedInPeriod: null, byStatus: by({ active: 1, bench: 1 }) },
  ],
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/v1/reports/joinings-exits": () => ({ body: { from: "2026-07-05", to: "2026-10-03", totals: { joinings: 0, firstPlacements: 0, exits: 0, exitsByReason: {} }, byTeam: [], items: [], truncated: false } }),
    "GET /api/v1/reports/market": (url) => ({
      body: url.searchParams.get("placedFrom")
        ? { ...REPORT, placedBetween: { from: url.searchParams.get("placedFrom"), to: url.searchParams.get("placedTo"), timeZone: "America/New_York" },
            totals: { ...REPORT.totals, placedInPeriod: 1 }, groups: REPORT.groups.map((g) => ({ ...g, placedInPeriod: g.id ? 1 : 0 })) }
        : { ...REPORT, groupBy: url.searchParams.get("groupBy") ?? "technology" },
    }),
  });
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-03T12:00:00") });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const openMarket = async () => {
  fireEvent.click(await screen.findByRole("tab", { name: "Market" }));
  return screen.findByRole("table", { name: "Market by technology" });
};
const lastQuery = () => api.gets("/api/v1/reports/market").at(-1)!.url.searchParams;

describe("Reports > Market", () => {
  it("is a tab only for report.market:read holders", async () => {
    wrap(<ReportsPage me={meFor("hr")} />);
    await screen.findByText("Joinings", { selector: ".tilelabel" });
    expect(screen.queryByRole("tab", { name: "Market" })).not.toBeInTheDocument();
    expect(api.gets("/api/v1/reports/market")).toHaveLength(0);
  });

  it("shows totals, groups with the per-status breakdown and a total row; missing values get a label", async () => {
    wrap(<ReportsPage me={meFor("ceo")} />);
    expect(screen.getByRole("tab", { name: "Joinings and exits" })).toHaveAttribute("aria-selected", "true");
    const table = await openMarket();
    expect(screen.getByRole("tab", { name: "Market" })).toHaveAttribute("aria-selected", "true");
    expect(lastQuery().get("groupBy")).toBe("technology");
    expect([...lastQuery().keys()]).toEqual(["groupBy"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4); // header, Java, no technology, total
    expect(within(rows[1]!).getAllByRole("cell").slice(0, 3).map((c) => c.textContent)).toEqual(["5", "3", "2"]);
    expect(within(rows[2]!).getByText("No technology")).toBeInTheDocument();
    expect(within(rows[3]!).getByRole("rowheader")).toHaveTextContent("Total");
    expect(within(rows[3]!).getAllByRole("cell")[0]).toHaveTextContent("7");
    expect(screen.getByText("In market", { selector: ".tilelabel" }).nextSibling).toHaveTextContent("4");
    expect(within(table).queryByRole("columnheader", { name: /Placed .*–/ })).not.toBeInTheDocument();
  });

  it("regroups and adds a placed-between column; refuses an inverted period without calling the server", async () => {
    wrap(<ReportsPage me={meFor("ceo")} />);
    await openMarket();
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "batch" } });
    await waitFor(() => expect(lastQuery().get("groupBy")).toBe("batch"));
    expect(await screen.findByRole("table", { name: "Market by batch" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Placed from"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Placed through"), { target: { value: "2026-09-30" } });
    await waitFor(() => expect([lastQuery().get("placedFrom"), lastQuery().get("placedTo")]).toEqual(["2026-09-01", "2026-09-30"]));
    expect(await screen.findByText("Placed in period", { selector: ".tilelabel" })).toBeInTheDocument();

    const n = api.gets("/api/v1/reports/market").length;
    fireEvent.change(screen.getByLabelText("Placed from"), { target: { value: "2026-10-15" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("on or before");
    expect(api.gets("/api/v1/reports/market")).toHaveLength(n);
    fireEvent.click(screen.getByRole("button", { name: "Clear dates" }));
    await waitFor(() => expect(lastQuery().get("placedFrom")).toBeNull());
  });

  it("exports with the current options for report:export holders and reports a rate limit", async () => {
    let calls = 0;
    api.routes["POST /api/v1/reports/market/export"] = () => (++calls === 1 ? { body: "csv" } : problem(429, { detail: "Too many exports; try again in a few minutes" }));
    const created: Blob[] = [];
    Object.assign(URL, { createObjectURL: (b: Blob) => { created.push(b); return "blob:x"; }, revokeObjectURL: () => undefined });
    wrap(<ReportsPage me={meFor("lead")} />);
    await openMarket();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ groupBy: "technology" });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many exports");
  });

  it("location roles see the tab without an export button", async () => {
    wrap(<ReportsPage me={meFor("location_incharge")} />);
    await openMarket();
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });
});
