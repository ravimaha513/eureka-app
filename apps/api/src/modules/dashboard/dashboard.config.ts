/**
 * "Needs attention" thresholds (docs/dashboards-api.md). OD-05 (bench,
 * unresponsive and target thresholds) is still open with Sales leadership, so
 * these are conservative placeholders: each flags only work that is clearly
 * overdue, to keep the list short and trusted. Change them here; the API
 * returns the values in use so the page can explain each list.
 */
export const DASHBOARD_THRESHOLDS = {
  /** An open submission (not selected, rejected or withdrawn) with no status change for this many days. */
  staleSubmissionDays: 7,
  /** An interview that ended at least this many hours ago with no coach, location or client feedback. */
  feedbackGraceHours: 24,
  /** Interviews that ended longer ago than this are no longer chased for feedback. */
  feedbackLookbackDays: 30,
  /** An open (pre-join) placement with no status change for this many days, or past its tentative start. */
  placementStallDays: 5,
} as const;

/** Rows returned per "needs attention" list (the total is always exact). */
export const NEEDS_ATTENTION_LIMIT = 25;

/** Longest period one dashboard request may cover. */
export const MAX_PERIOD_DAYS = 366;

/** Default period when the request names none. */
export const DEFAULT_PERIOD_DAYS = 7;
