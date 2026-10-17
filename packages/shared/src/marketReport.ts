/**
 * CEO market reports (gap L3, docs/market-reports-api.md): point-in-time
 * candidate counts for planning batches. Shared by the API and the web app.
 */
import { CANDIDATE_STATUSES, type CandidateStatus } from "./authz/state-machines.js";

/** What the counts can be grouped by. `lead` is the lead of the candidate's team. */
export const MARKET_REPORT_GROUPS = ["technology", "batch", "location", "team", "lead", "recruiter"] as const;
export type MarketReportGroup = (typeof MARKET_REPORT_GROUPS)[number];

/** "In market": the actively marketed statuses (the same set as the Open-to-all-teams rule, MARKETABLE_STATUSES). */
export const IN_MARKET_STATUSES = ["active", "full_of_interviews"] as const satisfies readonly CandidateStatus[];

/** "Placed": joined and on a project. */
export const PLACED_STATUSES = ["placed"] as const satisfies readonly CandidateStatus[];

/** Column order of the per-status breakdown. */
export const MARKET_REPORT_STATUSES: readonly CandidateStatus[] = CANDIDATE_STATUSES;

/** "Placed between" days are calendar days in this time zone (the organisation's). */
export const MARKET_REPORT_TIME_ZONE = "America/New_York";
