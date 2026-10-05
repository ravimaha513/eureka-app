import { z } from "zod";
import {
  EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, JOB_CATEGORIES, JOB_KINDS, JOB_STATUSES, PAY_CURRENCIES, PAY_FREQUENCIES,
  RichDocSchema, WORK_MODES,
} from "@eureka/shared";
import { Cursor } from "../submissions/pipeline.js";

/** docs/jobs-portal-api.md. Bodies are strict: unknown and server-managed fields are refused (422). */
const uuid = z.string().uuid();
// eslint-disable-next-line no-control-regex
const noControl = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);
const line = (max: number) => z.string().trim().min(1).max(max).refine(noControl, "control characters are not allowed");
const day = z.string().date().refine((d) => d >= "2000-01-01" && d <= "2100-12-31", "out of range");

const Skills = z.array(line(40)).max(30)
  .transform((s) => { const seen = new Set<string>(); return s.filter((x) => !seen.has(x.toLowerCase()) && !!seen.add(x.toLowerCase())); });

const Pay = z.object({
  amount: z.number().min(0).max(99_999_999.99).transform((n) => Math.round(n * 100) / 100),
  frequency: z.enum(PAY_FREQUENCIES),
  currency: z.enum(PAY_CURRENCIES),
}).strict();

const fields = {
  title: line(160),
  category: z.enum(JOB_CATEGORIES),
  experienceLevel: z.enum(EXPERIENCE_LEVELS),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  workMode: z.enum(WORK_MODES),
  status: z.enum(JOB_STATUSES),
  deadline: day.nullable(),
  workHours: z.number().int().min(1).max(80).nullable(),
  pay: Pay.nullable(),
  clientId: uuid.nullable(),
  companyId: uuid.nullable(),
  location: line(120).nullable(),
  skills: Skills,
  requirements: RichDocSchema.nullable(),
  description: RichDocSchema.nullable(),
  hiringManagerId: uuid.nullable(),
  publishedToPortal: z.boolean(),
};

export const CreateJob = z.object({
  kind: z.enum(JOB_KINDS),
  ...fields,
  status: fields.status.default("draft"),
  deadline: fields.deadline.optional(),
  workHours: fields.workHours.optional(),
  pay: fields.pay.optional(),
  clientId: fields.clientId.optional(),
  companyId: fields.companyId.optional(),
  location: fields.location.optional(),
  skills: fields.skills.default([]),
  requirements: fields.requirements.optional(),
  description: fields.description.optional(),
  hiringManagerId: fields.hiringManagerId.optional(),
  publishedToPortal: fields.publishedToPortal.default(false),
}).strict()
  .refine((j) => j.kind !== "client_requirement" || (j.clientId ?? null) !== null, { message: "client_required", path: ["clientId"] })
  .refine((j) => j.kind !== "client_requirement" || (j.companyId ?? null) === null, { message: "company_not_allowed", path: ["companyId"] })
  .refine((j) => j.kind !== "internal_opening" || (j.clientId ?? null) === null, { message: "client_not_allowed", path: ["clientId"] })
  .refine((j) => j.kind === "internal_opening" || !j.publishedToPortal, { message: "portal_internal_only", path: ["publishedToPortal"] });
export type CreateJob = z.infer<typeof CreateJob>;

/** PATCH: any subset of the editable fields (kind never changes). Row version in If-Match. */
export const UpdateJob = z.object(fields).partial().strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });
export type UpdateJob = z.infer<typeof UpdateJob>;

export const JobListQuery = z.object({
  kind: z.enum(JOB_KINDS).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  clientId: uuid.optional(),
  search: z.string().trim().min(1).max(80).optional(),
  /** Only jobs whose hiring manager is the caller. */
  mine: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type JobListQuery = z.infer<typeof JobListQuery>;
