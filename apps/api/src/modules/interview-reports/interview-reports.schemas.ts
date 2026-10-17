import { z } from "zod";
import { INTERVIEW_REPORT_GROUPS } from "@eureka/shared";
import { QueryInstant } from "../submissions/pipeline.js";

/** A date (YYYY-MM-DD, UTC midnight) or an ISO date-time with offset, as on the interview board. */
const instant = QueryInstant;

const DAY_MS = 86_400_000;
const span = (p: { from: string; to: string }) => Date.parse(p.to) - Date.parse(p.from);

/**
 * Interview report (gap L4): interviews whose start is in [from, to),
 * grouped by coach, technology, candidate or duration bucket.
 */
export const InterviewReportQuery = z
  .object({ from: instant, to: instant, groupBy: z.enum(INTERVIEW_REPORT_GROUPS).default("coach") })
  .strict()
  .refine((p) => span(p) > 0, { message: "to must be after from", path: ["to"] })
  .refine((p) => span(p) <= 731 * DAY_MS, { message: "the period can span at most two years", path: ["to"] });
export type InterviewReportQuery = z.infer<typeof InterviewReportQuery>;

/**
 * Daily interviews report: one row per interview starting in [from, to).
 * The client sends its local day's boundaries; at most 26 hours (a day in
 * any time zone, daylight-saving days included).
 */
export const DailyInterviewsQuery = z
  .object({ from: instant, to: instant })
  .strict()
  .refine((p) => span(p) > 0, { message: "to must be after from", path: ["to"] })
  .refine((p) => span(p) <= 26 * 3_600_000, { message: "the daily report covers one day", path: ["to"] });
export type DailyInterviewsQuery = z.infer<typeof DailyInterviewsQuery>;
