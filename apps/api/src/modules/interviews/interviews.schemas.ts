import { z } from "zod";
import { CALL_STATUSES, Cursor, QueryInstant, interviewTimesProblem } from "../submissions/pipeline.js";

const uuid = z.string().uuid();
/** Only https links are stored (no javascript: or data: URLs reach the board). */
const link = z.string().max(500).url().refine((u) => u.startsWith("https://"), "must be an https URL");

export const InterviewListQuery = z
  .object({
    from: QueryInstant.optional(),
    to: QueryInstant.optional(),
    status: z.enum(CALL_STATUSES).optional(),
    teamId: uuid.optional(),
    locationId: uuid.optional(),
    candidateId: uuid.optional(),
    submissionId: uuid.optional(),
    cleared: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type InterviewListQuery = z.infer<typeof InterviewListQuery>;

/** Snapshots (candidate, recruiter, team, location, client) come from the submission. */
export const CreateInterview = z
  .object({
    submissionId: uuid,
    round: z.string().trim().min(1).max(40),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    coachId: uuid.optional(),
    inviteReceived: z.boolean().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const problem = interviewTimesProblem(b.startsAt, b.endsAt);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["endsAt"] });
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
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "no fields to update");
export type UpdateInterview = z.infer<typeof UpdateInterview>;
export type InterviewField = keyof UpdateInterview;

/** Sales grants (own/team/hierarchy) on the interview's actor snapshot. */
export const SALES_FIELDS: ReadonlySet<InterviewField> = new Set<InterviewField>([
  "round", "startsAt", "endsAt", "otterUrl", "recordingUrl", "coachId", "inviteReceived", "callStatus",
]);
/** Location grants on the interview's location. */
export const LOCATION_FIELDS: ReadonlySet<InterviewField> = new Set<InterviewField>([
  "cleared", "consentCaptured", "systemName", "callStatus",
]);

export const COLUMN: Record<InterviewField, string> = {
  round: "round", startsAt: "starts_at", endsAt: "ends_at", otterUrl: "otter_url", recordingUrl: "recording_url",
  coachId: "coach_id", inviteReceived: "invite_received", callStatus: "call_status", cleared: "cleared",
  consentCaptured: "consent_captured", systemName: "system_name",
};

export const FEEDBACK_KINDS = ["coach", "location", "client"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const CreateFeedback = z
  .object({
    kind: z.enum(FEEDBACK_KINDS).optional(),
    rating: z.number().int().min(1).max(5).optional(),
    notes: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .refine((b) => b.rating !== undefined || b.notes !== undefined, "rating or notes is required");
export type CreateFeedback = z.infer<typeof CreateFeedback>;
