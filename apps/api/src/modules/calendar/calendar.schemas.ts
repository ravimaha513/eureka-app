import { z } from "zod";

/** A Google calendar id ("primary" or an address such as support@company.com); no spaces or control characters. */
export const CalendarId = z.string().trim().min(1).max(200).refine((v) => !/[\s\u0000-\u001f\u007f]/.test(v), "not a calendar id");
export const ConnectQuery = z.object({ calendarId: CalendarId.default("primary") }).strict();
export const CallbackQuery = z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(200) })
  .passthrough(); // Google adds scope, authuser, prompt

/** Free/busy window (CA-7): instants, `to` after `from`, at most 31 days apart. */
export const BUSY_WINDOW_MAX_MS = 31 * 24 * 3_600_000;
export const BusyQuery = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }).strict()
  .transform((q) => ({ from: new Date(q.from), to: new Date(q.to) }))
  .refine((q) => q.to > q.from, { message: "to must be after from", path: ["to"] })
  .refine((q) => +q.to - +q.from <= BUSY_WINDOW_MAX_MS, { message: "window must be 31 days or less", path: ["to"] });
