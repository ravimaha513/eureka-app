/** Calendar helpers for daily jobs. No timezone library: Intl handles DST. */

/** "YYYY-MM-DD" of the UTC calendar day containing `d`. */
export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Adds whole days to a "YYYY-MM-DD" key. */
export function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateKey(d);
}

/** Offset of `timeZone` from UTC at instant `at`, in milliseconds (EDT = -4 h). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which wall-clock `hh:mm` on `dateKey` occurs in `timeZone`. */
export function zonedTime(dateKey: string, hh: number, mm: number, timeZone: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Second pass settles instants near a DST change.
  t = guess - zoneOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

/**
 * When the export of UTC day `dateKey` is due: `hh:mm` local time in `timeZone`
 * on the first local day that starts after the UTC day has ended. For
 * America/New_York 03:30 this is 03:30 ET the next day (07:30 or 08:30 UTC).
 */
export function dailyDueAt(dateKey: string, hh: number, mm: number, timeZone: string): Date {
  const dayEnd = new Date(`${addDays(dateKey, 1)}T00:00:00Z`);
  // Local calendar date at the moment the UTC day ends, then the first hh:mm after it.
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(dayEnd);
  let due = zonedTime(localDate, hh, mm, timeZone);
  if (due.getTime() <= dayEnd.getTime()) due = zonedTime(addDays(localDate, 1), hh, mm, timeZone);
  return due;
}

/** Whole days from `from` to `to` ("YYYY-MM-DD" keys; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The latest UTC day whose daily run is due at `now` (yesterday once hh:mm local has passed). */
export function latestDueDailyKey(now: Date, hh: number, mm: number, timeZone: string): string {
  const yesterday = addDays(utcDateKey(now), -1);
  return dailyDueAt(yesterday, hh, mm, timeZone).getTime() <= now.getTime() ? yesterday : addDays(yesterday, -1);
}

/**
 * Run keys (UTC dates) of a daily job that are due at `now`, oldest first,
 * looking back `catchupDays` days so a worker that was down catches up.
 */
export function dueDailyKeys(
  now: Date, hh: number, mm: number, timeZone: string, catchupDays: number,
): string[] {
  const today = utcDateKey(now);
  const keys: string[] = [];
  for (let back = catchupDays; back >= 1; back--) {
    const key = addDays(today, -back);
    if (dailyDueAt(key, hh, mm, timeZone).getTime() <= now.getTime()) keys.push(key);
  }
  return keys;
}

/** A job run once per UTC day, due at hh:mm local time in timeZone the next day (see dailyDueAt). */
export interface DailySchedule { hh: number; mm: number; timeZone: string }

/**
 * Schedules of the worker's maintenance and delivery jobs (design B6).
 * - outbox-delivery: every tick; one run key per unpublished event (its id).
 * - outbox-prune, idempotency-cleanup: daily, after the audit export (03:30).
 *   Both delete by age relative to now(), so after downtime only the latest
 *   day is run (catch-up is not needed).
 */
export const OUTBOX_PRUNE_SCHEDULE: DailySchedule = { hh: 4, mm: 0, timeZone: "America/New_York" };
export const IDEMPOTENCY_CLEANUP_SCHEDULE: DailySchedule = { hh: 4, mm: 15, timeZone: "America/New_York" };

/** The run key due at `now` for a daily maintenance job (only the latest day; [] before the first is due). */
export function dueMaintenanceKeys(now: Date, s: DailySchedule): string[] {
  return dueDailyKeys(now, s.hh, s.mm, s.timeZone, 1);
}
