import { z } from "zod";

/** docs/pipeline-vendors-api.md. Every body and query schema is strict: unknown keys are refused (rule 4). */

export const ASSESSMENT_PLATFORMS = ["glider", "hackerrank", "codility", "vendor_portal", "other"] as const;
export const ASSESSMENT_STATUSES = ["assigned", "completed", "passed", "failed", "expired", "cancelled"] as const;
export const NONRESPONSE_REASONS = ["no_reply_calls", "no_reply_messages", "missed_interview", "missed_assessment", "other"] as const;
export const NONRESPONSE_RESOLUTIONS = ["responded", "flagged_in_error"] as const;

/** Furthest stage a candidate reached, in pipeline order (PV-2). */
export const PIPELINE_STAGES = [
  "not_started", "marketing", "submitted", "interviewing", "assessment", "confirmed", "paperwork", "joined",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const Day = z.string().date();

const AssessmentFields = {
  platform: z.enum(ASSESSMENT_PLATFORMS),
  status: z.enum(ASSESSMENT_STATUSES),
  assignedOn: Day,
  dueOn: Day.nullable().optional(),
  completedOn: Day.nullable().optional(),
  score: z.number().int().min(0).max(100).nullable().optional(),
};

const datesOk = (b: { assignedOn?: string; dueOn?: string | null; completedOn?: string | null }) =>
  (!b.assignedOn || !b.dueOn || b.dueOn >= b.assignedOn) && (!b.assignedOn || !b.completedOn || b.completedOn >= b.assignedOn);
const outcomeOk = (b: { status?: string; completedOn?: string | null }) =>
  !b.status || !["completed", "passed", "failed"].includes(b.status) || Boolean(b.completedOn);

export const CreateAssessment = z.object(AssessmentFields).strict()
  .refine(datesOk, { message: "dates must not be before assignedOn", path: ["dueOn"] })
  .refine(outcomeOk, { message: "completed_on_required", path: ["completedOn"] });
export type CreateAssessment = z.infer<typeof CreateAssessment>;

/** A full replacement of the editable fields (If-Match: the rowVersion the client saw). */
export const UpdateAssessment = CreateAssessment;
export type UpdateAssessment = CreateAssessment;

export const FlagNonResponse = z.object({ reason: z.enum(NONRESPONSE_REASONS) }).strict();
export const ResolveNonResponse = z.object({ resolution: z.enum(NONRESPONSE_RESOLUTIONS) }).strict();

export const PipelineQuery = z
  .object({
    /** Optional period (calendar days, inclusive). Counts cover the period; only candidates with pipeline activity in it are listed. */
    from: Day.optional(),
    to: Day.optional(),
    technologyId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    recruiterId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    marketingStatus: z.enum(["in_training", "active", "on_hold", "stopped", "full_of_interviews", "confirmation", "placed", "bench", "terminated"]).optional(),
    stage: z.enum(PIPELINE_STAGES).optional(),
    /** Only candidates with an open "not responding" flag. */
    notResponding: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "to must not be before from", path: ["to"] })
  .refine((q) => !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000,
    { message: "the period can cover at most 366 days", path: ["from"] })
  .refine((q) => (q.from === undefined) === (q.to === undefined), { message: "give both from and to, or neither", path: ["to"] });
export type PipelineQuery = z.infer<typeof PipelineQuery>;
