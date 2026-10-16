import { z } from "zod";

/** A Google calendar id ("primary" or an address such as support@company.com); no spaces or control characters. */
export const CalendarId = z.string().trim().min(1).max(200).refine((v) => !/[\s\u0000-\u001f\u007f]/.test(v), "not a calendar id");
export const ConnectQuery = z.object({ calendarId: CalendarId.default("primary") }).strict();
export const CallbackQuery = z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(200) })
  .passthrough(); // Google adds scope, authuser, prompt
