import { z } from "zod";
import { QueryInstant } from "../submissions/pipeline.js";

/** The longest window one read may ask for (the database caps it too). */
export const COACH_CALENDAR_MAX_DAYS = 31;

export const CoachCalendarQuery = z.object({ from: QueryInstant, to: QueryInstant }).strict()
  .transform((q) => ({ from: new Date(q.from), to: new Date(q.to) }))
  .refine((q) => q.to > q.from && q.to.getTime() - q.from.getTime() <= COACH_CALENDAR_MAX_DAYS * 86_400_000, { message: "invalid_window" });

export const CoachCalendarPeopleQuery = z.object({ q: z.string().trim().min(1).max(100) }).strict();

/** Exactly one grantee; coachIds only when not all coaches. Granting again replaces what they had. */
export const SetCoachCalendarGrant = z.object({
  granteeRole: z.string().min(1).max(64).optional(),
  granteeUserId: z.string().uuid().optional(),
  allCoaches: z.boolean(),
  coachIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  detail: z.enum(["full", "busy"]),
}).strict()
  .refine((b) => (b.granteeRole === undefined) !== (b.granteeUserId === undefined), { message: "invalid_grantee" })
  .refine((b) => b.allCoaches === (b.coachIds === undefined), { message: "invalid_coaches" });
export type SetCoachCalendarGrant = z.infer<typeof SetCoachCalendarGrant>;
