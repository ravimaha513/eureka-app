import { z } from "zod";
import { CONTRACT_KINDS, CONTRACT_NOTES_MAX, CONTRACT_REFERENCE_MAX, CONTRACT_TITLE_MAX } from "@eureka/shared";

const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const text = (max: number) => z.string().trim().max(max).refine((v) => !CONTROL.test(v), "remove control characters");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "not a date");

/** docs/alerts-calendar-birthdays.md CT-2: a contract on a placement. */
export const CreateContract = z
  .object({
    kind: z.enum(CONTRACT_KINDS),
    title: text(CONTRACT_TITLE_MAX).refine((v) => v.length > 0, "give the contract a title"),
    reference: text(CONTRACT_REFERENCE_MAX).nullable().optional().transform((v) => (v ? v : null)),
    startsOn: isoDate.nullable().optional().transform((v) => v ?? null),
    endsOn: isoDate.nullable().optional().transform((v) => v ?? null),
    notes: z.string().max(CONTRACT_NOTES_MAX).refine((v) => !CONTROL.test(v), "remove control characters")
      .nullable().optional().transform((v) => (v && v.trim() ? v.trim() : null)),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.startsOn && b.endsOn && b.endsOn < b.startsOn) ctx.addIssue({ code: "custom", message: "end date must be on or after the start date", path: ["endsOn"] });
  });
export type CreateContract = z.infer<typeof CreateContract>;
