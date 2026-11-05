import { z } from "zod";
import { isValidBirthday } from "@eureka/shared";

/** docs/alerts-calendar-birthdays.md BD-1: month and day only (never the year); null clears it. */
export const BirthdayValue = z
  .object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) })
  .strict()
  .refine(isValidBirthday, "not a calendar day")
  .nullable();
export type BirthdayValue = z.infer<typeof BirthdayValue>;
export const BirthdayUpdate = z.object({ birthday: BirthdayValue }).strict();

/** GET /staff/birthdays: the first BIRTHDAY_LIST_CAP people by name (as before), or a keyset page. */
export const BIRTHDAY_LIST_CAP = 2000;
export const BirthdayListQuery = z
  .object({
    /** The previous page's `nextCursor` (opaque; keyset on display name, id). */
    cursor: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(BIRTHDAY_LIST_CAP).default(BIRTHDAY_LIST_CAP),
  })
  // Not strict: this route took no query before, so unknown keys stay ignored (no breaking change).
  .strip();
export type BirthdayListQuery = z.infer<typeof BirthdayListQuery>;
