/**
 * Interview details and scorecards (interviews-settings, migration 0080,
 * docs/interviews-settings-api.md). Shared by the API, the web app and tests.
 */

export const INTERVIEW_TYPES = ["phone", "video", "in_person"] as const;
export type InterviewType = (typeof INTERVIEW_TYPES)[number];

/** Outcome of a round (migration 0360); not the location's pre-call "cleared" readiness flag. */
export const INTERVIEW_RESULTS = ["pending", "cleared", "rejected"] as const;
export type InterviewResult = (typeof INTERVIEW_RESULTS)[number];
export const INTERVIEW_TYPE_LABELS: Record<InterviewType, string> = { phone: "Phone", video: "Video", in_person: "In person" };

/** Durations offered by the scheduling dialog; the API accepts any whole minute in the range. */
export const INTERVIEW_DURATION_MIN = 15;
export const INTERVIEW_DURATION_MAX = 240;
export const INTERVIEW_DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240] as const;

/** Suggested rounds (the round stays free text up to 40 characters). L1/L2/L3 keep the funnel's stages exact. */
export const INTERVIEW_ROUNDS = [
  "Initial Screening", "L1", "L2", "L3", "Technical Screening", "Technical Round 2", "Manager Round", "Client Round", "Final Round", "HR Round",
] as const;

/**
 * Funnel stage of an interview, derived by the API from the free-text round
 * (submissions module, `interviewStageSql`): screening, L1, L2, L3 and beyond,
 * final; anything else (manager, client, HR rounds without a number) is `other`.
 */
export const INTERVIEW_STAGES = ["screening", "l1", "l2", "l3", "final", "other"] as const;
export type InterviewStage = (typeof INTERVIEW_STAGES)[number];
export const INTERVIEW_STAGE_LABELS: Record<InterviewStage, string> = {
  screening: "Screening", l1: "L1", l2: "L2", l3: "L3+", final: "Final", other: "Other round",
};

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
