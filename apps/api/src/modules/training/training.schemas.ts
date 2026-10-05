import { z } from "zod";
import { TRAINING_COVER_COLORS, TRAINING_COVER_ICONS } from "@eureka/shared";

/** Request schemas for docs/training-api.md. Limits match the CHECKs of migration 0065. */
const uuid = z.string().uuid();
const day = z.string().date().refine((d) => d >= "2000-01-01" && d <= "2100-12-31", "out of range");
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, "no control characters");
/** Multi-line text: newlines allowed, other control characters refused. */
const text = (max: number) => z.string().trim().max(max).regex(/^[^\x00-\x09\x0b-\x1f\x7f]*$/, "no control characters");
/** https only, no spaces or control characters, and no user info (`user@host`) in the authority. */
const https = z.string().trim().max(2000).url()
  .refine((u) => /^https:\/\/[^\s\p{Cc}@/?#]+([/?#][^\s\p{Cc}]*)?$/u.test(u), "Use an https:// link without spaces or user info");

export const BATCH_STATUSES = ["planned", "in_training", "completed", "cancelled"] as const;
export const coverColor = z.enum(TRAINING_COVER_COLORS);
export const coverIcon = z.enum(TRAINING_COVER_ICONS);

/** `If-Match: "3"` (or 3, or W/"3") -> 3; anything else -> null. */
export function parseIfMatch(v: string | undefined): number | null {
  const m = v === undefined ? null : /^\s*(?:W\/)?"?([1-9][0-9]{0,8})"?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}

/** Keyset cursor of the batch list: "<start month YYYY-MM-DD>~<id>". */
const BatchCursor = z.string().regex(/^\d{4}-\d{2}-\d{2}~[0-9a-f-]{36}$/i, "invalid cursor");

export const BatchListQuery = z
  .object({
    status: z.enum(BATCH_STATUSES).optional(),
    cursor: BatchCursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type BatchListQuery = z.infer<typeof BatchListQuery>;

const batchDetails = {
  name: line(80).nullable().optional(),
  trainerId: uuid.nullable().optional(),
  endDate: day.nullable().optional(),
  sizePlanned: z.number().int().min(1).max(500).nullable().optional(),
  coverColor: coverColor.optional(),
  coverIcon: coverIcon.optional(),
};

/** POST /training/batches (TR-5): the 0026 batch plus the training details. */
export const CreateTrainingBatch = z
  .object({ locationId: uuid, technologyId: uuid, startDate: day, ...batchDetails })
  .strict()
  .refine((b) => !b.endDate || b.endDate >= b.startDate, { message: "endDate must not be before startDate", path: ["endDate"] });
export type CreateTrainingBatch = z.infer<typeof CreateTrainingBatch>;

/** PATCH /training/batches/:id (TR-6): only the keys present change; `null` clears. */
export const UpdateTrainingBatch = z
  .object({ startDate: day.optional(), ...batchDetails })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to change");
export type UpdateTrainingBatch = z.infer<typeof UpdateTrainingBatch>;

export const BatchStatusChange = z.object({ to: z.enum(["in_training", "completed", "cancelled"]) }).strict();

export const AddBatchCourse = z.object({ courseId: uuid }).strict();
export const ReorderCourses = z.object({ courseIds: z.array(uuid).min(1).max(1000).refine((a) => new Set(a).size === a.length, "ids must be unique") }).strict();
export const ReorderModules = z.object({ moduleIds: z.array(uuid).min(1).max(1000).refine((a) => new Set(a).size === a.length, "ids must be unique") }).strict();

export const AddStudent = z.object({ candidateId: uuid }).strict();
export const StudentQuery = z.object({ search: z.string().trim().max(80).optional() }).strict();
export const ModuleCompletion = z.object({ completed: z.boolean() }).strict();

export const CourseListQuery = z
  .object({ includeArchived: z.enum(["true", "false"]).transform((v) => v === "true").optional() })
  .strict();

export const CreateModule = z
  .object({
    title: line(160),
    durationMinutes: z.number().int().min(1).max(10000),
    resources: z.array(https).max(10).optional(),
  })
  .strict();
export type CreateModule = z.infer<typeof CreateModule>;

export const UpdateModule = z
  .object({
    title: line(160).optional(),
    durationMinutes: z.number().int().min(1).max(10000).optional(),
    resources: z.array(https).max(10).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to change");
export type UpdateModule = z.infer<typeof UpdateModule>;

/** POST /training/courses (TR-4). `locationId` defaults to the caller's only managed location. */
export const CreateCourse = z
  .object({
    locationId: uuid.optional(),
    title: line(120),
    description: text(2000).nullable().optional(),
    coverColor: coverColor.optional(),
    coverIcon: coverIcon.optional(),
    modules: z.array(CreateModule).max(100).optional(),
  })
  .strict();
export type CreateCourse = z.infer<typeof CreateCourse>;

export const UpdateCourse = z
  .object({
    title: line(120).optional(),
    description: text(2000).nullable().optional(),
    coverColor: coverColor.optional(),
    coverIcon: coverIcon.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to change");
export type UpdateCourse = z.infer<typeof UpdateCourse>;
