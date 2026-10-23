/** Typed client for the CEO market reports (docs/market-reports-api.md MR-1, MR-2). */
import type { MarketReportGroup } from "@eureka/shared";
import { api } from "../api";
import { fetchCsv, type ExportResult } from "../lib/download";

export interface MarketCounts {
  candidates: number;
  inMarket: number;
  placed: number;
  /** null when no "placed between" window was asked for. */
  placedInPeriod: number | null;
  byStatus: Record<string, number>;
}
export interface MarketGroup extends MarketCounts { id: string | null; name: string | null }
export interface MarketReport {
  asOf: string;
  groupBy: MarketReportGroup;
  placedBetween: { from: string | null; to: string | null; timeZone: string } | null;
  inMarketStatuses: string[];
  placedStatuses: string[];
  statuses: string[];
  totals: MarketCounts;
  groups: MarketGroup[];
}
export interface MarketFilters { groupBy: MarketReportGroup; placedFrom?: string; placedTo?: string }

const clean = (f: MarketFilters) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Record<string, string>;

export const marketReportApi = {
  get: (f: MarketFilters) => api<MarketReport>(`/api/v1/reports/market?${new URLSearchParams(clean(f)).toString()}`),
  exportCsv: (f: MarketFilters): Promise<ExportResult> => fetchCsv("/api/v1/reports/market/export", clean(f), "market-report.csv"),
};

export const marketKeys = {
  report: (f: MarketFilters) => ["reports", "market", f.groupBy, f.placedFrom ?? "", f.placedTo ?? ""] as const,
};

export const GROUP_LABELS: Record<MarketReportGroup, string> = {
  technology: "Technology", batch: "Batch", location: "Location", team: "Team", lead: "Lead", recruiter: "Recruiter",
};
/** Row label for candidates without a value for the grouping. */
export const NO_VALUE: Record<MarketReportGroup, string> = {
  technology: "No technology", batch: "No batch", location: "No location", team: "No team", lead: "No lead", recruiter: "Unassigned",
};
