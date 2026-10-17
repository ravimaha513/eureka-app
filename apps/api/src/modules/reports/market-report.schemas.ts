import { z } from "zod";
import { MARKET_REPORT_GROUPS } from "@eureka/shared";

/**
 * GET /api/v1/reports/market and POST /api/v1/reports/market/export
 * (docs/market-reports-api.md MR-1, MR-2). The counts are point in time; the
 * optional "placed between" days (inclusive, America/New_York) add a count of
 * candidates whose placement joined in that window. Either bound may be left
 * open; both together span at most five years.
 */
export const MarketReportQuery = z
  .object({
    groupBy: z.enum(MARKET_REPORT_GROUPS).default("technology"),
    placedFrom: z.string().date().optional(),
    placedTo: z.string().date().optional(),
  })
  .strict()
  .refine((q) => !q.placedFrom || !q.placedTo || q.placedFrom <= q.placedTo,
    { message: "placedFrom must be on or before placedTo", path: ["placedTo"] })
  .refine((q) => !q.placedFrom || !q.placedTo || (Date.parse(q.placedTo) - Date.parse(q.placedFrom)) / 86_400_000 <= 1827,
    { message: "the period can span at most five years", path: ["placedTo"] });
export type MarketReportQuery = z.infer<typeof MarketReportQuery>;
