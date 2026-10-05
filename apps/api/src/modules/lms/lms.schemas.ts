import { z } from "zod";

/** docs/lms-api.md. Every body is strict: unknown and server-managed fields are refused (422). */
const uuid = z.string().uuid();
const day = z.string().date().refine((d) => d >= "2000-01-01" && d <= "2100-12-31", "out of range");
const search = z.string().trim().min(1).max(80);
const limit = z.coerce.number().int().min(1).max(100).default(25);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const cursor = z.string().min(3).max(120);

export const CourseListQuery = z
  .object({ q: search.optional(), archived: bool.optional(), limit, cursor: cursor.optional() })
  .strict();
export type CourseListQuery = z.infer<typeof CourseListQuery>;

export const CourseCreate = z
  .object({ title: z.string().trim().min(1).max(160), description: z.string().max(2000).optional() })
  .strict();
export type CourseCreate = z.infer<typeof CourseCreate>;

export const CoursePatch = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(2000).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "nothing to change");
export type CoursePatch = z.infer<typeof CoursePatch>;

export const ModulesPut = z
  .object({
    modules: z
      .array(
        z.object({
          id: uuid.optional(),
          title: z.string().trim().min(1).max(160),
          durationMinutes: z.number().int().min(0).max(6000),
        }).strict(),
      )
      .max(200),
  })
  .strict();
export type ModulesPut = z.infer<typeof ModulesPut>;

export const BatchListQuery = z
  .object({
    status: z.enum(["not_started", "in_progress", "completed"]).optional(),
    q: search.optional(),
    archived: bool.optional(),
    limit,
    cursor: cursor.optional(),
  })
  .strict();
export type BatchListQuery = z.infer<typeof BatchListQuery>;

const dates = (b: { startDate?: string; endDate?: string }) => b.startDate === undefined || b.endDate === undefined || b.endDate >= b.startDate;

export const BatchCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    startDate: day,
    endDate: day,
    year: z.number().int().min(2000).max(2100).optional(),
  })
  .strict()
  .refine(dates, { message: "endDate must be on or after startDate", path: ["endDate"] });
export type BatchCreate = z.infer<typeof BatchCreate>;

export const BatchPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    startDate: day.optional(),
    endDate: day.optional(),
    year: z.number().int().min(2000).max(2100).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "nothing to change")
  .refine(dates, { message: "endDate must be on or after startDate", path: ["endDate"] });
export type BatchPatch = z.infer<typeof BatchPatch>;

export const BatchCoursesPut = z.object({ courseIds: z.array(uuid).max(100) }).strict();
export const StudentListQuery = z.object({ q: search.optional(), limit, cursor: cursor.optional() }).strict();
export type StudentListQuery = z.infer<typeof StudentListQuery>;
export const StudentsAdd = z.object({ userIds: z.array(uuid).min(1).max(100) }).strict();
export const StudentLookupQuery = z.object({ q: search.optional() }).strict();
export const ProgressPut = z.object({ percent: z.number().int().min(0).max(100) }).strict();

/** `If-Match: "3"` (or 3, or W/"3") -> 3; anything else -> null. */
export function parseIfMatch(v: string | undefined): number | null {
  const m = v === undefined ? null : /^\s*(?:W\/)?"?([1-9][0-9]{0,8})"?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}
