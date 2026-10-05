import { z } from "zod";
import { INTERVIEW_DURATION_MAX, INTERVIEW_DURATION_MIN, INTERVIEW_TYPES, PANEL_MAX, SCORECARD_KINDS } from "@eureka/shared";
import { CALL_STATUSES, Cursor, QueryInstant, interviewTimesProblem } from "../submissions/pipeline.js";

const uuid = z.string().uuid();
/** Only https links are stored (no javascript: or data: URLs reach the board). */
const link = z.string().max(500).url().refine((u) => u.startsWith("https://"), "must be an https URL");
/** IS-3: meeting links are https without whitespace (the database checks the same). */
const meetingLink = link.refine((u) => !/\s/.test(u), "must not contain spaces");

export const InterviewListQuery = z
  .object({
    from: QueryInstant.optional(),
    to: QueryInstant.optional(),
    status: z.enum(CALL_STATUSES).optional(),
    teamId: uuid.optional(),
    locationId: uuid.optional(),
    candidateId: uuid.optional(),
    clientId: uuid.optional(),
    submissionId: uuid.optional(),
    cleared: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type InterviewListQuery = z.infer<typeof InterviewListQuery>;

/** IS-2: whole minutes, 15..240; the server turns it into endsAt (no duration column). */
const durationMin = z.number().int().min(INTERVIEW_DURATION_MIN).max(INTERVIEW_DURATION_MAX);
/** IS-4: distinct app users, at most PANEL_MAX. */
const panelIds = z.array(uuid).max(PANEL_MAX)
  .refine((ids) => new Set(ids).size === ids.length, "panel members must be distinct");

/** endsAt from startsAt and a duration in minutes. */
export const endFromDuration = (startsAt: string, minutes: number) => new Date(Date.parse(startsAt) + minutes * 60_000).toISOString();

/**
 * Snapshots (candidate, recruiter, team, location, client) come from the
 * submission. Send endsAt or durationMin (exactly one).
 */
export const CreateInterview = z
  .object({
    submissionId: uuid,
    round: z.string().trim().min(1).max(40),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).optional(),
    durationMin: durationMin.optional(),
    coachId: uuid.optional(),
    inviteReceived: z.boolean().optional(),
    interviewType: z.enum(INTERVIEW_TYPES).optional(),
    meetingUrl: meetingLink.optional(),
    panelIds: panelIds.optional(),
    leadId: uuid.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if ((b.endsAt === undefined) === (b.durationMin === undefined)) {
      ctx.addIssue({ code: "custom", message: "send endsAt or durationMin", path: ["durationMin"] });
      return;
    }
    const problem = interviewTimesProblem(b.startsAt, b.endsAt ?? endFromDuration(b.startsAt, b.durationMin!));
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["endsAt"] });
    if (b.leadId !== undefined && !(b.panelIds ?? []).includes(b.leadId)) {
      ctx.addIssue({ code: "custom", message: "the lead must be a panel member", path: ["leadId"] });
    }
  });
export type CreateInterview = z.infer<typeof CreateInterview>;

/**
 * Every field any role may change. Which of them a caller may send depends
 * on the grant that covers the interview (SALES_FIELDS / LOCATION_FIELDS);
 * anything else is rejected with 422 (design B4.7).
 */
export const UpdateInterview = z
  .object({
    round: z.string().trim().min(1).max(40),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    otterUrl: link.nullable(),
    recordingUrl: link.nullable(),
    coachId: uuid.nullable(),
    inviteReceived: z.boolean(),
    callStatus: z.enum(CALL_STATUSES),
    cleared: z.boolean(),
    consentCaptured: z.boolean(),
    systemName: z.string().trim().min(1).max(80).nullable(),
    interviewType: z.enum(INTERVIEW_TYPES).nullable(),
    meetingUrl: meetingLink.nullable(),
    /** Replaces endsAt (startsAt + minutes); not together with endsAt. */
    durationMin,
    /** Replaces the whole panel. */
    panelIds,
    /** Needs panelIds in the same request; null = no lead. */
    leadId: uuid.nullable(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "no fields to update")
  .refine((b) => b.endsAt === undefined || b.durationMin === undefined, { message: "send endsAt or durationMin, not both", path: ["durationMin"] })
  .refine((b) => b.leadId === undefined || b.panelIds !== undefined, { message: "send panelIds with leadId", path: ["leadId"] })
  .refine((b) => b.leadId == null || (b.panelIds ?? []).includes(b.leadId), { message: "the lead must be a panel member", path: ["leadId"] });
export type UpdateInterview = z.infer<typeof UpdateInterview>;
export type InterviewField = keyof UpdateInterview;

/** Sales grants (own/team/hierarchy) on the interview's actor snapshot. */
export const SALES_FIELDS: ReadonlySet<InterviewField> = new Set<InterviewField>([
  "round", "startsAt", "endsAt", "otterUrl", "recordingUrl", "coachId", "inviteReceived", "callStatus",
  "interviewType", "meetingUrl", "durationMin", "panelIds", "leadId",
]);
/** Location grants on the interview's location. */
export const LOCATION_FIELDS: ReadonlySet<InterviewField> = new Set<InterviewField>([
  "cleared", "consentCaptured", "systemName", "callStatus",
]);

/** Fields that are interview columns (durationMin, panelIds and leadId are handled separately). */
export type InterviewColumnField = Exclude<InterviewField, "durationMin" | "panelIds" | "leadId">;
export const COLUMN: Record<InterviewColumnField, string> = {
  round: "round", startsAt: "starts_at", endsAt: "ends_at", otterUrl: "otter_url", recordingUrl: "recording_url",
  coachId: "coach_id", inviteReceived: "invite_received", callStatus: "call_status", cleared: "cleared",
  consentCaptured: "consent_captured", systemName: "system_name", interviewType: "interview_type", meetingUrl: "meeting_url",
};

export const FEEDBACK_KINDS = ["coach", "location", "client"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

const score = z.number().int().min(1).max(5);
/** IS-6: all four criteria, 1..5 each. */
export const ScorecardInput = z
  .object({ technicalSkills: score, communication: score, problemSolving: score, attitude: score })
  .strict();

export const CreateFeedback = z
  .object({
    kind: z.enum(FEEDBACK_KINDS).optional(),
    rating: z.number().int().min(1).max(5).optional(),
    notes: z.string().trim().min(1).max(4000).optional(),
    scorecard: ScorecardInput.optional(),
  })
  .strict()
  .refine((b) => b.rating !== undefined || b.notes !== undefined || b.scorecard !== undefined, "rating, notes or a scorecard is required")
  .refine((b) => b.scorecard === undefined || b.kind === undefined || (SCORECARD_KINDS as readonly string[]).includes(b.kind),
    { message: "a scorecard goes with coach or client feedback", path: ["scorecard"] });
export type CreateFeedback = z.infer<typeof CreateFeedback>;
