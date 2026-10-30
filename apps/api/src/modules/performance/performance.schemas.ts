import { z } from "zod";
import { validTimeZone } from "../../platform/time-zone.js";
import { QueryInstant } from "../submissions/pipeline.js";

const uuid = z.string().uuid();

const TimeZone = z.string().max(64).refine(validTimeZone, "unknown time zone");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "not a date");

/** PF-1: the period (instants; default the last 30 days) and the caller's time zone for calendar dates. */
export const PeriodQuery = z
  .object({
    from: QueryInstant.optional(),
    to: QueryInstant.optional(),
    tz: TimeZone.optional(),
  })
  .strict();
export type PeriodQuery = z.infer<typeof PeriodQuery>;

/** The activity a count is made of (PF-2 drill-down). */
export const ACTIVITY_KINDS = ["submissions", "interviews", "interviewsCleared", "placements", "joined"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ActivityQuery = z
  .object({
    from: QueryInstant.optional(),
    to: QueryInstant.optional(),
    tz: TimeZone.optional(),
    kind: z.enum(ACTIVITY_KINDS),
    userId: uuid.optional(),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ActivityQuery = z.infer<typeof ActivityQuery>;

export const ActiveCandidatesQuery = z
  .object({
    from: QueryInstant.optional(),
    to: QueryInstant.optional(),
    tz: TimeZone.optional(),
    userId: uuid.optional(),
  })
  .strict();
export type ActiveCandidatesQuery = z.infer<typeof ActiveCandidatesQuery>;

export const PERIOD_KINDS = ["week", "month", "quarter"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** Targets whose period overlaps [from, through] (calendar dates), optionally for one person. */
export const TargetListQuery = z
  .object({
    from: isoDate.optional(),
    through: isoDate.optional(),
    userId: uuid.optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.through || q.from <= q.through, { message: "from must be on or before through", path: ["through"] });
export type TargetListQuery = z.infer<typeof TargetListQuery>;

const count = z.number().int().min(0).max(100_000).nullable().optional().transform((v) => v ?? null);

/** PF-4: create or replace the target of (person, period kind, period start). */
export const SetTarget = z
  .object({
    userId: uuid,
    periodKind: z.enum(PERIOD_KINDS),
    periodStart: isoDate,
    submissions: count,
    interviews: count,
    placements: count,
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.submissions === null && b.interviews === null && b.placements === null) {
      ctx.addIssue({ code: "custom", message: "set at least one target", path: ["submissions"] });
    }
    const d = new Date(`${b.periodStart}T00:00:00Z`);
    const aligned = b.periodKind === "week" ? d.getUTCDay() === 1
      : b.periodKind === "month" ? d.getUTCDate() === 1
        : d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0;
    if (!aligned) {
      ctx.addIssue({
        code: "custom", path: ["periodStart"],
        message: b.periodKind === "week" ? "a week starts on a Monday" : b.periodKind === "month" ? "a month starts on the 1st" : "a quarter starts on 1 January, April, July or October",
      });
    }
  });
export type SetTarget = z.infer<typeof SetTarget>;
