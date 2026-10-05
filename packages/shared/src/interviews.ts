/**
 * Interview details and scorecards (interviews-settings, migration 0080,
 * docs/interviews-settings-api.md). Shared by the API, the web app and tests.
 */

export const INTERVIEW_TYPES = ["phone", "video", "in_person"] as const;
export type InterviewType = (typeof INTERVIEW_TYPES)[number];
export const INTERVIEW_TYPE_LABELS: Record<InterviewType, string> = { phone: "Phone", video: "Video", in_person: "In person" };

/** Durations offered by the scheduling dialog; the API accepts any whole minute in the range. */
export const INTERVIEW_DURATION_MIN = 15;
export const INTERVIEW_DURATION_MAX = 240;
export const INTERVIEW_DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240] as const;

/** Suggested rounds (the round stays free text up to 40 characters). */
export const INTERVIEW_ROUNDS = [
  "Initial Screening", "Technical Screening", "Technical Round 2", "Manager Round", "Client Round", "Final Round", "HR Round",
] as const;

/** At most this many panel members per interview. */
export const PANEL_MAX = 10;

/** Scorecard criteria (1 to 5 each), all four or none. */
export const SCORECARD_CRITERIA = ["technicalSkills", "communication", "problemSolving", "attitude"] as const;
export type ScorecardCriterion = (typeof SCORECARD_CRITERIA)[number];
export type Scorecard = Record<ScorecardCriterion, number>;
export const SCORECARD_LABELS: Record<ScorecardCriterion, string> = {
  technicalSkills: "Technical skills", communication: "Communication", problemSolving: "Problem solving", attitude: "Attitude",
};
/** Feedback kinds that may carry a scorecard: the coach's own evaluation and the client's, relayed by Sales. */
export const SCORECARD_KINDS = ["coach", "client"] as const;
