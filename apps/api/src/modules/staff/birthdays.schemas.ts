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
