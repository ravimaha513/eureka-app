import { z } from "zod";
import { APPLICATION_STATUSES, APP_INTERVIEW_STATUSES, APP_INTERVIEW_ROUNDS, APP_INTERVIEW_TYPES, isSafeHttpsUrl } from "@eureka/shared";
import { Cursor } from "../submissions/pipeline.js";

/** docs/jobs-portal-api.md "Applications". Bodies are strict. */
const uuid = z.string().uuid();
// eslint-disable-next-line no-control-regex
const noControlButNewlines = (v: string) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v);

export const ApplicationListQuery = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  jobId: uuid.optional(),
  search: z.string().trim().min(1).max(80).optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type ApplicationListQuery = z.infer<typeof ApplicationListQuery>;
export const ApplicationExport = ApplicationListQuery.omit({ cursor: true, limit: true });
export type ApplicationExport = z.infer<typeof ApplicationExport>;

export const ApplicantListQuery = z.object({
  search: z.string().trim().min(1).max(80).optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type ApplicantListQuery = z.infer<typeof ApplicantListQuery>;
export const ApplicantExport = ApplicantListQuery.omit({ cursor: true, limit: true });

/** Staff status change; withdrawn is the applicant's alone. Comments are internal (never emailed). */
export const StatusChange = z.object({
  to: z.enum(APPLICATION_STATUSES).refine((s) => s !== "withdrawn" && s !== "applied", "not a staff status"),
  comment: z.string().trim().max(1000).refine(noControlButNewlines, "control characters are not allowed").optional(),
}).strict();
export type StatusChange = z.infer<typeof StatusChange>;

export const ScheduleInterview = z.object({
  interviewType: z.enum(APP_INTERVIEW_TYPES),
  round: z.enum(APP_INTERVIEW_ROUNDS),
  leadUserId: uuid,
  panelUserIds: z.array(uuid).max(10).default([]),
  startsAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(480),
  /** https only; never shown to anyone but the applicant and staff who can read the application. */
  meetingLink: z.string().trim().max(2000).refine(isSafeHttpsUrl, "meeting links must be https URLs").optional(),
}).strict();
export type ScheduleInterview = z.infer<typeof ScheduleInterview>;

export const InterviewStatus = z.object({
  status: z.enum(APP_INTERVIEW_STATUSES).refine((s) => s !== "scheduled", "not a final status"),
}).strict();

const score = z.number().int().min(1).max(5);
export const Scorecard = z.object({
  technical: score, communication: score, problemSolving: score, attitude: score,
  notes: z.string().trim().max(2000).refine(noControlButNewlines, "control characters are not allowed").optional(),
}).strict();
export type Scorecard = z.infer<typeof Scorecard>;

/** Create a Eureka candidate from a hired application (the candidate service decides team and duplicates). */
export const CreateCandidateFromApplication = z.object({
  technologyId: uuid,
  locationId: uuid,
  teamId: uuid.optional(),
  confirmDuplicate: z.boolean().optional(),
}).strict();
export type CreateCandidateFromApplication = z.infer<typeof CreateCandidateFromApplication>;

// ---------- portal ----------
export const PortalJobsQuery = z.object({ cursor: Cursor.optional() }).strict();
export const PortalApplicationsQuery = z.object({ status: z.enum(APPLICATION_STATUSES).optional() }).strict();
