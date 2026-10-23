/** Interview reports (gap L4, docs/interviews-settings-api.md "Interview reports"). */
export const INTERVIEW_REPORT_GROUPS = ["coach", "technology", "candidate", "duration"] as const;
export type InterviewReportGroup = (typeof INTERVIEW_REPORT_GROUPS)[number];

/** Call statuses left out of the report counts (the interview did not take place as planned). */
export const INTERVIEW_REPORT_EXCLUDED_STATUSES = ["cancelled", "rescheduled", "no_invite"] as const;

/**
 * Duration buckets in minutes: [min, max), max null = open-ended.
 * Duration = ends_at - starts_at (there is no separate duration column).
 */
export const INTERVIEW_DURATION_BUCKETS = [
  { key: "lt30", label: "Under 30 min", min: 0, max: 30 },
  { key: "30-59", label: "30-59 min", min: 30, max: 60 },
  { key: "60-89", label: "60-89 min", min: 60, max: 90 },
  { key: "90-119", label: "90-119 min", min: 90, max: 120 },
  { key: "120plus", label: "120 min or more", min: 120, max: null },
] as const;
export type InterviewDurationBucket = (typeof INTERVIEW_DURATION_BUCKETS)[number]["key"];

/** Bucket key for a duration in minutes. */
export function durationBucket(minutes: number): InterviewDurationBucket {
  for (const b of INTERVIEW_DURATION_BUCKETS) if (minutes >= b.min && (b.max === null || minutes < b.max)) return b.key;
  return "lt30";
}
